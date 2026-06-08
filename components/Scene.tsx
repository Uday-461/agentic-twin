"use client";

import { CameraControls, Environment } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Suspense, useEffect, useRef } from "react";
import * as THREE from "three";
import type { TwinController } from "@/lib/client/twin";
import { MACHINES, STATIONS } from "@/lib/world";
import { Agv, AgvGhost, useSmoothedPose } from "./scene/Agv";
import { Factory } from "./scene/Factory";
import { Floor } from "./scene/Floor";
import { Effects, LidarCloud, PhysicalCrates, RouteLine, SensorBeams, TwinMap } from "./scene/TwinLayer";
import { X, Z } from "./scene/util";

export default function Scene({ ctrl }: { ctrl: TwinController }) {
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 1.6]}
      camera={{ position: [6, 34, 42], fov: 42, near: 0.1, far: 200 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      onPointerMissed={() => ctrl.focus(null)}
    >
      <color attach="background" args={[ctrl.view === "twin" ? "#04101c" : "#14132a"]} />
      <fog attach="fog" args={[ctrl.view === "twin" ? "#04101c" : "#14132a", 28, 75]} />
      <Suspense fallback={null}>
        <World ctrl={ctrl} />
        <Environment files="/env/empty_warehouse_01_2k.hdr" environmentIntensity={ctrl.view === "twin" ? 0.15 : 0.55} />
      </Suspense>
      <Lights twin={ctrl.view === "twin"} />
      <CameraRig ctrl={ctrl} />
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <N8AO aoRadius={1.1} distanceFalloff={0.8} intensity={ctrl.view === "twin" ? 0 : 2.4} quality="medium" halfRes />
        <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={ctrl.view === "twin" ? 1.4 : 0.8} radius={0.7} />
        <ToneMapping mode={ToneMappingMode.AGX} />
        <Vignette offset={0.25} darkness={0.55} />
        <SMAA />
      </EffectComposer>
    </Canvas>
  );
}

function Lights({ twin }: { twin: boolean }) {
  return (
    <>
      <hemisphereLight args={["#b9c2ff", "#2a2240", twin ? 0.1 : 0.35]} />
      <directionalLight
        position={[9, 18, 7]}
        intensity={twin ? 0.2 : 2.2}
        color="#fff3e2"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-camera-near={1}
        shadow-camera-far={50}
      />
      {/* cool fill from the opposite side, warm overhead bays */}
      <directionalLight position={[-12, 8, -6]} intensity={twin ? 0 : 0.5} color="#8fa0ff" />
      {!twin && [-6, 0, 6].map((x) => <pointLight key={x} position={[x, 5.5, -1]} intensity={14} distance={11} decay={1.8} color="#ffe2b8" />)}
    </>
  );
}

function World({ ctrl }: { ctrl: TwinController }) {
  const pose = useSmoothedPose(ctrl);
  const v = ctrl.view;
  const reality = v !== "twin";
  const twin = v !== "reality";
  const select = (id: string, stationId?: string) => {
    ctrl.focus(id);
    if (stationId) ctrl.setDraft(`Go to ${stationId}`);
  };
  return (
    <group>
      <Floor view={v} />
      <group visible={reality}>
        <Factory onSelect={select} target={ctrl.telemetry?.target ?? null} />
      </group>
      <PhysicalCrates ctrl={ctrl} visible={reality} />
      <Agv ctrl={ctrl} pose={pose} visible={reality} />
      {twin && <TwinMap ctrl={ctrl} opacity={v === "twin" ? 1 : 0.35} />}
      <AgvGhost pose={pose} visible={twin} opacity={v === "twin" ? 0.7 : 0.18} />
      <LidarCloud ctrl={ctrl} pose={pose} visible={twin} />
      <SensorBeams ctrl={ctrl} pose={pose} />
      <RouteLine ctrl={ctrl} pose={pose} />
      <Effects ctrl={ctrl} pose={pose} />
      <PoseProbe pose={pose} />
    </group>
  );
}

// The camera rig needs the smoothed AGV pose; share it through a module-level ref.
const agvPose = { x: 0, z: 0, yaw: 0 };
function PoseProbe({ pose }: { pose: ReturnType<typeof useSmoothedPose> }) {
  useFrame(() => { agvPose.x = pose.current.x; agvPose.z = pose.current.z; agvPose.yaw = pose.current.yaw; });
  return null;
}

const PRESETS = {
  overview: [-0.6, 17, 17.5, -0.6, 0, 1.2],
  top: [0, 25, 0.01, 0, 0, 0],
} as const;

function CameraRig({ ctrl }: { ctrl: TwinController }) {
  const cc = useRef<CameraControls>(null);
  const intro = useRef(true);

  // Intro fly-in, then hand over to the selected preset.
  useEffect(() => {
    const c = cc.current;
    if (!c) return;
    c.smoothTime = 0.9;
    const t = setTimeout(() => {
      void c.setLookAt(...PRESETS.overview, true).then(() => { intro.current = false; c.smoothTime = 0.35; });
    }, 250);
    const onStart = () => { if (!intro.current && ctrl.cam !== "free") ctrl.setCam("free"); };
    c.addEventListener("controlstart", onStart);
    return () => { clearTimeout(t); c.removeEventListener("controlstart", onStart); };
  }, [ctrl]);

  useEffect(() => {
    const c = cc.current;
    if (!c || intro.current) return;
    if (ctrl.cam === "overview") void c.setLookAt(...PRESETS.overview, true);
    if (ctrl.cam === "top") void c.setLookAt(...PRESETS.top, true);
  }, [ctrl.cam]);

  useEffect(() => {
    const c = cc.current;
    if (!c || !ctrl.focusId) return;
    const m = MACHINES.find((r) => r.id === ctrl.focusId);
    const s = STATIONS.find((r) => r.id === ctrl.focusId);
    const p = m ?? (s ? { x: s.x, y: s.y + 1.2, w: 2.4, h: 2.4 } : null);
    if (!p) return;
    const box = new THREE.Box3(new THREE.Vector3(X(p.x) - p.w / 2, 0, Z(p.y) - p.h / 2), new THREE.Vector3(X(p.x) + p.w / 2, 1.6, Z(p.y) + p.h / 2));
    const center = box.getCenter(new THREE.Vector3());
    void c.setLookAt(center.x + 2.2, 4.2, center.z + 5.2, center.x, 0.7, center.z, true);
  }, [ctrl.focusId]);

  useFrame(() => {
    const c = cc.current;
    if (!c || intro.current || ctrl.cam !== "follow") return;
    const { x, z, yaw } = agvPose;
    const bx = x - Math.cos(yaw) * 4.2, bz = z + Math.sin(yaw) * 4.2;
    void c.setLookAt(bx, 3.2, bz, x + Math.cos(yaw) * 2, 0.3, z - Math.sin(yaw) * 2, true);
  });

  return <CameraControls ref={cc} makeDefault maxPolarAngle={Math.PI / 2.15} minDistance={2} maxDistance={55} />;
}
