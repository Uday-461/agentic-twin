import { generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planPath } from "@/lib/astar";
import { FusionMonitor } from "@/lib/fusion";
import { segmentHitsRect } from "@/lib/geometry";
import type { TwinSnapshot } from "@/lib/protocol";
import { appendAudit, readAudit, verifyAudit } from "@/lib/server/audit";
import { unbackedMotionClaims } from "@/lib/server/agent";
import { applyToState, evaluate } from "@/lib/server/gate";
import { searchManual } from "@/lib/server/rag";
import { publicKeyX, signCommand } from "@/lib/server/signing";
import { AGV, MACHINES, START_POSE, findStation } from "@/lib/world";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.ED25519_PRIVATE_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
});

const fusion = new FusionMonitor().snapshot();
const base: TwinSnapshot = {
  pose: START_POSE, mode: "idle", estopReason: null, speedLimit: 1.2, target: null,
  telemetryAgeMs: 100, fusion: { ...fusion, state: "AGREE" }, knownObstacles: [],
};
const ctx = (state: Partial<TwinSnapshot> = {}, consultedManual = true) => ({ state: { ...base, ...state }, consultedManual });

describe("gate: hallucination guard", () => {
  it("rejects a station that does not exist and lists the real ones", () => {
    const r = evaluate("move_to", { station: "PAINT_SHOP" }, ctx());
    expect(r).toMatchObject({ ok: false, check: "hallucination" });
    expect(!r.ok && r.reason).toContain("QC");
  });
  it("rejects invented arguments and unknown tools", () => {
    expect(evaluate("move_to", { station: "QC", turbo: true }, ctx())).toMatchObject({ ok: false, check: "hallucination" });
    expect(evaluate("teleport", {}, ctx())).toMatchObject({ ok: false, check: "hallucination" });
  });
  it("rejects reconcile when the cross-check has nothing to reconcile", () => {
    expect(evaluate("reconcile_twin", {}, ctx())).toMatchObject({ ok: false, check: "hallucination" });
  });
});

describe("gate: operation guard", () => {
  it("requires the manual to be consulted before control", () => {
    expect(evaluate("move_to", { station: "SHIPPING" }, ctx({}, false))).toMatchObject({ ok: false, check: "operation" });
    expect(evaluate("stop", {}, ctx({}, false))).toMatchObject({ ok: true });
  });
  it("blocks motion under E-STOP, link loss and sensor disagreement", () => {
    expect(evaluate("move_to", { station: "SHIPPING" }, ctx({ mode: "estop", estopReason: "x" }))).toMatchObject({ ok: false, check: "operation" });
    expect(evaluate("move_to", { station: "SHIPPING" }, ctx({ telemetryAgeMs: 900 }))).toMatchObject({ ok: false, check: "operation" });
    const disagree = { ...fusion, state: "DISAGREE" as const, hint: "sensor_fault" as const };
    expect(evaluate("move_to", { station: "SHIPPING" }, ctx({ fusion: disagree }))).toMatchObject({ ok: false, check: "operation" });
  });
});

describe("gate: parameter validator", () => {
  it("enforces the QC zone speed limit, and accepts a compliant speed", () => {
    expect(evaluate("move_to", { station: "QC", speed: 1.0 }, ctx())).toMatchObject({ ok: false, check: "parameters" });
    const ok = evaluate("move_to", { station: "QC", speed: 0.4 }, ctx());
    expect(ok.ok && ok.command?.type).toBe("goto");
  });
  it("counts the fleet limit toward the QC rule", () => {
    expect(evaluate("move_to", { station: "QC" }, ctx({ speedLimit: 0.5 })).ok).toBe(true);
  });
  it("rejects out-of-range speeds", () => {
    expect(evaluate("set_speed_limit", { mps: 3 }, ctx())).toMatchObject({ ok: false, check: "parameters" });
    expect(evaluate("move_to", { station: "SHIPPING", speed: -1 }, ctx())).toMatchObject({ ok: false, check: "parameters" });
  });
  it("reconcile adds the detected object and clears the disagreement in the working state", () => {
    const pose = { x: 10, y: 3, theta: 0 };
    const d = { ...fusion, state: "DISAGREE" as const, hint: "unmapped_obstacle" as const, measured: 1, offset: -2 };
    const r = evaluate("reconcile_twin", {}, ctx({ pose, fusion: d }));
    expect(r.ok && r.twinOp?.rect.x).toBeCloseTo(10 + AGV.length / 2 + 1.3, 1);
    const s = applyToState({ ...base, pose, fusion: d }, r);
    expect(s.fusion.state).toBe("AGREE");
    expect(s.knownObstacles).toHaveLength(1);
  });
});

