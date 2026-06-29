# Design Document

## Overview

This design covers a review-and-extension of the Vitest unit test suite for Drone Domination's backend and shared logic, scoped strictly to `src/world/**`, `server/**`, and `shared/**`. Client code (`client/**`) is out of scope.

The work has three thrusts, executed in priority order:

1. **Review and repair** weak existing tests in place (tautological, mock-only, brittle, implementation-coupled, or pinned-value tests).
2. **Convert balance-formula tests** (starting with `repair.test.ts`) from pinned numeric outputs to property/range assertions, keeping at most one labelled golden smoke test per formula.
3. **Add new behavioural coverage** for untested modules, combat-correctness first.

This is a test-only change set. No production code under `src/world/**`, `server/**`, or `shared/**` is modified except where a genuine bug is uncovered (which would be raised separately, not silently patched). `COMBAT_RULES.md` is the authoritative source for every combat constant and formula referenced here.

### Guiding Constraints (from `conventions.md`)

- **No pinned formula values** — assert monotonicity, bounds, relative comparisons, and capping instead.
- **One golden smoke test per formula** is allowed, clearly labelled, expected to break on balance changes.
- **Test behaviour, not implementation.**
- **Each test file under 300 lines** — split by concern when a file would exceed it.
- **Mock only true external boundaries** — system time, randomness (`src/world/rng.ts`), network, filesystem. Everything else exercises the real implementation.
- **Imports use `.js` extension; named exports only.**

## Architecture

### Module-under-test inventory

The suite covers three source trees. Existing test files and the gaps this effort fills:

| Source tree | Module | Existing test | Action |
|---|---|---|---|
| `src/world` | `combat.ts` | `__tests__/combat.test.ts` | Review/repair |
| `src/world` | `repair.ts` | `__tests__/repair.test.ts` | Convert to properties |
| `src/world` | `movement.ts` | `__tests__/movement.test.ts` | Review/repair |
| `src/world` | `pathfinding.ts` | `__tests__/pathfinding.test.ts` | Review/repair + extend |
| `src/world` | `spawn.ts` | `__tests__/spawn.test.ts` | Review/repair |
| `src/world` | `units.ts` | `__tests__/units.test.ts` | Review/repair |
| `src/world` | `vec3.ts` | `__tests__/vec3.test.ts` | Review/repair |
| `src/world` | (terrain) | `__tests__/terrain.test.ts` | Review/repair |
| `src/world` | `turnState.ts` | `__tests__/turnState.test.ts` | Review/repair |
| `src/world` | `combatFacing.ts` | — | **New (P1)** |
| `src/world` | `combatFormula.ts` | — | **New (P1)** |
| `shared` | `rangeCheck.ts` | — | **New (P1)** |
| `server` | `combatApi.ts` | `__tests__/combat.test.ts` (partial) | **New/extend (P2)** |
| `server` | `combatExplainer.ts` | — | **New (P2)** |
| `src/world` | `buildings.ts` | — | New (P3) |
| `src/world` | `compact.ts` | — | New (P3) |
| `src/world` | `generate.ts` | — | New (P3) |
| `src/world` | `geodesic.ts` | — | New (P3) |
| `src/world` | `segmentGeometry.ts` | — | New (P3) |
| `src/world` | `validate.ts` | — | New (P3) |
| `shared` | `combatTypes.ts` | — | New (P3, if helpers) |
| `shared` | `pathfinding.ts` | — | New (P3) |
| `shared` | `unitNaming.ts` | — | New (P3) |
| `shared` | `unitTypes.ts` | — | New (P3, if helpers) |
| `shared` | `wireTypes.ts` | — | New (P3, if helpers) |
| `server` | `generateApi.ts` | — | New (P3, integration) |
| `server` | `regenerate.ts` | — | New (P3, integration) |
| `server` | `devPlugin.ts` | — | New (P3, smoke) |

### Priority ordering (Requirement 3.6)

```
P1  combatFacing → combatFormula → shared/rangeCheck     (highest combat-correctness risk)
P2  server/combatApi → server/combatExplainer            (combat orchestration + presentation)
P3  remaining src/world gaps → remaining shared gaps → remaining server gaps
```

New test files are added in this order so combat correctness is locked down before lower-priority gaps.

### Test file placement and naming

Tests live in the `__tests__/` folder adjacent to their source tree, matching the existing convention:

