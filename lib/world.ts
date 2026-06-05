// Factory floor shared by the plant (simulated hardware), the twin and the agent gate.
// Units: metres, radians. Origin is the bottom-left corner of the arena; +y points "north".

export type Vec2 = { x: number; y: number };
export type Pose = Vec2 & { theta: number };
/** Axis-aligned box, centre + size. */
export type Rect = { id: string; x: number; y: number; w: number; h: number };

export const ARENA = { w: 20, h: 12 };

export const AGV = {
  length: 0.8,
  width: 0.6,
  wheelBase: 0.5,
  /** Radius of the circle enclosing the footprint, used for path inflation and collisions. */
  radius: 0.5,
};

// Operating limits. knowledge/agv-operations-manual.md quotes the same numbers; the gate enforces these.
export const LIMITS = {
  maxSpeed: 1.2,
  defaultSpeed: 0.8,
  minSpeed: 0.1,
  qcZoneSpeed: 0.5,
  qcZoneRadius: 3,
  stopDistance: 0.5,
  sensorMin: 0.05,
  sensorMax: 4,
  watchdogMs: 600,
  heartbeatMs: 200,
  telemetrySilenceMs: 600,
  commandTtlMs: 15_000,
};

export type Station = { id: string; label: string; x: number; y: number };

export const STATIONS: Station[] = [
  { id: "RECEIVING", label: "Receiving dock", x: 2.5, y: 8.4 },
  { id: "ASSEMBLY_A", label: "Assembly cell A", x: 7, y: 7.6 },
  { id: "ASSEMBLY_B", label: "Assembly cell B", x: 13, y: 7.6 },
  { id: "QC", label: "Quality control", x: 17.5, y: 7.6 },
  { id: "SHIPPING", label: "Shipping dock", x: 17, y: 3.4 },
  { id: "CHARGER", label: "Charging bay", x: 3, y: 3.3 },
];

/** Fixed machinery, known to both the plant and the twin. */
export const MACHINES: Rect[] = [
  { id: "Inbound rack", x: 2.5, y: 10.2, w: 2.6, h: 1.4 },
  { id: "Assembly cell A", x: 7, y: 9.6, w: 2.4, h: 1.8 },
  { id: "Assembly cell B", x: 13, y: 9.6, w: 2.4, h: 1.8 },
  { id: "QC bench", x: 17.5, y: 9.6, w: 2.2, h: 1.6 },
  { id: "Outbound rack", x: 17, y: 1.4, w: 2.6, h: 1.4 },
  { id: "Charger", x: 3, y: 1.4, w: 1.2, h: 1 },
  { id: "Pillar W", x: 7, y: 4.8, w: 0.6, h: 0.6 },
  { id: "Pillar E", x: 13, y: 4.8, w: 0.6, h: 0.6 },
];

export const START_POSE: Pose = { x: 3, y: 3.3, theta: Math.PI / 2 };

export function findStation(id: string): Station | undefined {
  return STATIONS.find((s) => s.id === id.trim().toUpperCase());
}

export function inQcZone(p: Vec2): boolean {
  const qc = findStation("QC")!;
  return Math.hypot(p.x - qc.x, p.y - qc.y) <= LIMITS.qcZoneRadius;
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
