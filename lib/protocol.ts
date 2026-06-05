import type { FusionSnapshot } from "./fusion";
import type { Pose, Rect, Vec2 } from "./world";

// MQTT-style topics, prefixed per browser session: twin/<session>/<channel>
export const topic = (session: string, channel: Channel) => `twin/${session}/${channel}`;
export type Channel = "cmd" | "ack" | "telemetry" | "hb" | "world";

export type CommandType = "goto" | "speed_limit" | "stop" | "estop" | "reset";

export type CommandPayload = {
  id: string;
  session: string;
  type: CommandType;
  args: Record<string, unknown>;
  issuedBy: "agent" | "operator" | "supervisor";
  iat: number;
  exp: number;
};

/** What travels on the cmd topic. `payload` is the exact signed JSON string. */
export type SignedCommand = { payload: string; sig: string };

export type PlantMode = "idle" | "moving" | "blocked" | "estop";

export type Telemetry = {
  t: number;
  pose: Pose;
  v: number;
  w: number;
  /** Ultrasonic forward range as measured by the plant (noisy, possibly faulty). */
  ultrasonic: number;
  mode: PlantMode;
  estopReason: string | null;
  speedLimit: number;
  route: Vec2[];
  target: string | null;
};

export type Ack = { cmdId: string; type: string; status: "executed" | "rejected"; reason?: string };

/** Physical-world events. In real life these just happen; here the injector panel publishes them. */
export type WorldEvent =
  | { kind: "add_obstacle"; rect: Rect }
  | { kind: "clear_obstacles" }
  | { kind: "sensor_bias"; metres: number };

/** The live state the browser sends with every agent request. */
export type TwinSnapshot = {
  pose: Pose;
  mode: PlantMode;
  estopReason: string | null;
  speedLimit: number;
  target: string | null;
  telemetryAgeMs: number;
  fusion: FusionSnapshot;
  /** Obstacles the twin knows about beyond the fixed machinery (reconciled detections). */
  knownObstacles: Rect[];
};

/** Twin-side changes the agent can make; applied by the browser, not signed for the plant. */
export type TwinOp = { type: "add_obstacle"; rect: Rect };