- `src/world/__tests__/<module>.test.ts`
- `shared/__tests__/<module>.test.ts`
- `server/__tests__/<module>.test.ts`

Property-based tests use `fast-check` (the standard PBT library for the Vitest/TS ecosystem). If `fast-check` is not already a dev dependency, it is added pinned. Each property test runs a **minimum of 100 iterations** and is tagged with its design-property reference.

## Components and Interfaces

### 1. Review-and-repair component

A systematic pass over every existing in-scope test file to find and fix **weak tests**. A test is weak if any of the following hold:

| Weakness | How to detect | Repair |
|---|---|---|
| **Tautological** | Assertion restates the input, or compares a value to itself (`expect(x).toBe(x)`); passes regardless of code-under-test. | Replace with an assertion tied to real output. |
| **Mock-only** | The module under test is itself mocked (`vi.mock('../moduleUnderTest')`), so the real implementation never runs. | Remove the mock; exercise the real function. Mock only external boundaries. |
| **Brittle / pinned** | Asserts an exact balance-formula output (`expect(damage).toBe(14)`); breaks on tuning with no correctness signal. | Replace with property/range assertion; keep one labelled golden smoke test if useful. |
| **Implementation-coupled** | Asserts private call order, internal field names, or intermediate values rather than observable behaviour. | Re-express against the public result / observable behaviour. |
| **Passes when code is broken** | A mutation of the code-under-test would not fail the test. | Strengthen the assertion so an incorrect output fails it. |

**Worked example — `repair.test.ts`:** the existing file pins formula outputs throughout `calculateRepairAmount` (`toBe(2)`, `toBe(20)`, `toBe(9)`, `toBe(5)`) and `applyRepair` (`toBe(29)`, `toBe(3)`). These are brittle balance-formula assertions. They are replaced with the monotonicity, bounds, and cap properties (Properties 1–4 below), plus exactly one labelled golden smoke test. The genuinely behavioural tests in that file (`validateRepair` rejection reasons, `resolveRepair` mutation/non-mutation, not-found handling) are correctness checks on observable behaviour and are **retained** — they are not pinned formula values.

**Change report (Requirement 1.4):** the effort produces a summary listing, per file, each test modified, removed, or added, with the reason (which weakness, or which new property/module). This is delivered with the implementation, not stored as a spec artifact.

### 2. Property-assertion strategy for balance formulas

Balance formulas (damage, repair, defence, range falloff, orientation, chassis/drone modifiers) have outputs that are **tuning values subject to change**. Tests assert structural properties that survive tuning rather than the numbers themselves.

The property toolkit, applied per formula:

- **Monotonicity** — output moves in a known direction as one input increases (e.g. damage rises with attack power; repair rises with repair points).
- **Bounds** — output stays within documented min/max (e.g. damage ∈ [1, 30]; orientation bonus ∈ [0, 2]).
- **Relative comparison** — ordering between related cases (e.g. drone Direct-Fire damage < non-drone Direct-Fire damage for the same inputs; rear shot ≥ front shot).
- **Capping / invariants** — a clamp or cap always holds (e.g. repaired health never exceeds max; applied damage never drives health below 0).

**Golden smoke test rule:** each balance formula gets **at most one** clearly-labelled golden smoke test that pins a single representative output, with a comment stating it is expected to break on intentional balance changes. Example label: `it('GOLDEN SMOKE: rp=3 maxHealth=30 repairs ~9 (breaks on balance change)', ...)`.

**Constant sourcing (Requirement 6):** every property derives its expected bounds and constants from `COMBAT_RULES.md` §21 Constants Summary and the formula sections. The constants used:

| Constant | Value | Source |
|---|---|---|
| `MIN_DAMAGE` / `MAX_DAMAGE` | 1 / 30 | §6, §21 |
| `DEFENCE_SCALE` | 0.75 | §5, §21 |
| `DAMAGE_PER_ATTACK_POWER` | 6 | §6, §21 |
| `SPLASH_SCALE` | 0.3 | §9, §21 |
| `RANGE_FALLOFF_PER_HEX` | 0.10 | §3, §21 |
| `TANK / SPIDER / DRONE_ATTACK_MODIFIER` | 1.00 / 0.75 / 0.50 | §7, §21 |
| `DRONE_DIRECT / SPLASH / ANTI_AIR_FIRE_DAMAGE_MULTIPLIER` | 0.33 / 0.50 / 1.00 | §7, §21 |
| `SEGMENT_RANGE_PER_POINT` / `SEGMENT_RANGE_BASE` | 0.5 / 1.0 | §3, §21 |
| `ELEVATION_RANGE_*` (per-level, min, max) | 0.5/3, 0.5, 1.5 | §13 |
| orientation bonus range | 0.0–2.0 | §4 |
| repair rate | `2 + (maxHealth−10)/20` ⇒ ∈ [2, 4] | §18 |

