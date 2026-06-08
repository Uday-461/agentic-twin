"use client";

import { Clone, useGLTF } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ARENA, MACHINES, STATIONS, type Rect } from "@/lib/world";
import { Label, PALETTE, X, Z, hazardTexture } from "./util";

// Kenney Factory Kit (CC0). Props sit inside each machine's collision rect, so what you see
// is exactly what the plant collides with and the planner avoids.

const M = (name: string) => `/models/kenney/${name}.glb`;
const MODELS = [
  "machine-window", "machine-window-bar", "robot-arm-a", "robot-arm-b", "conveyor-long-stripe", "conveyor-long",
  "scanner-low", "box-small", "box-large", "box-long", "structure-window-wide", "structure-wall", "screen-hanging-wide",
  "structure-tall", "warning-traffic", "hopper-high-square", "cone",
] as const;
MODELS.forEach((m) => useGLTF.preload(M(m)));

type V3 = [number, number, number];

const STATION_MACHINE: Record<string, string> = {
  RECEIVING: "Inbound rack", ASSEMBLY_A: "Assembly cell A", ASSEMBLY_B: "Assembly cell B",
  QC: "QC bench", SHIPPING: "Outbound rack", CHARGER: "Charger",
};

export function Prop({ name, position, rotation = 0, scale = 1 }: { name: (typeof MODELS)[number]; position: V3; rotation?: number; scale?: number | V3 }) {
  const { scene } = useGLTF(M(name));
  useEffect(() => {
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
  }, [scene]);
  return <Clone object={scene} position={position} rotation-y={rotation} scale={scale} />;
}

/** Position relative to a machine rect's centre, in world metres → three coords. */
const at = (r: Rect, dx = 0, dy = 0, h = 0): V3 => [X(r.x + dx), h, Z(r.y + dy)];
const rect = (id: string) => MACHINES.find((m) => m.id === id)!;

export function Factory({ onSelect, target }: { onSelect: (id: string, stationId?: string) => void; target: string | null }) {
  const inbound = rect("Inbound rack"), cellA = rect("Assembly cell A"), cellB = rect("Assembly cell B");
  const qc = rect("QC bench"), outbound = rect("Outbound rack"), charger = rect("Charger");
  const click = (id: string, stationId?: string) => (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(id, stationId); };

  return (
    <group>
      {/* Receiving: inbound conveyor with parts flowing in */}
      <group onClick={click("Inbound rack", "RECEIVING")}>
        <Prop name="conveyor-long-stripe" position={at(inbound)} scale={[1.25, 1, 1.25]} />
        <ConveyorFlow from={at(inbound, -1.15, 0, 0.4)} to={at(inbound, 1.15, 0, 0.4)} />
        <Prop name="hopper-high-square" position={at(inbound, -1.6, 0.1)} scale={0.7} />
      </group>

      {/* Assembly cells: machine + robot arm */}
      {[{ r: cellA, s: "ASSEMBLY_A", arm: "robot-arm-a" as const }, { r: cellB, s: "ASSEMBLY_B", arm: "robot-arm-b" as const }].map(({ r, s, arm }) => (
        <group key={r.id} onClick={click(r.id, s)}>
          <Prop name="machine-window" position={at(r, -0.55)} rotation={Math.PI} />
          <Arm name={arm} position={at(r, 0.65, 0.1)} active={target === s} />
          <StatusLight position={at(r, -0.55, 0.55, 1.42)} active={target === s} />
        </group>
      ))}

      {/* QC: conveyor through a scanner */}
      <group onClick={click("QC bench", "QC")}>
        <Prop name="conveyor-long" position={at(qc)} scale={[1.05, 1, 1.2]} />
        <Prop name="scanner-low" position={at(qc)} rotation={0} />
        <ConveyorFlow from={at(qc, -1, 0, 0.4)} to={at(qc, 1, 0, 0.4)} speed={0.25} />
        <StatusLight position={at(qc, 0, 0, 1.2)} active={target === "QC"} />
      </group>

      {/* Shipping: outbound conveyor + staged boxes */}
      <group onClick={click("Outbound rack", "SHIPPING")}>
        <Prop name="conveyor-long-stripe" position={at(outbound)} rotation={Math.PI} scale={[1.25, 1, 1.25]} />
        <ConveyorFlow from={at(outbound, 1.15, 0, 0.4)} to={at(outbound, -1.15, 0, 0.4)} />
        <Prop name="box-large" position={at(outbound, 1.75, -0.3)} scale={0.8} />
        <Prop name="box-long" position={at(outbound, 1.75, 0.35)} scale={0.8} rotation={0.2} />
      </group>

      {/* Charging bay */}
      <group onClick={click("Charger", "CHARGER")}>
        <Prop name="machine-window-bar" position={at(charger)} rotation={Math.PI} scale={[1, 0.8, 0.66]} />
        <StatusLight position={at(charger, 0, 0, 1.15)} active color={PALETTE.green} />
      </group>

      {/* Pillars: structural columns with hazard wrap */}
      {MACHINES.filter((m) => m.id.startsWith("Pillar")).map((p) => <Pillar key={p.id} r={p} />)}

      <Walls />
      <ControlTower />
      <Scatter />

      {STATIONS.map((s) => (
        <group key={s.id} onClick={click(s.id, s.id)}>
          <mesh position={[X(s.x), 0.03, Z(s.y)]} rotation-x={-Math.PI / 2}>
            <circleGeometry args={[0.55, 32]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          {(() => {
            const m = MACHINES.find((r) => r.id === STATION_MACHINE[s.id])!;
            return <Label text={s.id.replace("_", " ")} position={[X(m.x), 2.1, Z(m.y)]} height={0.3} color="#dfe2ff" />;
          })()}
        </group>
      ))}
    </group>
  );
}

/** Boxes riding a conveyor in a loop. */
function ConveyorFlow({ from, to, speed = 0.35, count = 3 }: { from: V3; to: V3; speed?: number; count?: number }) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const len = Math.hypot(to[0] - from[0], to[2] - from[2]);
  useFrame(({ clock }) => {
    refs.current.forEach((g, i) => {
      if (!g) return;
      const u = ((clock.elapsedTime * speed) / len + i / count) % 1;
      g.position.set(from[0] + (to[0] - from[0]) * u, from[1], from[2] + (to[2] - from[2]) * u);
      g.scale.setScalar(Math.min(1, u * 8, (1 - u) * 8) * 0.55);
    });
  });
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} ref={(g) => { refs.current[i] = g; }}>
          <Prop name="box-small" position={[0, 0, 0]} />
        </group>
      ))}
    </>
  );
}