describe("planner", () => {
  it("finds a collision-free route around machines and pillars", () => {
    const goal = findStation("ASSEMBLY_B")!;
    const route = planPath(START_POSE, goal, MACHINES)!;
    expect(route.at(-1)).toEqual(goal);
    for (let i = 0; i < route.length - 1; i++) {
      for (const m of MACHINES) expect(segmentHitsRect(route[i], route[i + 1], AGV.radius, m)).toBe(false);
    }
  });
  it("routes around a newly known obstacle on the direct line", () => {
    const crate = { id: "c", x: 10, y: 3.3, w: 0.6, h: 0.6 };
    const route = planPath({ x: 3, y: 3.3 }, findStation("SHIPPING")!, [...MACHINES, crate])!;
    expect(route.length).toBeGreaterThan(2);
    for (let i = 0; i < route.length - 1; i++) expect(segmentHitsRect(route[i], route[i + 1], AGV.radius, crate)).toBe(false);
  });
});

describe("fusion monitor", () => {
  it("goes SKIP → DISAGREE → AGREE with hysteresis and diagnoses the cause", () => {
    const m = new FusionMonitor();
    expect(m.update(4, 4).state).toBe("SKIP");
    m.update(1.0, 3.0);
    m.update(1.0, 3.0);
    const d = m.update(1.0, 3.0);
    expect(d).toMatchObject({ state: "DISAGREE", hint: "unmapped_obstacle" });
    for (let i = 0; i < 4; i++) expect(m.update(1.0, 1.05).state).toBe("DISAGREE");
    expect(m.update(1.0, 1.05).state).toBe("AGREE");
  });
  it("flags a sensor reading farther than a mapped wall as a sensor fault", () => {
    const m = new FusionMonitor();
    for (let i = 0; i < 3; i++) m.update(3.0, 2.0);
    expect(m.snapshot().hint).toBe("sensor_fault");
  });
});

describe("signed commands", () => {
  async function verify(payload: string, sig: string) {
    const key = await webcrypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKeyX() }, { name: "Ed25519" }, false, ["verify"]);
    return webcrypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(sig, "base64"), new TextEncoder().encode(payload));
  }
  it("verifies with the public key, fails if the payload is tampered", async () => {
    const { cmd, payload } = signCommand("s1", "goto", { station: "QC" }, "agent");
    expect(payload.exp - payload.iat).toBe(15_000);
    expect(await verify(cmd.payload, cmd.sig)).toBe(true);
    expect(await verify(cmd.payload.replace("QC", "SHIPPING"), cmd.sig)).toBe(false);
  });
});

describe("audit chain", () => {
  it("detects an edited entry", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "audit-")), "a.jsonl");
    appendAudit("cmd.signed", { type: "goto" }, file);
    appendAudit("plant.ack", { status: "executed" }, file);
    appendAudit("agent.reply", { reply: "ok" }, file);
    expect(verifyAudit(readAudit(file))).toEqual({ ok: true, brokenAt: null });
    writeFileSync(file, readFileSync(file, "utf8").replace("executed", "rejected"));
    expect(verifyAudit(readAudit(file))).toEqual({ ok: false, brokenAt: 2 });
  });
});

describe("manual retrieval", () => {
  it("finds the QC speed rule and the sensor fault procedure", () => {
    expect(searchManual("QC speed limit")[0].text).toContain("0.5 m/s");
    expect(searchManual("sensor reads farther fault").map((h) => h.heading)).toContain("Sensor cross-validation (digital twin)");
  });
});

describe("reply hallucination check", () => {
  it("flags a claimed destination with no command behind it", () => {
    expect(unbackedMotionClaims("AGV-01 is heading to QC now.", [], null)).toEqual(["QC"]);
  });
  it("ignores stations mentioned as the current location", () => {
    const reply = "AGV-01 is dispatched to ASSEMBLY_A at 0.8 m/s (it was idle at the Receiving area).";
    expect(unbackedMotionClaims(reply, [{ station: "ASSEMBLY_A" }], null)).toEqual([]);
  });
});
