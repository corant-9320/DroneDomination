# Implementation Plan: Unit Test Coverage

## Overview

Test-only change set raising the Vitest suite for `src/world/**`, `server/**`, and `shared/**` from incidental coverage to behavioural confidence, combat-correctness first. Property tests use `fast-check` (≥100 iterations each, tagged with their design-property number), balance formulas are asserted via property/range checks with at most one labelled golden smoke test per formula, mocks are confined to true external boundaries (time, `src/world/rng.ts`, network, filesystem), every combat constant is derived from `COMBAT_RULES.md`, and each test file stays under 300 lines. No production code is modified; a genuine bug, if found, is raised separately rather than silently patched.

Task order follows the design priority phases: P1 combat coverage → repair conversion → review-and-repair pass → P2 server combat → P3 remaining gaps → final change report and acceptance gate.

## Tasks

- [x] 1. Test tooling setup
  - [x] 1.1 Add and pin `fast-check` as a dev dependency
    - Add `fast-check` to `devDependencies` in `package.json` with a pinned version
    - Verify it resolves under the existing Vitest config and ESM `.js` import resolution
    - Confirm a trivial property test runs at ≥100 iterations
    - _Requirements: 4.1, 7.3_

  - [x] 1.2 Verify coverage reporting tooling
    - Confirm `npm run test:cov` runs Vitest with the `@vitest/coverage-v8` provider already configured in `vite.config.ts` (scoped to `src/**`, `shared/**`, `server/**`; `client/**` excluded)
    - Confirm the run emits the three report artifacts: the terminal text summary, `coverage/coverage-summary.json`, and `coverage/index.html`
    - Do NOT add or enforce coverage thresholds — coverage stays report-only
    - _Requirements: 7.3_

- [x] 2. P1 — Combat-correctness coverage (new)
  - [x] 2.1 Add behavioural coverage for `src/world/combatFacing.ts`
    - Create `src/world/__tests__/combatFacing.test.ts` exercising the real bearing/orientation geometry on synthetic tile grids with hand-placed 3D positions and explicit neighbour rings — no mocks
    - **Property 10: Orientation bonus is bounded `[0,2]`, head-on→0, rear→2, non-decreasing with angular difference** (fast-check, ≥100 iterations)
    - **Property 11: `classifyArcFromAngle` returns front 0–60°, side 60–120°, rear 120–180° per COMBAT_RULES §4** (fast-check, ≥100 iterations)
    - Add example tests for degenerate geometry: coincident tiles → `getBearingBetweenTiles` `NaN`, `calculateOrientationBonus` → 0
    - Derive thresholds/bounds from `COMBAT_RULES.md` §4; keep file under 300 lines
    - _Requirements: 3.1, 4.1, 4.4, 4.5, 5.2, 6.1_

  - [x] 2.2 Add behavioural coverage for `src/world/combatFormula.ts`
    - Create `src/world/__tests__/combatFormula.test.ts` exercising the pure damage module directly with fast-check generators over attack power, effective defence, distance, weapon mode, and drone flag — no mocks
    - **Property 5: Formula damage stays within `[MIN_DAMAGE, MAX_DAMAGE]` = `[1, 30]`** (≥100 iterations)
    - **Property 6: Damage non-decreasing in attack power, non-increasing in effective defence** (≥100 iterations)
    - **Property 7: Drone incoming modifiers order damage Direct ≤ Splash ≤ Anti-Air, each ≤ non-drone, never below `MIN_DAMAGE`** (≥100 iterations)
    - **Property 8: `calculateRangeEfficiency(1) = 1.0`, non-increasing as distance grows, never below 0** (≥100 iterations)
    - **Property 9: `applyDamage` caps health to `[0, 50]` and reflects damage of at least `MIN_DAMAGE`** (≥100 iterations)
    - Add exactly one labelled `GOLDEN SMOKE` example pinning a representative damage value, commented as expected to break on balance changes
    - Derive `MIN_DAMAGE`/`MAX_DAMAGE`/`DEFENCE_SCALE`/`DAMAGE_PER_ATTACK_POWER`/`SPLASH_SCALE`/drone multipliers/`RANGE_FALLOFF_PER_HEX` from `COMBAT_RULES.md` §3, §6, §7, §9, §21; if a constant is absent, assert only the structural property
    - Split into `combatFormula.core.test.ts` + `combatFormula.modifiers.test.ts` with a shared `combatFormula.fixtures.ts` if the file would exceed 300 lines
    - _Requirements: 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 5.2, 6.1, 6.2_

  - [x] 2.3 Add behavioural coverage for `shared/rangeCheck.ts`
    - Create `shared/__tests__/rangeCheck.test.ts` exercising the real range gate on synthetic `RangeTile` grids — no mocks
    - **Property 12: `getRangeThreshold` monotonic, `getRangeThreshold(0) = SEGMENT_RANGE_BASE` (1.0)** (≥100 iterations)
    - **Property 13: `elevationRangeMultiplier` bounded `[0.5, 1.5]`, monotonic in elevation delta, exactly 1.0 when either combatant is a drone** (≥100 iterations)
    - **Property 14: `isTargetInRange` true exactly when unit has a weapon and segment distance ≤ elevation-scaled threshold** (≥100 iterations)
    - **Property 15: `segmentDistance` is 0 for identical positions and symmetric** (≥100 iterations)
    - Derive `SEGMENT_RANGE_PER_POINT`/`SEGMENT_RANGE_BASE`/`ELEVATION_RANGE_*` from `COMBAT_RULES.md` §3, §13, §21
    - Keep file under 300 lines
    - _Requirements: 3.3, 4.1, 4.4, 4.5, 5.2, 6.1_

