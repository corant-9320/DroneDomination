# Requirements Document

## Introduction

The Drone Domination unit test suite has good breadth but uneven depth. Several critical pure functions
in `combatMath.ts` are untested, the `shared/unitNaming.ts` module has zero dedicated tests, and
`combat.ts` has key branches — weapon selection, EW weapon-mode multipliers, anti-air-only validation,
reaction fire on multi-tile drone paths, and simultaneous resolution — that are either absent or
covered only indirectly.

This document captures the requirements for a focused test-improvement pass that adds direct,
behavioural tests for every significant gap identified in the design. The goal is not 100 % line
coverage but meaningful confidence: every significant formula, branch, and validation rule must be
exercised by at least one test that would fail if the logic were subtly wrong.

## Glossary

- **CombatMath**: The module `src/world/combatMath.ts`. Contains all stateless arithmetic used by
  the combat engine (range efficiency, chassis modifiers, drone incoming-damage modifiers, core
  damage formula).
- **Combat**: The module `src/world/combat.ts`. Orchestrates full attack resolution, weapon mode
  selection, anti-air reaction fire, and simultaneous resolution.
- **UnitNaming**: The module `shared/unitNaming.ts`. Pure naming tables and the
  `buildUnitNameParts` function used by both client and server.
- **Drone**: A unit whose `flightMovement` attribute is ≥ 1.
- **Ground unit**: A unit with `wheeledMovement > 0` or `limbMovement > 0` and no `flightMovement`.
- **Tank**: A unit with `wheeledMovement > 0` (and no limb/flight movement). ChassisAttackModifier = 1.00.
- **Spider**: A unit with `limbMovement > 0` (and no flight movement). ChassisAttackModifier = 0.75.
- **RangeEfficiency**: `1 − RANGE_FALLOFF_PER_HEX × max(0, distance − 1)`, clamped to [0, 1].
- **AttackPower**: `(BaseWeaponValue × ChassisAttackModifier × RangeEfficiency) + OrientationBonus`.
- **EffectiveDefence**: `DefencePower × DEFENCE_SCALE` (DEFENCE_SCALE = 0.75).
- **WeaponMode**: One of `'direct'`, `'splash'`, `'antiAir'`.
- **EW_EFFECTIVENESS_DIRECT**: 0.50 — EW multiplier when the incoming weapon is direct (kinetic).
- **EW_EFFECTIVENESS_SPLASH**: 0.75 — EW multiplier when the incoming weapon is splash.
- **EW_EFFECTIVENESS_ANTIAIR**: 1.00 — EW multiplier when the incoming weapon is anti-air or reaction.
- **Simultaneous resolution**: The mechanic in `resolveSimultaneousAttacks` where both attackers'
  health is snapshotted before either result is applied, so neither unit gets temporal priority.
- **UnitNameParts**: The `{ movementKey, speedWord, typeWord, descriptors }` struct returned by
  `buildUnitNameParts`.

---

## Requirements

### Requirement 1: combatMath.ts — Range Efficiency

**User Story:** As a developer, I want direct unit tests for `calculateRangeEfficiency`, so that any
regression in the range-falloff formula is caught immediately rather than buried in integration tests.

#### Acceptance Criteria

1. WHEN `calculateRangeEfficiency` is called with distance 1, THE CombatMath module SHALL return
   exactly 1.00.
2. WHEN `calculateRangeEfficiency` is called with distance 2, THE CombatMath module SHALL return
   exactly 0.90.
3. WHEN `calculateRangeEfficiency` is called with distance 5, THE CombatMath module SHALL return
   exactly 0.60.
4. WHEN `calculateRangeEfficiency` is called with distance 11 or greater, THE CombatMath module
   SHALL return 0 (floor clamp).
5. WHEN `calculateRangeEfficiency` is called with distance 0 or a negative value, THE CombatMath
   module SHALL treat the input as distance 1 and return 1.00.
6. FOR ALL integer distances d ≥ 1, `calculateRangeEfficiency(d + 1)` SHALL be less than or equal to
   `calculateRangeEfficiency(d)` (monotonically non-increasing).

