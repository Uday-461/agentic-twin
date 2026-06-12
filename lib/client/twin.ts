"use client";

import { connectBest, type Bus, type Transport } from "../bus";
import { FusionMonitor, type FusionSnapshot } from "../fusion";
import { forwardRange, raycast } from "../geometry";
import { topic, type Ack, type SignedCommand, type Telemetry, type TwinOp, type TwinSnapshot, type WorldEvent } from "../protocol";
import type { AgentReply } from "../server/agent";
import { AGV, LIMITS, MACHINES, START_POSE, type Rect } from "../world";
import type { ScenarioView } from "./scenarios";

// The supervisor side of the twin, running in the page: heartbeats to the plant, telemetry
// in, the twin's own sensor prediction, the cross-check, and link-silence detection.

export type LogLine = { t: number; level: "info" | "warn" | "error"; text: string };
export type Sample = { t: number; measured: number; expected: number };

export type ViewMode = "reality" | "split" | "twin";
export type CameraMode = "overview" | "follow" | "top" | "free";

/** Short-lived visual events the 3D scene animates, then drops after a few seconds. */
export type Fx =
  | { kind: "packet"; t: number; id: string; type: string }
  | { kind: "ack"; t: number; ok: boolean }
  | { kind: "ghost"; t: number; waypoints: { x: number; y: number }[]; label: string }
  | { kind: "reject"; t: number; label: string };

const FX_TTL_MS = 5000;

const LIDAR_RAYS = 48;

export class TwinController {
  readonly session = Math.random().toString(36).slice(2, 10);
  transport: Transport | "connecting" = "connecting";
  telemetry: Telemetry | null = null;
  lastTelemetryAt = 0;
  linkDown = false;
  linkLost = false;
  fusion: FusionSnapshot;
  knownObstacles: Rect[] = [];
  physicalObstacles: Rect[] = [];
  sensorBias = 0;
  lidar: number[] = [];
  history: Sample[] = [];
  log: LogLine[] = [];
  version = 0;

  // View state shared by the HUD and the 3D scene.
  view: ViewMode = "split";
  cam: CameraMode = "overview";
  focusId: string | null = null;
  fx: Fx[] = [];
  /** Text for the chat box: clicking a station prefills it; scenarios also send it. */
  draft = { text: "", n: 0, send: false };
  agentBusy = false;
  agentReplies = 0;
  lastReply: AgentReply | null = null;
  /** Set by the scenario runner (lib/client/scenarios.ts); read by the HUD. */
  scenario: ScenarioView | null = null;

  private bus?: Bus;
  private worker?: Worker;
  private heartbeat?: Worker;
  private monitor = new FusionMonitor();
  private listeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor() {
    this.fusion = this.monitor.snapshot();
  }

  async start() {
    const { x } = await (await fetch("/api/pubkey")).json();
    const url = process.env.NEXT_PUBLIC_MQTT_URL ?? "ws://localhost:9001";
    this.bus = await connectBest(url, this.session);
    this.transport = this.bus.transport;
    this.note(this.bus.transport === "mqtt" ? `Connected to Mosquitto at ${url}` : `Broker unreachable at ${url}; using in-browser bus`, this.bus.transport === "mqtt" ? "info" : "warn");

    this.worker = new Worker(new URL("../plant/plant.worker.ts", import.meta.url), { type: "module" });
    this.worker.postMessage({ session: this.session, transport: this.bus.transport, url, publicKeyX: x });

    this.heartbeat = new Worker(new URL("./heartbeat.worker.ts", import.meta.url), { type: "module" });
    this.heartbeat.postMessage({ session: this.session, transport: this.bus.transport, url });

    this.bus.subscribe(topic(this.session, "telemetry"), (_t, m) => this.onTelemetry(m as Telemetry));
    this.bus.subscribe(topic(this.session, "ack"), (_t, m) => this.onAck(m as Ack));
    this.timers.push(setInterval(() => this.checkSilence(), 100));
    this.emit();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.worker?.terminate();
    this.heartbeat?.terminate();
    this.bus?.close();
  }

  // ---- React binding (useSyncExternalStore) ----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private emit() { this.version++; this.listeners.forEach((fn) => fn()); }

