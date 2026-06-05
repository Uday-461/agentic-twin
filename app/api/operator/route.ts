import { appendAudit } from "@/lib/server/audit";
import { signCommand } from "@/lib/server/signing";

// Operator actions (E-STOP, reset) and the supervisor's automatic stop. Signed like everything
// else; reset is never available to the agent.
export async function POST(req: Request) {
  const { session, action, reason } = (await req.json()) as { session: string; action: "estop" | "reset" | "stop"; reason?: string };
  if (!["estop", "reset", "stop"].includes(action)) return Response.json({ error: "unknown action" }, { status: 400 });
  const issuedBy = action === "stop" ? "supervisor" : "operator";
  const { cmd, payload } = signCommand(session, action, {}, issuedBy);
  appendAudit("cmd.signed", { session, id: payload.id, type: action, issuedBy, ...(reason ? { reason } : {}) });
  return Response.json({ command: cmd });
}