---

### Requirement 2: combatMath.ts — Chassis Attack Modifier

**User Story:** As a developer, I want direct unit tests for `getChassisAttackModifier`, so that the
three chassis multiplier branches (drone 0.50, spider 0.75, tank 1.00) are each covered by a test
that would fail if the wrong constant were returned.

#### Acceptance Criteria

1. WHEN `getChassisAttackModifier` is called with a drone unit (`flightMovement ≥ 1`), THE CombatMath
   module SHALL return 0.50.
2. WHEN `getChassisAttackModifier` is called with a spider unit (`limbMovement ≥ 1` and no
   `flightMovement`), THE CombatMath module SHALL return 0.75.
3. WHEN `getChassisAttackModifier` is called with a tank unit (`wheeledMovement ≥ 1` and no limb or
   flight movement), THE CombatMath module SHALL return 1.00.
4. WHEN `getChassisAttackModifier` is called with a unit that has no movement attributes, THE
   CombatMath module SHALL return 1.00 (default tank modifier).
5. FOR ALL units, `getChassisAttackModifier` SHALL return a value in {0.50, 0.75, 1.00}.

---

### Requirement 3: combatMath.ts — Modified Attack Power

**User Story:** As a developer, I want direct unit tests for `calculateModifiedAttackPower`, so that
the formula composition (chassis × range efficiency + orientation bonus) is verified and the
non-negative lower bound is enforced.

#### Acceptance Criteria

1. WHEN `calculateModifiedAttackPower` is called with a tank unit, base weapon value 3, orientation
   bonus 1, and distance 1, THE CombatMath module SHALL return `3 × 1.00 × 1.00 + 1 = 4.0`.
2. WHEN `calculateModifiedAttackPower` is called with a drone unit, base weapon value 3, orientation
   bonus 0, and distance 1, THE CombatMath module SHALL return `3 × 0.50 × 1.00 + 0 = 1.5`.
3. WHEN `calculateModifiedAttackPower` is called with a tank unit, base weapon value 3, orientation
   bonus 0, and distance 2, THE CombatMath module SHALL return `3 × 1.00 × 0.90 + 0 = 2.7`.
4. IF `calculateModifiedAttackPower` would produce a value less than 0.01, THEN THE CombatMath
   module SHALL return 0.01 (minimum to prevent zero-division in the damage formula).
5. FOR ALL valid unit and weapon inputs, `calculateModifiedAttackPower` SHALL return a value ≥ 0.01.

---

### Requirement 4: combatMath.ts — Drone Incoming Damage Modifier

**User Story:** As a developer, I want direct unit tests for `applyDroneIncomingDamageModifier`, so
that the per-mode reduction factors (direct ×0.33, splash ×0.50, antiAir ×1.00) and the minimum-1
floor are each asserted at the function boundary rather than only observable through full
`resolveAttack` integration tests.

#### Acceptance Criteria

1. WHEN `applyDroneIncomingDamageModifier` is called with mode `'direct'` and a drone target with
   incoming damage 18, THE CombatMath module SHALL return `max(1, round(18 × 0.33)) = 6`.
2. WHEN `applyDroneIncomingDamageModifier` is called with mode `'splash'` and a drone target with
   incoming damage 10, THE CombatMath module SHALL return `max(1, round(10 × 0.50)) = 5`.
3. WHEN `applyDroneIncomingDamageModifier` is called with mode `'antiAir'` and a drone target, THE
   CombatMath module SHALL return the original damage value unchanged.
4. WHEN `applyDroneIncomingDamageModifier` is called with any mode and a non-drone target, THE
   CombatMath module SHALL return the original damage value unchanged.
5. FOR ALL drone targets and all modes `'direct'` or `'splash'`, the result SHALL be ≥ 1 (minimum
   damage floor enforced).
6. FOR ALL drone targets and modes `'direct'` or `'splash'`, the result SHALL be ≤ the input damage
   (the modifier never amplifies damage against drones).

---

