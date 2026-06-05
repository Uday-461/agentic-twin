import { planPath } from "../astar";
import type { CommandType, TwinOp, TwinSnapshot } from "../protocol";
import { AGV, LIMITS, MACHINES, STATIONS, findStation, inQcZone, type Vec2 } from "../world";

// Pre-execution safety gate. Every actuating tool call from the model passes three checks
// in order, and nothing reaches the plant unless all three pass:
//   1. hallucination guard   does the call refer to things that exist in the live state?
//   2. operation guard       is the plant in a state where this operation is allowed?
//   3. parameter validator   are the arguments inside the manual's operating limits?

export type GateCheck = "hallucination" | "operation" | "parameters";

export type GateResult =
  | { ok: true; command?: { type: CommandType; args: Record<string, unknown> }; twinOp?: TwinOp; note?: string }
  | { ok: false; check: GateCheck; reason: string };

export type GateContext = {
  state: TwinSnapshot;
  /** Has the agent called search_manual earlier in this request? Actuation requires it. */
  consultedManual: boolean;
};

export const TOOL_ARGS: Record<string, string[]> = {
  get_twin_state: [],
  search_manual: ["query"],
  move_to: ["station", "speed"],
  set_speed_limit: ["mps"],
  stop: [],
  reconcile_twin: [],
};

const MOTION = new Set(["move_to"]);
const ACTUATING = new Set(["move_to", "set_speed_limit", "stop", "reconcile_twin"]);

const fail = (check: GateCheck, reason: string): GateResult => ({ ok: false, check, reason });

export function evaluate(name: string, input: Record<string, unknown>, ctx: GateContext): GateResult {
  const { state } = ctx;

  // 1. Hallucination guard
  if (!(name in TOOL_ARGS)) return fail("hallucination", `unknown tool "${name}"`);
  const extra = Object.keys(input).filter((k) => !TOOL_ARGS[name].includes(k));
  if (extra.length) return fail("hallucination", `invented argument(s): ${extra.join(", ")}`);
  if (name === "move_to") {
    const st = findStation(String(input.station ?? ""));
    if (!st) {
      return fail("hallucination", `station "${input.station}" does not exist. Valid stations: ${STATIONS.map((s) => s.id).join(", ")}`);
    }
    if (Math.hypot(st.x - state.pose.x, st.y - state.pose.y) < 0.3) return fail("hallucination", `AGV is already at ${st.id}`);
  }
  if (name === "reconcile_twin" && !(state.fusion.state === "DISAGREE" && state.fusion.hint === "unmapped_obstacle")) {
    return fail("hallucination", `nothing to reconcile: fusion is ${state.fusion.state}${state.fusion.hint ? ` (${state.fusion.hint})` : ""}, not an unmapped obstacle`);
  }
  if (!ACTUATING.has(name)) return { ok: true };

  // 2. Operation guard
  if (name !== "stop" && !ctx.consultedManual) {
    return fail("operation", "consult the manual (search_manual) before issuing control commands");
  }
  if (MOTION.has(name)) {
    if (state.mode === "estop") return fail("operation", `E-STOP latched (${state.estopReason}). Only a human operator can reset it.`);
    if (state.telemetryAgeMs > LIMITS.telemetrySilenceMs) return fail("operation", `telemetry silent for ${Math.round(state.telemetryAgeMs)} ms; link presumed lost`);
    if (state.fusion.state === "DISAGREE") {
      return fail("operation", `sensor/twin DISAGREE (${state.fusion.hint}, offset ${state.fusion.offset.toFixed(2)} m). Motion blocked until resolved.`);
    }
  }

  // 3. Parameter validator
  switch (name) {
    case "stop":
      return { ok: true, command: { type: "stop", args: {} } };

    case "set_speed_limit": {
      const mps = Number(input.mps);
      if (!Number.isFinite(mps) || mps < LIMITS.minSpeed || mps > LIMITS.maxSpeed) {
        return fail("parameters", `speed limit must be between ${LIMITS.minSpeed} and ${LIMITS.maxSpeed} m/s, got ${input.mps}`);
      }
      return { ok: true, command: { type: "speed_limit", args: { mps } } };
    }

    case "move_to": {
      const st = findStation(String(input.station))!;
      const speed = input.speed === undefined ? LIMITS.defaultSpeed : Number(input.speed);
      if (!Number.isFinite(speed) || speed < LIMITS.minSpeed || speed > LIMITS.maxSpeed) {
        return fail("parameters", `speed must be between ${LIMITS.minSpeed} and ${LIMITS.maxSpeed} m/s, got ${input.speed}`);
      }
      const effective = Math.min(speed, state.speedLimit);
      if (inQcZone(st) && effective > LIMITS.qcZoneSpeed) {
        return fail("parameters", `${st.id} is inside the QC zone: speed must be <= ${LIMITS.qcZoneSpeed} m/s (requested ${effective} m/s)`);
      }
      const waypoints = planPath(state.pose, st, [...MACHINES, ...state.knownObstacles]);
      if (!waypoints) return fail("parameters", `no collision-free route to ${st.id} with the current twin map`);
      return { ok: true, command: { type: "goto", args: { station: st.id, speed: effective, waypoints: round(waypoints) } } };
    }

    case "reconcile_twin": {
      const { pose, fusion } = state;
      const reach = AGV.length / 2 + fusion.measured + 0.3; // nose → detected face → centre of a ~0.6 m object
      const rect = {
        id: `detected-${state.knownObstacles.length + 1}`,
        x: +(pose.x + Math.cos(pose.theta) * reach).toFixed(2),
        y: +(pose.y + Math.sin(pose.theta) * reach).toFixed(2),
        w: 0.6,
        h: 0.6,
      };
      return { ok: true, twinOp: { type: "add_obstacle", rect }, note: `added ${rect.id} at (${rect.x}, ${rect.y}) to the twin map` };
    }
  }
  return fail("hallucination", `unhandled tool "${name}"`);
}

/** Apply an accepted call to the agent's working copy of the state, so later calls in the same turn see it. */
export function applyToState(state: TwinSnapshot, result: GateResult): TwinSnapshot {
  if (!result.ok) return state;
  const s = { ...state };
  if (result.twinOp) {
    s.knownObstacles = [...s.knownObstacles, result.twinOp.rect];
    // The twin now predicts the object, so its expected reading matches the sensor again.
    s.fusion = { ...s.fusion, state: "AGREE", hint: null, offset: 0 };
  }
  const cmd = result.command;
  if (cmd?.type === "goto") { s.mode = "moving"; s.target = String(cmd.args.station); }
  if (cmd?.type === "stop") { s.mode = s.mode === "estop" ? "estop" : "idle"; s.target = null; }
  if (cmd?.type === "speed_limit") s.speedLimit = Number(cmd.args.mps);
  return s;
}

const round = (pts: Vec2[]) => pts.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) }));
