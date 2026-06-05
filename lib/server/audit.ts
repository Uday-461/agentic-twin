import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Append-only, hash-chained audit log. Each entry carries the hash of the previous one, so
// editing or deleting any line breaks every hash after it.

export type AuditEntry = {
  seq: number;
  ts: number;
  kind: string;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
};

const GENESIS = "0".repeat(64);

export function auditPath(): string {
  return process.env.AUDIT_LOG_PATH ?? path.join(process.cwd(), "data", "audit.jsonl");
}

function hashOf(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify([e.seq, e.ts, e.kind, e.data, e.prev])).digest("hex");
}

export function readAudit(file = auditPath()): AuditEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Survives Next dev hot reloads, so the chain head isn't re-read on every request.
const g = globalThis as unknown as { __auditHead?: Map<string, { seq: number; hash: string }> };
g.__auditHead ??= new Map();

export function appendAudit(kind: string, data: Record<string, unknown>, file = auditPath()): AuditEntry {
  let head = g.__auditHead!.get(file);
  if (!head) {
    const last = readAudit(file).at(-1);
    head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
  }
  const base = { seq: head.seq + 1, ts: Date.now(), kind, data, prev: head.hash };
  const entry: AuditEntry = { ...base, hash: hashOf(base) };
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
  g.__auditHead!.set(file, { seq: entry.seq, hash: entry.hash });
  return entry;
}

export function verifyAudit(entries: AuditEntry[]): { ok: boolean; brokenAt: number | null } {
  let prev = GENESIS;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.prev !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true, brokenAt: null };
}
