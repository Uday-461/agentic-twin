import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import type { CommandPayload, CommandType, SignedCommand } from "../protocol";
import { LIMITS } from "../world";

// Ed25519: the server holds the private key; the plant only needs the public key, so a
// compromised plant (or anyone reading the browser) can verify commands but never forge them.

let cached: KeyObject | null = null;

function privateKey(): KeyObject {
  if (cached) return cached;
  const der = process.env.ED25519_PRIVATE_KEY;
  if (!der) throw new Error("ED25519_PRIVATE_KEY missing. Run `npm run setup` to generate .env.local.");
  cached = createPrivateKey({ key: Buffer.from(der, "base64"), format: "der", type: "pkcs8" });
  return cached;
}

/** Raw public key as base64url, the `x` of an OKP JWK. */
export function publicKeyX(): string {
  const jwk = createPublicKey(privateKey()).export({ format: "jwk" });
  return jwk.x!;
}

export function signCommand(
  session: string,
  type: CommandType,
  args: Record<string, unknown>,
  issuedBy: CommandPayload["issuedBy"],
): { cmd: SignedCommand; payload: CommandPayload } {
  const iat = Date.now();
  const payload: CommandPayload = { id: randomUUID(), session, type, args, issuedBy, iat, exp: iat + LIMITS.commandTtlMs };
  const json = JSON.stringify(payload);
  const sig = sign(null, Buffer.from(json), privateKey()).toString("base64");
  return { cmd: { payload: json, sig }, payload };
}
