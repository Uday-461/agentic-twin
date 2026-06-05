import Anthropic from "@anthropic-ai/sdk";
import type { SignedCommand, TwinOp, TwinSnapshot } from "../protocol";
import { STATIONS } from "../world";
import { appendAudit } from "./audit";
import { applyToState, evaluate, type GateResult } from "./gate";
import { searchManual } from "./rag";
import { signCommand } from "./signing";

// ReAct loop: the model reasons, calls a tool, reads the result, repeats. Read-only tools
// run directly; actuating tools go through the gate, and only gate-approved calls are
// signed into commands for the plant.

export type TraceStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; output: string; gate?: GateSummary; commandId?: string }
  | { kind: "warning"; text: string };

type GateSummary = { ok: boolean; check?: string; reason?: string; note?: string };

export type AgentReply = {
  reply: string;
  trace: TraceStep[];
  commands: SignedCommand[];
  twinOps: TwinOp[];
  model: string;
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

const MAX_STEPS = 8;

const SYSTEM = `You are the fleet controller agent for AGV-01, an autonomous guided vehicle on a factory floor.
Operators give you instructions in natural language; you act only through tools.

Rules:
- Before your first control command in a turn, call search_manual for the relevant procedure or limit, and follow what it says.
- Use get_twin_state whenever you need the live position, mode, sensor cross-check or E-STOP status.
- Every control command passes a safety gate. If a tool result starts with REJECTED, read the reason. Correct the command if the manual allows it; otherwise explain to the operator what is blocking and what they must do.
- Never claim an action happened unless a tool result says ACCEPTED. Accepted commands are signed and dispatched; the AGV executes them over the following seconds.
- You cannot reset an E-STOP. Only a human operator can.
- Reply to the operator in 1-3 short sentences.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_twin_state",
    description: "Live state of AGV-01 from the digital twin: pose (x, y metres; theta radians), mode, E-STOP reason, fleet speed limit, current target, telemetry age, sensor/twin cross-check (fusion) and extra obstacles known to the twin map.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_manual",
    description: "Search the AGV operations manual and safety procedures. Returns the most relevant sections.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "What to look up" } }, required: ["query"] },
  },
  {
    name: "move_to",
    description: "Send AGV-01 to a station. The controller plans a collision-free route around everything on the twin map.",
    input_schema: {
      type: "object",
      properties: {
        station: { type: "string", description: "Station ID from the manual" },
        speed: { type: "number", description: "Travel speed in m/s. Optional, default 0.8." },
      },
      required: ["station"],
    },
  },
  {
    name: "set_speed_limit",
    description: "Set the fleet speed limit in m/s. Caps every route until changed.",
    input_schema: { type: "object", properties: { mps: { type: "number" } }, required: ["mps"] },
  },
  {
    name: "stop",
    description: "Controlled stop: cancel the current route and hold position. Not an E-STOP.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "reconcile_twin",
    description: "Add the object the forward sensor is detecting to the twin map. Only valid when the sensor/twin cross-check is DISAGREE because of an unmapped obstacle.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export function modelId(): string {
  return process.env.OPENROUTER_API_KEY ? (process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash") : "mock-planner";
}

function client(): Anthropic {
  // OpenRouter speaks the Anthropic Messages API at /api; its key goes in as a bearer token.
  return new Anthropic({
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
    authToken: process.env.OPENROUTER_API_KEY,
    apiKey: null,
  });
}

class Run {
  trace: TraceStep[] = [];
  commands: SignedCommand[] = [];
  twinOps: TwinOp[] = [];
  accepted: { type: string; station?: string }[] = [];
  consultedManual = false;
  constructor(public session: string, public state: TwinSnapshot) {}

  /** Execute one tool call; returns the text the model sees. */
  execute(name: string, input: Record<string, unknown>): string {
    if (name === "get_twin_state") {
      const out = JSON.stringify(this.state);
      this.trace.push({ kind: "tool", name, input, output: out });
      return out;
    }
    if (name === "search_manual") {
      this.consultedManual = true;
      const hits = searchManual(String(input.query ?? ""));
      const out = hits.length
        ? hits.map((h) => `[${h.source} › ${h.heading}]\n${h.text}`).join("\n\n")
        : "No matching manual sections.";
      this.trace.push({ kind: "tool", name, input, output: out });
      return out;
    }

    const result: GateResult = evaluate(name, input, { state: this.state, consultedManual: this.consultedManual });
    appendAudit(result.ok ? "gate.pass" : "gate.reject", {
      session: this.session, tool: name, input, ...(result.ok ? {} : { check: result.check, reason: result.reason }),
    });
    if (!result.ok) {
      const out = `REJECTED by ${result.check} check: ${result.reason}`;
      this.trace.push({ kind: "tool", name, input, output: out, gate: { ok: false, check: result.check, reason: result.reason } });
      return out;
    }

    this.state = applyToState(this.state, result);
    let commandId: string | undefined;
    if (result.command) {
      const { cmd, payload } = signCommand(this.session, result.command.type, result.command.args, "agent");
      this.commands.push(cmd);
      commandId = payload.id;
      const { waypoints, ...args } = payload.args;
      appendAudit("cmd.signed", { session: this.session, id: payload.id, type: payload.type, args, legs: Array.isArray(waypoints) ? waypoints.length - 1 : undefined, issuedBy: "agent" });
      this.accepted.push({ type: payload.type, station: payload.args.station as string | undefined });
    }
    if (result.twinOp) {
      this.twinOps.push(result.twinOp);
      appendAudit("twin.op", { session: this.session, ...result.twinOp });
      this.accepted.push({ type: "reconcile" });
    }
    const out = `ACCEPTED${commandId ? ` (command ${commandId.slice(0, 8)} signed and dispatched)` : ""}${result.note ? `: ${result.note}` : ""}`;
    this.trace.push({ kind: "tool", name, input, output: out, gate: { ok: true, note: result.note }, commandId });
    return out;
  }

  /** Post-hoc hallucination check on the final reply: claims of movement with no accepted command. */
  checkReply(reply: string) {
    const claimsMotion = /\b(moving|moved|heading|dispatched|sent|on (its|the) way|en route|driving)\b/i.test(reply);
    if (!claimsMotion) return;
    for (const st of STATIONS) {
      const named = new RegExp(`\\b${st.id.replace("_", "[ _]")}\\b`, "i").test(reply);
      if (named && !this.accepted.some((a) => a.station === st.id) && this.state.target !== st.id) {
        this.trace.push({ kind: "warning", text: `Reply claims motion toward ${st.id}, but no command to ${st.id} was accepted this turn.` });
      }
    }
  }

  result(reply: string, model: string): AgentReply {
    this.checkReply(reply);
    appendAudit("agent.reply", { session: this.session, model, reply, commands: this.commands.length, warnings: this.trace.filter((t) => t.kind === "warning").length });
    return { reply, trace: this.trace, commands: this.commands, twinOps: this.twinOps, model };
  }
}

export async function runAgent(session: string, history: ChatTurn[], state: TwinSnapshot): Promise<AgentReply> {
  const prompt = history.at(-1)?.content ?? "";
  appendAudit("agent.request", { session, prompt });
  const run = new Run(session, state);
  const model = modelId();
  if (model === "mock-planner") return mockPlanner(run, prompt);

  const messages: Anthropic.MessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));
  const api = client();
  for (let i = 0; i < MAX_STEPS; i++) {
    const res = await api.messages.create({ model, max_tokens: 2048, system: SYSTEM, tools: TOOLS, messages });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) return run.result(text || "(no reply)", model);

    if (text) run.trace.push({ kind: "thought", text });
    messages.push({ role: "assistant", content: res.content });
    messages.push({
      role: "user",
      content: calls.map((c) => {
        const out = run.execute(c.name, (c.input ?? {}) as Record<string, unknown>);
        return { type: "tool_result" as const, tool_use_id: c.id, content: out, is_error: out.startsWith("REJECTED") };
      }),
    });
  }
  return run.result("I stopped after too many steps without finishing. Please rephrase or break the request down.", model);
}

/**
 * Deterministic stand-in used when no OpenRouter key is configured, so the twin, gate,
 * signing and audit chain can be exercised offline. It follows the same tool path.
 */
function mockPlanner(run: Run, prompt: string): AgentReply {
  const p = prompt.toLowerCase();
  const say = (t: string) => run.trace.push({ kind: "thought", text: t });
  const outputs: string[] = [];

  run.execute("get_twin_state", {});
  if (/\b(stop|halt|hold)\b/.test(p)) {
    outputs.push(run.execute("stop", {}));
  } else if (/reconcile|update (the )?map/.test(p)) {
    run.execute("search_manual", { query: "sensor cross-validation disagree reconcile" });
    outputs.push(run.execute("reconcile_twin", {}));
  } else if (/limit/.test(p)) {
    run.execute("search_manual", { query: "speed limits" });
    const mps = Number(p.match(/(\d+(\.\d+)?)/)?.[1]);
    outputs.push(run.execute("set_speed_limit", { mps }));
  } else {
    const aliases: [RegExp, string][] = [
      [/receiv/, "RECEIVING"], [/assembly\s*a\b|cell a\b/, "ASSEMBLY_A"], [/assembly\s*b\b|cell b\b/, "ASSEMBLY_B"],
      [/\bqc\b|quality/, "QC"], [/shipping|outbound/, "SHIPPING"], [/charg/, "CHARGER"],
    ];
    const hit = aliases.find(([re]) => re.test(p));
    const named = p.match(/(?:to|at)\s+(?:the\s+)?([a-z_]+(?:\s[a-z_]+)?)/)?.[1];
    const station = hit?.[1] ?? named?.toUpperCase().replace(" ", "_");
    if (!station) {
      say("No station, stop, limit or reconcile request recognised.");
      return run.result("Mock planner: try \"go to QC at 0.4 m/s\", \"stop\", \"set speed limit 0.6\" or \"reconcile the twin\".", "mock-planner");
    }
    run.execute("search_manual", { query: `${station} route speed limits` });
    const speed = Number(p.match(/(\d+(\.\d+)?)\s*m\/?s/)?.[1]);
    outputs.push(run.execute("move_to", Number.isFinite(speed) ? { station, speed } : { station }));
  }
  const last = outputs.at(-1) ?? "";
  return run.result(last.startsWith("REJECTED") ? `Not executed. ${last}` : `Done. ${last}`, "mock-planner");
}
