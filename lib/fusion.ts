import { LIMITS } from "./world";

// Cross-validates the plant's ultrasonic reading against the twin's simulated LiDAR on the
// same bearing. Lifecycle mirrors the reference design: SKIP → DISAGREE → AGREE.
//   SKIP      both readings out of range, nothing to compare
//   AGREE     readings within tolerance
//   DISAGREE  sustained mismatch; motion is blocked until reconciled or the fault is cleared

export type FusionState = "SKIP" | "AGREE" | "DISAGREE";
export type DriftHint = "unmapped_obstacle" | "sensor_fault" | null;

export type FusionSnapshot = {
  state: FusionState;
  hint: DriftHint;
  measured: number;
  expected: number;
  /** Mean (measured − expected) over the current disagreement, metres. */
  offset: number;
  frames: { agree: number; disagree: number; skip: number };
};

export const FUSION = { tolerance: 0.25, enterFrames: 3, exitFrames: 5 };

export class FusionMonitor {
  private state: FusionState = "SKIP";
  private streakBad = 0;
  private streakGood = 0;
  private offsets: number[] = [];
  private frames = { agree: 0, disagree: 0, skip: 0 };
  private last = { measured: NaN, expected: NaN };

  update(measured: number, expected: number): FusionSnapshot {
    this.last = { measured, expected };
    const outOfRange = measured >= LIMITS.sensorMax - 0.05 && expected >= LIMITS.sensorMax - 0.05;
    const diff = measured - expected;

    if (outOfRange) {
      this.frames.skip++;
      this.streakBad = 0;
      if (this.state !== "DISAGREE") this.state = "SKIP";
      else this.streakGood++;
    } else if (Math.abs(diff) > FUSION.tolerance) {
      this.frames.disagree++;
      this.streakBad++;
      this.streakGood = 0;
      this.offsets.push(diff);
      if (this.offsets.length > 20) this.offsets.shift();
      if (this.streakBad >= FUSION.enterFrames) this.state = "DISAGREE";
    } else {
      this.frames.agree++;
      this.streakGood++;
      this.streakBad = 0;
      if (this.state !== "DISAGREE" || this.streakGood >= FUSION.exitFrames) {
        this.state = "AGREE";
        this.offsets = [];
      }
    }
    if (this.state === "DISAGREE" && this.streakGood >= FUSION.exitFrames) {
      this.state = outOfRange ? "SKIP" : "AGREE";
      this.offsets = [];
    }
    return this.snapshot();
  }

  snapshot(): FusionSnapshot {
    const offset = this.offsets.length ? this.offsets.reduce((a, b) => a + b, 0) / this.offsets.length : 0;
    return {
      state: this.state,
      // Something closer than the map says → an object the twin doesn't know about.
      // Sensor reading farther than the map says → the sensor is lying (it can't see through walls).
      hint: this.state === "DISAGREE" ? (offset < 0 ? "unmapped_obstacle" : "sensor_fault") : null,
      measured: this.last.measured,
      expected: this.last.expected,
      offset,
      frames: { ...this.frames },
    };
  }
}
