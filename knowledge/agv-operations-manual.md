# AGV-01 Operations Manual

AGV-01 is a differential-drive autonomous guided vehicle that moves parts between stations
on the assembly floor. It has two driven wheels, a rear caster and a forward ultrasonic
range sensor. Footprint 0.8 m x 0.6 m. Floor area 20 m x 12 m.

## Stations

| Station ID  | Purpose                               |
|-------------|---------------------------------------|
| RECEIVING   | Inbound parts dock, north-west corner |
| ASSEMBLY_A  | Assembly cell A, north side           |
| ASSEMBLY_B  | Assembly cell B, north side           |
| QC          | Quality control bench, north-east     |
| SHIPPING    | Outbound dock, south-east corner      |
| CHARGER     | Charging bay, south-west corner       |

Only these six station IDs are valid destinations. There is no paint shop, warehouse,
loading bay or maintenance station on this floor. Requests for any other destination must
be refused and the operator told which stations exist.

## Speed limits

- Maximum travel speed: 1.2 m/s.
- Default travel speed: 0.8 m/s.
- Minimum commanded speed: 0.1 m/s.
- QC zone: within 3 m of the QC bench the AGV must not exceed 0.5 m/s, because inspectors
  work on foot around the bench. Any route that ends at QC must be commanded at 0.5 m/s or
  less.
- The fleet speed limit (set_speed_limit) caps every route. It persists until changed.

## Routing

Routes are planned by the fleet controller on a 25 cm grid around all known obstacles,
keeping at least 0.6 m between the AGV centre and any obstacle. If no route exists the
command is refused. The AGV follows the route waypoint by waypoint.

## Obstacle stop

The AGV stops automatically when its forward ultrasonic reading falls below 0.5 m while
driving forward. It then holds in the BLOCKED state until it receives a new command. A
blocked AGV should be re-routed only after the twin map has been reconciled with the
obstacle; otherwise the planner will route straight back into it.

## Battery and charging

Return to CHARGER at the end of a shift or when instructed. The AGV parks facing north in
the charging bay.