If a required constant is **absent** from `COMBAT_RULES.md`, the test asserts only the structural property (direction/bound) and does **not** invent a numeric value (Requirement 6.2).

### 3. New combat-coverage components (P1)

**`combatFacing.test.ts`** — exercises the real bearing/orientation geometry. Builds small synthetic tile grids with known 3D positions and neighbour rings so bearings are deterministic. Asserts orientation-bonus bounds, the head-on→0 / rear→2 endpoints, monotonic growth with angular difference, and `classifyArcFromAngle` thresholds (0–60 front, 60–120 side, 120–180 rear). No mocks — pure geometry.

**`combatFormula.test.ts`** — exercises the pure damage module directly. `fast-check` generators over attack power, effective defence, distance, weapon mode, and drone flag. Asserts damage bounds, monotonicity in attack power and in defence, splash-scale reduction, drone incoming-modifier ordering, range-efficiency behaviour, and `applyDamage` health capping. No mocks.

**`rangeCheck.test.ts`** (in `shared/__tests__`) — exercises the shared range gate. Asserts `getRangeThreshold` monotonicity and base value, `elevationRangeMultiplier` bounds/monotonicity and the drone exception (=1.0), `isTargetInRange` agreement with the threshold, and `segmentDistance` zero-and-symmetry on synthetic `RangeTile` grids. No mocks.

### 4. Server combat components (P2)

**`combatApi`** is exercised against real constructed worlds (real `Tile`/`Unit` objects, real `resolveAttack`). Where randomness is involved it is controlled through `src/world/rng.ts` only. Properties target weapon-mode selection (the highest-scoring mode is chosen; anti-air preferred against drones) and post-attack health invariants. Representative example tests cover end-to-end wiring.

**`combatExplainer`** formats a damage breakdown into human-readable text. Property: for any breakdown, the rendered explanation contains every component the breakdown carries (attack power, effective defence, weapon mode, final damage). Example tests cover representative formatting.

### 5. Remaining-gap components (P3)

Classified by suitability (from prework):

- **Property-suitable:** `compact` (serialize/deserialize round-trip), `geodesic` (polyhedron invariants — tile counts, neighbour symmetry), `pathfinding` (path validity invariants), `segmentGeometry` (distance zero/symmetry), `validate` (rejects malformed worlds), `unitNaming` (deterministic, collision-free naming).
- **Example-suitable:** `buildings` (attribute lookups), and any small helpers in `combatTypes` / `unitTypes` / `wireTypes` (pure type modules with no logic get no tests).
- **Integration/smoke:** `generate` / `generateApi` / `regenerate` (world generation + IO — 1–3 representative examples, controlling rng via `src/world/rng.ts`), `devPlugin` (server wiring — single smoke check).

### 6. Mocking strategy

```
External boundary        Mocking approach
─────────────────────    ─────────────────────────────────────────────
System time              vi.useFakeTimers() / inject a clock
Randomness               control via src/world/rng.ts (seeded), never Math.random patching
Network                  mock the transport boundary only
Filesystem               mock fs at the call site (generation/regenerate IO)
```

Everything inside the in-scope module graph runs for real. No `vi.mock` of a code-under-test module. This guarantees tests verify production logic (Requirements 5.1–5.3).

### 7. File-size management (<300 lines)

When a module's coverage would exceed 300 lines, the test file is split by concern, e.g.:

- `combatFormula.core.test.ts` (damage curve, bounds, monotonicity)
- `combatFormula.modifiers.test.ts` (chassis, drone incoming, range falloff)

Split files keep a shared helper module (e.g. `combatFormula.fixtures.ts`) for generators/builders so neither file duplicates setup. Each resulting file stays under 300 lines.

## Data Models

This is a test-only effort; it introduces no production data models. Test fixtures reuse existing production types:

