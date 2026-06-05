/// <reference lib="webworker" />
// Supervisor heartbeat, in a worker so main-thread rendering stalls and background-tab
// timer throttling can't fake a dead controller and trip the plant's watchdog.

import { connectBus, type Bus, type Transport } from "../bus";
import { topic } from "../protocol";
import { LIMITS } from "../world";

let bus: Bus | undefined;
let paused = false;

self.onmessage = async (e: MessageEvent<{ session: string; transport: Transport; url: string } | { paused: boolean }>) => {
  if ("paused" in e.data) { paused = e.data.paused; return; }
  const { session } = e.data;
  bus = await connectBus(e.data);
  setInterval(() => { if (!paused) bus!.publish(topic(session, "hb"), { t: Date.now() }); }, LIMITS.heartbeatMs);
};