  // ---- inbound ----
  private onTelemetry(t: Telemetry) {
    if (this.linkDown) return; // simulated link loss drops everything in flight
    const prev = this.telemetry;
    this.telemetry = t;
    this.lastTelemetryAt = Date.now();

    const map = [...MACHINES, ...this.knownObstacles];
    const expected = forwardRange(t.pose, map, LIMITS.sensorMax);
    const before = this.fusion.state;
    this.fusion = this.monitor.update(t.ultrasonic, expected);
    if (this.fusion.state !== before) {
      this.note(`Sensor/twin cross-check: ${before} → ${this.fusion.state}${this.fusion.hint ? ` (${this.fusion.hint})` : ""}`, this.fusion.state === "DISAGREE" ? "warn" : "info");
      this.audit("fusion.change", { from: before, to: this.fusion.state, hint: this.fusion.hint, offset: +this.fusion.offset.toFixed(3) });
      // The gate only screens new commands; a route already in flight must be halted here.
      if (this.fusion.state === "DISAGREE" && t.mode === "moving") {
        this.note("Supervisor halted the AGV: sensor/twin disagreement during motion", "error");
        void this.command("stop", `cross-check DISAGREE (${this.fusion.hint})`);
      }
    }
    this.lidar = Array.from({ length: LIDAR_RAYS }, (_, i) =>
      raycast(t.pose, t.pose.theta + (i / LIDAR_RAYS) * 2 * Math.PI, map, LIMITS.sensorMax));
    this.history.push({ t: t.t, measured: t.ultrasonic, expected });
    if (this.history.length > 150) this.history.shift();

    if (prev?.mode !== t.mode) {
      if (t.mode === "estop") {
        this.note(`E-STOP: ${t.estopReason}`, "error");
        this.cam = "follow";
        this.audit("plant.estop", { reason: t.estopReason });
      } else if (t.mode === "blocked") {
        this.note("AGV stopped: obstacle within 0.5 m", "warn");
      } else if (prev?.mode === "moving" && t.mode === "idle") {
        this.note("AGV arrived / idle");
      }
    }
    this.emit();
  }

  private onAck(a: Ack) {
    if (this.linkDown) return;
    this.note(`Plant ${a.status} ${a.type} ${a.cmdId.slice(0, 8)}${a.reason ? `: ${a.reason}` : ""}`, a.status === "rejected" ? "warn" : "info");
    this.audit("plant.ack", { ...a });
    this.pushFx({ kind: "ack", t: Date.now(), ok: a.status === "executed" });
  }

  private checkSilence() {
    const lost = this.lastTelemetryAt > 0 && Date.now() - this.lastTelemetryAt > LIMITS.telemetrySilenceMs;
    if (lost !== this.linkLost) {
      this.linkLost = lost;
      this.note(lost ? `Telemetry silent > ${LIMITS.telemetrySilenceMs} ms: link lost, motion commands blocked` : "Telemetry resumed", lost ? "error" : "info");
      this.audit("link.change", { lost });
      this.emit();
    }
  }

  // ---- outbound ----
  dispatch(commands: SignedCommand[]) {
    for (const c of commands) {
      this.bus?.publish(topic(this.session, "cmd"), c);
      const p = JSON.parse(c.payload) as { id: string; type: string };
      this.pushFx({ kind: "packet", t: Date.now(), id: p.id, type: p.type });
    }
  }

  pushFx(fx: Fx) {
    const now = Date.now();
    this.fx = [...this.fx.filter((f) => now - f.t < FX_TTL_MS), fx];
    this.emit();
  }

  setView(v: ViewMode) { this.view = v; this.emit(); }
  setCam(c: CameraMode) { this.cam = c; this.focusId = null; this.emit(); }
  focus(id: string | null) { this.focusId = id; this.cam = "free"; this.emit(); }
  setDraft(text: string, send = false) { this.draft = { text, n: this.draft.n + 1, send }; this.emit(); }
  setAgentBusy(busy: boolean) { this.agentBusy = busy; this.emit(); }
  recordReply(r: AgentReply | null) { this.lastReply = r; this.agentReplies++; this.agentBusy = false; this.emit(); }
  setScenario(v: ScenarioView | null) { this.scenario = v; this.emit(); }

