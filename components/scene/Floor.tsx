"use client";

import { Grid, MeshReflectorMaterial, useTexture } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { ARENA, LIMITS, MACHINES, STATIONS, findStation } from "@/lib/world";
import { PALETTE, fontFamily } from "./util";

const PX = 100; // marking canvas: px per metre

/** Polished concrete (Poly Haven, CC0) with a painted-markings overlay, plus the twin's grid. */
export function Floor({ view }: { view: "reality" | "split" | "twin" }) {
  // Epoxy-coated concrete: Poly Haven's normal/roughness/AO for surface detail under a flat
  // painted colour. Configure tiling in the loader callback (hook values are immutable).
  const maps = useTexture(
    {
      normalMap: "/textures/concrete/concrete_floor_02_nor_gl_2k.jpg",
      roughnessMap: "/textures/concrete/concrete_floor_02_rough_2k.jpg",
      aoMap: "/textures/concrete/concrete_floor_02_ao_2k.jpg",
    },
    (loaded) => {
      for (const t of Object.values(loaded) as THREE.Texture[]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(ARENA.w / 4, ARENA.h / 4);
        t.anisotropy = 8;
      }
    },
  );
  const markings = useMemo(() => paintMarkings(), []);
  const twin = view === "twin";

  return (
    <group>
      {/* Apron around the arena so it doesn't float in space. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color="#17162b" roughness={0.95} />
      </mesh>

      {!twin && (
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[ARENA.w, ARENA.h]} />
          <MeshReflectorMaterial
            {...maps}
            color="#575a7a"
            normalScale={new THREE.Vector2(0.6, 0.6)}
            roughness={0.75}
            metalness={0.05}
            mirror={0}
            blur={[400, 120]}
            resolution={1024}
            mixBlur={1}
            mixStrength={1.6}
            mixContrast={1}
            depthScale={0.6}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.2}
          />
        </mesh>
      )}

      {!twin && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.004, 0]} receiveShadow>
          <planeGeometry args={[ARENA.w, ARENA.h]} />
          <meshStandardMaterial map={markings} transparent roughness={0.6} polygonOffset polygonOffsetFactor={-2} />
        </mesh>
      )}

      {view !== "reality" && (
        <Grid
          position={[0, twin ? 0.002 : 0.012, 0]}
          args={[ARENA.w, ARENA.h]}
          cellSize={0.5}
          cellThickness={0.6}
          cellColor={twin ? "#1d6a86" : "#1b4a63"}
          sectionSize={2}
          sectionThickness={1.1}
          sectionColor={PALETTE.holo}
          fadeDistance={twin ? 60 : 38}
          fadeStrength={1.5}
          infiniteGrid={false}
        />
      )}
      {twin && (
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.005, 0]}>
          <planeGeometry args={[ARENA.w, ARENA.h]} />
          <meshBasicMaterial color="#071624" />
        </mesh>
      )}
    </group>
  );
}

/** Paint lanes, keep-clear boxes, docking squares and the QC zone onto a transparent canvas. */
function paintMarkings() {
  const c = document.createElement("canvas");
  c.width = ARENA.w * PX;
  c.height = ARENA.h * PX;
  const g = c.getContext("2d")!;
  const px = (x: number) => x * PX;
  const py = (y: number) => (ARENA.h - y) * PX; // canvas y grows downward = south

  const paint = (color: string, alpha = 0.85) => { g.strokeStyle = color; g.fillStyle = color; g.globalAlpha = alpha; };

  // Perimeter walkway line
  paint("#e8c13a");
  g.lineWidth = 9;
  g.strokeRect(px(0.35), py(ARENA.h - 0.35), px(ARENA.w - 0.7), px(ARENA.h - 0.7));

  // Keep-clear boxes around machinery, hatched
  for (const m of MACHINES) {
    const pad = m.id.startsWith("Pillar") ? 0.2 : 0.3;
    const x0 = px(m.x - m.w / 2 - pad), y0 = py(m.y + m.h / 2 + pad);
    const w = px(m.w + pad * 2), h = px(m.h + pad * 2);
    paint("#e8c13a", 0.9);
    g.lineWidth = 7;
    g.strokeRect(x0, y0, w, h);
    g.save();
    g.beginPath();
    g.rect(x0, y0, w, h);
    g.clip();
    g.globalAlpha = 0.35;
    g.lineWidth = 10;
    for (let i = -h; i < w; i += 34) { g.beginPath(); g.moveTo(x0 + i, y0 + h); g.lineTo(x0 + i + h, y0); g.stroke(); }
    g.restore();
  }

  // Main east-west aisle with direction arrows
  paint("#f2f2f5", 0.55);
  g.setLineDash([60, 40]);
  g.lineWidth = 6;
  g.beginPath(); g.moveTo(px(1), py(6.1)); g.lineTo(px(19), py(6.1)); g.stroke();
  g.setLineDash([]);
  for (let x = 2.2; x < 19; x += 3.2) arrow(g, px(x), py(5.6), 1);
  for (let x = 3.8; x < 19; x += 3.2) arrow(g, px(x), py(6.6), -1);

  // Station docking squares
  g.font = `600 30px ${fontFamily("display")}`;
  g.textAlign = "center";
  for (const s of STATIONS) {
    const half = 0.55;
    paint("#ffffff", 0.9);
    g.lineWidth = 8;
    corners(g, px(s.x - half), py(s.y + half), px(half * 2));
    paint(s.id === "CHARGER" ? PALETTE.green : "#ffffff", 0.75);
    g.fillText(s.id.replace("_", " "), px(s.x), py(s.y - half - 0.28));
  }

  // QC speed zone
  const qc = findStation("QC")!;
  paint(PALETTE.orange, 0.9);
  g.lineWidth = 10;
  g.setLineDash([36, 22]);
  g.beginPath(); g.arc(px(qc.x), py(qc.y), px(LIMITS.qcZoneRadius), 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.font = `700 34px ${fontFamily("display")}`;
  g.fillText(`QC ZONE · ${LIMITS.qcZoneSpeed} m/s`, px(qc.x - 0.4), py(qc.y - 2.45));

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1) {
  g.beginPath();
  g.moveTo(x + dir * 40, y);
  g.lineTo(x - dir * 10, y - 22);
  g.lineTo(x - dir * 10, y - 9);
  g.lineTo(x - dir * 45, y - 9);
  g.lineTo(x - dir * 45, y + 9);
  g.lineTo(x - dir * 10, y + 9);
  g.lineTo(x - dir * 10, y + 22);
  g.closePath();
  g.fill();
}

function corners(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const l = s * 0.28;
  g.beginPath();
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + s, y, -1, 1], [x, y + s, 1, -1], [x + s, y + s, -1, -1]]) {
    g.moveTo(cx + dx * l, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + dy * l);
  }
  g.stroke();
}
