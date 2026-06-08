"use client";

import { useEffect, useRef, useState } from "react";
import { planPath } from "@/lib/astar";
import type { TwinController } from "@/lib/client/twin";
import type { AgentReply, TraceStep } from "@/lib/server/agent";
import { MACHINES, findStation } from "@/lib/world";

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
  const field = useRef<HTMLInputElement>(null);

  // Clicking a station in the 3D view prefills the command.
  const { text: draft, n: draftN } = ctrl.draft;
  useEffect(() => {
    if (!draftN) return;
    setInput(draft);
    field.current?.focus();
  }, [draft, draftN]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: "user" as const, content: text.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 30);
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
      showRejections(ctrl, data.trace);
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
            <p>Command the fleet in plain language. Every control action is screened by the safety gate, then signed before it reaches the AGV.</p>
            <div className="examples">
              {EXAMPLES.map((e, i) => <button key={e} style={{ animationDelay: `${i * 60}ms` }} onClick={() => send(e)}><span>›</span>{e}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? "error" : ""}`}>
            <div className="who">{m.role === "user" ? "OPERATOR" : "AGENT"}{m.model && <em>{m.model}</em>}</div>
            {m.trace && m.trace.length > 0 && <Trace steps={m.trace} />}
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="who">AGENT</div><div className="bubble thinking"><i /><i /><i /> reasoning</div></div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <span className="prompt">›</span>
        <input ref={field} value={input} onChange={(e) => setInput(e.target.value)} placeholder="take the parts to QC…" disabled={busy} />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}

/** Mirror gate rejections into the 3D scene: a red ghost route for blocked moves, a tag otherwise. */
function showRejections(ctrl: TwinController, trace: TraceStep[]) {
  const now = Date.now();
  for (const s of trace) {
    if (s.kind !== "tool" || !s.gate || s.gate.ok) continue;
    const reason = (s.gate.reason ?? "").split(/[.:(]/)[0].trim();
    const label = reason.length > 46 ? reason.slice(0, 44) + "…" : reason;
    const station = s.name === "move_to" ? findStation(String(s.input.station ?? "")) : undefined;
    const pose = ctrl.snapshot().pose;
    const path = station ? planPath(pose, station, [...MACHINES, ...ctrl.knownObstacles]) : null;
    if (path) ctrl.pushFx({ kind: "ghost", t: now, waypoints: path, label });
    else ctrl.pushFx({ kind: "reject", t: now, label: `${s.gate.check}: ${label}` });
  }
}

function Trace({ steps }: { steps: TraceStep[] }) {
  const rejected = steps.filter((s) => s.kind === "tool" && s.gate && !s.gate.ok).length;
  const signed = steps.filter((s) => s.kind === "tool" && s.commandId).length;
  const warnings = steps.filter((s) => s.kind === "warning").length;
  return (
    <details className="trace">
      <summary>
        <span>ReAct · {steps.length} steps</span>
        {signed > 0 && <span className="tag ok">{signed} signed</span>}
        {rejected > 0 && <span className="tag bad">{rejected} gated</span>}
        {warnings > 0 && <span className="tag warn">hallucination flag</span>}
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.kind === "tool" ? (s.gate ? (s.gate.ok ? "pass" : "fail") : "read") : s.kind}>
            {s.kind === "thought" && <><b>think</b><p>{s.text}</p></>}
            {s.kind === "warning" && <><b>hallucination check</b><p>{s.text}</p></>}
            {s.kind === "tool" && (
              <>
                <b>{s.name}</b>
                <code>{JSON.stringify(s.input)}</code>
                {s.gate && <span className={`tag ${s.gate.ok ? "ok" : "bad"}`}>{s.gate.ok ? "gate ✓" : `${s.gate.check} ✕`}</span>}
                <pre>{s.output.length > 360 ? s.output.slice(0, 360) + "…" : s.output}</pre>
              </>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