- [x] 3. Convert repair formula tests to property assertions
  - [x] 3.1 Rewrite pinned values in `src/world/__tests__/repair.test.ts`
    - Replace pinned `calculateRepairAmount`/`applyRepair` outputs (`toBe(2)`, `toBe(20)`, `toBe(9)`, `toBe(5)`, `toBe(29)`, `toBe(3)`) with property assertions
    - **Property 1: `calculateRepairAmount` monotonic in repair points** (≥100 iterations)
    - **Property 2: `calculateRepairAmount` monotonic in maximum health** (≥100 iterations)
    - **Property 3: repair amount within `[2, 20]` including clamped out-of-range inputs, derived from COMBAT_RULES §18 rate `2 + (maxHealth−10)/20`** (≥100 iterations)
    - **Property 4: `applyRepair` result ≤ maxHealth and ≥ clamp(currentHealth, 0, maxHealth)** (≥100 iterations)
    - Retain exactly one labelled golden smoke test (e.g. `GOLDEN SMOKE: rp=3 maxHealth=30 repairs ~9 (breaks on balance change)`)
    - Retain the genuinely behavioural tests (`validateRepair` rejection reasons, `resolveRepair` mutate/non-mutate, not-found handling)
    - Keep file under 300 lines
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.2, 4.3, 4.4, 6.1_

- [x] 4. Review-and-repair pass over existing in-scope tests
  - [x] 4.1 Review and repair existing `src/world/__tests__` tests
    - Audit `combat.test.ts`, `movement.test.ts`, `pathfinding.test.ts`, `spawn.test.ts`, `units.test.ts`, `vec3.test.ts`, `terrain.test.ts`, `turnState.test.ts` for weak tests (tautological, mock-only, brittle/pinned, implementation-coupled, passes-when-broken)
    - Remove any `vi.mock` of a code-under-test module and exercise the real implementation; keep mocks only on external boundaries
    - Replace tautological/implementation-coupled assertions with ones that fail on incorrect observable behaviour; replace pinned balance values with property/range assertions (keep at most one labelled golden smoke per formula)
    - Record each modified/removed test with its reason for the change report (task 7.1)
    - Keep each touched file under 300 lines, splitting by concern if needed
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 4.1, 4.4, 4.5, 5.1, 5.2, 5.3, 7.1, 7.2_

  - [x] 4.2 Review and repair existing `server/__tests__` tests
    - Audit existing server tests (including the partial `server/__tests__/combat.test.ts`) for the same weaknesses
    - Remove code-under-test mocks; control randomness through `src/world/rng.ts` rather than patching `Math.random`
    - Strengthen assertions to observable behaviour; record changes for the change report (task 7.1)
    - Keep each touched file under 300 lines
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 4.4, 5.1, 5.2, 5.3, 7.1_

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. P2 — Server combat coverage
  - [x] 6.1 Extend coverage for `server/combatApi.ts`
    - Create/extend `server/__tests__/combatApi.test.ts` against real constructed worlds (real `Tile`/`Unit`, real `resolveAttack`); control randomness only via `src/world/rng.ts` — no code-under-test mocks
    - **Property 18: weapon-mode selection chooses the highest-scoring mode, preferring Anti-Air against drone targets, per COMBAT_RULES §10** (≥100 iterations)
    - Add example tests for post-attack health invariants and end-to-end wiring
    - Derive scoring/mode constants from `COMBAT_RULES.md` §7, §10
    - Keep file under 300 lines
    - _Requirements: 3.4, 4.4, 5.1, 5.2, 5.3, 6.1_

  - [x] 6.2 Add behavioural coverage for `server/combatExplainer.ts`
    - Create `server/__tests__/combatExplainer.test.ts` exercising the real formatter — no mocks
    - **Property 17: rendered explanation contains every breakdown component (attack power, effective defence, weapon mode, final damage)** (≥100 iterations)
    - Add example tests for representative formatting
    - Keep file under 300 lines
    - _Requirements: 3.4, 4.4, 5.2_

