import mqtt from "mqtt";

// One pub/sub interface over two transports:
//   mqtt   real Mosquitto broker over WebSocket (default ws://localhost:9001)
//   local  BroadcastChannel fallback when the broker is unreachable
// Works in both the page and the plant Web Worker.

export type Transport = "mqtt" | "local";
type Handler = (topic: string, msg: unknown) => void;

export interface Bus {
  transport: Transport;
  publish(topic: string, msg: unknown): void;
  /** Subscribe to an exact topic. */
  subscribe(topic: string, handler: Handler): void;
  close(): void;
}

export function connectBus(opts: { transport: Transport; url: string; session: string }): Promise<Bus> {
  return opts.transport === "mqtt" ? connectMqtt(opts.url) : Promise.resolve(localBus(opts.session));
}

/** Try the broker first; fall back to the local bus if it doesn't answer in time. */
export async function connectBest(url: string, session: string, timeoutMs = 2500): Promise<Bus> {
  try {
    return await connectMqtt(url, timeoutMs);
  } catch {
    return localBus(session);
  }
}

function connectMqtt(url: string, timeoutMs = 2500): Promise<Bus> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { connectTimeout: timeoutMs, reconnectPeriod: 1000 });
    const handlers = new Map<string, Handler[]>();
    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error(`MQTT broker ${url} unreachable`));
    }, timeoutMs);

    client.on("message", (t, buf) => {
      let msg: unknown;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      handlers.get(t)?.forEach((h) => h(t, msg));
    });
    client.once("connect", () => {
      clearTimeout(timer);
      resolve({
        transport: "mqtt",
        publish: (t, msg) => client.publish(t, JSON.stringify(msg), { qos: 0 }),
        subscribe: (t, h) => {
          if (!handlers.has(t)) { handlers.set(t, []); client.subscribe(t); }
          handlers.get(t)!.push(h);
        },
        close: () => client.end(true),
      });
    });
  });
}

function localBus(session: string): Bus {
  const ch = new BroadcastChannel(`agentic-twin/${session}`);
  const handlers = new Map<string, Handler[]>();
  ch.onmessage = (e: MessageEvent<{ topic: string; msg: unknown }>) =>
    handlers.get(e.data.topic)?.forEach((h) => h(e.data.topic, e.data.msg));
  return {
    transport: "local",
    publish: (t, msg) => ch.postMessage({ topic: t, msg }),
    subscribe: (t, h) => {
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t)!.push(h);
    },
    close: () => ch.close(),
  };
}
