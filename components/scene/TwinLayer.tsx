"use client";

import { Edges, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { Fx, TwinController } from "@/lib/client/twin";
import { AGV, LIMITS, MACHINES, type Rect } from "@/lib/world";
import { Prop, TOWER_TOP } from "./Factory";
import type { useSmoothedPose } from "./Agv";
import { HoloMaterial, Label, PALETTE, X, Z } from "./util";

type Pose = ReturnType<typeof useSmoothedPose>;

/** Physical crates dropped by the injector: real objects, rendered as Kenney boxes. */
export function PhysicalCrates({ ctrl, visible }: { ctrl: TwinController; visible: boolean }) {
  return (
    <group visible={visible}>
      {ctrl.physicalObstacles.map((r) => (
        <Prop key={r.id} name="box-large" position={[X(r.x), 0, Z(r.y)]} scale={[r.w / 1.1, 1.1, r.h / 1]} rotation={0} />
      ))}
    </group>
  );
}

/** Everything the twin believes: machine volumes, reconciled obstacles, and what it can't see. */
export function TwinMap({ ctrl, opacity }: { ctrl: TwinController; opacity: number }) {
  const unmapped = ctrl.physicalObstacles.filter(
    (p) => !ctrl.knownObstacles.some((k) => Math.hypot(k.x - p.x, k.y - p.y) < 0.9),
  );
  return (
    <group>
      {MACHINES.map((m) => <HoloBox key={m.id} r={m} height={m.id.startsWith("Pillar") ? 1.6 : 1.35} opacity={opacity * (m.id.startsWith("Pillar") ? 0.4 : 0.7)} />)}
      {ctrl.knownObstacles.map((r) => (
        <group key={r.id}>
          <HoloBox r={r} height={0.66} opacity={opacity} />
          <Label text={`MAPPED · ${r.id}`} position={[X(r.x), 1.1, Z(r.y)]} height={0.26} bg="rgba(8,40,56,.85)" color={PALETTE.holo} mono />
        </group>
      ))}
      {unmapped.map((r) => <Unmapped key={r.id} r={r} />)}
    </group>
  );
}

function HoloBox({ r, height, opacity, color = PALETTE.holo }: { r: Rect; height: number; opacity: number; color?: string }) {
  return (
    <mesh position={[X(r.x), height / 2, Z(r.y)]}>
      <boxGeometry args={[r.w + 0.04, height, r.h + 0.04]} />
      <HoloMaterial color={color} opacity={opacity} />
      <Edges color={color} threshold={15} />
    </mesh>
  );
}

/** Physical object with no twin counterpart: pulsing red cage. */
function Unmapped({ r }: { r: Rect }) {
  const g = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (g.current) g.current.scale.setScalar(1 + (Math.sin(clock.elapsedTime * 6) + 1) * 0.05);
  });
  return (
    <group position={[X(r.x), 0.36, Z(r.y)]}>
      <group ref={g}>
        <mesh>
          <boxGeometry args={[r.w + 0.18, 0.72, r.h + 0.18]} />
          <HoloMaterial color={PALETTE.red} opacity={0.9} />
          <Edges color={PALETTE.red} />
        </mesh>
      </group>
      <Label text="UNMAPPED OBJECT" position={[0, 0.8, 0]} height={0.3} bg="rgba(255,59,78,.92)" color="#fff" mono />
    </group>
  );
}

