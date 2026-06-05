import { ARENA, AGV, type Pose, type Rect, type Vec2 } from "./world";

/** Distance along a ray to the first box or arena wall, capped at maxRange. */
export function raycast(origin: Vec2, angle: number, rects: Rect[], maxRange: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = maxRange;

  // Arena walls: the ray starts inside, so take the exit distance.
  const tx = dx > 0 ? (ARENA.w - origin.x) / dx : dx < 0 ? -origin.x / dx : Infinity;
  const ty = dy > 0 ? (ARENA.h - origin.y) / dy : dy < 0 ? -origin.y / dy : Infinity;
  best = Math.min(best, tx, ty);

  for (const r of rects) {
    const t = rayBox(origin, dx, dy, r);
    if (t !== null && t < best) best = t;
  }
  return Math.max(0, best);
}

function rayBox(o: Vec2, dx: number, dy: number, r: Rect): number | null {
  const minX = r.x - r.w / 2, maxX = r.x + r.w / 2;
  const minY = r.y - r.h / 2, maxY = r.y + r.h / 2;
  let tmin = -Infinity, tmax = Infinity;
  for (const [o1, d, lo, hi] of [[o.x, dx, minX, maxX], [o.y, dy, minY, maxY]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (o1 < lo || o1 > hi) return null;
    } else {
      const t1 = (lo - o1) / d, t2 = (hi - o1) / d;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
  }
  if (tmax < Math.max(tmin, 0)) return null;
  return tmin >= 0 ? tmin : null; // origin inside a box: ignore it
}

/** Forward ultrasonic: narrow cone, reports the nearest of three rays from the AGV's nose. */
export const ULTRASONIC_CONE = [-0.13, 0, 0.13];

export function forwardRange(pose: Pose, rects: Rect[], maxRange: number): number {
  const nose = {
    x: pose.x + Math.cos(pose.theta) * (AGV.length / 2),
    y: pose.y + Math.sin(pose.theta) * (AGV.length / 2),
  };
  return Math.min(...ULTRASONIC_CONE.map((a) => raycast(nose, pose.theta + a, rects, maxRange)));
}

export function circleHitsRect(c: Vec2, radius: number, r: Rect): boolean {
  const nx = Math.max(r.x - r.w / 2, Math.min(c.x, r.x + r.w / 2));
  const ny = Math.max(r.y - r.h / 2, Math.min(c.y, r.y + r.h / 2));
  return Math.hypot(c.x - nx, c.y - ny) < radius;
}

/** True if the segment a→b passes within `radius` of the box (sampled every 5 cm). */
export function segmentHitsRect(a: Vec2, b: Vec2, radius: number, r: Rect): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (circleHitsRect({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, radius, r)) return true;
  }
  return false;
}
