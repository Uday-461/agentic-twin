"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TwinController, type CameraMode, type ViewMode } from "@/lib/client/twin";
import { AGV, LIMITS, MACHINES, STATIONS } from "@/lib/world";
import Chat from "./Chat";

const Scene = dynamic(() => import("./Scene"), { ssr: false });

export default function App() {
  const [ctrl, setCtrl] = useState<TwinController | null>(null);
  useEffect(() => {
    const c = new TwinController();
    let cancelled = false; // React dev mode mounts twice; don't leak the first plant worker
    // Fonts must be ready before the 3D labels are painted to canvas.
    void Promise.all([c.start(), document.fonts.ready]).then(() => (cancelled ? c.stop() : setCtrl(c)));
    return () => { cancelled = true; c.stop(); };
  }, []);
  if (!ctrl) return <Boot />;
  return <Dashboard ctrl={ctrl} />;
}

function Boot() {
  return (
    <div className="boot">
      <div className="boot-mark">AGENTIC<span>TWIN</span></div>
      <div className="boot-line">Arming plant · binding broker · loading twin…</div>
      <div className="boot-bar"><i /></div>
    </div>
  );
}

function Dashboard({ ctrl }: { ctrl: TwinController }) {
  useSyncExternalStore(ctrl.subscribe, ctrl.getVersion, ctrl.getVersion);
  const t = ctrl.telemetry;
  const mode = ctrl.linkLost ? "no telemetry" : (t?.mode ?? "idle");
  const estop = t?.mode === "estop";
  const disagree = ctrl.fusion.state === "DISAGREE";

  return (
    <div className={`stage ${estop ? "is-estop" : ""} ${disagree ? "is-disagree" : ""} ${ctrl.linkLost ? "is-linklost" : ""} view-${ctrl.view}`}>
      <div className="canvas-wrap"><Scene ctrl={ctrl} /></div>
      <div className="alarm-edge" />
      <div className="grain" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-tab" />
          <div>
            <div className="brand-name">AGENTIC <b>TWIN</b></div>
            <div className="brand-sub">AGV-01 · Assembly floor · session {ctrl.session}</div>
          </div>
        </div>
        <div className="chips">
          <Chip k="Bus" v={ctrl.transport === "mqtt" ? "MQTT · Mosquitto" : ctrl.transport === "local" ? "Local bus" : "…"} tone={ctrl.transport === "mqtt" ? "ok" : "warn"} />
          <Chip k="Plant" v={mode} tone={estop || ctrl.linkLost ? "bad" : mode === "blocked" ? "warn" : mode === "moving" ? "live" : "ok"} />
          <Chip k="Cross-check" v={ctrl.fusion.state} tone={disagree ? "bad" : "ok"} />
          <Chip k="Link" v={ctrl.linkLost ? "Lost" : "Nominal"} tone={ctrl.linkLost ? "bad" : "ok"} />
        </div>
        <div className="estop-group">
          <button className="reset" disabled={!estop} onClick={() => void ctrl.command("reset")}>Reset</button>
          <button className="estop" onClick={() => void ctrl.command("estop")} aria-label="Emergency stop">
            <span>E-STOP</span>
          </button>
        </div>
      </header>

      {estop && <div className="banner bad">E-STOP LATCHED · {t?.estopReason} · operator reset required</div>}
      {!estop && disagree && (
        <div className="banner warn">
          CROSS-CHECK DISAGREE · {ctrl.fusion.hint === "unmapped_obstacle" ? "unmapped object ahead, reconcile the twin" : "sensor fault, motion locked"}
        </div>
      )}

      <aside className="dock dock-left"><Panel n="01" title="Agent console" className="grow"><Chat ctrl={ctrl} /></Panel></aside>

      <aside className="dock dock-right">
        <Panel n="02" title="Sensor cross-check"><SensorChart ctrl={ctrl} /></Panel>
        <Panel n="03" title="Fault injection" hazard><Injector ctrl={ctrl} /></Panel>
        <Panel n="04" title="Event stream" className="grow"><EventLog ctrl={ctrl} /></Panel>
        <Panel n="05" title="Audit chain"><Audit /></Panel>
      </aside>

      <FocusCard ctrl={ctrl} />

      <footer className="bottombar">
        <Segmented<ViewMode> value={ctrl.view} onChange={(v) => ctrl.setView(v)} options={[["reality", "Reality"], ["split", "Split"], ["twin", "Twin"]]} />
        <div className="readout">
          {t ? (
            <>
              <R k="X" v={t.pose.x.toFixed(2)} u="m" />
              <R k="Y" v={t.pose.y.toFixed(2)} u="m" />
              <R k="HDG" v={(((t.pose.theta * 180) / Math.PI + 360) % 360).toFixed(0)} u="°" />
              <R k="SPD" v={t.v.toFixed(2)} u="m/s" />
              <R k="LIM" v={t.speedLimit.toFixed(1)} u="m/s" />
              <R k="TGT" v={t.target ?? "—"} />
            </>
          ) : <span className="muted">waiting for telemetry…</span>}
        </div>
        <Segmented<CameraMode> value={ctrl.cam} onChange={(v) => ctrl.setCam(v)} options={[["overview", "Overview"], ["follow", "Follow"], ["top", "Top"], ["free", "Free"]]} />
      </footer>
    </div>
  );
}

