"use client";

import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { TwinController } from "@/lib/client/twin";
import { AGV, ARENA, LIMITS, MACHINES, STATIONS, findStation, type Rect } from "@/lib/world";

// World (x, y) metres → three.js (X, Z): centred on the arena, north (+y) is −Z.
const X = (x: number) => x - ARENA.w / 2;
const Z = (y: number) => ARENA.h / 2 - y;

const MODE_COLOR = { idle: "#4ade80", moving: "#38bdf8", blocked: "#fbbf24", estop: "#ef4444" } as const;

export default function Scene({ ctrl }: { ctrl: TwinController }) {
  return (
    <Canvas camera={{ position: [0, 17, 12.5], fov: 50 }} shadows="percentage">
      <color attach="background" args={["#0b1020"]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[8, 16, 6]} intensity={1.1} castShadow />
      <Floor />
      {MACHINES.map((m) => <Machine key={m.id} rect={m} />)}
      {STATIONS.map((s) => (
        <group key={s.id} position={[X(s.x), 0.02, Z(s.y)]}>
          <mesh rotation-x={-Math.PI / 2}>
            <ringGeometry args={[0.3, 0.38, 32]} />
            <meshBasicMaterial color="#a78bfa" />
          </mesh>
          <Label text={s.id} position={[0, 0.15, 0.6]} color="#c4b5fd" />
        </group>
      ))}
      <QcZone />
      <Obstacles ctrl={ctrl} />
      <Agv ctrl={ctrl} />
      <Lidar ctrl={ctrl} />
      <Route ctrl={ctrl} />
      <OrbitControls target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.1} />
    </Canvas>
  );
}

function Floor() {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[ARENA.w, ARENA.h]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <gridHelper args={[ARENA.w, ARENA.w, "#334155", "#273449"]} position={[0, 0.005, 0]} scale={[1, 1, ARENA.h / ARENA.w]} />
      {[
        { x: ARENA.w / 2, y: -0.05, w: ARENA.w, h: 0.1 },
        { x: ARENA.w / 2, y: ARENA.h + 0.05, w: ARENA.w, h: 0.1 },
        { x: -0.05, y: ARENA.h / 2, w: 0.1, h: ARENA.h },
        { x: ARENA.w + 0.05, y: ARENA.h / 2, w: 0.1, h: ARENA.h },
      ].map((r, i) => (
        <mesh key={i} position={[X(r.x), 0.25, Z(r.y)]}>
          <boxGeometry args={[r.w, 0.5, r.h]} />
          <meshStandardMaterial color="#475569" />
        </mesh>
      ))}
    </group>
  );
}

function Machine({ rect }: { rect: Rect }) {
  const pillar = rect.id.startsWith("Pillar");
  const h = pillar ? 2.5 : 1.1;
  return (
    <group position={[X(rect.x), h / 2, Z(rect.y)]}>
      <mesh castShadow>
        <boxGeometry args={[rect.w, h, rect.h]} />
        <meshStandardMaterial color={pillar ? "#64748b" : "#334e68"} />
      </mesh>
      {!pillar && <Label text={rect.id} position={[0, h / 2 + 0.25, 0]} color="#cbd5e1" />}
    </group>
  );
}

function QcZone() {
  const qc = findStation("QC")!;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[X(qc.x), 0.01, Z(qc.y)]}>
      <ringGeometry args={[LIMITS.qcZoneRadius - 0.05, LIMITS.qcZoneRadius, 64]} />
      <meshBasicMaterial color="#facc15" transparent opacity={0.5} />
    </mesh>
  );
}

function Obstacles({ ctrl }: { ctrl: TwinController }) {
  return (
    <group>
      {/* Physical crates: what is really on the floor. */}
      {ctrl.physicalObstacles.map((r) => (
        <mesh key={r.id} position={[X(r.x), 0.3, Z(r.y)]} castShadow>
          <boxGeometry args={[r.w, 0.6, r.h]} />
          <meshStandardMaterial color="#c2410c" />
        </mesh>
      ))}
      {/* Twin map: what the twin believes is there. */}
      {ctrl.knownObstacles.map((r) => (
        <mesh key={r.id} position={[X(r.x), 0.32, Z(r.y)]}>
          <boxGeometry args={[r.w, 0.64, r.h]} />
          <meshBasicMaterial color="#22d3ee" wireframe />
        </mesh>
      ))}
    </group>
  );
}