- [x] 7. P3 — Remaining-gap coverage
  - [x] 7.1 Coverage-driven gap read (before P3 implementation)
    - Run `npm run test:cov` and read the report (`coverage/coverage-summary.json` for per-file statement/branch/function numbers, `coverage/index.html` for the exact uncovered lines/branches)
    - Let uncovered branches and functions in in-scope business logic (`src/world/**`, `shared/**`, `server/**`) drive WHICH remaining P3 modules/branches (7.2–7.6) get tests first, ahead of already well-exercised code
    - When a gap drives a test, cite the concrete file + line range from the report (e.g. `combatFormula.ts:42–58 branch uncovered`) for the change report (task 8.1)
    - Note (do not force tests onto) genuinely untestable code (pure type modules, thin IO wrappers, 3D/DOM glue)
    - Coverage stays report-only — no thresholds added or enforced
    - _Requirements: 3.5, 3.6, 7.3_

  - [x] 7.2 Add round-trip coverage for `src/world/compact.ts`
    - Create `src/world/__tests__/compact.test.ts`
    - **Property 16: converting a valid world to compact wire format and back yields an equivalent world (tiles, units, attributes preserved)** (≥100 iterations)
    - Keep file under 300 lines
    - _Requirements: 3.5, 4.4, 5.2_

  - [x] 7.3 Add coverage for `src/world/geodesic.ts` and `src/world/segmentGeometry.ts`
    - Create `src/world/__tests__/geodesic.test.ts` (polyhedron invariants — tile counts, neighbour symmetry) and `src/world/__tests__/segmentGeometry.test.ts` (segment distance zero/symmetry), each as fast-check properties ≥100 iterations
    - Keep each file under 300 lines
    - _Requirements: 3.5, 4.4, 5.2_

  - [x] 7.4 Extend/add coverage for `src/world/pathfinding.ts` and `shared/pathfinding.ts`
    - Add path-validity invariants (returned path is contiguous, starts/ends correctly, respects blocked tiles) as fast-check properties ≥100 iterations
    - Keep each file under 300 lines
    - _Requirements: 3.5, 4.4, 5.2_

  - [x] 7.5 Add coverage for `src/world/validate.ts`, `shared/unitNaming.ts`, and `src/world/buildings.ts`
    - `validate.test.ts`: feed structurally malformed worlds and assert rejection (error/`false`, no unhandled throw)
    - `unitNaming.test.ts`: assert deterministic, collision-free naming as a property ≥100 iterations
    - `buildings.test.ts`: example tests for attribute lookups
    - Skip pure type modules with no logic (`combatTypes`, `unitTypes`, `wireTypes`) per design
    - Keep each file under 300 lines
    - _Requirements: 3.5, 4.4, 5.2_

  - [x] 7.6 Add integration/smoke coverage for generation and server wiring
    - `generate`/`generateApi`/`regenerate`: 1–3 representative integration examples, controlling rng via `src/world/rng.ts` and mocking filesystem only at the IO boundary
    - `devPlugin`: single smoke check of server wiring
    - Keep each file under 300 lines
    - _Requirements: 3.5, 4.4, 5.1, 5.2, 5.3_

- [x] 8. Finalisation
  - [x] 8.1 Produce the change report
    - Compile a summary listing, per file, each test modified, removed, or added and the reason (which weakness repaired, or which property/module added)
    - Confirm scope: changes limited to `src/world/**`, `server/**`, `shared/**`; no `client/**` test changes
    - _Requirements: 1.4, 7.1, 7.2_

  - [x] 8.2 Run the acceptance gate
    - Run `npm test` as a single (non-watch) run and confirm the whole suite passes
    - Confirm every touched/added test file is under 300 lines
    - _Requirements: 4.5, 7.3_

  - [x] 8.3 Re-run the coverage report
    - Re-run `npm run test:cov` after P3 and compare against the pre-P3 read (task 7.1) to confirm the targeted gaps closed and no previously-covered behaviour regressed
    - Layered on top of — not replacing — the single `npm test` acceptance gate (task 8.2, Requirement 7.3); coverage stays report-only, no thresholds
    - _Requirements: 3.5, 3.6, 7.3_

- [x] 9. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- This is a test-only effort — no production code under `src/world/**`, `server/**`, or `shared/**` is modified; a genuine bug, if uncovered, is raised separately, not silently patched.
- Every property test uses `fast-check` at ≥100 iterations and is tagged `Feature: unit-test-coverage, Property N: <text>`.
- All combat constants and bounds are derived from `COMBAT_RULES.md`; absent constants are not invented (structural property only).
- Mocks are confined to external boundaries (time, randomness via `src/world/rng.ts`, network, filesystem); code-under-test always runs for real.
- Balance formulas use property/range assertions with at most one labelled golden smoke test per formula.
- Each test file is kept under 300 lines, split by concern (with a shared fixtures module) where needed.
- Priority ordering: P1 combat → repair conversion → review-and-repair → P2 server combat → P3 remaining gaps → final report + `npm test` gate.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "3.1", "4.1", "4.2", "7.1"] },
    { "id": 2, "tasks": ["6.1", "6.2", "7.2", "7.3", "7.4", "7.5", "7.6"] },
    { "id": 3, "tasks": ["8.1"] },
    { "id": 4, "tasks": ["8.2", "8.3"] }
  ]
}
```