- `Unit` / `HexSegment` from `src/world/units.ts`
- `Tile` / `Vec3` from `src/world/types.ts`
- `RangeTile` from `shared/rangeCheck.ts`
- `DamageInput` / `DamageBreakdown` from `src/world/combatFormula.ts`

**Synthetic tile grids:** geometry tests construct minimal tile arrays (hand-placed 3D positions, explicit neighbour rings) so bearings, segment distances, and range gates are deterministic and independent of generated world data.

**fast-check generators (illustrative):**

```typescript
const arbRp = fc.integer({ min: 1, max: 5 });
const arbMaxHealth = fc.integer({ min: 10, max: 50 });
const arbAttackPower = fc.double({ min: 0.01, max: 10, noNaN: true });
const arbEffectiveDefence = fc.double({ min: 0, max: 10, noNaN: true });
const arbDistance = fc.double({ min: 1, max: 6, noNaN: true });
```

## Error Handling

- **Out-of-range inputs:** clamping behaviour is asserted as a property (e.g. `calculateRepairAmount(0, …)` equals the `rp=1` result; values above max equal the max-clamped result), exercising the real clamps rather than assuming callers pre-validate.
- **Degenerate geometry:** coincident tiles return `NaN`/`0` per the source contract; tests assert the documented fallback (e.g. `getBearingBetweenTiles` → `NaN`, `calculateOrientationBonus` → `0`).
- **Malformed worlds:** `validate` tests feed structurally broken worlds and assert rejection (error/`false`), not a thrown unhandled exception.
- **Test isolation:** mutation-based functions (`resolveRepair`, `resolveAttack`) are tested for both the mutate-on-valid and do-not-mutate-on-invalid paths so a regression in the guard is caught.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Each property below is implemented as a `fast-check` test running at least 100 iterations, tagged `Feature: unit-test-coverage, Property N: <text>`. Constants are taken from `COMBAT_RULES.md`.

### Property 1: Repair amount is monotonic in repair points

For any maximum health in [10, 50] and any two repair-point values `rp1 ≤ rp2` (within the clamped range [1, 5]), `calculateRepairAmount(rp1, maxHealth) ≤ calculateRepairAmount(rp2, maxHealth)`.

**Validates: Requirements 2.1, 2.2, 4.1**

### Property 2: Repair amount is monotonic in maximum health

For any repair-point value in [1, 5] and any two maximum-health values `maxH1 ≤ maxH2` (within [10, 50]), `calculateRepairAmount(rp, maxH1) ≤ calculateRepairAmount(rp, maxH2)`.

**Validates: Requirements 2.1, 2.3, 4.1**

### Property 3: Repair amount stays within documented bounds

For any repair-point and maximum-health inputs (including out-of-range values that exercise clamping), the repair amount lies within `[2, 20]`, derived from the `COMBAT_RULES.md` §18 repair rate `2 + (maxHealth−10)/20 ∈ [2, 4]` and `rp ∈ [1, 5]`.

**Validates: Requirements 2.1, 2.4, 4.1, 6.1**

### Property 4: Repaired health is capped at maximum and never decreases

For any current health, maximum health in [10, 50], and repair points, `applyRepair(currentHealth, maxHealth, rp)` is `≤ maxHealth` and `≥ clamp(currentHealth, 0, maxHealth)`.

**Validates: Requirements 2.1, 2.5, 4.4**

### Property 5: Formula damage stays within [MIN_DAMAGE, MAX_DAMAGE]

For any attack power > 0 and any effective defence ≥ 0, `calculateFormulaDamage(attackPower, effectiveDefence)` lies within `[1, 30]`.

**Validates: Requirements 3.2, 4.1, 6.1**

### Property 6: Formula damage is monotonic in attack power and in defence

For any fixed effective defence, damage is non-decreasing as attack power increases; and for any fixed attack power, damage is non-increasing as effective defence increases.

**Validates: Requirements 3.2, 4.1**

### Property 7: Drone incoming modifiers reduce and order damage by weapon mode

For any drone target, final damage under Direct Fire ≤ final damage under Splash Fire ≤ final damage under Anti-Air Fire for the same pre-modifier damage (multipliers 0.33 ≤ 0.50 ≤ 1.00), and each drone result is ≤ the non-drone result; final damage is never below `MIN_DAMAGE`.

