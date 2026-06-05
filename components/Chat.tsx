"use client";

import { useRef, useState } from "react";
import type { TwinController } from "@/lib/client/twin";
import type { AgentReply, TraceStep } from "@/lib/server/agent";

type Msg = { role: "user" | "assistant"; content: string; trace?: TraceStep[]; model?: string; error?: boolean };

const EXAMPLES = [
  "Take the parts to QC",
  "Go to assembly cell B at 1.0 m/s",
  "Send it to the paint shop",
  "Set the speed limit to 0.6",
  "Something is blocking the AGV, fix it and continue to shipping",
  "Stop",
];

export default function Chat({ ctrl }: { ctrl: TwinController }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: "user" as const, content: text.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const history = next.filter((m) => !m.error).slice(-10).map(({ role, content }) => ({ role, content }));
      const res = await fetch("/api/agent", {
        method: "POST",
        body: JSON.stringify({ session: ctrl.session, history, state: ctrl.snapshot() }),
      });
      const data = (await res.json()) as AgentReply & { error?: string };
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      ctrl.applyTwinOps(data.twinOps);
      ctrl.dispatch(data.commands);
      setMsgs((m) => [...m, { role: "assistant", content: data.reply, trace: data.trace, model: data.model }]);
    } catch (err) {
      setMsgs((m) => [...m, { role: "assistant", content: `Agent error: ${(err as Error).message}`, error: true }]);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {!msgs.length && (
          <div className="hint">
            Talk to the fleet agent in plain language. Every control command goes through the safety gate before it is signed.
            <div className="examples">
              {EXAMPLES.map((e) => <button key={e} onClick={() => send(e)}>{e}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? "error" : ""}`}>
            {m.trace && m.trace.length > 0 && <Trace steps={m.trace} />}
            <div className="bubble">{m.content}</div>
            {m.model && <div className="meta">{m.model}</div>}
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="bubble thinking">thinking…</div></div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. take the parts to QC" disabled={busy} />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}

function Trace({ steps }: { steps: TraceStep[] }) {
  const rejected = steps.filter((s) => s.kind === "tool" && s.gate && !s.gate.ok).length;
  const signed = steps.filter((s) => s.kind === "tool" && s.commandId).length;
  const warnings = steps.filter((s) => s.kind === "warning").length;
  return (
    <details className="trace">
      <summary>
        ReAct trace · {steps.length} steps
        {signed > 0 && <span className="tag ok">{signed} signed</span>}
        {rejected > 0 && <span className="tag bad">{rejected} gated</span>}
        {warnings > 0 && <span className="tag warn">{warnings} hallucination flag</span>}
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.kind}>
            {s.kind === "thought" && <><b>thought</b> {s.text}</>}
            {s.kind === "warning" && <><b>hallucination check</b> {s.text}</>}
            {s.kind === "tool" && (
              <>
                <b>{s.name}</b> <code>{JSON.stringify(s.input)}</code>
                {s.gate && <span className={`tag ${s.gate.ok ? "ok" : "bad"}`}>{s.gate.ok ? "gate pass" : `${s.gate.check} ✗`}</span>}
                <pre>{s.output.length > 400 ? s.output.slice(0, 400) + "…" : s.output}</pre>
              </>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