### Requirement 5: combatMath.ts — Core Damage Formula Bounds and Monotonicity

**User Story:** As a developer, I want property-level assertions on `calculateFormulaDamage`, so that
the bounded-output contract [1, 30] and the monotonicity relationships are verified across a wide
range of inputs.

#### Acceptance Criteria

1. FOR ALL attack-power values and effective-defence values, `calculateFormulaDamage` SHALL return a
   value in the range [1, 30] (bounds enforced by MIN_DAMAGE and MAX_DAMAGE clamps).
2. FOR ALL fixed effective-defence values, if attackPower1 < attackPower2 then
   `calculateFormulaDamage(attackPower1, ed)` SHALL be ≤ `calculateFormulaDamage(attackPower2, ed)`
   (monotonically non-decreasing in attack power).
3. FOR ALL fixed attack-power values, if ed1 < ed2 then `calculateFormulaDamage(ap, ed1)` SHALL be ≥
   `calculateFormulaDamage(ap, ed2)` (monotonically non-increasing in effective defence).
4. WHEN `calculateFormulaDamage` is called with attack power 1 and zero effective defence, THE
   CombatMath module SHALL return 6 (MaxFormulaDamage = min(30, 6×1) = 6; no defence → full max).
5. WHEN `calculateFormulaDamage` is called with attack power 5 and zero effective defence, THE
   CombatMath module SHALL return 30 (maximum possible damage).
6. WHEN `calculateFormulaDamage` is called with attack power 1 and maximum effective defence (5+5+1+4
   components at DEFENCE_SCALE = 0.75), THE CombatMath module SHALL return 1 (minimum possible
   damage).

---

### Requirement 6: shared/unitNaming.ts — New Test Coverage

**User Story:** As a developer, I want a dedicated test file for `shared/unitNaming.ts`, so that the
naming tables and `buildUnitNameParts` logic have at least one test that would fail for every
significant incorrectness.

#### Acceptance Criteria

1. WHEN `buildUnitNameParts` is called with attributes that include `flightMovement ≥ 1`, THE
   UnitNaming module SHALL choose `'flightMovement'` as the `movementKey` regardless of whether
   `limbMovement` or `wheeledMovement` are also present.
2. WHEN `buildUnitNameParts` is called with attributes that include `limbMovement ≥ 1` but no
   `flightMovement`, THE UnitNaming module SHALL choose `'limbMovement'` as the `movementKey`.
3. WHEN `buildUnitNameParts` is called with attributes that include only `wheeledMovement ≥ 1`, THE
   UnitNaming module SHALL choose `'wheeledMovement'` as the `movementKey`.
4. WHEN `buildUnitNameParts` is called with `flightMovement = 1`, THE UnitNaming module SHALL set
   `speedWord` to `'Loitering'` (SPEED_NAMES[1]).
5. WHEN `buildUnitNameParts` is called with `flightMovement = 5`, THE UnitNaming module SHALL set
   `speedWord` to `'Sprinter'` (SPEED_NAMES[5]).
6. WHEN `buildUnitNameParts` is called with `flightMovement ≥ 1`, THE UnitNaming module SHALL set
   `typeWord` to `'Drone'`.
7. WHEN `buildUnitNameParts` is called with `limbMovement ≥ 1` and no `flightMovement`, THE
   UnitNaming module SHALL set `typeWord` to `'Spider'`.
8. WHEN `buildUnitNameParts` is called with `wheeledMovement ≥ 1` and no limb or flight movement,
   THE UnitNaming module SHALL set `typeWord` to `'Tank'`.
9. WHEN `buildUnitNameParts` is called with attributes where exactly two non-movement attributes have
   values > 0, THE UnitNaming module SHALL return exactly two `descriptors`, with the higher-valued
   attribute's word appearing first.
10. WHEN `buildUnitNameParts` is called with attributes where only one non-movement attribute has a
    value > 0, THE UnitNaming module SHALL return exactly one descriptor.
11. WHEN `buildUnitNameParts` is called with attributes where no non-movement attribute has a value >
    0, THE UnitNaming module SHALL return an empty `descriptors` array.
