# AGV Safety Procedures

## E-STOP

An E-STOP cuts drive power immediately and latches. While latched the AGV rejects every
motion command. Causes: operator E-STOP button, watchdog timeout, collision detection.
Only a human operator may reset an E-STOP, from the operator panel, after confirming the
area is clear. The AI agent must never attempt to reset an E-STOP and must tell the
operator to do it.

## Watchdog

The fleet controller sends a heartbeat every 200 ms. If the AGV hears no heartbeat for
600 ms it triggers an E-STOP on its own. Separately, if the controller receives no AGV
telemetry for 600 ms, it treats the link as lost and refuses to issue motion commands
until telemetry resumes.

## Signed commands

Every command, including E-STOP, is signed by the fleet controller with Ed25519. The AGV
verifies the signature, the session, the 15 s expiry and that the command ID has never been
used before. Anything else is rejected and logged.

## Sensor cross-validation (digital twin)

The twin predicts what the forward sensor should read from the AGV pose and the twin map.
The plant reports what it actually reads. States:

- SKIP: both readings beyond the 4 m sensor range, nothing to compare.
- AGREE: readings within 0.25 m.
- DISAGREE: mismatch above 0.25 m for 3 consecutive frames. All motion commands are
  blocked until the disagreement is resolved. Five agreeing frames return to AGREE.

Diagnosis of a DISAGREE:

- Sensor reads CLOSER than the twin expects: there is a physical object the twin map does
  not know about (unmapped obstacle). Resolve by reconciling the twin map (reconcile_twin),
  which adds the detected object to the map so routes plan around it.
- Sensor reads FARTHER than the twin expects: the sensor is faulty. A sensor cannot see
  through a mapped wall, so the reading is untrustworthy and the obstacle stop cannot be
  relied on. Do not move the AGV. Do not reconcile. Ask the operator for maintenance and
  wait for the fault to be cleared.

## Audit

Every request, gate decision, signed command, plant acknowledgement and operator action is
written to a hash-chained audit log. Each entry includes the hash of the previous entry,
so any edit or deletion is detectable.
