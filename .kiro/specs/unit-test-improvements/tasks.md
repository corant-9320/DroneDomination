# Implementation Plan: Unit Test Improvements

## Overview

Add direct, behavioural unit tests across four areas: pure `combatMath.ts` functions, a new
`shared/unitNaming.ts` test file, extended `combat.test.ts` branches, and test quality improvements.
All tests use Vitest with named ESM imports and `.js` extensions.

## Tasks

- [ ] 1. Add combatMath pure-function tests to `src/world/__tests__/combatMath.test.ts`
  - Create the new file and import `calculateRangeEfficiency`, `getChassisAttackModifier`,
    `calculateModifiedAttackPower`, `applyDroneIncomingDamageModifier`, `calculateFormulaDamage`,
    and the relevant constants from `../combatMath.js`
  - Use minimal inline unit helpers (no grid needed — all functions are stateless)
  - _Requirements: 1, 2, 3, 4, 5_

  - [ ] 1.1 Write `calculateRangeEfficiency` example tests
    - Assert distance 1 → 1.00, distance 2 → 0.90, distance 5 → 0.60
    - Assert distance 11 → 0 (floor clamp)
    - Assert distance 0 (and negative) is treated as distance 1 → 1.00
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 1.2 Write property test for `calculateRangeEfficiency` monotonicity
    - **Property 1: Range efficiency is monotonically non-increasing with distance**
    - **Validates: Requirements 1.6**

  - [ ] 1.3 Write `getChassisAttackModifier` example tests
    - Assert drone (flightMovement ≥ 1) → 0.50
    - Assert spider (limbMovement ≥ 1, no flight) → 0.75
    - Assert tank (wheeledMovement ≥ 1, no limb/flight) → 1.00
    - Assert unit with no movement attributes → 1.00 (default)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 1.4 Write property test for `getChassisAttackModifier` return-set constraint
    - **Property 2 (derived): Return value is always in {0.50, 0.75, 1.00}**
    - **Validates: Requirements 2.5**

  - [ ] 1.5 Write `calculateModifiedAttackPower` example tests
    - Assert tank, base=3, orientation=1, distance=1 → 4.0
    - Assert drone, base=3, orientation=0, distance=1 → 1.5
    - Assert tank, base=3, orientation=0, distance=2 → 2.7
    - Assert result floor: inputs that would produce < 0.01 return exactly 0.01
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 1.6 Write property test for `calculateModifiedAttackPower` non-negative bound
    - **Property 2: Modified attack power is non-negative (≥ 0.01)**
    - **Validates: Requirements 3.5**

  - [ ] 1.7 Write `applyDroneIncomingDamageModifier` example tests
    - Assert direct + drone + damage 18 → max(1, round(18 × 0.33)) = 6
    - Assert splash + drone + damage 10 → max(1, round(10 × 0.50)) = 5
    - Assert antiAir + drone → damage unchanged (multiplier 1.00)
    - Assert any mode + non-drone → damage unchanged
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 1.8 Write property tests for `applyDroneIncomingDamageModifier` bounds
    - **Property 3: Drone incoming modifier never increases damage (result ≤ input for direct/splash)**
    - **Validates: Requirements 4.6**
    - Also assert result ≥ 1 for all drone + direct/splash inputs
    - **Validates: Requirements 4.5**

  - [ ] 1.9 Write `calculateFormulaDamage` spec-value example tests
    - Assert attackPower=1, effectiveDefence=0 → 6
    - Assert attackPower=5, effectiveDefence=0 → 30
    - Assert attackPower=1, max effective defence → 1
    - _Requirements: 5.4, 5.5, 5.6_

  - [ ]* 1.10 Write property tests for `calculateFormulaDamage` bounds and monotonicity
    - **Property 4: Formula damage is bounded within [1, 30]**
    - **Validates: Requirements 5.1**
    - **Property 5: Higher attack power never produces lower damage (non-decreasing in ap)**
    - **Validates: Requirements 5.2**
    - **Property 6: Higher effective defence never produces higher damage (non-increasing in ed)**
    - **Validates: Requirements 5.3**

