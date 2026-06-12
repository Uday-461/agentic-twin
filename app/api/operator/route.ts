import { planPath } from "@/lib/astar";
import type { Pose, Rect } from "@/lib/world";
import { LIMITS, MACHINES, findStation, inQcZone } from "@/lib/world";
import { appendAudit } from "@/lib/server/audit";
import { signCommand } from "@/lib/server/signing";

// Operator actions (E-STOP, reset, scenario setup moves) and the supervisor's automatic stop.
// Signed like everything else; reset is never available to the agent.
type Body = {
  session: string;
  action: "estop" | "reset" | "stop" | "reposition";
  reason?: string;
  station?: string;
  pose?: Pose;
  knownObstacles?: Rect[];
};

export async function POST(req: Request) {
  const { session, action, reason, station, pose, knownObstacles = [] } = (await req.json()) as Body;
  if (action === "reposition") {
    const st = findStation(station ?? "");
    if (!st || !pose) return Response.json({ error: "reposition needs a valid station and pose" }, { status: 400 });
    const waypoints = planPath(pose, st, [...MACHINES, ...knownObstacles]);
    if (!waypoints) return Response.json({ error: `no route to ${st.id}` }, { status: 409 });
    const speed = inQcZone(st) ? LIMITS.qcZoneSpeed : LIMITS.defaultSpeed;
    const { cmd, payload } = signCommand(session, "goto", { station: st.id, speed, waypoints }, "operator");
    appendAudit("cmd.signed", { session, id: payload.id, type: "goto", args: { station: st.id, speed }, issuedBy: "operator", reason: "scenario setup" });
    return Response.json({ command: cmd });
  }
  if (!["estop", "reset", "stop"].includes(action)) return Response.json({ error: "unknown action" }, { status: 400 });
  const issuedBy = action === "stop" ? "supervisor" : "operator";
  const { cmd, payload } = signCommand(session, action as "estop" | "reset" | "stop", {}, issuedBy);
  appendAudit("cmd.signed", { session, id: payload.id, type: action, issuedBy, ...(reason ? { reason } : {}) });
  return Response.json({ command: cmd });
}
