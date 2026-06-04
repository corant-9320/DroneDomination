# Drone Domination — Combat Rules (Standalone Reference)

> This document is the single authoritative reference for all combat mechanics.
> It is designed to be readable and editable in any external tool without needing
> access to the codebase. All relevant attributes, formulas, and contextual data
> are included here.

---

## Table of Contents

1. [Unit Attributes](#1-unit-attributes)
2. [Hex Grid & Tile Properties](#2-hex-grid--tile-properties)
3. [Range & Distance](#3-range--distance)
4. [Orientation & Facing](#4-orientation--facing)
5. [Defence Power](#5-defence-power)
6. [Damage Formula (Core)](#6-damage-formula-core)
7. [Anti-Drone Penalty](#7-anti-drone-penalty)
8. [Anti-Air Weapon](#8-anti-air-weapon)
9. [Splash Damage](#9-splash-damage)
10. [Total Damage & Health](#10-total-damage--health)
11. [Defensive Formation](#11-defensive-formation)
12. [Electronic Warfare (EW)](#12-electronic-warfare-ew)
13. [Terrain Defence](#13-terrain-defence)
14. [Encirclement (Informational)](#14-encirclement-informational)
15. [Crossfire Bonus (Optional)](#15-crossfire-bonus-optional)
16. [Anti-Air Reaction Fire](#16-anti-air-reaction-fire)
17. [Movement & Attack Eligibility](#17-movement--attack-eligibility)
18. [Repair System](#18-repair-system)
19. [Attack Validation Rules](#19-attack-validation-rules)
20. [Simultaneous Resolution](#20-simultaneous-resolution)
21. [Constants Summary](#21-constants-summary)

---

## 1. Unit Attributes

Every unit is defined entirely by its attributes — there are no fixed unit classes.
All attribute values are integers. Ranges are hard-clamped during combat resolution.

| Attribute | Range | Description |
|-----------|-------|-------------|
| `maxHealth` | 1–5 | Maximum hit points. Actual HP = maxHealth × 10 (so 10–50 HP). |
| `kinetic` | 0–5 | Base attack power for direct (melee/close) damage. Determines gun length in icon. |
| `armour` | 0–5 | Passive damage reduction from incoming attacks. |
| `defence` | 0–5 | Electronic Warfare (EW) value. Contributes to nearby allies' defence via same-hex stacking. |
| `splashAttack` | 0–5 | Area-of-effect attack power. When chosen as the weapon mode, damages all enemy units in the target hex. |
| `rangeAttack` | 0–5 | Maximum attack range in hexes. 0 = melee only (range 1). |
| `wheeledMovement` | 0–5 | Movement points for ground/vehicle traversal. |
| `limbMovement` | 0–5 | Movement points for legged/spider traversal. |
| `flightMovement` | 0–5 | Movement points for aerial (drone) traversal. Also classifies unit as a **drone**. |
| `repair` | 0–5 | Repair capability — points of health restored per repair action to a friendly unit. |
| `antiAir` | 0–5 | Anti-air attack power — Anti-Air Fire weapon mode, only targets drones. Uses full damage formula (no drone penalty). |

### Constraints

- A unit **must** have exactly one movement type with at least 1 point (`wheeledMovement`, `limbMovement`, or `flightMovement`).
- A unit with `flightMovement ≥ 1` is classified as a **drone** (this affects incoming damage).
- `maxHealth` must be at least 1 if present.

### Unit Instance Properties (Non-Attribute)

| Property | Description |
|----------|-------------|
| `id` | Globally unique identifier. |
| `label` | Human-readable name (e.g. "Scout Alpha"). |
| `ownerId` | Faction / player ID that owns this unit. |
| `tileIndex` | Index of the hex tile this unit occupies. |
| `segment` | Which triangular sub-segment (0–5) within the hex the unit occupies. |
| `facing` | Direction the unit faces (0–5), set by last movement direction. |
| `currentHealth` | Current HP (0 to maxHealth × 10). Unit is destroyed at 0. |

---

## 2. Hex Grid & Tile Properties

The world is a Goldberg polyhedron — mostly hexagons with 12 pentagons.

### Tile Properties (Defending Hex Info)

| Property | Values | Combat Relevance |
|----------|--------|-----------------|
| `terrainType` | `grassland`, `plains`, `tundra`, `desert`, `ocean` | Terrain defence value (indirectly via elevation/forest). |
| `elevationType` | `flat`, `rolling`, `hills`, `mountain` | Directly contributes to terrain defence. Mountain is impassable to ground. |
| `forested` | `true` / `false` | +1 terrain defence. Only possible on grassland at non-mountain elevation. |
| `neighbours` | Array of 5 or 6 adjacent tile indices | Defines adjacency for movement, range, formation. |
| `sides` | 5 or 6 | Pentagon (5) or hexagon (6). |
| `ownerId` | Faction ID or empty | Territory ownership (not currently used in combat). |
| `cityId` | City ID or empty | Whether a city is on this tile (not currently used in combat). |
| `resourceType` | String or empty | Resource present (not currently used in combat). |
| `unitIds` | Array of unit IDs | Units present on the tile (up to 5 per tile). |

### Hex Segment Model

Each hex is subdivided into 6 triangular segments (0–5). Segment 0 faces `neighbour[0]`, proceeding clockwise. A maximum of **5 units** may occupy a single tile simultaneously (one segment must remain free).

---

## 3. Range & Distance

Range is measured as **graph distance** (BFS shortest path in hexes) between the attacker's tile and target's tile.

### Effective Attack Range

```
attackRange = max(rangeAttack, (kinetic > 0 ? 1 : 0), (antiAir > 0 ? 1 : 0))
```

- If `rangeAttack = 0` but `kinetic > 0`: effective range is 1 (melee).
- If only `antiAir > 0`: effective range is 1.
- `rangeAttack` of 2–5 allows attacking from that many hexes away.

### Validation

- `distance ≤ attackRange` → attack is valid.
- `distance > attackRange` or `distance < 0` (unreachable) → attack is invalid.

### Range Falloff

Declared attacks become less effective at longer distances.

Range efficiency is calculated from the graph distance between attacker and target:

```
rangeEfficiency = 1 - RANGE_FALLOFF_PER_HEX × max(0, distance - 1)
```

With `RANGE_FALLOFF_PER_HEX = 0.10`:

| Distance | Range Efficiency |
|----------|------------------|
| 1 | 1.00 |
| 2 | 0.90 |
| 3 | 0.80 |
| 4 | 0.70 |
| 5 | 0.60 |

Range efficiency modifies the weapon's base power before orientation bonus:

```
AttackPower = (BaseWeaponValue × ChassisAttackModifier × rangeEfficiency) + OrientationBonus
```

Range falloff applies to Direct Fire, Splash Fire, and declared Anti-Air Fire.
Range falloff does **not** apply to Anti-Air Reaction Fire.

---

## 4. Orientation & Facing

Each unit has a **facing** direction (0–5) representing which hex edge it points toward.

### Approach Direction

The **approach direction** is the direction from the defender's hex toward the attacker's hex:
- If adjacent: direct neighbour index lookup.
- If non-adjacent: BFS from defender toward attacker, first hop direction.

### Attack Arc Classification

The difference between the approach direction and defender's facing determines the arc:

```
diff = ((approachDirection - defenderFacing) mod 6 + 6) mod 6
```

| diff | Arc | Orientation Bonus |
|------|-----|-------------------|
| 0, 1, 5 | **Front** | +0 |
| 2, 4 | **Side** | +1 |
| 3 | **Rear** | +2 |

### Attack Power

```
AttackPower = (BaseWeaponValue × ChassisAttackModifier × rangeEfficiency) + orientationBonus
```

Where `BaseWeaponValue` is `kinetic`, `splashAttack`, or `antiAir` depending on weapon mode, clamped to [1, 5]. `ChassisAttackModifier` is based on movement type (see §7). `rangeEfficiency` is based on attack distance (see §3). `orientationBonus` is 0, 1, or 2 based on the arc. AttackPower may be a decimal — do not round before the damage formula.

For distance 1 attacks, `rangeEfficiency = 1.00`. For Anti-Air Reaction Fire, `rangeEfficiency` is not used.

---

## 5. Defence Power

Defence Power is the sum of four components, each individually clamped:

```
DefencePower = armour + EW + defensiveFormation + terrain
```

| Component | Source | Range |
|-----------|--------|-------|
| Armour | Target unit's `armour` attribute | 0–5 |
| EW | Sum of `defence` attributes of all friendly units in same hex (incl. self), capped at 5 | 0–5 |
| Defensive Formation | Count of adjacent friendly units (same hex different segment, or neighbouring hex), capped at 2 | 0–2 |
| Terrain | Based on tile's elevation + forest (see §13) | 0–4 |

### Effective Defence (Scaled)

```
EffectiveDefence = DefencePower × 0.75
```

The 0.75 scale factor ensures defence is meaningful without being overwhelming.

---

## 6. Damage Formula (Core)

The same ratio-based curve is used by all three weapon modes (Direct Fire, Splash Fire, Anti-Air Fire). The maximum possible damage is scaled by AttackPower:

```
MaxFormulaDamage = min(30, 6 × AttackPower)
Damage = round(1
             + (MaxFormulaDamage - 1)
             × AttackPower²
             / (AttackPower² + EffectiveDefence²))
Damage = clamp(Damage, 1, 30)
```

### Properties

- **Minimum damage**: 1 (weak attacks are never useless).
- **Maximum damage**: 30.
- **Weak attacks** can no longer deal 30 damage just because the target has zero defence.
- **Strong attacks** (AttackPower ≥ 5) can still reach 30 against undefended targets.
- AttackPower now affects both the attack/defence ratio **and** the maximum possible damage ceiling.
- When `AttackPower = EffectiveDefence`: Damage ≈ MaxFormulaDamage / 2.

### Expected Damage Against Zero Defence

| AttackPower | MaxFormulaDamage | Damage |
|-------------|------------------|--------|
| 1 | 6 | 6 |
| 2 | 12 | 12 |
| 3 | 18 | 18 |
| 4 | 24 | 24 |
| 5 | 30 | 30 |
| 6 | 30 | 30 |
| 7 | 30 | 30 |

### Input Clamping

Before calculation:
- `kinetic` clamped to [1, 5]
- `armour` clamped to [0, 5]
- `ew` clamped to [0, 5]
- `defensiveFormation` clamped to [0, 2]
- `terrain` clamped to [0, 4]

---

## 7. Drone Incoming Damage Modifiers

When the **target is a drone** (has `flightMovement ≥ 1`), incoming damage is modified by weapon mode.

| Weapon Mode | Target Is Drone? | Final Damage Multiplier |
|-------------|------------------|-------------------------|
| Direct Fire | Yes | 0.33 |
| Splash Fire | Yes | 0.50 |
| Anti-Air Fire | Yes | 1.00 |
| Any weapon | No | 1.00 |

Direct Fire damage against drones:
```
finalDamage = max(1, round(damage × DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER))
```

Splash Fire damage against drones:
```
finalDamage = max(1, round(damage × DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER))
```

Anti-Air Fire damage against drones:
```
finalDamage = damage
```

Anti-Air Fire is the dedicated anti-drone weapon and receives no damage penalty.

### Chassis Attack Modifiers (Outgoing)

Drones also deal reduced outgoing damage due to their chassis type. The modifier applies to all weapon modes before the orientation bonus is added:

```
AttackPower = (BaseWeaponValue × ChassisAttackModifier) + OrientationBonus
```

| Movement Type | Condition | ChassisAttackModifier |
|---------------|-----------|-----------------------|
| Tank | `wheeledMovement > 0` | 1.00 |
| Spider | `limbMovement > 0` | 0.75 |
| Drone | `flightMovement > 0` | 0.50 |

**Rationale**: Drones are balanced by lower outgoing weapon power, high mobility, strong resistance to Direct Fire, moderate resistance to Splash Fire, and full vulnerability to Anti-Air Fire.

---

## 8. Anti-Air Weapon

A unit with `antiAir > 0` can use Anti-Air Fire as a weapon mode, **only against drone targets**.

- Uses the **full damage formula** with `antiAir` as the attack value.
- Uses the same orientation bonus as other weapon modes (same arc).
- Uses the target's full DefencePower.
- **Not subject to the anti-drone penalty** (this IS the dedicated anti-drone weapon).
- Anti-Air Fire is a separate weapon mode — it is not additive with Direct or Splash damage.

```
AntiAirAttackPower = (antiAir × ChassisAttackModifier) + orientationBonus
MaxFormulaDamage = min(30, 6 × AntiAirAttackPower)
AntiAirDamage = round(1
                    + (MaxFormulaDamage - 1)
                    × AntiAirAttackPower²
                    / (AntiAirAttackPower² + EffectiveDefence²))
AntiAirDamage = clamp(AntiAirDamage, 1, 30)
```

Anti-Air remains unpenalised against drones (DRONE_ANTI_AIR_DAMAGE_MULTIPLIER = 1.00).

### Anti-Air Only Units

If a unit has ONLY `antiAir` (no `kinetic`, no `rangeAttack`, no `splashAttack`), it can **only target drones**. Attempting to attack a non-drone target is invalid.

---

## 9. Splash Damage

Units with `splashAttack > 0` can use Splash Fire as a weapon mode.

Splash Fire is a **separate weapon mode** — it is not a bonus added to direct fire. Only one weapon mode is resolved per attack.

### Splash Fire Validity

Splash Fire is valid if:
- `splashAttack > 0`
- The target hex is within effective range
- The target hex contains at least one enemy unit

### Splash Fire Damage Formula

For each enemy unit in the target hex:

```
SplashAttackPower = (splashAttack × ChassisAttackModifier) + orientationBonus
```

Orientation bonus applies **only to the originally selected target**. For all other units in the same hex, orientation is always front (no bonus):

```
SplashAttackPower = splashAttack × ChassisAttackModifier   (for non-primary units)
```

Then:

```
effectiveDefence = DefencePower × DEFENCE_SCALE
fullFormulaDamage = calculateFormulaDamage(SplashAttackPower, effectiveDefence)
splashDamage = max(1, round(fullFormulaDamage × SPLASH_SCALE))
```

If the affected unit is a drone, apply the drone incoming damage modifier after splash scaling:

```
splashDamage = max(1, round(splashDamage × DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER))
```

### Splash Target Area

Splash Fire affects **only enemy units in the target hex**. It does not affect:
- Units in neighbouring hexes
- Friendly units (enemy-occupied hexes cannot contain friendly units)

### Splash Scale Factor

`SPLASH_SCALE = 0.3` (30% of the full formula result per affected unit).

At 0.3 scale, splash becomes better than a same-value single-target attack when the target hex contains **4 or more enemy units**.

| Units in hex | Splash total (relative) |
|---|---|
| 1 | 30% |
| 2 | 60% |
| 3 | 90% |
| 4 | 120% |
| 5 | 150% |

---

## 10. Total Damage & Health

### One Weapon Per Attack

Each attack uses exactly one weapon mode. The game automatically evaluates all valid weapon modes and chooses the one with the highest expected total enemy damage. Damage from different weapon modes is **not additive**.

### Valid Weapon Modes

| Mode | Valid when | Attack value used | Drone incoming modifier |
|------|-----------|-------------------|-------------------------|
| Direct Fire | `kinetic > 0`, target in range | `(kinetic × chassisModifier × rangeEfficiency)` + orientation bonus | ×0.33 if target is drone |
| Splash Fire | `splashAttack > 0`, target hex has enemies | `(splashAttack × chassisModifier × rangeEfficiency)` (+ orientation for primary target only) | ×0.50 if affected unit is drone |
| Anti-Air Fire | `antiAir > 0`, target is a drone | `(antiAir × chassisModifier × rangeEfficiency)` + orientation bonus | ×1.00 (no penalty) |

### Weapon Score (for automatic selection)

- **Direct Fire score**: damage to selected target
- **Splash Fire score**: sum of splash damage to all enemy units in target hex
- **Anti-Air Fire score**: damage to selected drone target

The highest-scoring mode is chosen. Tie-break order:
1. Anti-Air preferred if target is a drone
2. Splash preferred if it damages more than one enemy unit
3. Direct preferred
4. Highest damage to the originally selected target

### Total Damage to Primary Target

```
totalDamage = damage from the single selected weapon mode only
```

### Health System

- Max HP = `maxHealth × 10` (range: 10–50).
- `currentHealth` starts at max and decreases with damage.
- `newHealth = clamp(currentHealth - damage, 0, 50)`
- Unit is **destroyed** when `currentHealth` reaches 0.
- Minimum damage applied is always 1 (no attack deals zero).

---

## 11. Defensive Formation

Adjacent friendly units provide a defence bonus to the target:

### Who Qualifies as Support

- Must be a **friendly** unit (same `ownerId`).
- Must NOT be the target itself.
- Must NOT be destroyed (`currentHealth > 0`).
- Must be in the **same hex** (different segment) OR an **adjacent hex** (neighbouring tile).

### Bonus

- Count qualifying supporters.
- **Cap at 2** (even if more friendly units are adjacent).
- Each support unit adds +1 to the DefencePower.

---

## 12. Electronic Warfare (EW)

EW defence is contributed by friendly units stacked in the **same hex** as the target.

### Calculation

```
EW = min(5, sum of defence attributes of all same-hex friendly units including target)
```

### Rules

- Only units in the **exact same tile** contribute (not adjacent tiles).
- The target's own `defence` attribute **counts** toward its own EW.
- Destroyed units (`currentHealth ≤ 0`) do not contribute.
- Enemy units do not contribute.
- Capped at 5.

---

## 13. Terrain Defence

The defending hex's terrain provides a defence bonus based on elevation and forest:

| Elevation | Defence Value |
|-----------|--------------|
| `flat` | 0 |
| `rolling` | 0 |
| `hills` | 1 |
| `mountain` | 3 |

| Forest | Defence Value |
|--------|--------------|
| Not forested | 0 |
| Forested | +1 |

```
terrainDefence = min(4, elevationValue + forestValue)
```

**Maximum terrain defence: 4** (e.g. mountain + forest is impossible in generation, but capped regardless).

### Terrain Type Constraints (World Generation)

- `ocean` — always flat, never forested.
- `tundra` — has elevation, never forested.
- `desert` — has elevation (flat or rolling only), never forested.
- `plains` — has elevation, never forested.
- `grassland` — has elevation, can be forested.

---

## 14. Encirclement (Informational)

A unit is **encircled** if enemy units occupy **3 or more distinct adjacent directions** around it.

### Calculation

- Check all enemy units that are alive and in neighbouring hexes of the target.
- Count how many distinct neighbour slots (directions) are occupied by enemies.
- If 3+ directions occupied → encircled.

**Note**: Encirclement does NOT currently affect the damage formula. It is tracked for informational/UI purposes only and may be used in future rules.

---

## 15. Crossfire Bonus (Optional)

Crossfire rewards coordinated attacks from multiple angles.

### Condition

- The attacker is hitting the target from **side or rear** arc.
- At least **1 other attacker** is also targeting the same unit from a **side or rear** arc in the same resolution window.

### Bonus

- +1 damage to each qualifying attacker's attack.
- Only applies to attackers that themselves are in side/rear position.

**Note**: This is an optional mechanic and may not be active in all resolution modes.

---

## 16. Anti-Air Reaction Fire

Anti-Air Reaction Fire is a defensive response triggered exclusively against air/drone units. Ground units never trigger Reaction Fire, and ground units never perform Reaction Fire against other ground units.

### Eligibility (Per Reacting Unit)

A unit may perform Anti-Air Reaction Fire only if **all** of the following are true:

1. The moving or attacking unit is a **drone** (`flightMovement ≥ 1`).
2. The reacting unit is an **enemy** of the drone (`ownerId` differs).
3. The reacting unit has `antiAir > 0`.
4. The reacting unit is **alive** (`currentHealth > 0`).
5. The reacting unit has **not already reacted** during this drone movement/attack action.
6. The drone **enters, passes over, or attacks** a tile occupied by the reacting unit.

Anti-Air Reaction Fire uses **Anti-Air Fire only**. It may not use Direct Fire, Splash Fire, or automatic best-weapon selection.

### Trigger Cases

**1. Fly-over trigger**
A drone triggers Anti-Air Reaction Fire when its movement path enters an enemy-occupied tile containing one or more enemy units with `antiAir > 0`. This represents the drone flying over a position protected by anti-air weapons.

**2. Attack trigger**
A drone triggers Anti-Air Reaction Fire when it attacks a target in an enemy-occupied tile containing one or more enemy units with `antiAir > 0`. This represents local anti-air fire against a drone making an attack run.

### Multiple Anti-Air Units in the Same Tile

If multiple enemy `antiAir` units are present in the triggered tile, each eligible unit may react once, subject to the reaction limit.

- Each reacting unit resolves Anti-Air Fire **separately** against the drone.
- Each reacting unit can react **at most once** during a single drone movement/attack action.
- Recommended default: allow each eligible unit to react once (stacking anti-air is a strong but explicit defensive choice).
- Optional simplification: only the unit with the highest `antiAir` value reacts.

### Damage Formula

Anti-Air Reaction Fire uses the Anti-Air Fire damage rules, but **orientation bonus is 0** (snap shot against an airborne target — no ground-facing arc applies):

```
AntiAirReactionAttackPower = antiAir × ChassisAttackModifier
MaxFormulaDamage = min(30, 6 × AntiAirReactionAttackPower)
Damage = round(1 + (MaxFormulaDamage - 1)
             × AntiAirReactionAttackPower²
             / (AntiAirReactionAttackPower² + EffectiveDefence²))
Damage = clamp(Damage, 1, 30)
```

Anti-Air Reaction Fire damage is **not** reduced by drone incoming damage modifiers.

### Drone Defence Against Reaction Fire

The drone uses its normal DefencePower:

```
DefencePower = armour + EW + defensiveFormation + terrain
```

- `armour`, `EW`, and `defensiveFormation` apply normally.
- `terrain` is **0** for airborne movement (drones in flight do not benefit from ground terrain cover).
- If simpler implementation is preferred, use the existing `calculateEffectiveDefence` function unchanged.

### Drone Pathing (Default)

Default air pathing uses the **shortest direct route** to the target:

- Ignore enemy unit occupancy when calculating the path.
- Ignore ground terrain restrictions (mountain, ocean).
- Prefer direct shortest paths over safer paths.
- If multiple shortest paths exist, any deterministic tie-breaker may be used.

Drones may therefore fly over enemy-occupied tiles by default and may trigger Anti-Air Reaction Fire along the way.

### Ground vs. Air Pathing Rules

| Unit Type | Enemy-Occupied Tiles | Pathing Behaviour |
|-----------|---------------------|-------------------|
| Ground (tank/spider) | Block normal movement | Cannot enter except as an attack request |
| Drone / air | Do not block pathing | May pass over freely; triggers Anti-Air Reaction Fire |

A drone may **not** end its movement stacked with enemy units unless the action is an attack. Moving or attacking into an enemy-occupied destination tile is still interpreted as an attack request.

### Attack Sequence (Drone Attacking)

1. Player selects drone attacker and target.
2. Game calculates the direct drone path to the target.
3. Check fly-over Anti-Air Reaction Fire for enemy `antiAir` units in tiles along the path (excluding start tile).
4. If the drone survives, check attack-trigger Anti-Air Reaction Fire from eligible `antiAir` units in the target tile.
5. If the drone survives, resolve the drone's attack normally.
6. If the drone is destroyed by Anti-Air Reaction Fire, its attack does not resolve.

An `antiAir` unit that already fired because the drone flew over its tile does **not** fire again when the drone attacks from or into that same tile during the same action.

### Move Sequence (Drone Moving Without Attacking)

1. Game calculates the direct drone path to the destination.
2. For each tile entered along the path, check for eligible `antiAir` units.
3. If a path tile contains enemy units with `antiAir > 0`, eligible units may make Anti-Air Reaction Fire.
4. If the drone is destroyed, movement stops immediately.
5. If the drone survives all tiles, it completes its movement.

### Pseudocode

```
function getDirectDronePath(drone, destinationTile, gameState):
    return shortestPath(
        startTile = drone.tileIndex,
        endTile = destinationTile,
        ignoreEnemyOccupancy = true,
        ignoreGroundTerrainRestrictions = true
    )

function resolveDroneMove(drone, destinationTile, gameState):
    path = getDirectDronePath(drone, destinationTile, gameState)
    reactionState = createEmptyReactionState()
    for each tile in path excluding starting tile:
        resolveAntiAirReactionFireForTile(drone, tile, reactionState, gameState)
        if drone.currentHealth <= 0:
            stop movement
            return destroyed
    move drone to destinationTile
    return success

function resolveDroneAttack(drone, selectedTarget, gameState):
    path = getDirectDronePath(drone, selectedTarget.tileIndex, gameState)
    reactionState = createEmptyReactionState()
    for each tile in path excluding starting tile:
        resolveAntiAirReactionFireForTile(drone, tile, reactionState, gameState)
        if drone.currentHealth <= 0:
            return attackCancelledDroneDestroyed
    resolveAntiAirReactionFireForTile(drone, selectedTarget.tileIndex, reactionState, gameState)
    if drone.currentHealth <= 0:
        return attackCancelledDroneDestroyed
    resolveNormalAttack(drone, selectedTarget, gameState)
    return success

function resolveAntiAirReactionFireForTile(drone, tileIndex, reactionState, gameState):
    if drone.flightMovement <= 0:
        return
    enemyUnits = getAliveEnemyUnitsInTile(tileIndex, drone.ownerId, gameState)
    antiAirUnits = filter enemyUnits where unit.antiAir > 0
    for each antiAirUnit in antiAirUnits:
        if reactionState.hasReacted(antiAirUnit.id):
            continue
        damage = calculateAntiAirReactionDamage(antiAirUnit, drone, gameState)
        applyDamage(drone, damage)
        reactionState.markReacted(antiAirUnit.id)
        if drone.currentHealth <= 0:
            break

function calculateAntiAirReactionDamage(antiAirUnit, drone, gameState):
    chassisModifier = getChassisAttackModifier(antiAirUnit)
    attackPower = antiAirUnit.antiAir * chassisModifier
    effectiveDefence = calculateEffectiveDefenceForAntiAirReaction(drone, gameState)
    damage = calculateFormulaDamage(attackPower, effectiveDefence)
    return damage

function calculateEffectiveDefenceForAntiAirReaction(drone, gameState):
    defencePower =
        calculateArmour(drone)
        + calculateEW(drone, gameState)
        + calculateDefensiveFormation(drone, gameState)
    terrain = 0   // airborne — no terrain cover
    defencePower = defencePower + terrain
    return defencePower * DEFENCE_SCALE
```

---

## 17. Movement & Attack Eligibility

### Movement Costs (Per Hex Entered)

| Mode | First Hex | Subsequent Hexes |
|------|-----------|------------------|
| **Tank** (wheeledMovement) | 1 MP | Flat/clear: 2 MP, Hill OR Forest: 3 MP, Hill AND Forest: 4 MP |
| **Spider** (limbMovement) | 1 MP | All terrain: 3 MP (ignores terrain) |
| **Drone** (flightMovement) | 1 MP | All terrain: 1 MP (ignores terrain) |

- Mountain and ocean are **impassable** for ground units (tanks/spiders).
- Drones can fly over any terrain.

### Attack After Movement

- A unit needs **at least 1 MP remaining** after movement to attack.
- Pivot (changing facing within same hex) is free but requires MP remaining and no prior move that turn.
- Once a unit has moved to a different hex, facing is locked for the rest of the turn.

### Turn State Rules

- Each unit has a movement budget = its movement attribute value (1–5 MP).
- Movement points are spent as hexes are entered.
- A unit that has spent all MP cannot attack or pivot.

---

## 18. Repair System

Units with `repair ≥ 1` can heal friendly units in the same hex.

### Repair as a Turn Action

Repair is a unit action equivalent to attacking for turn-state purposes. A unit may perform **at most one action per turn** — either attack or repair, not both.

- A unit may **move and then repair**, provided it has at least 1 MP remaining after movement.
- A unit that has already attacked this turn may **not** repair.
- A unit that has already repaired this turn may **not** attack.
- Each repair unit may perform **at most one repair action per turn**.
- Multiple repair units may repair the **same target** in the same turn, provided each repairer has not already used its action.

### Repair Formula

```
RepairRate = 2 + (targetMaxHealth - 10) / 20
RepairAmount = roundHalfUp(RP × RepairRate)
NewHealth = min(targetMaxHealth, currentHealth + RepairAmount)
```

Where:
- `RP` = repairer's `repair` attribute (1–5).
- `targetMaxHealth` = target's `maxHealth × 10` (10–50 HP range).
- `roundHalfUp` = standard half-up rounding.

### Repair Validation

| Condition | Requirement |
|-----------|-------------|
| Repairer capability | `repair ≥ 1` |
| Repairer alive | `currentHealth > 0` |
| Target alive | `currentHealth > 0` |
| Same tile | Repairer and target on same `tileIndex` |
| Same faction | Same `ownerId` |
| Not at full health | `currentHealth < maxHealth × 10` |
| Not self | Repairer ≠ target |
| MP remaining | Repairer has at least 1 MP remaining |
| Action not used | Repairer has not already attacked or repaired this turn |

---

## 19. Attack Validation Rules

An attack is **invalid** (and deals no damage) if any of these fail:

| Check | Rule |
|-------|------|
| Attacker exists | Unit must be found in the unit list. |
| Target exists | Unit must be found in the unit list. |
| Attacker alive | `currentHealth > 0` |
| Target alive | `currentHealth > 0` |
| Not friendly fire | `attacker.ownerId ≠ target.ownerId` |
| Anti-Air targeting | If attacker has ONLY `antiAir` (no attack/range/splash), target must be a drone. |
| Range check | Graph distance ≤ effective attack range. |
| Turn ownership | Only the active faction may attack (server enforcement). |

### Anti-Air Reaction Fire — Validation Exception

Anti-Air Reaction Fire is **not** a normal player-declared attack. It is a defensive reaction triggered by drone movement or drone attack. It ignores normal attack validation requirements that do not apply to reactions:

- Does not require active faction ownership.
- Does not require player-declared target selection.
- Does not use normal `rangeAttack` range.
- Does not require the drone to be in the reacting unit's front arc.

It still requires:

| Check | Rule |
|-------|------|
| Reacting unit exists | Unit must be found in the unit list. |
| Reacting unit alive | `currentHealth > 0` |
| Reacting unit has anti-air | `antiAir > 0` |
| Moving/attacking unit is a drone | `flightMovement ≥ 1` |
| Units are enemies | `reacting.ownerId ≠ drone.ownerId` |
| Not already reacted | Reacting unit has not fired during this drone movement/attack action. |

---

## 20. Simultaneous Resolution

When two units attack each other in the same resolution window:

1. Snapshot both units' health.
2. Resolve A → B (using snapshot health).
3. Restore both to snapshot.
4. Resolve B → A (using snapshot health).
5. Apply both damage results simultaneously.

Neither attacker gets priority — both fire at full health.

---

## 21. Constants Summary

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFENCE_SCALE` | 0.75 | Multiplier applied to DefencePower to get EffectiveDefence. |
| `MAX_DAMAGE` | 30 | Maximum damage from a single damage formula evaluation. |
| `MIN_DAMAGE` | 1 | Minimum damage — no attack is completely useless. |
| `DAMAGE_PER_ATTACK_POWER` | 6 | Maximum possible damage contribution per point of AttackPower before the global cap is applied. |
| `SPLASH_SCALE` | 0.3 | Splash Fire deals 30% of full formula damage to each enemy unit in the target hex. |
| `RANGE_FALLOFF_PER_HEX` | 0.10 | AttackPower is reduced by 10% for each hex of attack distance beyond 1. |
| `TANK_ATTACK_MODIFIER` | 1.00 | Outgoing weapon power multiplier for wheeled (tank) units. |
| `SPIDER_ATTACK_MODIFIER` | 0.75 | Outgoing weapon power multiplier for limb/spider units. |
| `DRONE_ATTACK_MODIFIER` | 0.50 | Outgoing weapon power multiplier for flight/drone units. |
| `DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER` | 0.33 | Final Direct Fire damage multiplier when the target is a drone. |
| `DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER` | 0.50 | Final Splash Fire damage multiplier when the affected unit is a drone. |
| `DRONE_ANTI_AIR_DAMAGE_MULTIPLIER` | 1.00 | Final Anti-Air damage multiplier when the target is a drone (no penalty). |
| `HP_PER_POINT` | 10 | Each maxHealth point = 10 actual health units. |
| `MAX_UNITS_PER_TILE` | 5 | Maximum units per hex (one segment must stay free). |
| `EW_CAP` | 5 | Maximum EW contribution from same-hex allies. |
| `FORMATION_CAP` | 2 | Maximum defensive formation support count. |
| `TERRAIN_DEFENCE_CAP` | 4 | Maximum terrain defence value. |
| `REACTION_FIRE_AIR_ONLY` | true | Reaction Fire only triggers against drone / air units. |
| `REACTION_FIRE_USES_ANTI_AIR_ONLY` | true | Reaction Fire may only use Anti-Air Fire. |
| `DRONE_PATHING_IGNORES_ENEMY_OCCUPANCY` | true | Drone pathing ignores enemy-occupied tiles. |
| `DRONE_DEFAULT_PATHING_DIRECT` | true | Drone default pathing uses a direct shortest route rather than avoiding danger. |

**Implementation note**: Only one weapon mode is resolved per attack. Direct, Splash, and Anti-Air damage are not additive. Reaction Fire is an anti-air-only mechanic — ground units do not trigger it and do not perform it against other ground units.

---

## Appendix A: Full Damage Worked Example

**Attacker**: attack=3, splashAttack=2, antiAir=0, approaching from rear.
**Defender**: armour=2, drone=no, on hills+forest tile, 1 same-hex EW ally (defence=3), 2 adjacent friendlies.

**Scenario A: Direct Fire (single target)**

1. **Orientation**: Rear → bonus = +2 → AttackPower = 3 + 2 = 5
2. **Defence**: armour(2) + EW(3) + formation(2) + terrain(1+1=2) = 9
3. **EffectiveDefence**: 9 × 0.75 = 6.75
4. **MaxFormulaDamage**: min(30, 6 × 5) = 30
5. **Damage**: round(1 + (30 - 1) × 25 / (25 + 45.5625)) = round(1 + 725/70.5625) = round(11.27) = **11**
6. **Direct Fire score**: 11

**Scenario B: Splash Fire (3 enemies in target hex)**

For the primary target (rear orientation):
- SplashAttackPower = 2 + 2 = 4, MaxFormulaDamage = min(30, 24) = 24
- AP² = 16, ED² = 45.5625
- Full = round(1 + (24-1)×16/(16+45.5625)) = round(1+5.98) = 7
- splashDamage = max(1, round(7 × 0.3)) = max(1, 2) = **2**

For each other enemy in the hex (front orientation, same defence):
- SplashAttackPower = 2, MaxFormulaDamage = min(30, 12) = 12
- AP² = 4, ED² = 45.5625
- Full = round(1 + (12-1)×4/(4+45.5625)) = round(1+0.89) = 2
- splashDamage = max(1, round(2 × 0.3)) = max(1, 1) = **1**

Splash Fire score = 2 + 1 + 1 = **4** (3 enemies)

**Result**: Direct Fire (score 11) > Splash Fire (score 4) → **Direct Fire chosen, 11 damage**.

---

## Appendix B: Defending Hex Summary Checklist

When evaluating combat for a defending unit, these tile/formation properties matter:

- [ ] Tile elevation type (flat/rolling/hills/mountain)
- [ ] Tile forested status
- [ ] Friendly units in same hex (EW contributions)
- [ ] Friendly units in same hex or adjacent hexes (formation support)
- [ ] Enemy directions around the tile (encirclement tracking)
- [ ] Defender's facing direction (determines arc for incoming attacks)
- [ ] Tile's neighbour list (adjacency for formation and approach calculation)

---

## Appendix C: Attribute Interaction Matrix

| Attacking Attribute | Affected By | Special Rules |
|--------------------|-------------|---------------|
| `kinetic` | Chassis modifier, orientation, DefencePower, drone incoming modifier (×0.33) | Direct Fire weapon mode |
| `splashAttack` | Chassis modifier, DefencePower (per victim), SPLASH_SCALE, drone incoming modifier (×0.50) | Splash Fire weapon mode — hits all enemies in target hex only |
| `antiAir` | Chassis modifier, orientation, DefencePower | Anti-Air Fire weapon mode — only targets drones, no drone incoming penalty |
| `rangeAttack` | — | Determines max attack distance, does not add damage directly |

| Defending Attribute | Contribution | Cap |
|--------------------|--------------|-----|
| `armour` | Direct to DefencePower | 5 |
| `defence` (EW) | Adds to same-hex allies' DefencePower | Sum capped at 5 |
| `flightMovement` | Classifies as drone → triggers drone incoming damage modifiers on incoming Attack/Splash | — |

| Contextual Factor | Contribution | Cap |
|-------------------|--------------|-----|
| Terrain (elevation) | hills=1, mountain=3 | — |
| Terrain (forest) | +1 | — |
| Terrain total | elevation + forest | 4 |
| Formation (adj. friendlies) | +1 per friendly | 2 |
| Orientation bonus | front=0, side=+1, rear=+2 | 2 |
| Chassis modifier (outgoing) | tank=1.00, spider=0.75, drone=0.50 | — |
