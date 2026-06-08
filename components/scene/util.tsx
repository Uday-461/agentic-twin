"use client";

import { shaderMaterial } from "@react-three/drei";
import { extend, useFrame, type ThreeElement } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { ARENA } from "@/lib/world";

// World (x, y) metres → three.js (X, Z): centred on the arena, north (+y) is −Z.
export const X = (x: number) => x - ARENA.w / 2;
export const Z = (y: number) => ARENA.h / 2 - y;

export const PALETTE = {
  indigo: "#5b5fc7",
  orange: "#ff8a1f",
  holo: "#38e1ff",
  red: "#ff3b4e",
  green: "#3ddc84",
  amber: "#ffc531",
};

export const MODE_COLOR = { idle: PALETTE.green, moving: PALETTE.holo, blocked: PALETTE.amber, estop: PALETTE.red } as const;

/** Resolve next/font's generated family names (canvas text can't use CSS variables directly). */
export function fontFamily(kind: "display" | "mono") {
  const v = getComputedStyle(document.documentElement).getPropertyValue(kind === "display" ? "--f-display" : "--f-mono").trim();
  return v || (kind === "mono" ? "ui-monospace, monospace" : "sans-serif");
}

type LabelOpts = { color?: string; bg?: string; size?: number; weight?: number; mono?: boolean };

export function labelTexture(text: string, o: LabelOpts = {}) {
  const size = o.size ?? 56;
  const font = `${o.weight ?? 600} ${size}px ${fontFamily(o.mono ? "mono" : "display")}`;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const padX = o.bg ? size * 0.6 : size * 0.2;
  const w = Math.ceil(probe.measureText(text).width + padX * 2);
  const h = Math.ceil(size * 1.6);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  if (o.bg) {
    g.fillStyle = o.bg;
    g.beginPath();
    g.roundRect(0, 0, w, h, h * 0.18);
    g.fill();
  }
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (!o.bg) { g.shadowColor = "rgba(0,0,0,.85)"; g.shadowBlur = size * 0.25; }
  g.fillStyle = o.color ?? "#e6e8ff";
  g.fillText(text, w / 2, h / 2 + size * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: w / h };
}

/** Camera-facing text. `height` is in metres. */
export function Label({ text, position, height = 0.32, ...o }: LabelOpts & { text: string; position: [number, number, number]; height?: number }) {
  const { tex, aspect } = useMemo(() => labelTexture(text, o), [text, o.color, o.bg, o.size, o.weight, o.mono]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={10}>
      <spriteMaterial map={tex} transparent depthWrite={false} depthTest={false} toneMapped={false} />
    </sprite>
  );
}

// Holographic material for the twin layer: fresnel rim + drifting scanlines, additive.
const HoloMaterialImpl = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(PALETTE.holo), uOpacity: 0.6 },
  /* glsl */ `
    varying vec3 vNormal; varying vec3 vView; varying vec3 vWorld;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vNormal = normalize(mat3(modelMatrix) * normal);
      vView = normalize(cameraPosition - world.xyz);
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  /* glsl */ `
    uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
    varying vec3 vNormal; varying vec3 vView; varying vec3 vWorld;
    void main() {
      float fres = pow(1.0 - abs(dot(normalize(vNormal), vView)), 2.2);
      float scan = smoothstep(0.55, 1.0, sin(vWorld.y * 38.0 - uTime * 3.0)) * 0.35;
      float a = (0.08 + fres * 0.85 + scan * 0.4) * uOpacity;
      gl_FragColor = vec4(uColor * (1.2 + fres * 1.6), a);
    }`,
);
extend({ HoloMaterialImpl });
declare module "@react-three/fiber" {
  interface ThreeElements { holoMaterialImpl: ThreeElement<typeof HoloMaterialImpl> }
}

export function HoloMaterial({ color = PALETTE.holo, opacity = 0.6 }: { color?: string; opacity?: number }) {
  const ref = useRef<THREE.ShaderMaterial & { uTime: number }>(null);
  useFrame((_, dt) => { if (ref.current) ref.current.uTime += dt; });
  const c = useMemo(() => new THREE.Color(color), [color]);
  return (
    <holoMaterialImpl
      ref={ref}
      uColor={c}
      uOpacity={opacity}
      transparent
      depthWrite={false}
      blending={THREE.AdditiveBlending}
      side={THREE.DoubleSide}
      toneMapped={false}
    />
  );
}

/** Diagonal yellow/black hazard stripes. */
export function hazardTexture(repeat = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1a1a1f";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = PALETTE.amber;
  for (let i = -128; i < 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0); g.lineTo(i + 32, 0); g.lineTo(i + 160, 128); g.lineTo(i + 128, 128);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat * 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
