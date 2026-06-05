import { circleHitsRect, segmentHitsRect } from "./geometry";
import { ARENA, AGV, type Rect, type Vec2 } from "./world";

const CELL = 0.25;
const MARGIN = 0.1;

/**
 * Shortest collision-free route on a 25 cm grid, obstacles inflated by the AGV radius,
 * then shortcut to the fewest straight legs. Returns null when the goal is unreachable.
 */
export function planPath(start: Vec2, goal: Vec2, obstacles: Rect[]): Vec2[] | null {
  const cols = Math.floor(ARENA.w / CELL);
  const rows = Math.floor(ARENA.h / CELL);
  const clear = AGV.radius + MARGIN;
  const blocked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = center(c, r);
      const nearWall = p.x < clear || p.y < clear || p.x > ARENA.w - clear || p.y > ARENA.h - clear;
      if (nearWall || obstacles.some((o) => circleHitsRect(p, clear, o))) blocked[r * cols + c] = 1;
    }
  }

  const toCell = (p: Vec2) => [clampI(Math.floor(p.x / CELL), cols), clampI(Math.floor(p.y / CELL), rows)];
  const [sc, sr] = toCell(start);
  const [gc, gr] = toCell(goal);
  const startIdx = sr * cols + sc;
  const goalIdx = gr * cols + gc;
  if (blocked[goalIdx]) return null;
  blocked[startIdx] = 0; // the AGV may be parked close to something; let it leave

  const g = new Float64Array(cols * rows).fill(Infinity);
  const parent = new Int32Array(cols * rows).fill(-1);
  const open = new Set<number>([startIdx]);
  const f = new Map<number, number>([[startIdx, 0]]);
  g[startIdx] = 0;

  while (open.size) {
    let cur = -1, bestF = Infinity;
    for (const i of open) if ((f.get(i) ?? Infinity) < bestF) { bestF = f.get(i)!; cur = i; }
    if (cur === goalIdx) break;
    open.delete(cur);
    const cc = cur % cols, cr = (cur - cc) / cols;
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
      if (!dc && !dr) continue;
      const nc = cc + dc, nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const n = nr * cols + nc;
      if (blocked[n]) continue;
      if (dc && dr && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue; // no corner cutting
      const cost = g[cur] + (dc && dr ? Math.SQRT2 : 1);
      if (cost < g[n]) {
        g[n] = cost;
        parent[n] = cur;
        f.set(n, cost + Math.hypot(gc - nc, gr - nr));
        open.add(n);
      }
    }
  }
  if (parent[goalIdx] === -1 && goalIdx !== startIdx) return null;

  const cells: Vec2[] = [];
  for (let i = goalIdx; i !== -1; i = parent[i]) cells.push(center(i % cols, Math.floor(i / cols)));
  cells.reverse();
  cells[0] = start;
  cells[cells.length - 1] = goal;
  return shortcut(cells, obstacles, clear);
}

/** Greedy line-of-sight smoothing: keep a point only when the straight leg past it would collide. */
function shortcut(points: Vec2[], obstacles: Rect[], clear: number): Vec2[] {
  const out = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && obstacles.some((o) => segmentHitsRect(points[i], points[j], clear - 0.05, o))) j--;
    out.push(points[j]);
    i = j;
  }
  return out;
}

function center(c: number, r: number): Vec2 {
  return { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL };
}

function clampI(v: number, n: number) {
  return Math.max(0, Math.min(n - 1, v));
}