/** Twin LiDAR: hit points (instanced) plus faint rays. */
export function LidarCloud({ ctrl, pose, visible }: { ctrl: TwinController; pose: Pose; visible: boolean }) {
  const n = 48;
  const inst = useRef<THREE.InstancedMesh>(null);
  const rays = useMemo(() => new THREE.BufferGeometry(), []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    const t = ctrl.telemetry;
    if (!t || !inst.current || !ctrl.lidar.length) return;
    const pts: number[] = [];
    const ox = pose.current.x, oz = pose.current.z;
    ctrl.lidar.forEach((r, i) => {
      const a = t.pose.theta + (i / n) * Math.PI * 2;
      const hx = ox + Math.cos(a) * r, hz = oz - Math.sin(a) * r;
      const hit = r < LIMITS.sensorMax - 0.01;
      m.makeTranslation(hx, 0.4, hz);
      m.scale(new THREE.Vector3(hit ? 1 : 0.0001, hit ? 1 : 0.0001, hit ? 1 : 0.0001));
      inst.current!.setMatrixAt(i, m);
      pts.push(ox, 0.4, oz, hx, 0.4, hz);
    });
    inst.current.instanceMatrix.needsUpdate = true;
    rays.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  });
  return (
    <group visible={visible}>
      <instancedMesh ref={inst} args={[undefined, undefined, n]} frustumCulled={false}>
        <sphereGeometry args={[0.045, 8, 8]} />
        <meshBasicMaterial color={PALETTE.holo} toneMapped={false} />
      </instancedMesh>
      <lineSegments geometry={rays} frustumCulled={false}>
        <lineBasicMaterial color={PALETTE.holo} transparent opacity={0.12} />
      </lineSegments>
    </group>
  );
}

/** Measured ultrasonic (plant, pink) against expected range (twin, cyan); a red gap when they disagree. */
export function SensorBeams({ ctrl, pose }: { ctrl: TwinController; pose: Pose }) {
  const measured = useMemo(() => new THREE.BufferGeometry(), []);
  const expected = useMemo(() => new THREE.BufferGeometry(), []);
  const gap = useMemo(() => new THREE.BufferGeometry(), []);
  const gapMat = useRef<THREE.LineBasicMaterial>(null);
  useFrame(({ clock }) => {
    const t = ctrl.telemetry;
    const f = ctrl.fusion;
    if (!t || !Number.isFinite(f.expected)) return;
    const th = pose.current.yaw;
    const nx = pose.current.x + Math.cos(th) * (AGV.length / 2), nz = pose.current.z - Math.sin(th) * (AGV.length / 2);
    const end = (d: number, h: number) => [nx + Math.cos(th) * d, h, nz - Math.sin(th) * d];
    measured.setAttribute("position", new THREE.Float32BufferAttribute([nx, 0.21, nz, ...end(t.ultrasonic, 0.21)], 3));
    expected.setAttribute("position", new THREE.Float32BufferAttribute([nx, 0.27, nz, ...end(f.expected, 0.27)], 3));
    const bad = f.state === "DISAGREE";
    gap.setAttribute("position", new THREE.Float32BufferAttribute(bad ? [...end(t.ultrasonic, 0.24), ...end(f.expected, 0.24)] : [0, 0, 0, 0, 0, 0], 3));
    if (gapMat.current) gapMat.current.opacity = 0.5 + Math.sin(clock.elapsedTime * 10) * 0.5;
  });
  return (
    <group>
      <lineSegments geometry={measured} frustumCulled={false}><lineBasicMaterial color="#ff5fa2" toneMapped={false} /></lineSegments>
      <lineSegments geometry={expected} frustumCulled={false}><lineBasicMaterial color={PALETTE.holo} transparent opacity={0.8} toneMapped={false} /></lineSegments>
      <lineSegments geometry={gap} frustumCulled={false}><lineBasicMaterial ref={gapMat} color={PALETTE.red} transparent toneMapped={false} linewidth={3} /></lineSegments>
    </group>
  );
}

/** The live route, drawn as a flowing dashed line. */
export function RouteLine({ ctrl, pose }: { ctrl: TwinController; pose: Pose }) {
  const line = useRef<{ material: { dashOffset: number } } | null>(null);
  useFrame((_, dt) => { if (line.current) line.current.material.dashOffset -= dt * 1.2; });
  const t = ctrl.telemetry;
  if (!t || !t.route.length) return null;
  const pts = [[pose.current.x, 0.06, pose.current.z], ...t.route.map((p) => [X(p.x), 0.06, Z(p.y)])] as [number, number, number][];
  const end = pts.at(-1)!;
  return (
    <group>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Line ref={line as any} points={pts} color={PALETTE.holo} lineWidth={3} dashed dashSize={0.35} gapSize={0.2} toneMapped={false} />
      <mesh position={end} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.32, 0.42, 40]} />
        <meshBasicMaterial color={PALETTE.holo} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Agent/command effects: signed-command packets, ack pulses, rejected-route ghosts. */
