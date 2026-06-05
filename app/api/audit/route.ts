import { connection } from "next/server";
import { appendAudit, readAudit, verifyAudit } from "@/lib/server/audit";

// GET: the latest entries plus a full-chain verification. POST: plant-side events
// (acks, E-STOPs, fusion changes) relayed by the browser so they land in the same chain.
export async function GET() {
  await connection(); // the log changes constantly; never prerender it
  const entries = readAudit();
  return Response.json({ total: entries.length, verify: verifyAudit(entries), entries: entries.slice(-60).reverse() });
}

const RELAYED = new Set(["plant.ack", "plant.estop", "fusion.change", "link.change", "world.event"]);

export async function POST(req: Request) {
  const { kind, data } = (await req.json()) as { kind: string; data: Record<string, unknown> };
  if (!RELAYED.has(kind)) return Response.json({ error: "kind not allowed" }, { status: 400 });
  return Response.json(appendAudit(kind, data));
}