**Validates: Requirements 3.2, 4.1, 6.1**

### Property 8: Range efficiency is 1 at distance 1 and non-increasing beyond it

For any distance ≥ 1, `calculateRangeEfficiency(1) = 1.0`, the result is non-increasing as distance grows, and it never goes below 0.

**Validates: Requirements 3.2, 4.1, 6.1**

### Property 9: Applied damage caps health to [0, 50] and is never zero

For any current health and any damage value, `applyDamage(currentHealth, damage)` lies within `[0, 50]` and reflects a damage of at least `MIN_DAMAGE`.

**Validates: Requirements 3.2, 4.4**

### Property 10: Orientation bonus is bounded and grows with angular difference

For any attacker/defender tile pair and facing, `calculateOrientationBonus(...)` lies within `[0, 2]`; a head-on approach yields 0 and a perfect rear approach yields 2; the bonus is non-decreasing as the angular difference increases.

**Validates: Requirements 3.1, 4.1, 6.1**

### Property 11: Arc classification respects documented angle thresholds

For any angular difference, `classifyArcFromAngle` returns `front` for 0–60°, `side` for 60–120°, and `rear` for 120–180°, matching `COMBAT_RULES.md` §4.

**Validates: Requirements 3.1, 4.4, 6.1**

### Property 12: Range threshold is monotonic and anchored at the base reach

For any two range-attack values `r1 ≤ r2`, `getRangeThreshold(r1) ≤ getRangeThreshold(r2)`, and `getRangeThreshold(0) = SEGMENT_RANGE_BASE` (1.0).

**Validates: Requirements 3.3, 4.1, 6.1**

### Property 13: Elevation range multiplier is bounded, monotonic, and neutral for drones

For any attacker/defender elevation types, `elevationRangeMultiplier` lies within `[0.5, 1.5]`, increases as the attacker-minus-defender elevation delta increases, and equals exactly `1.0` whenever either combatant is a drone.

**Validates: Requirements 3.3, 4.1, 6.1**

### Property 14: In-range test agrees with the segment-distance threshold

For any synthetic tile grid, attacker, and target, `isTargetInRange` returns true exactly when the unit has a weapon and the segment distance is `≤` the (elevation-scaled) threshold.

**Validates: Requirements 3.3, 4.4**

### Property 15: Segment distance is zero for identical positions and symmetric

For any synthetic tile grid and any two (tile, segment) positions, `segmentDistance` of a position with itself is 0, and `segmentDistance(a, b) = segmentDistance(b, a)`.

**Validates: Requirements 3.3, 4.4**

### Property 16: Compact world serialization round-trips

For any valid world model, converting to the compact wire format and back produces an equivalent world (tiles, units, and attributes preserved).

**Validates: Requirements 3.5, 4.4**

### Property 17: Explainer output contains every breakdown component

For any damage breakdown, the rendered explanation text includes each component the breakdown carries (attack power, effective defence, weapon mode, and final damage).

**Validates: Requirements 3.4, 4.4**

### Property 18: Weapon-mode selection chooses the highest-scoring mode

For any attacker/target configuration, `combatApi` resolves the attack using the weapon mode with the highest score, preferring Anti-Air against drone targets, consistent with `COMBAT_RULES.md` §10.

**Validates: Requirements 3.4, 4.4, 6.1**

## Testing Strategy

### Dual approach

- **Property tests** (`fast-check`, ≥100 iterations each) cover the universal properties above — formula bounds, monotonicity, capping, round-trips, geometry invariants.
- **Example/unit tests** cover specific behaviours, edge cases, rejection reasons, and golden smoke values.
- **Integration tests** (1–3 examples) cover world generation and server-IO wiring where behaviour does not vary meaningfully with input.

### Golden smoke discipline

At most one labelled golden smoke test per balance formula (`repair`, `combatFormula` damage, orientation). Each is commented as expected to break on intentional balance changes, so a balance edit produces an obvious, single failure rather than dozens.

### Determinism

Where randomness matters, the seed is set through `src/world/rng.ts`. Time, network, and filesystem are mocked only at their boundaries. All other code runs for real.

### Verification

The whole suite must pass under a **single** `npm test` run (Vitest single-run, no watch mode) — the global acceptance gate (Requirement 7.3). Each test file is kept under 300 lines, splitting by concern where needed. Run:

```
npm test
```