- [ ] 2. Checkpoint — run combatMath tests
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Create `shared/__tests__/unitNaming.test.ts` with full coverage
  - Create the new file and import `buildUnitNameParts`, `SPEED_NAMES`, `TYPE_NAMES`,
    `ATTRIBUTE_NAMES` from `../../unitNaming.js`
  - Define a minimal `makeAttrs` helper that returns a partial `UnitAttributes` object
  - _Requirements: 6_

  - [ ] 3.1 Write movement key priority tests
    - Assert `flightMovement ≥ 1` → movementKey `'flightMovement'` even when limb/wheeled also set
    - Assert `limbMovement ≥ 1`, no flight → movementKey `'limbMovement'`
    - Assert only `wheeledMovement ≥ 1` → movementKey `'wheeledMovement'`
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 3.2 Write speed word and type word mapping tests
    - Assert flightMovement=1 → speedWord `'Loitering'` (SPEED_NAMES[1])
    - Assert flightMovement=5 → speedWord `'Sprinter'` (SPEED_NAMES[5])
    - Assert flightMovement → typeWord `'Drone'`
    - Assert limbMovement, no flight → typeWord `'Spider'`
    - Assert wheeledMovement, no limb/flight → typeWord `'Tank'`
    - _Requirements: 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ] 3.3 Write descriptor selection and ordering tests
    - Assert exactly two non-movement attrs > 0 → two descriptors, higher-value attr word first
    - Assert exactly one non-movement attr > 0 → one descriptor
    - Assert no non-movement attrs > 0 → empty descriptors array
    - Assert attrs with value 0 are excluded from descriptors
    - _Requirements: 6.9, 6.10, 6.11_

  - [ ]* 3.4 Write property tests for `buildUnitNameParts` invariants
    - **Property 9: Unit names always include a non-empty speedWord and typeWord**
    - **Validates: Requirements 6.12**
    - **Property (derived): descriptors array length is always ≤ 2 regardless of how many attrs > 0**
    - **Validates: Requirements 6.13**

- [ ] 4. Checkpoint — run unitNaming tests
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Extend `src/world/__tests__/combat.test.ts` — EW weapon-mode multipliers
  - Add a new `describe('getDefencePower — weapon mode EW multipliers')` block inside the existing
    `combat` suite; reuse the existing `createTestGrid()` and `makeUnit()` helpers
  - _Requirements: 7_

  - [ ] 5.1 Write EW multiplier example tests for each weapon mode
    - Build a target with `defence > 0` so ewRaw > 0; assert `ew = ewRaw × 0.50` for `'direct'`
    - Assert `ew = ewRaw × 0.75` for `'splash'`
    - Assert `ew = ewRaw × 1.00` for `'antiAir'`
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 5.2 Write property test for EW ordering across modes
    - **Property 7: EW contribution is strictly lower under direct mode than antiAir mode for any non-zero ewRaw**
    - **Validates: Requirements 7.4**
    - Also assert direct < splash < antiAir ordering
    - **Validates: Requirements 7.5**

- [ ] 6. Extend `combat.test.ts` — anti-air-only validation and attack edge cases
  - Add `describe('anti-air only unit')` and `describe('resolveAttack edge cases')` blocks
  - _Requirements: 8, 9, 12, 13_

  - [ ] 6.1 Write anti-air-only vs ground target test
    - Attacker: antiAir=3, all other attack attrs 0; target: wheeledMovement ground unit
    - Assert `wasValid: false`, reasonInvalid contains `'Anti-Air weapons can only target drones'`
    - _Requirements: 8.1_

  - [ ] 6.2 Write anti-air-only vs drone target tests
    - Attacker: antiAir=3 only; target: flightMovement drone
    - Assert `wasValid: true`
    - Assert `chosenWeaponMode === 'antiAir'`
    - _Requirements: 8.2, 8.3_

  - [ ] 6.3 Write no-weapon attacker test
    - Attacker with all weapon attrs 0 or absent
    - Assert `wasValid: false`, reasonInvalid contains `'No valid weapon modes'`
    - _Requirements: 9.1_

  - [ ] 6.4 Write destroyed target test
    - Set target.currentHealth = 0 before calling resolveAttack
    - Assert `wasValid: false`
    - _Requirements: 9.2_

  - [ ] 6.5 Write range-falloff damage comparison test
    - Use createLinearGrid(); same attacker/target pair, one at distance 1, one at distance 3
    - Assert directDamage at distance 1 > directDamage at distance 3
    - _Requirements: 9.3_

  - [ ] 6.6 Write drone vs non-drone direct fire comparison test
    - Identical attacker and defence setup; one target is a drone, one is an equivalent ground unit
    - Assert drone's directDamage < ground target's directDamage
    - Also call `applyDroneIncomingDamageModifier('direct', droneUnit, rawDamage)` directly and
      assert the result matches the reduction (satisfies Req 13.1)
    - _Requirements: 9.4, 13.1_

  - [ ] 6.7 Write drone vs non-drone splash damage comparison test
    - Attacker with splashAttack; target hex has both a drone and a non-drone enemy
    - Assert splash event damage for drone < splash event damage for non-drone
    - Assert the assertion is on the event.damage value, not inferred from health (Req 13.2)
    - _Requirements: 9.5, 13.2_