function Arm({ name, position, active }: { name: "robot-arm-a" | "robot-arm-b"; position: V3; active: boolean }) {
  const g = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!g.current) return;
    const t = clock.elapsedTime * (active ? 1.6 : 0.5);
    g.current.rotation.y = Math.sin(t) * (active ? 1.2 : 0.5);
  });
  return (
    <group ref={g} position={position}>
      <Prop name={name} position={[0, 0, 0]} scale={0.6} />
    </group>
  );
}

/** Glowing stack light; pulses when the AGV is heading to this station. */
function StatusLight({ position, active, color = PALETTE.holo }: { position: V3; active: boolean; color?: string }) {
  const m = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (!m.current) return;
    m.current.emissiveIntensity = active ? 2.5 + Math.sin(clock.elapsedTime * 6) * 1.5 : 0.9;
  });
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.08, 16, 16]} />
      <meshStandardMaterial ref={m} color={active ? color : "#6d72d6"} emissive={active ? color : "#6d72d6"} toneMapped={false} />
    </mesh>
  );
}

function Pillar({ r }: { r: Rect }) {
  const stripes = useMemo(() => hazardTexture(1), []);
  return (
    <group position={[X(r.x), 0, Z(r.y)]}>
      <mesh position={[0, 1.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[r.w * 0.8, 2.6, r.h * 0.8]} />
        <meshStandardMaterial color="#4b4f9e" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.45, 0]} castShadow>
        <boxGeometry args={[r.w, 0.9, r.h]} />
        <meshStandardMaterial map={stripes} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Back and side walls built from Kenney structure pieces, kept just outside the arena. */
function Walls() {
  const north = Array.from({ length: ARENA.w / 2 }, (_, i) => i * 2 + 1);
  return (
    <group>
      {north.map((x, i) => (
        <Prop key={`n${x}`} name={i % 3 === 1 ? "structure-wall" : "structure-window-wide"} position={[X(x), 0, Z(ARENA.h) - 0.5]} rotation={Math.PI} scale={i % 3 === 1 ? [2, 1, 1] : 1} />
      ))}
    </group>
  );
}

export const TOWER_TOP: V3 = [X(ARENA.w) + 1.6, 4.1, Z(1.2)];

/** Fleet controller mast outside the east wall; signed commands fly from here. */
function ControlTower() {
  const tip = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => { if (tip.current) tip.current.emissiveIntensity = 2 + Math.sin(clock.elapsedTime * 3) * 1.2; });
  const [x, , z] = TOWER_TOP;
  return (
    <group>
      <Prop name="structure-tall" position={[x, 0, z]} scale={[1, 1.9, 1]} />
      <Prop name="screen-hanging-wide" position={[x - 0.2, 2.1, z]} rotation={-Math.PI / 2} />
      <mesh position={TOWER_TOP}>
        <sphereGeometry args={[0.14, 16, 16]} />
        <meshStandardMaterial ref={tip} color={PALETTE.orange} emissive={PALETTE.orange} toneMapped={false} />
      </mesh>
      <Label text="FLEET CONTROLLER" position={[x, 4.6, z]} height={0.26} color={PALETTE.orange} />
    </group>
  );
}

/** Set dressing outside the drivable area. */
function Scatter() {
  return (
    <group>
      <Prop name="warning-traffic" position={[X(0.25), 0, Z(0.25)]} />
      <Prop name="warning-traffic" position={[X(19.75), 0, Z(11.75)]} />
      {[[-0.6, 3], [-0.7, 4], [20.6, 9], [20.7, 10]].map(([x, y], i) => (
        <Prop key={i} name="cone" position={[X(x), 0, Z(y)]} />
      ))}
      <Prop name="box-large" position={[X(-1.3), 0, Z(8)]} rotation={0.3} />
      <Prop name="box-large" position={[X(-1.2), 0.55, Z(8.1)]} rotation={-0.2} scale={0.8} />
      <Prop name="box-long" position={[X(21.4), 0, Z(4.2)]} rotation={1.2} />
    </group>
  );
}
