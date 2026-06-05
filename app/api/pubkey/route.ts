import { connection } from "next/server";
import { publicKeyX } from "@/lib/server/signing";

export async function GET() {
  await connection(); // read the key at request time, not baked in at build
  return Response.json({ x: publicKeyX() });
}
