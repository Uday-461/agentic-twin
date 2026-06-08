"use client";

import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import type { TwinController } from "@/lib/client/twin";
import { AGV } from "@/lib/world";
import { Prop } from "./Factory";
import { HoloMaterial, MODE_COLOR, PALETTE, X, Z } from "./util";

const WHEEL_R = 0.1;
const tmp = new THREE.Vector3();

/** Shared pose smoothing so the AGV, its ghost and the camera agree on where it is. */
export function useSmoothedPose(ctrl: TwinController) {
  const pose = useRef({ x: 0, z: 0, yaw: 0, init: false });
  useFrame((_, dt) => {
    const t = ctrl.telemetry;
    if (!t) return;
    const p = pose.current;
    const k = 1 - Math.exp(-dt * 12);
    if (!p.init) { p.x = X(t.pose.x); p.z = Z(t.pose.y); p.yaw = t.pose.theta; p.init = true; }
    p.x += (X(t.pose.x) - p.x) * k;
    p.z += (Z(t.pose.y) - p.z) * k;
    p.yaw += Math.atan2(Math.sin(t.pose.theta - p.yaw), Math.cos(t.pose.theta - p.yaw)) * k;
  }, -1);
  return pose;
}

/** Physical AGV in Kenney's palette: rounded chassis, mode-coloured LED band, spinning LiDAR, beacon. */
export function Agv({ ctrl, pose, visible }: { ctrl: TwinController; pose: ReturnType<typeof useSmoothedPose>; visible: boolean }) {
  const root = useRef<THREE.Group>(null);
  const wheels = useRef<THREE.Group[]>([]);
  const lidar = useRef<THREE.Group>(null);
  const led = useRef<THREE.MeshStandardMaterial>(null);
  const beacon = useRef<THREE.MeshStandardMaterial>(null);
  const beaconLight = useRef<THREE.PointLight>(null);

  useFrame(({ clock }, dt) => {
    const t = ctrl.telemetry;
    const g = root.current;
    if (!t || !g) return;
    g.position.set(pose.current.x, 0, pose.current.z);
    g.rotation.y = pose.current.yaw;
    const spin = (t.v / WHEEL_R) * dt;
    wheels.current.forEach((w, i) => { if (w) w.rotation.z -= spin + (i ? 1 : -1) * t.w * 0.25 * dt * 4; });
    if (lidar.current) lidar.current.rotation.y += dt * 9;

    const color = MODE_COLOR[t.mode];
    led.current?.color.set(color);
    led.current?.emissive.set(color);
    const estop = t.mode === "estop";
    const flash = estop ? (Math.sin(clock.elapsedTime * 14) > 0 ? 6 : 0.2) : t.mode === "moving" ? 1.5 + Math.sin(clock.elapsedTime * 5) : 0.6;
    if (beacon.current) {
      beacon.current.emissive.set(estop ? PALETTE.red : PALETTE.orange);
      beacon.current.emissiveIntensity = flash;
    }
    if (beaconLight.current) {
      beaconLight.current.color.set(estop ? PALETTE.red : PALETTE.orange);
      beaconLight.current.intensity = estop ? flash * 1.5 : 0;
    }
  });

  return (
    <group ref={root} visible={visible}>
      {/* chassis */}
      <RoundedBox args={[AGV.length, 0.22, AGV.width]} radius={0.06} smoothness={4} position={[0, 0.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={PALETTE.indigo} roughness={0.45} metalness={0.1} />
      </RoundedBox>
      {/* safety bumper band */}
      <RoundedBox args={[AGV.length + 0.04, 0.06, AGV.width + 0.04]} radius={0.03} position={[0, 0.12, 0]} castShadow>
        <meshStandardMaterial color={PALETTE.orange} roughness={0.5} />
      </RoundedBox>
      {/* LED status band */}
      <RoundedBox args={[AGV.length + 0.01, 0.025, AGV.width + 0.01]} radius={0.012} position={[0, 0.285, 0]}>
        <meshStandardMaterial ref={led} color={MODE_COLOR.idle} emissive={MODE_COLOR.idle} emissiveIntensity={2.2} toneMapped={false} />
      </RoundedBox>
      {/* deck + cargo */}
      <RoundedBox args={[AGV.length - 0.12, 0.05, AGV.width - 0.1]} radius={0.02} position={[-0.05, 0.33, 0]} castShadow>
        <meshStandardMaterial color="#3a3d86" roughness={0.7} />
      </RoundedBox>
      <group position={[-0.12, 0.355, 0]}>
        <Prop name="box-small" position={[0, 0, 0]} scale={0.45} rotation={Math.PI / 2} />
      </group>
      {/* LiDAR head */}
      <group position={[0.24, 0.36, 0]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.07, 0.08, 0.06, 24]} />
          <meshStandardMaterial color="#222339" roughness={0.3} metalness={0.6} />
        </mesh>
        <group ref={lidar} position={[0, 0.06, 0]}>
          <mesh>
            <cylinderGeometry args={[0.06, 0.06, 0.06, 24]} />
            <meshStandardMaterial color="#121226" roughness={0.2} metalness={0.8} />
          </mesh>
          <mesh position={[0.058, 0, 0]}>
            <boxGeometry args={[0.012, 0.025, 0.04]} />
            <meshStandardMaterial color={PALETTE.holo} emissive={PALETTE.holo} emissiveIntensity={4} toneMapped={false} />
          </mesh>
        </group>
      </group>
      {/* beacon */}
      <mesh position={[-0.3, 0.42, 0.2]}>
        <cylinderGeometry args={[0.035, 0.04, 0.08, 16]} />
        <meshStandardMaterial ref={beacon} color="#552a10" emissive={PALETTE.orange} toneMapped={false} />
      </mesh>
      <pointLight ref={beaconLight} position={[-0.3, 0.6, 0.2]} distance={5} decay={1.6} intensity={0} />
      {/* ultrasonic eye */}
      <mesh position={[AGV.length / 2 + 0.005, 0.2, 0]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.035, 0.035, 0.02, 20]} />
        <meshStandardMaterial color="#111" emissive="#ff5fa2" emissiveIntensity={1.5} toneMapped={false} />
      </mesh>
      {/* wheels */}
      {[-1, 1].map((s, i) => (
        <group key={s} position={[0.05, WHEEL_R, (s * (AGV.width + 0.02)) / 2]} ref={(g) => { if (g) wheels.current[i] = g; }}>
          <mesh rotation-x={Math.PI / 2} castShadow>
            <cylinderGeometry args={[WHEEL_R, WHEEL_R, 0.06, 24]} />
            <meshStandardMaterial color="#1b1b24" roughness={0.9} />
          </mesh>
          <mesh rotation-x={Math.PI / 2} position={[0, 0, s * 0.032]}>
            <cylinderGeometry args={[0.045, 0.045, 0.004, 6]} />
            <meshStandardMaterial color={PALETTE.orange} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** The twin's copy of the AGV: holographic hull at the reported pose. */
export function AgvGhost({ pose, visible, opacity = 0.55 }: { pose: ReturnType<typeof useSmoothedPose>; visible: boolean; opacity?: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!g.current) return;
    g.current.position.copy(tmp.set(pose.current.x, 0, pose.current.z));
    g.current.rotation.y = pose.current.yaw;
  });
  return (
    <group ref={g} visible={visible}>
      <mesh position={[0, 0.24, 0]}>
        <boxGeometry args={[AGV.length + 0.1, 0.42, AGV.width + 0.1]} />
        <HoloMaterial opacity={opacity} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
        <ringGeometry args={[AGV.radius + 0.05, AGV.radius + 0.1, 48]} />
        <meshBasicMaterial color={PALETTE.holo} transparent opacity={0.6} toneMapped={false} />
      </mesh>
    </group>
  );
}