- [ ] 7. Checkpoint — run combat edge case tests
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Extend `combat.test.ts` — reaction fire and simultaneous resolution
  - Add `describe('resolveReactionFire')` and `describe('resolveSimultaneousAttacks')` blocks
  - _Requirements: 10, 11_

  - [ ] 8.1 Write ground unit triggers no reaction fire test
    - Moving unit: wheeledMovement ground unit on a path past an enemy AA unit
    - Assert `resolveReactionFire` returns an empty array
    - _Requirements: 10.1_

  - [ ]* 8.2 Write property test: ground units never trigger reaction fire
    - **Property 10: resolveReactionFire with a non-drone moving unit always returns []**
    - **Validates: Requirements 10.1**

  - [ ] 8.3 Write drone through one AA tile test
    - Drone path: [tile0 → tile1]; enemy AA unit on tile1
    - Assert exactly one CombatResult returned
    - _Requirements: 10.2_

  - [ ] 8.4 Write drone through two consecutive AA tiles test
    - Drone path: [tile0 → tile1 → tile2]; enemy AA on both tile1 and tile2 (different units)
    - Assert exactly two CombatResults returned
    - _Requirements: 10.3_

  - [ ] 8.5 Write drone destroyed mid-path early-exit test
    - AA unit on tile1 deals enough damage to destroy the drone
    - Path has a tile2 with another AA unit
    - Assert only one CombatResult returned (processing stops at destruction)
    - Assert drone.currentHealth === 0 after the call
    - _Requirements: 10.4_

  - [ ] 8.6 Write no-double-react per action test
    - Single enemy AA unit occupying multiple tiles in the path (tileIndex unchanged but path visits
      the tile twice) — or use a single-tile path that the drone re-enters; assert the AA unit
      fires at most once
    - _Requirements: 10.5_

  - [ ] 8.7 Write simultaneous resolution — both survive test
    - Two units each with moderate attack/health; neither is killed by the other's damage
    - Assert two CombatResults returned, both `wasValid: true`
    - Assert both units have lower health after the call
    - _Requirements: 11.1_

  - [ ] 8.8 Write simultaneous resolution — snapshot semantics test
    - Unit A has just enough attack to one-shot unit B
    - Assert both CombatResults have `wasValid: true` (B still attacks even though it "dies")
    - Assert unit A also has reduced health (B's attack applied from snapshotted pre-combat health)
    - _Requirements: 11.2_

  - [ ]* 8.9 Write property test for simultaneous resolution symmetry
    - **Property 8: Simultaneous resolution is symmetric for identical units**
    - **Validates: Requirements 11.3**

- [ ] 9. Final checkpoint — full test suite
  - Run `npm test` and ensure all new and existing tests pass; ask the user if anything is failing.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements from `requirements.md` for traceability
- Property tests (optional `*` tasks) use Vitest's built-in tooling; no extra PBT library is
  required — implement them as parameterised example tables covering edge points and mid-range values
- All new test files follow project conventions: named imports only, `.js` extensions, no default exports
- The three new/extended test files are: `src/world/__tests__/combatMath.test.ts` (new),
  `shared/__tests__/unitNaming.test.ts` (new), `src/world/__tests__/combat.test.ts` (extended)
- Run tests at any time with: `npm test`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.5", "1.7", "1.9", "3.1", "3.2", "3.3"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.6", "1.8", "1.10", "3.4"] },
    { "id": 2, "tasks": ["5.1", "6.1", "6.2", "6.3", "6.4"] },
    { "id": 3, "tasks": ["5.2", "6.5", "6.6", "6.7"] },
    { "id": 4, "tasks": ["8.1", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8"] },
    { "id": 5, "tasks": ["8.2", "8.9"] }
  ]
}
```
