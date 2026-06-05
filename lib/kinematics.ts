import { AGV, clamp, wrapAngle, type Pose, type Vec2 } from "./world";

/** Differential-drive pose update from left/right wheel ground speeds (m/s). */
export function stepDiffDrive(p: Pose, vL: number, vR: number, dt: number): Pose {
  const v = (vL + vR) / 2;
  const w = (vR - vL) / AGV.wheelBase;
  return {
    x: p.x + v * Math.cos(p.theta) * dt,
    y: p.y + v * Math.sin(p.theta) * dt,
    theta: wrapAngle(p.theta + w * dt),
  };
}

/** Go-to-point controller: turn in place when badly misaligned, otherwise drive and steer. */
export function gotoCommand(p: Pose, target: Vec2, maxSpeed: number): { v: number; w: number; dist: number } {
  const dist = Math.hypot(target.x - p.x, target.y - p.y);
  const err = wrapAngle(Math.atan2(target.y - p.y, target.x - p.x) - p.theta);
  const w = clamp(2.5 * err, -1.6, 1.6);
  const v = Math.abs(err) > 0.5 ? 0 : Math.min(maxSpeed, 0.9 * dist) * Math.cos(err);
  return { v, w, dist };
}

export function toWheels(v: number, w: number): { vL: number; vR: number } {
  return { vL: v - (w * AGV.wheelBase) / 2, vR: v + (w * AGV.wheelBase) / 2 };
}
