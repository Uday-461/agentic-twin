// Creates .env.local with a fresh Ed25519 signing key (and placeholders) if it doesn't exist.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = ".env.local";
const current = existsSync(file) ? readFileSync(file, "utf8") : "";
const lines = [];
if (!/^ED25519_PRIVATE_KEY=/m.test(current)) {
  const { privateKey } = generateKeyPairSync("ed25519");
  lines.push(`ED25519_PRIVATE_KEY=${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`);
}
if (!/^AGENT_MODEL=/m.test(current)) lines.push("AGENT_MODEL=deepseek/deepseek-v4.1-flash");
if (!/^NEXT_PUBLIC_MQTT_URL=/m.test(current)) lines.push("NEXT_PUBLIC_MQTT_URL=ws://localhost:9001");
if (!/OPENROUTER_API_KEY=/m.test(current)) lines.push("# OPENROUTER_API_KEY=sk-or-...   (unset = offline mock planner)");
if (lines.length) writeFileSync(file, (current && !current.endsWith("\n") ? current + "\n" : current) + lines.join("\n") + "\n");
console.log(lines.length ? `.env.local: added ${lines.length} line(s)` : ".env.local already complete");
