"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TwinController } from "@/lib/client/twin";
import { AGV, LIMITS } from "@/lib/world";
import Chat from "./Chat";

const Scene = dynamic(() => import("./Scene"), { ssr: false });

export default function App() {
  const [ctrl, setCtrl] = useState<TwinController | null>(null);
  useEffect(() => {
    const c = new TwinController();
    let cancelled = false; // React dev mode mounts twice; don't leak the first plant worker
    void c.start().then(() => (cancelled ? c.stop() : setCtrl(c)));
    return () => { cancelled = true; c.stop(); };
  }, []);
  if (!ctrl) return <div className="loading">Starting plant, broker link and twin…</div>;
  return <Dashboard ctrl={ctrl} />;
}

function Dashboard({ ctrl }: { ctrl: TwinController }) {
  useSyncExternalStore(ctrl.subscribe, ctrl.getVersion, ctrl.getVersion);
  const t = ctrl.telemetry;
  const mode = t?.mode ?? "idle";
  return (
    <div className="layout">
      <header>
        <h1>Agentic Twin <span>AGV-01 · assembly floor</span></h1>
        <div className="badges">
          <Badge label="Bus" value={ctrl.transport === "mqtt" ? "MQTT · Mosquitto" : ctrl.transport === "local" ? "local (no broker)" : "…"} tone={ctrl.transport === "mqtt" ? "ok" : "warn"} />
          <Badge label="Plant" value={ctrl.linkLost ? "NO TELEMETRY" : mode.toUpperCase()} tone={ctrl.linkLost || mode === "estop" ? "bad" : mode === "blocked" ? "warn" : "ok"} />
          <Badge label="Cross-check" value={ctrl.fusion.state} tone={ctrl.fusion.state === "DISAGREE" ? "bad" : "ok"} />
          <Badge label="Link" value={ctrl.linkLost ? "LOST" : "OK"} tone={ctrl.linkLost ? "bad" : "ok"} />
        </div>
        <div className="estop">
          <button className="btn-estop" onClick={() => void ctrl.command("estop")}>E-STOP</button>
          <button className="btn-reset" disabled={mode !== "estop"} onClick={() => void ctrl.command("reset")}>Reset</button>
        </div>
      </header>

      <aside className="left"><Chat ctrl={ctrl} /></aside>

      <main className="center">
        <Scene ctrl={ctrl} />
        <div className="hud">
          {t ? <>x {t.pose.x.toFixed(2)} · y {t.pose.y.toFixed(2)} · θ {((t.pose.theta * 180) / Math.PI).toFixed(0)}° · v {t.v.toFixed(2)} m/s · limit {t.speedLimit} m/s{t.target ? ` · → ${t.target}` : ""}</> : "waiting for telemetry…"}
          {t?.estopReason && <div className="hud-estop">E-STOP: {t.estopReason}</div>}
        </div>
      </main>

      <aside className="right">
        <Panel title="Fault injection">
          <Injector ctrl={ctrl} />
        </Panel>
        <Panel title="Ultrasonic (plant) vs LiDAR (twin)">
          <SensorChart ctrl={ctrl} />
        </Panel>
        <Panel title="Events"><EventLog ctrl={ctrl} /></Panel>
        <Panel title="Audit chain"><Audit /></Panel>
      </aside>
    </div>
  );
}

function Badge({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "bad" }) {
  return <div className={`badge ${tone}`}><span>{label}</span>{value}</div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}

function Injector({ ctrl }: { ctrl: TwinController }) {
  function dropCrate() {
    const t = ctrl.telemetry;
    if (!t) return;
    // 1.8 m ahead along the current route, or straight ahead when idle.
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
    ctrl.world({ kind: "add_obstacle", rect: { id: `crate-${Date.now() % 100000}`, x: p.x, y: p.y, w: 0.6, h: 0.6 } });
  }
  return (
    <div className="injector">
      <button onClick={dropCrate}>Drop crate in path</button>
      <button className={ctrl.sensorBias ? "on" : ""} onClick={() => ctrl.world({ kind: "sensor_bias", metres: ctrl.sensorBias ? 0 : 1.0 })}>
        {ctrl.sensorBias ? "Clear sensor fault" : "Sensor fault (+1.0 m)"}
      </button>
      <button className={ctrl.linkDown ? "on" : ""} onClick={() => ctrl.setLinkDown(!ctrl.linkDown)}>
        {ctrl.linkDown ? "Restore control link" : "Cut control link"}
      </button>
      <button onClick={() => ctrl.world({ kind: "clear_obstacles" })}>Clear floor</button>
      <p className="small">Watchdog trips after {LIMITS.watchdogMs} ms without a heartbeat. Orange crates are physical; cyan wireframes are what the twin knows.</p>
    </div>
  );
}