  /** Operator-signed setup move used by scenarios to start from a known station. */
  async reposition(station: string) {
    const res = await fetch("/api/operator", {
      method: "POST",
      body: JSON.stringify({ session: this.session, action: "reposition", station, pose: this.snapshot().pose, knownObstacles: this.knownObstacles }),
    });
    const { command, error } = await res.json();
    if (error) throw new Error(error);
    this.dispatch([command]);
  }

  /** Resolve true when `pred` holds, false on timeout. */
  waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const id = setInterval(() => {
        if (pred()) { clearInterval(id); resolve(true); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(id); resolve(false); }
      }, 100);
    });
  }

  applyTwinOps(ops: TwinOp[]) {
    for (const op of ops) {
      if (op.type === "add_obstacle") {
        this.knownObstacles.push(op.rect);
        this.note(`Twin map updated: ${op.rect.id} at (${op.rect.x}, ${op.rect.y})`);
      }
    }
    this.emit();
  }

  async command(action: "estop" | "reset" | "stop", reason?: string) {
    const res = await fetch("/api/operator", { method: "POST", body: JSON.stringify({ session: this.session, action, reason }) });
    const { command } = await res.json();
    this.dispatch([command]);
  }

  /** Physical-world events (injector panel). These happen on the floor, not over the control link. */
  world(ev: WorldEvent) {
    if (ev.kind === "add_obstacle") this.physicalObstacles.push(ev.rect);
    if (ev.kind === "clear_obstacles") { this.physicalObstacles = []; this.knownObstacles = []; }
    if (ev.kind === "sensor_bias") this.sensorBias = ev.metres;
    this.bus?.publish(topic(this.session, "world"), ev);
    this.audit("world.event", ev as unknown as Record<string, unknown>);
    this.note(describe(ev), "warn");
    this.emit();
  }

  /** Injector: drop a crate 1.8 m ahead along the current route (or straight ahead when idle). */
  dropCrateAhead() {
    const t = this.telemetry;
    if (!t) return;
    let p = { x: t.pose.x, y: t.pose.y };
    let left = 1.8;
    for (const wp of t.route) {
      const d = Math.hypot(wp.x - p.x, wp.y - p.y);
      if (d >= left) { p = { x: p.x + ((wp.x - p.x) * left) / d, y: p.y + ((wp.y - p.y) * left) / d }; left = 0; break; }
      left -= d;
      p = wp;
    }
    if (left > 0) {
      const reach = AGV.length / 2 + 1.4;
      p = { x: t.pose.x + Math.cos(t.pose.theta) * reach, y: t.pose.y + Math.sin(t.pose.theta) * reach };
    }
    this.world({ kind: "add_obstacle", rect: { id: `crate-${Date.now() % 100000}`, x: +p.x.toFixed(2), y: +p.y.toFixed(2), w: 0.6, h: 0.6 } });
  }

  setLinkDown(down: boolean) {
    this.linkDown = down;
    this.heartbeat?.postMessage({ paused: down });
    this.note(down ? "Control link cut (simulated)" : "Control link restored", down ? "warn" : "info");
    this.emit();
  }

  snapshot(): TwinSnapshot {
    const t = this.telemetry;
    return {
      pose: t?.pose ?? START_POSE,
      mode: t?.mode ?? "idle",
      estopReason: t?.estopReason ?? null,
      speedLimit: t?.speedLimit ?? LIMITS.maxSpeed,
      target: t?.target ?? null,
      telemetryAgeMs: this.lastTelemetryAt ? Date.now() - this.lastTelemetryAt : 1e9, // JSON has no Infinity
      fusion: this.fusion,
      knownObstacles: this.knownObstacles,
    };
  }

  note(text: string, level: LogLine["level"] = "info") {
    this.log.push({ t: Date.now(), level, text });
    if (this.log.length > 80) this.log.shift();
  }

  private audit(kind: string, data: Record<string, unknown>) {
    void fetch("/api/audit", { method: "POST", body: JSON.stringify({ kind, data: { session: this.session, ...data } }) }).catch(() => {});
  }
}

function describe(ev: WorldEvent): string {
  if (ev.kind === "add_obstacle") return `Physical obstacle placed at (${ev.rect.x.toFixed(1)}, ${ev.rect.y.toFixed(1)}), unknown to the twin`;
  if (ev.kind === "clear_obstacles") return "Floor cleared, twin map reset";
  return ev.metres ? `Sensor fault injected: +${ev.metres} m bias` : "Sensor fault cleared";
}
