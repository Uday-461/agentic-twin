import { modelId, runAgent, type ChatTurn } from "@/lib/server/agent";
import type { TwinSnapshot } from "@/lib/protocol";

export async function POST(req: Request) {
  const { session, history, state } = (await req.json()) as { session: string; history: ChatTurn[]; state: TwinSnapshot };
  try {
    return Response.json(await runAgent(session, history, state));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}

export async function GET() {
  return Response.json({ model: modelId() });
}