12. FOR ALL valid `UnitAttributes` that contain at least one movement attribute ≥ 1, THE UnitNaming
    module SHALL return non-empty `speedWord` and `typeWord` strings.
13. FOR ALL valid `UnitAttributes` with three or more non-movement attributes > 0, THE UnitNaming
    module SHALL return exactly two `descriptors` (top-2 cap is respected).

---

### Requirement 7: combat.ts — EW Weapon-Mode Multipliers

**User Story:** As a developer, I want `getDefencePower` to be tested with each weapon-mode argument,
so that the three EW multipliers (0.50 for direct, 0.75 for splash, 1.00 for antiAir) are each
directly asserted rather than being invisible inside integration tests.

#### Acceptance Criteria

1. WHEN `getDefencePower` is called with `weaponMode: 'direct'`, THE Combat module SHALL set the `ew`
   field to `ewRaw × 0.50`.
2. WHEN `getDefencePower` is called with `weaponMode: 'splash'`, THE Combat module SHALL set the `ew`
   field to `ewRaw × 0.75`.
3. WHEN `getDefencePower` is called with `weaponMode: 'antiAir'`, THE Combat module SHALL set the
   `ew` field to `ewRaw × 1.00` (unchanged).
4. FOR ALL units with `ewRaw > 0`, `getDefencePower` with `'direct'` SHALL return a lower `ew` value
   than `getDefencePower` with `'antiAir'` for the same inputs (EW_EFFECTIVENESS_DIRECT <
   EW_EFFECTIVENESS_ANTIAIR).
5. WHEN `getDefencePower` is called with `weaponMode: 'direct'` and `weaponMode: 'splash'` for the
   same inputs, THE Combat module SHALL return a higher `ew` for `'splash'` than for `'direct'`
   (0.75 > 0.50).

---

### Requirement 8: combat.ts — Anti-Air-Only Unit Validation

**User Story:** As a developer, I want explicit tests for the anti-air-only validation rule in
`resolveAttack`, so that a unit with only `antiAir > 0` (no kinetic, splash, or rangeAttack) cannot
successfully target a non-drone unit.

#### Acceptance Criteria

1. WHEN `resolveAttack` is called with an attacker that has only `antiAir > 0` (no `kinetic`, no
   `splashAttack`, no `rangeAttack`) and the target is a ground unit, THE Combat module SHALL return
   `wasValid: false` with a `reasonInvalid` message containing `'Anti-Air weapons can only target
   drones'`.
2. WHEN `resolveAttack` is called with an attacker that has only `antiAir > 0` and the target is a
   drone, THE Combat module SHALL return `wasValid: true`.
3. WHEN `resolveAttack` is called with an anti-air-only attacker against a drone, THE Combat module
   SHALL set `chosenWeaponMode` to `'antiAir'`.

---

### Requirement 9: combat.ts — Additional Attack Edge Cases

**User Story:** As a developer, I want explicit tests for attack edge cases (no weapon, destroyed
target, and range falloff), so that regressions in these code paths produce a clear test failure.

#### Acceptance Criteria

1. WHEN `resolveAttack` is called with an attacker that has no weapon attributes (`kinetic`,
   `splashAttack`, `antiAir`, `rangeAttack` all 0 or absent), THE Combat module SHALL return
   `wasValid: false` with a `reasonInvalid` message containing `'No valid weapon modes'`.
2. WHEN `resolveAttack` is called and the target has `currentHealth ≤ 0`, THE Combat module SHALL
   return `wasValid: false`.
3. WHEN the same attacker and target are used for two attacks at different distances (distance 1 vs.
   distance 3), THE Combat module SHALL deal more damage in the closer attack (range falloff reduces
   damage monotonically with distance).
4. WHEN a direct-fire attack is resolved against a drone target and against an otherwise-identical
   non-drone target, THE Combat module SHALL deal less `directDamage` to the drone (drone
   DIRECT_FIRE_DAMAGE_MULTIPLIER = 0.33).