function SensorChart({ ctrl }: { ctrl: TwinController }) {
  const W = 300, H = 90, max = LIMITS.sensorMax;
  const h = ctrl.history;
  const line = (key: "measured" | "expected") =>
    h.map((s, i) => `${((i / Math.max(1, h.length - 1)) * W).toFixed(1)},${(H - (s[key] / max) * H).toFixed(1)}`).join(" ");
  const f = ctrl.fusion;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart">
        <polyline points={line("expected")} className="expected" />
        <polyline points={line("measured")} className="measured" />
      </svg>
      <div className="legend">
        <span className="measured">measured {Number.isFinite(f.measured) ? f.measured.toFixed(2) : "–"} m</span>
        <span className="expected">twin {Number.isFinite(f.expected) ? f.expected.toFixed(2) : "–"} m</span>
        <span>frames A/D/S {f.frames.agree}/{f.frames.disagree}/{f.frames.skip}</span>
      </div>
      {f.hint && <div className={`diag ${f.hint}`}>{f.hint === "unmapped_obstacle" ? "Sensor sees something the twin map doesn't. Ask the agent to reconcile." : "Sensor reads farther than a mapped surface: sensor fault. Motion blocked."}</div>}
    </div>
  );
}

function EventLog({ ctrl }: { ctrl: TwinController }) {
  return (
    <ul className="events">
      {ctrl.log.slice(-14).reverse().map((l, i) => (
        <li key={i} className={l.level}><time>{new Date(l.t).toLocaleTimeString()}</time>{l.text}</li>
      ))}
    </ul>
  );
}

type AuditView = { total: number; verify: { ok: boolean; brokenAt: number | null }; entries: { seq: number; kind: string; hash: string; data: Record<string, unknown> }[] };

function Audit() {
  const [a, setA] = useState<AuditView | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/audit").then((r) => r.json()).then(setA).catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);
  if (!a) return <div className="small">loading…</div>;
  return (
    <div>
      <div className={`chain ${a.verify.ok ? "ok" : "bad"}`}>
        {a.verify.ok ? `✓ chain intact · ${a.total} entries` : `✗ chain broken at #${a.verify.brokenAt}`}
      </div>
      <ul className="audit">
        {a.entries.slice(0, 12).map((e) => (
          <li key={e.seq}>
            <span className="seq">#{e.seq}</span>
            <span className={`kind ${e.kind.split(".")[0]}`}>{e.kind}</span>
            <span className="detail">{summary(e.kind, e.data)}</span>
            <code>{e.hash.slice(0, 8)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function summary(kind: string, d: Record<string, unknown>): string {
  if (kind === "gate.reject") return `${d.tool}: ${d.reason}`;
  if (kind === "gate.pass") return `${d.tool} ${JSON.stringify(d.input)}`;
  if (kind === "cmd.signed") return `${d.type} by ${d.issuedBy} ${d.args ? JSON.stringify(d.args) : ""}`;
  if (kind === "plant.ack") return `${d.status} ${d.type}${d.reason ? `: ${d.reason}` : ""}`;
  if (kind === "agent.request") return String(d.prompt);
  if (kind === "agent.reply") return String(d.reply).slice(0, 80);
  if (kind === "fusion.change") return `${d.from} → ${d.to}${d.hint ? ` (${d.hint})` : ""}`;
  if (kind === "plant.estop") return String(d.reason);
  if (kind === "link.change") return d.lost ? "telemetry lost" : "telemetry resumed";
  return JSON.stringify(d).slice(0, 80);
}