function Chip({ k, v, tone }: { k: string; v: string; tone: "ok" | "warn" | "bad" | "live" }) {
  return <div className={`chip ${tone}`}><i />{k}<b>{v}</b></div>;
}

function R({ k, v, u }: { k: string; v: string; u?: string }) {
  return <span className="r"><em>{k}</em>{v}{u && <small>{u}</small>}</span>;
}

function Panel({ n, title, children, className = "", hazard }: { n: string; title: string; children: React.ReactNode; className?: string; hazard?: boolean }) {
  return (
    <section className={`panel ${className} ${hazard ? "hazard" : ""}`}>
      <h2><span>{n}</span>{title}</h2>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function FocusCard({ ctrl }: { ctrl: TwinController }) {
  if (!ctrl.focusId) return null;
  const station = STATIONS.find((s) => s.id === ctrl.focusId) ?? STATIONS.find((s) => MACHINES.find((m) => m.id === ctrl.focusId && Math.abs(m.x - s.x) < 1.5 && Math.abs(m.y - s.y) < 2.5));
  const machine = MACHINES.find((m) => m.id === ctrl.focusId);
  return (
    <div className="focus-card">
      <div className="fc-kicker">{machine ? "Machine" : "Station"}</div>
      <div className="fc-title">{machine?.id ?? station?.label}</div>
      {station && <div className="fc-meta">Dock {station.id} · ({station.x.toFixed(1)}, {station.y.toFixed(1)}){station.id === "QC" ? ` · ${LIMITS.qcZoneSpeed} m/s zone` : ""}</div>}
      <div className="fc-actions">
        {station && <button onClick={() => ctrl.setDraft(`Go to ${station.id}`)}>Send AGV here</button>}
        <button className="ghost" onClick={() => ctrl.focus(null)}>Close</button>
      </div>
    </div>
  );
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
      <button onClick={dropCrate}><b>Drop crate</b><small>in the AGV&apos;s path</small></button>
      <button className={ctrl.sensorBias ? "on" : ""} onClick={() => ctrl.world({ kind: "sensor_bias", metres: ctrl.sensorBias ? 0 : 1.0 })}>
        <b>{ctrl.sensorBias ? "Clear fault" : "Sensor fault"}</b><small>{ctrl.sensorBias ? "bias active" : "+1.0 m bias"}</small>
      </button>
      <button className={ctrl.linkDown ? "on" : ""} onClick={() => ctrl.setLinkDown(!ctrl.linkDown)}>
        <b>{ctrl.linkDown ? "Restore link" : "Cut link"}</b><small>watchdog {LIMITS.watchdogMs} ms</small>
      </button>
      <button onClick={() => ctrl.world({ kind: "clear_obstacles" })}><b>Clear floor</b><small>reset twin map</small></button>
    </div>
  );
}

function SensorChart({ ctrl }: { ctrl: TwinController }) {
  const W = 300, H = 84, max = LIMITS.sensorMax;
  const h = ctrl.history;
  const pts = (key: "measured" | "expected") =>
    h.map((s, i) => `${((i / Math.max(1, h.length - 1)) * W).toFixed(1)},${(H - (s[key] / max) * (H - 6) - 3).toFixed(1)}`).join(" ");
  const f = ctrl.fusion;
  const state = f.state.toLowerCase();
  return (
    <div className="xcheck">
      <div className="xc-head">
        <div className={`xc-state ${state}`}>{f.state}</div>
        <div className="xc-nums">
          <span className="m">{Number.isFinite(f.measured) ? f.measured.toFixed(2) : "—"}<small>plant</small></span>
          <span className="e">{Number.isFinite(f.expected) ? f.expected.toFixed(2) : "—"}<small>twin</small></span>
          <span>{f.frames.agree}/{f.frames.disagree}/{f.frames.skip}<small>A/D/S</small></span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none">
        {[1, 2, 3].map((m) => <line key={m} x1="0" x2={W} y1={H - (m / max) * (H - 6) - 3} y2={H - (m / max) * (H - 6) - 3} className="gridline" />)}
        <polyline points={pts("expected")} className="expected" />
        <polyline points={pts("measured")} className="measured" />
      </svg>
      {f.hint && (
        <div className={`diag ${f.hint}`}>
          {f.hint === "unmapped_obstacle" ? "Plant sees an object the twin map lacks. Ask the agent to reconcile." : "Plant reads past a mapped surface: sensor fault. Motion locked."}
        </div>
      )}
    </div>
  );
}

function EventLog({ ctrl }: { ctrl: TwinController }) {
  return (
    <ul className="events">
      {ctrl.log.slice(-30).reverse().map((l, i) => (
        <li key={`${l.t}-${i}`} className={l.level}><time>{new Date(l.t).toLocaleTimeString([], { hour12: false })}</time><span>{l.text}</span></li>
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
  if (!a) return <div className="muted">loading…</div>;
  return (
    <div>
      <div className={`chain ${a.verify.ok ? "ok" : "bad"}`}>
        <span className="links">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</span>
        {a.verify.ok ? `Intact · ${a.total} entries` : `Broken at #${a.verify.brokenAt}`}
      </div>
      <ul className="audit">
        {a.entries.slice(0, 6).map((e) => (
          <li key={e.seq}>
            <span className="seq">{String(e.seq).padStart(3, "0")}</span>
            <span className={`kind ${e.kind.split(".")[0]}`}>{e.kind}</span>
            <code>{e.hash.slice(0, 6)}</code>
            <span className="detail">{summary(e.kind, e.data)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function summary(kind: string, d: Record<string, unknown>): string {
  if (kind === "gate.reject") return `${d.tool}: ${d.reason}`;
  if (kind === "gate.pass") return `${d.tool} ${JSON.stringify(d.input)}`;
  if (kind === "cmd.signed") return `${d.type} by ${d.issuedBy}${d.reason ? ` (${d.reason})` : ""}`;
  if (kind === "plant.ack") return `${d.status} ${d.type}${d.reason ? `: ${d.reason}` : ""}`;
  if (kind === "agent.request") return String(d.prompt);
  if (kind === "agent.reply") return String(d.reply);
  if (kind === "fusion.change") return `${d.from} → ${d.to}${d.hint ? ` (${d.hint})` : ""}`;
  if (kind === "plant.estop") return String(d.reason);
  if (kind === "link.change") return d.lost ? "telemetry lost" : "telemetry resumed";
  return JSON.stringify(d);
}
