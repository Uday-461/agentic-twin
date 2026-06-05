/// <reference lib="webworker" />
// The "physical" AGV. Runs in its own thread with its own bus connection, so the only way
// to reach it is a signed command on the cmd topic, exactly like a real controller.

import { connectBus, type Bus, type Transport } from "../bus";
import { circleHitsRect, forwardRange } from "../geometry";
import { gotoCommand, stepDiffDrive, toWheels } from "../kinematics";
import { topic, type Ack, type CommandPayload, type PlantMode, type SignedCommand, type Telemetry, type WorldEvent } from "../protocol";
import { ARENA, LIMITS, MACHINES, START_POSE, clamp, inQcZone, type Rect, type Vec2 } from "../world";

const DT = 0.05; // 20 Hz physics
const RIGHT_WHEEL_SLIP = 0.02; // real wheels are never identical
const COLLISION_RADIUS = 0.38;

type Init = { session: string; transport: Transport; url: string; publicKeyX: string };

let bus: Bus;
let session = "";
let key: CryptoKey;
const used = new Set<string>();

let pose = { ...START_POSE };
let v = 0, w = 0;
let mode: PlantMode = "idle";
let estopReason: string | null = null;
let route: Vec2[] = [];
let target: string | null = null;
let routeSpeed: number = LIMITS.defaultSpeed;
let speedLimit: number = LIMITS.maxSpeed;
let bias = 0;
const physical: Rect[] = [];
let lastHb = 0; // watchdog arms on the first heartbeat
let tick = 0;

self.onmessage = async (e: MessageEvent<Init>) => {
  const init = e.data;
  session = init.session;
  key = await crypto.subtle.importKey(
    "jwk", { kty: "OKP", crv: "Ed25519", x: init.publicKeyX }, { name: "Ed25519" }, false, ["verify"],
  );
  bus = await connectBus(init);
  bus.subscribe(topic(session, "cmd"), (_t, m) => void onCommand(m as SignedCommand));
  bus.subscribe(topic(session, "hb"), () => { lastHb = Date.now(); });
  bus.subscribe(topic(session, "world"), (_t, m) => onWorld(m as WorldEvent));
  setInterval(step, DT * 1000);
  self.postMessage({ ready: true, transport: bus.transport });
};

async function onCommand(sc: SignedCommand) {
  let p: CommandPayload;
  try { p = JSON.parse(sc.payload); } catch { return; }
  const reject = (reason: string) => ack({ cmdId: p.id, type: p.type, status: "rejected", reason });

  const sig = Uint8Array.from(atob(sc.sig), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(sc.payload));
  if (!ok) return reject("signature invalid");
  if (p.session !== session) return reject("wrong session");
  if (Date.now() > p.exp) return reject("expired");
  if (used.has(p.id)) return reject("replayed command id");
  used.add(p.id);

  switch (p.type) {
    case "estop":
      triggerEstop(`E-STOP by ${p.issuedBy}`);
      break;
    case "reset":
      estopReason = null;
      mode = "idle";
      route = [];
      target = null;
      lastHb = Date.now();
      break;
    case "stop":
      route = [];
      target = null;
      if (mode !== "estop") mode = "idle";
      break;
    case "speed_limit":
      speedLimit = clamp(Number(p.args.mps), LIMITS.minSpeed, LIMITS.maxSpeed);
      break;
    case "goto": {
      if (mode === "estop") return reject("E-STOP latched");
      const pts = p.args.waypoints as Vec2[];
      route = pts.slice(1);
      routeSpeed = Number(p.args.speed);
      target = String(p.args.station);
      mode = "moving";
      break;
    }
  }
  ack({ cmdId: p.id, type: p.type, status: "executed" });
}

function onWorld(ev: WorldEvent) {
  if (ev.kind === "add_obstacle") physical.push(ev.rect);
  if (ev.kind === "clear_obstacles") physical.length = 0;
  if (ev.kind === "sensor_bias") bias = ev.metres;
}

function triggerEstop(reason: string) {
  mode = "estop";
  estopReason = reason;
  route = [];
  target = null;
}

function step() {
  tick++;
  const now = Date.now();
  if (lastHb && mode !== "estop" && now - lastHb > LIMITS.watchdogMs) {
    triggerEstop(`watchdog: no heartbeat for ${LIMITS.watchdogMs} ms`);
  }

  const world = [...MACHINES, ...physical];
  const ultrasonic = measure(world);

  v = 0; w = 0;
  if (mode === "moving" && route.length) {
    const cap = Math.min(routeSpeed, speedLimit, inQcZone(pose) ? LIMITS.qcZoneSpeed : Infinity);
    const cmd = gotoCommand(pose, route[0], cap);
    if (cmd.dist < 0.12) {
      route.shift();
      if (!route.length) { mode = "idle"; target = null; }
    } else if (cmd.v > 0.02 && ultrasonic < LIMITS.stopDistance) {
      mode = "blocked"; // obstacle in the way: hold position and wait for a new command
    } else {
      v = cmd.v; w = cmd.w;
    }
  }

  const { vL, vR } = toWheels(v, w);
  pose = stepDiffDrive(pose, vL, vR * (1 - RIGHT_WHEEL_SLIP), DT);
  const hitWall = pose.x < COLLISION_RADIUS || pose.y < COLLISION_RADIUS ||
    pose.x > ARENA.w - COLLISION_RADIUS || pose.y > ARENA.h - COLLISION_RADIUS;
  if (mode !== "estop" && (hitWall || world.some((r) => circleHitsRect(pose, COLLISION_RADIUS, r)))) {
    triggerEstop("collision detected");
  }

  if (tick % 2 === 0) {
    const t: Telemetry = {
      t: now, pose, v, w, ultrasonic, mode, estopReason, speedLimit,
      route: route.slice(), target,
    };
    bus.publish(topic(session, "telemetry"), t);
  }
}

function measure(world: Rect[]): number {
  const truth = forwardRange(pose, world, LIMITS.sensorMax);
  const noise = 0.015 * Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
  return clamp(truth + noise + bias, LIMITS.sensorMin, LIMITS.sensorMax);
}

function ack(a: Ack) {
  bus.publish(topic(session, "ack"), a);
}
