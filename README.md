# Agentic Twin

An LLM agent that drives a simulated factory AGV from natural language, through a safety gate,
signed commands, a real MQTT broker and a digital twin that cross-checks the plant's sensors.
Modelled on the architecture of [LLM-Agent-DigitalTwin](https://github.com/Viandanze/LLM-Agent-DigitalTwin),
rebuilt as a local web app.

## Run

```bash
brew install mosquitto     # once
npm install
npm run setup              # creates .env.local with a fresh Ed25519 signing key
npm run up                 # Mosquitto (ws://localhost:9001) + Next.js (http://localhost:3000)
```

Without `OPENROUTER_API_KEY` in `.env.local`, a deterministic mock planner stands in for the
model so everything else can be exercised offline. Add the key to use a real model:

```
OPENROUTER_API_KEY=sk-or-...
AGENT_MODEL=deepseek/deepseek-v4.1-flash     # or qwen/qwen3-235b-a22b-2507, any tool-capable model
```

If Mosquitto isn't running the app falls back to an in-browser bus (header badge shows which).

`npm test` runs the gate, signing, audit-chain, fusion, planner and retrieval tests.

## Architecture

```
Browser ──────────────────────────────────────────────────────────────────────────────
  Chat ─► /api/agent ─────────────────────────────┐
  3D twin (react-three-fiber)                     │
  Supervisor (lib/client/twin.ts)                 │
    • twin LiDAR prediction from pose + twin map  │
    • cross-check vs plant ultrasonic             │
    • telemetry-silence detection                 │
    • auto-stop on mid-route disagreement         │
  Heartbeat worker ── hb every 200 ms ──┐         │
                                        ▼         │
                 Mosquitto (MQTT over WebSocket)  │
                   twin/<session>/cmd|ack|telemetry|hb|world
                                        ▲         │
  Plant worker (lib/plant/plant.worker.ts)        │
    • Ed25519 verify, session, 15 s expiry, replay│
    • diff-drive kinematics, wheel slip           │
    • noisy ultrasonic (+ injectable bias)        │
    • obstacle stop, collision E-STOP             │
    • watchdog: E-STOP after 600 ms without hb    │
                                                  │
Next.js server ───────────────────────────────────┘
  /api/agent     ReAct loop: @anthropic-ai/sdk → OpenRouter (open models)
                 tools: get_twin_state, search_manual, move_to, set_speed_limit, stop, reconcile_twin
                 every actuating call → gate (lib/server/gate.ts)
                   1. hallucination guard   unknown tool/args/station, reconcile with nothing to reconcile
                   2. operation guard       manual consulted? E-STOP, link lost, sensor/twin DISAGREE
                   3. parameter validator   speed limits, QC-zone 0.5 m/s, A* route exists
                 pass → Ed25519-signed command; post-reply check flags claimed motion with no command
  /api/operator  E-STOP / reset (operator) and stop (supervisor), signed
  RAG            BM25 over knowledge/*.md (manual + safety procedures)
  Audit          data/audit.jsonl, SHA-256 hash chain, verified on every read
```

## Demo script

1. **Gate catches a limit:** "Take the parts to QC" → rejected (QC zone is 0.5 m/s). With a
   real model it reads the rejection and retries at 0.5 m/s on its own.
2. **Hallucination guard:** "Send it to the paint shop" → rejected, valid stations listed.
3. **Drift:** while moving, *Drop crate in path* → AGV stops, cross-check goes DISAGREE
   (unmapped obstacle), motion is blocked. "Something is blocking the AGV, fix it and continue
   to shipping" → reconcile the twin map, re-plan around the crate.
4. **Sensor fault:** *Sensor fault* then drive near a machine → DISAGREE (sensor fault),
   supervisor halts the AGV mid-route, the agent refuses to move it.
5. **Watchdog:** *Cut control link* → link LOST in the supervisor, plant E-STOPs itself after
   600 ms. Only the operator Reset clears it.
6. **Audit:** every request, gate decision, signed command, ack and fault is in the chain.
   Edit any line of `data/audit.jsonl` and the panel shows where the chain broke.

## Known limits

- The browser sends the twin state with each agent request; the server trusts it. Fine for a
  local demo, not for a multi-user deployment.
- A sensor fault is only detectable when something is within sensor range to compare against.
- Localisation is perfect (the plant reports its true pose); drift comes from unmapped
  obstacles and sensor faults, not odometry.
