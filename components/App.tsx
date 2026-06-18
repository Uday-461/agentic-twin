"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SCENARIOS, ScenarioRunner, type Scenario } from "@/lib/client/scenarios";
import { TwinController, type CameraMode, type ViewMode } from "@/lib/client/twin";
import { LIMITS, MACHINES, STATIONS } from "@/lib/world";
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
  return <Shell ctrl={ctrl} />;
}

function Boot() {
  return (
    <div className="boot">
      <Logo />
      <div className="boot-title">Agentic Twin</div>
      <div className="boot-line">Connecting plant, broker and digital twin…</div>
      <div className="boot-bar"><i /></div>
    </div>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="4" fill="#4c8dff" />
      <path d="M7 16 L12 7 L17 16" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="13.2" r="1.6" fill="#fff" />
    </svg>
  );
}

type RightTab = "scenarios" | "monitor" | "faults" | "audit";

function Shell({ ctrl }: { ctrl: TwinController }) {
  useSyncExternalStore(ctrl.subscribe, ctrl.getVersion, ctrl.getVersion);
  const runner = useMemo(() => new ScenarioRunner(ctrl), [ctrl]);
  const [tab, setTab] = useState<RightTab>("scenarios");
  const [leftOpen, setLeftOpen] = usePersisted("panel-left", true);
  const [rightOpen, setRightOpen] = usePersisted("panel-right", true);
  const [model, setModel] = useState("…");
  useEffect(() => { void fetch("/api/agent").then((r) => r.json()).then((d) => setModel(d.model)); }, []);

  const t = ctrl.telemetry;
  const estop = t?.mode === "estop";
  const disagree = ctrl.fusion.state === "DISAGREE";
  const mode = ctrl.linkLost ? "No telemetry" : cap(t?.mode ?? "idle");

  return (
    <div className={`app ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}>
      <header className="appbar">
        <div className="appbar-brand"><Logo /><span>Agentic Twin</span></div>
        <nav className="crumbs"><span>Plant 01</span><i>/</i><span>Assembly floor</span><i>/</i><b>AGV-01</b></nav>
        <div className="appbar-status">
          <Status label="Plant" value={mode} tone={estop || ctrl.linkLost ? "bad" : t?.mode === "blocked" ? "warn" : t?.mode === "moving" ? "info" : "ok"} />
          <Status label="Cross-check" value={cap(ctrl.fusion.state)} tone={disagree ? "bad" : "ok"} />
          <Status label="Control link" value={ctrl.linkLost ? "Lost" : "Nominal"} tone={ctrl.linkLost ? "bad" : "ok"} />
        </div>
        <div className="appbar-actions">
          <button className="btn btn-secondary" disabled={!estop} onClick={() => void ctrl.command("reset")}>Reset E-stop</button>
          <button className={`btn btn-danger ${estop ? "latched" : ""}`} onClick={() => void ctrl.command("estop")}>
            <svg viewBox="0 0 16 16" aria-hidden><path d="M5 1h6l4 4v6l-4 4H5l-4-4V5z" fill="currentColor" /></svg>
            Emergency stop
          </button>
        </div>
      </header>

      <aside className="side side-left">
        {/* Chat stays mounted when collapsed: it owns the conversation and scenarios send through it. */}
        <div className="side-content" hidden={!leftOpen}>
          <div className="side-head">
            <h2>Agent console</h2>
            <span className="pill">{model}</span>
            <CollapseButton side="left" open onClick={() => setLeftOpen(false)} />
          </div>
          <Chat ctrl={ctrl} />
        </div>
        {!leftOpen && <Rail side="left" label="Agent console" onOpen={() => setLeftOpen(true)} busy={ctrl.agentBusy} />}
      </aside>

      <main className={`viewport ${estop ? "is-estop" : ""} ${disagree ? "is-disagree" : ""} ${ctrl.linkLost ? "is-linklost" : ""}`}>
        <Scene ctrl={ctrl} />
        <div className="vp-edge" />
        <div className="vp-toolbar">
          <Segmented<ViewMode> label="View" value={ctrl.view} onChange={(v) => ctrl.setView(v)} options={[["reality", "Reality"], ["split", "Split"], ["twin", "Twin"]]} />
          <Segmented<CameraMode> label="Camera" value={ctrl.cam} onChange={(v) => ctrl.setCam(v)} options={[["overview", "Overview"], ["follow", "Follow"], ["top", "Top"], ["free", "Free"]]} />
        </div>
        {estop && <div className="alert alert-bad"><b>E-stop latched</b>{t?.estopReason}. An operator must reset it.</div>}
        {!estop && disagree && (
          <div className="alert alert-warn">
            <b>Cross-check disagree</b>
            {ctrl.fusion.hint === "unmapped_obstacle" ? "Unmapped object ahead. Reconcile the twin before moving." : "Sensor fault. Motion is locked until maintenance clears it."}
          </div>
        )}
        <FocusCard ctrl={ctrl} />
        <div className="vp-readout">
          {t ? (
            <>
              <R k="X" v={`${t.pose.x.toFixed(2)} m`} />
              <R k="Y" v={`${t.pose.y.toFixed(2)} m`} />
              <R k="Heading" v={`${(((t.pose.theta * 180) / Math.PI + 360) % 360).toFixed(0)}°`} />
              <R k="Speed" v={`${t.v.toFixed(2)} m/s`} />
              <R k="Limit" v={`${t.speedLimit.toFixed(1)} m/s`} />
              <R k="Target" v={t.target ?? "—"} />
            </>
          ) : <span>Waiting for telemetry…</span>}
        </div>
      </main>

      <aside className="side side-right">
        {!rightOpen ? (
          <Rail side="right" label={ctrl.scenario ? `Scenario · ${ctrl.scenario.title}` : "Scenarios · Monitoring · Faults · Audit"} onOpen={() => setRightOpen(true)} alert={disagree} busy={!!ctrl.scenario} />
        ) : (
        <>
        <div className="tabs" role="tablist">
          {([["scenarios", "Scenarios"], ["monitor", "Monitoring"], ["faults", "Faults"], ["audit", "Audit"]] as [RightTab, string][]).map(([k, label]) => (
            <button key={k} role="tab" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
              {k === "monitor" && disagree && <i className="dot bad" />}
              {k === "scenarios" && ctrl.scenario && <i className="dot info" />}
            </button>
          ))}
          <CollapseButton side="right" open onClick={() => setRightOpen(false)} />
        </div>
        <div className="tab-body">
          {tab === "scenarios" && <Scenarios ctrl={ctrl} runner={runner} />}
          {tab === "monitor" && <><Section title="Sensor cross-check"><SensorChart ctrl={ctrl} /></Section><Section title="Event stream" grow><EventLog ctrl={ctrl} /></Section></>}
          {tab === "faults" && <Section title="Fault injection"><Injector ctrl={ctrl} /></Section>}
          {tab === "audit" && <Section title="Audit chain" grow><Audit /></Section>}
        </div>
        </>
        )}
      </aside>

      <footer className="statusbar">
        <span className={ctrl.transport === "mqtt" ? "ok" : "warn"}><i />{ctrl.transport === "mqtt" ? "MQTT · Mosquitto ws://localhost:9001" : "Local bus (broker unreachable)"}</span>
        <span>Session {ctrl.session}</span>
        <span>Signing Ed25519 · 15 s TTL</span>
        <span>Watchdog {LIMITS.watchdogMs} ms</span>
        <span className="grow" />
        <span>Agent {model}</span>
      </footer>
    </div>
  );
}

/** Boolean UI preference stored in localStorage. */
function usePersisted(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    if (typeof window === "undefined") return initial;
    const raw = localStorage.getItem(key);
    return raw === null ? initial : raw === "1";
  });
  return [v, (next: boolean) => { localStorage.setItem(key, next ? "1" : "0"); setV(next); }];
}

function CollapseButton({ side, open, onClick }: { side: "left" | "right"; open: boolean; onClick: () => void }) {
  return (
    <button className="collapse-btn" onClick={onClick} aria-label={open ? "Collapse panel" : "Expand panel"} title={open ? "Collapse panel" : "Expand panel"}>
      <Chevron left={(side === "left") === open} />
    </button>
  );
}

function Chevron({ left }: { left: boolean }) {
  return <svg viewBox="0 0 16 16" aria-hidden><path d={left ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Rail({ side, label, onOpen, alert, busy }: { side: "left" | "right"; label: string; onOpen: () => void; alert?: boolean; busy?: boolean }) {
  return (
    <button className="rail" onClick={onOpen} title={`Expand ${label}`} aria-label={`Expand ${label}`}>
      <span className="rail-chevron"><Chevron left={side === "right"} /></span>
      <span className="rail-label">{label}</span>
      {(alert || busy) && <i className={`dot ${alert ? "bad" : "info"}`} />}
    </button>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function Status({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "bad" | "info" }) {
  return <div className={`status ${tone}`}><i /><span>{label}</span><b>{value}</b></div>;
}

function R({ k, v }: { k: string; v: string }) {
  return <span className="r"><em>{k}</em>{v}</span>;
}

function Section({ title, children, grow }: { title: string; children: React.ReactNode; grow?: boolean }) {
  return <section className={`section ${grow ? "grow" : ""}`}><h3>{title}</h3>{children}</section>;
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

// ---------- scenarios ----------

function Scenarios({ ctrl, runner }: { ctrl: TwinController; runner: ScenarioRunner }) {
  const v = ctrl.scenario;
  if (v) {
    const running = v.status === "running";
    return (
      <div className="runner">
        <div className="runner-head">
          <div>
            <div className="eyebrow">Scenario</div>
            <h3>{v.title}</h3>
          </div>
          <button className="btn btn-ghost" onClick={() => runner.abort()}>{v.status === "done" ? "Close" : "Abort"}</button>
        </div>
        <ol className="steps">
          {Array.from({ length: v.total }, (_, i) => {
            const h = v.history[i];
            const state = h ? (h.ok ? "pass" : "fail") : i === v.index ? (running ? "running" : "current") : "todo";
            const title = h?.title ?? (i === v.index ? v.step?.title : SCENARIOS.find((s) => s.id === v.id)!.steps[i].title);
            return (
              <li key={i} className={state}>
                <span className="marker">{state === "pass" ? "✓" : state === "fail" ? "✕" : i + 1}</span>
                <div>
                  <div className="step-title">{title}</div>
                  {h && <div className="step-observed">{h.observed}</div>}
                </div>
              </li>
            );
          })}
        </ol>
        {v.step && (
          <div className="step-card">
            <div className="eyebrow">Step {v.index + 1} of {v.total}</div>
            <h4>{v.step.title}</h4>
            <p>{v.step.body}</p>
            {v.step.prompt && <blockquote>“{v.step.prompt}”</blockquote>}
            <dl><dt>Expected</dt><dd>{v.step.expect}</dd></dl>
            <button className="btn btn-primary block" disabled={running} onClick={() => void runner.next()}>
              {running ? "Running…" : v.index === 0 ? "Start" : "Next step"}
            </button>
          </div>
        )}
        {v.status === "done" && (
          <div className={`summary ${v.history.every((h) => h.ok) ? "ok" : "bad"}`}>
            {v.history.every((h) => h.ok) ? "All steps behaved as designed." : "One or more steps did not behave as expected. See the step notes above."}
          </div>
        )}
      </div>
    );
  }

  const groups = ["Operations", "Guardrails", "Drift & faults"] as const;
  return (
    <div className="scenario-list">
      <p className="lede">Guided runs of realistic jobs and failure drills. Each step waits for you to click Next, then checks the outcome against the safety design.</p>
      {groups.map((g) => (
        <div key={g} className="scenario-group">
          <h3>{g}</h3>
          {SCENARIOS.filter((s) => s.group === g).map((s) => <ScenarioCard key={s.id} s={s} onRun={() => runner.start(s.id)} />)}
        </div>
      ))}
    </div>
  );
}

function ScenarioCard({ s, onRun }: { s: Scenario; onRun: () => void }) {
  return (
    <div className="scenario-card">
      <div className="sc-main">
        <h4>{s.title}</h4>
        <p>{s.summary}</p>
        <div className="tags">{s.proves.map((p) => <span key={p}>{p}</span>)}</div>
      </div>
      <button className="btn btn-secondary" onClick={onRun}>Run</button>
    </div>
  );
}

// ---------- viewport overlays ----------

function FocusCard({ ctrl }: { ctrl: TwinController }) {
  if (!ctrl.focusId) return null;
  const machine = MACHINES.find((m) => m.id === ctrl.focusId);
  const station = STATIONS.find((s) => s.id === ctrl.focusId) ?? (machine ? STATIONS.find((s) => Math.abs(machine.x - s.x) < 1.5 && Math.abs(machine.y - s.y) < 2.5) : undefined);
  return (
    <div className="focus-card">
      <div className="eyebrow">{machine ? "Machine" : "Station"}</div>
      <h4>{machine?.id ?? station?.label}</h4>
      {station && <div className="meta">Dock {station.id} · ({station.x.toFixed(1)}, {station.y.toFixed(1)}){station.id === "QC" ? ` · ${LIMITS.qcZoneSpeed} m/s zone` : ""}</div>}
      <div className="actions">
        {station && <button className="btn btn-primary" onClick={() => ctrl.setDraft(`Go to ${station.id}`)}>Send AGV here</button>}
        <button className="btn btn-ghost" onClick={() => ctrl.focus(null)}>Close</button>
      </div>
    </div>
  );
}

// ---------- right-panel content ----------

function Injector({ ctrl }: { ctrl: TwinController }) {
  const rows: { title: string; desc: string; on: boolean; action: string; run: () => void }[] = [
    { title: "Obstacle in path", desc: "Drop a crate 1.8 m ahead of the AGV. The twin map won't know about it.", on: false, action: "Drop crate", run: () => ctrl.dropCrateAhead() },
    { title: "Sensor fault", desc: "Add +1.0 m bias to the plant's ultrasonic sensor.", on: !!ctrl.sensorBias, action: ctrl.sensorBias ? "Clear" : "Inject", run: () => ctrl.world({ kind: "sensor_bias", metres: ctrl.sensorBias ? 0 : 1.0 }) },
    { title: "Control link loss", desc: `Stop heartbeats and drop telemetry. The plant E-stops after ${LIMITS.watchdogMs} ms.`, on: ctrl.linkDown, action: ctrl.linkDown ? "Restore" : "Cut link", run: () => ctrl.setLinkDown(!ctrl.linkDown) },
    { title: "Reset floor", desc: "Remove all obstacles and clear the twin map.", on: false, action: "Clear", run: () => ctrl.world({ kind: "clear_obstacles" }) },
  ];
  return (
    <div className="fault-list">
      {rows.map((r) => (
        <div key={r.title} className={`fault ${r.on ? "on" : ""}`}>
          <div>
            <div className="fault-title">{r.title}{r.on && <span className="badge warn">Active</span>}</div>
            <div className="fault-desc">{r.desc}</div>
          </div>
          <button className="btn btn-secondary" onClick={r.run}>{r.action}</button>
        </div>
      ))}
    </div>
  );
}

function SensorChart({ ctrl }: { ctrl: TwinController }) {
  const W = 320, H = 96, max = LIMITS.sensorMax;
  const h = ctrl.history;
  const y = (v: number) => H - (v / max) * (H - 8) - 4;
  const pts = (key: "measured" | "expected") => h.map((s, i) => `${((i / Math.max(1, h.length - 1)) * W).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const f = ctrl.fusion;
  return (
    <div className="xcheck">
      <div className="kpis">
        <div className="kpi"><span>State</span><b className={`state-${f.state.toLowerCase()}`}>{cap(f.state)}</b></div>
        <div className="kpi"><span>Plant</span><b className="m">{Number.isFinite(f.measured) ? f.measured.toFixed(2) : "—"} m</b></div>
        <div className="kpi"><span>Twin</span><b className="e">{Number.isFinite(f.expected) ? f.expected.toFixed(2) : "—"} m</b></div>
        <div className="kpi"><span>A / D / S</span><b>{f.frames.agree}/{f.frames.disagree}/{f.frames.skip}</b></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none">
        {[1, 2, 3].map((m) => <line key={m} x1="0" x2={W} y1={y(m)} y2={y(m)} className="gridline" />)}
        <polyline points={pts("expected")} className="expected" />
        <polyline points={pts("measured")} className="measured" />
      </svg>
      <div className="legend"><span className="m">Plant ultrasonic</span><span className="e">Twin prediction</span></div>
      {f.hint && (
        <div className={`callout ${f.hint === "sensor_fault" ? "bad" : "warn"}`}>
          {f.hint === "unmapped_obstacle" ? "The plant sees an object the twin map lacks. Ask the agent to reconcile." : "The plant reads past a mapped surface, so the sensor is faulty. Motion is locked."}
        </div>
      )}
    </div>
  );
}

function EventLog({ ctrl }: { ctrl: TwinController }) {
  return (
    <ul className="events">
      {ctrl.log.slice(-40).reverse().map((l, i) => (
        <li key={`${l.t}-${i}`} className={l.level}><time>{new Date(l.t).toLocaleTimeString([], { hour12: false })}</time><span>{l.text}</span></li>
      ))}
    </ul>
  );
}

type AuditView = { total: number; verify: { ok: boolean; brokenAt: number | null }; entries: { seq: number; ts: number; kind: string; hash: string; data: Record<string, unknown> }[] };

function Audit() {
  const [a, setA] = useState<AuditView | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/audit").then((r) => r.json()).then(setA).catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);
  if (!a) return <div className="muted">Loading…</div>;
  return (
    <div className="audit-wrap">
      <div className={`callout ${a.verify.ok ? "ok" : "bad"}`}>
        {a.verify.ok ? `Hash chain verified · ${a.total} entries` : `Hash chain broken at entry #${a.verify.brokenAt}`}
      </div>
      <table className="audit">
        <thead><tr><th>#</th><th>Event</th><th>Detail</th><th>Hash</th></tr></thead>
        <tbody>
          {a.entries.slice(0, 40).map((e) => (
            <tr key={e.seq}>
              <td className="num">{e.seq}</td>
              <td><span className={`kind ${e.kind.split(".")[0]}`}>{e.kind}</span></td>
              <td className="detail" title={summary(e.kind, e.data)}>{summary(e.kind, e.data)}</td>
              <td className="hash">{e.hash.slice(0, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