function Agv({ ctrl }: { ctrl: TwinController }) {
  const ref = useRef<THREE.Group>(null);
  const body = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const t = ctrl.telemetry;
    if (!t || !ref.current) return;
    const g = ref.current;
    g.position.lerp(new THREE.Vector3(X(t.pose.x), 0, Z(t.pose.y)), 0.35);
    const target = t.pose.theta;
    let d = target - g.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.rotation.y += d * 0.35;
    body.current?.color.set(MODE_COLOR[t.mode]);
  });
  return (
    <group ref={ref}>
      <mesh position={[0, 0.22, 0]} castShadow>
        <boxGeometry args={[AGV.length, 0.24, AGV.width]} />
        <meshStandardMaterial ref={body} color={MODE_COLOR.idle} />
      </mesh>
      <mesh position={[0.12, 0.42, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.16, 20]} />
        <meshStandardMaterial color="#e2e8f0" />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0.05, 0.1, (s * AGV.wheelBase) / 2]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.1, 0.1, 0.06, 20]} />
          <meshStandardMaterial color="#0f172a" />
        </mesh>
      ))}
      <mesh position={[AGV.length / 2 + 0.01, 0.22, 0]}>
        <boxGeometry args={[0.02, 0.06, 0.16]} />
        <meshStandardMaterial color="#f472b6" emissive="#f472b6" />
      </mesh>
    </group>
  );
}

function Lidar({ ctrl }: { ctrl: TwinController }) {
  const geom = useMemo(() => new THREE.BufferGeometry(), []);
  useFrame(() => {
    const t = ctrl.telemetry;
    if (!t || !ctrl.lidar.length) return;
    const pts: number[] = [];
    const n = ctrl.lidar.length;
    ctrl.lidar.forEach((r, i) => {
      const a = t.pose.theta + (i / n) * 2 * Math.PI;
      pts.push(X(t.pose.x), 0.42, Z(t.pose.y), X(t.pose.x + Math.cos(a) * r), 0.42, Z(t.pose.y + Math.sin(a) * r));
    });
    // Measured ultrasonic beam from the nose, drawn last.
    const nx = t.pose.x + Math.cos(t.pose.theta) * (AGV.length / 2);
    const ny = t.pose.y + Math.sin(t.pose.theta) * (AGV.length / 2);
    pts.push(X(nx), 0.25, Z(ny), X(nx + Math.cos(t.pose.theta) * t.ultrasonic), 0.25, Z(ny + Math.sin(t.pose.theta) * t.ultrasonic));
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const colors: number[] = [];
    for (let i = 0; i < n * 2; i++) colors.push(0.13, 0.83, 0.93);
    const bad = ctrl.fusion.state === "DISAGREE";
    colors.push(...(bad ? [1, 0.2, 0.2, 1, 0.2, 0.2] : [0.96, 0.45, 0.71, 0.96, 0.45, 0.71]));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  });
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial vertexColors transparent opacity={0.55} />
    </lineSegments>
  );
}

function Route({ ctrl }: { ctrl: TwinController }) {
  const t = ctrl.telemetry;
  if (!t || !t.route.length) return null;
  const pts = [t.pose, ...t.route].map((p) => [X(p.x), 0.05, Z(p.y)] as [number, number, number]);
  return <Line points={pts} color="#38bdf8" lineWidth={2} dashed dashSize={0.25} gapSize={0.15} />;
}

/** Text rendered to a canvas texture on a sprite: always faces the camera, no DOM. */
function Label({ text, position, color }: { text: string; position: [number, number, number]; color: string }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 96;
    const g = c.getContext("2d")!;
    g.font = "600 52px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.shadowColor = "#000"; g.shadowBlur = 8;
    g.fillStyle = color;
    g.fillText(text, 256, 48);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [text, color]);
  return (
    <sprite position={position} scale={[2.4, 0.45, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  );
}