export function Effects({ ctrl, pose }: { ctrl: TwinController; pose: Pose }) {
  return (
    <group>
      {ctrl.fx.map((f) => <Effect key={`${f.kind}-${f.t}-${"id" in f ? f.id : ""}`} fx={f} pose={pose} />)}
    </group>
  );
}

function Effect({ fx, pose }: { fx: Fx; pose: Pose }) {
  if (fx.kind === "packet") return <Packet fx={fx} pose={pose} />;
  if (fx.kind === "ack") return <AckPulse fx={fx} pose={pose} />;
  if (fx.kind === "ghost") return <Ghost fx={fx} />;
  return <RejectTag fx={fx} pose={pose} />;
}

function Packet({ fx, pose }: { fx: Extract<Fx, { kind: "packet" }>; pose: Pose }) {
  const m = useRef<THREE.Mesh>(null);
  const trail = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const u = Math.min(1, (Date.now() - fx.t) / 700);
    const s = new THREE.Vector3(...TOWER_TOP), e = new THREE.Vector3(pose.current.x, 0.5, pose.current.z);
    const p = s.clone().lerp(e, u);
    p.y += Math.sin(u * Math.PI) * 2.2;
    m.current?.position.copy(p);
    trail.current?.position.copy(p);
    const vis = u < 1;
    if (m.current) m.current.visible = vis;
    if (trail.current) { trail.current.visible = vis; trail.current.scale.setScalar(1 + u * 1.5); }
  });
  const color = fx.type === "estop" ? PALETTE.red : fx.type === "reset" ? PALETTE.green : PALETTE.orange;
  return (
    <group>
      <mesh ref={m}><octahedronGeometry args={[0.13]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
      <mesh ref={trail}><sphereGeometry args={[0.16, 12, 12]} /><meshBasicMaterial color={color} transparent opacity={0.25} toneMapped={false} /></mesh>
    </group>
  );
}

function AckPulse({ fx, pose }: { fx: Extract<Fx, { kind: "ack" }>; pose: Pose }) {
  const m = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const u = Math.min(1, (Date.now() - fx.t) / 900);
    m.current?.position.set(pose.current.x, 0.05, pose.current.z);
    m.current?.scale.setScalar(0.6 + u * 2.2);
    if (mat.current) mat.current.opacity = 1 - u;
  });
  return (
    <mesh ref={m} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.45, 0.55, 48]} />
      <meshBasicMaterial ref={mat} color={fx.ok ? PALETTE.green : PALETTE.red} transparent toneMapped={false} />
    </mesh>
  );
}

function Ghost({ fx }: { fx: Extract<Fx, { kind: "ghost" }> }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const age = (Date.now() - fx.t) / 1000;
    if (g.current) g.current.visible = age < 4.5 && (age > 3 ? Math.sin(age * 20) > 0 : true);
  });
  const pts = fx.waypoints.map((p) => [X(p.x), 0.08, Z(p.y)] as [number, number, number]);
  const end = pts.at(-1)!;
  return (
    <group ref={g}>
      <Line points={pts} color={PALETTE.red} lineWidth={3} dashed dashSize={0.15} gapSize={0.15} toneMapped={false} />
      <mesh position={end} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.3, 0.42, 40]} />
        <meshBasicMaterial color={PALETTE.red} toneMapped={false} />
      </mesh>
      <Label text={`✕ ${fx.label}`} position={[end[0], 1.3, end[2]]} height={0.24} bg="rgba(255,59,78,.92)" color="#fff" mono />
    </group>
  );
}

function RejectTag({ fx, pose }: { fx: Extract<Fx, { kind: "reject" }>; pose: Pose }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const age = (Date.now() - fx.t) / 1000;
    g.current?.position.set(pose.current.x, 1.3 + age * 0.15, pose.current.z);
    if (g.current) g.current.visible = age < 4;
  });
  return (
    <group ref={g}>
      <Label text={`✕ ${fx.label}`} position={[0, 0, 0]} height={0.24} bg="rgba(255,59,78,.92)" color="#fff" mono />
    </group>
  );
}