5. WHEN a splash attack is resolved and the target hex contains a drone alongside a non-drone enemy,
   THE Combat module SHALL record less splash damage for the drone than for the non-drone enemy
   (DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER = 0.50).

---

### Requirement 10: combat.ts — Anti-Air Reaction Fire

**User Story:** As a developer, I want explicit tests for `resolveReactionFire`, so that the drone-
only trigger, multi-tile path traversal, early-exit-on-destruction, and no-double-react rules are
each covered by a test that would fail if the logic were wrong.

#### Acceptance Criteria

1. WHEN `resolveReactionFire` is called with a non-drone moving unit (wheeled or limb), THE Combat
   module SHALL return an empty result array regardless of the path or enemies present.
2. WHEN `resolveReactionFire` is called with a drone whose path passes through one enemy tile
   containing a unit with `antiAir > 0`, THE Combat module SHALL return exactly one reaction result.
3. WHEN `resolveReactionFire` is called with a drone whose path passes through two consecutive enemy
   anti-air tiles, THE Combat module SHALL return exactly two reaction results (one per tile).
4. WHEN a drone is destroyed by reaction fire at an intermediate tile, THE Combat module SHALL stop
   processing the remaining path tiles and return only the results accumulated up to the
   destruction.
5. WHEN the same enemy anti-air unit occupies the tile for an entire drone path, THE Combat module
   SHALL allow that unit to react at most once per drone movement action.

---

### Requirement 11: combat.ts — Simultaneous Attack Resolution

**User Story:** As a developer, I want explicit tests for `resolveSimultaneousAttacks`, so that the
snapshot-based semantics (neither unit gets temporal priority) are directly verified.

#### Acceptance Criteria

1. WHEN `resolveSimultaneousAttacks` is called with two units that can both survive each other's
   attack, THE Combat module SHALL return two `CombatResult` objects and both units SHALL have
   reduced health.
2. WHEN `resolveSimultaneousAttacks` is called with units where one would be destroyed by the other's
   attack, THE Combat module SHALL still resolve both attacks (the snapshot ensures the second
   attacker's result is computed from pre-combat health), and both `CombatResult` objects SHALL have
   `wasValid: true`.
3. FOR ALL pairs of identical units attacking each other via `resolveSimultaneousAttacks`, the damage
   recorded in the first `CombatResult` SHALL equal the damage in the second `CombatResult`
   (symmetric: identical units deal identical damage to each other).

---

### Requirement 12: Test Quality — No Tautological Constant Assertions

**User Story:** As a developer, I want tests to assert derived behaviour rather than raw constant
values, so that a test actually fails if a constant is changed to a wrong value.

#### Acceptance Criteria

1. THE test suite SHALL NOT contain test cases that assert a module constant equals itself without
   using that constant in a computed result (e.g., `expect(DEFENCE_SCALE).toBe(0.75)` with no
   formula exercise).
2. THE test suite SHALL NOT contain test cases that only assert a spy or mock was called, without
   also asserting the effect on the return value or on unit health.
3. WHEN a test verifies a formula constant, THE test SHALL exercise that constant through at least
   one derived calculation (e.g., pass a known input through the formula and check the numeric
   output).

---

### Requirement 13: Test Quality — Direct Assertions on Drone Modifier Effects

**User Story:** As a developer, I want the drone direct-fire and splash-fire damage modifiers to be
asserted at the point where they apply (on the damage value), not only inferred from changes to
`currentHealth` after full attack resolution.

#### Acceptance Criteria

1. THE test for drone incoming direct-fire damage SHALL assert on the numeric damage value returned
   by `applyDroneIncomingDamageModifier` directly, in addition to any integration-level health
   checks.
2. THE test for drone incoming splash-fire damage SHALL assert on the numeric damage value from a
   splash event, not only on the final `currentHealth` of the drone.
3. WHEN asserting drone modifier effects inside `resolveAttack` integration tests, THE test SHALL
   compare the drone's damage figure against the damage figure for an equivalent non-drone target
   to make the proportional reduction observable.
