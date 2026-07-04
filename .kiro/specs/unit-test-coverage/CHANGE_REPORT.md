# Unit Test Coverage — Change Report

**Spec:** `unit-test-coverage`
**Task:** 8.1 — Produce the change report
**Validates:** Requirements 1.4, 7.1, 7.2

This report summarises every test file modified, removed, or added during the
unit-test-coverage effort, the reason for each change, where each correctness
property (1–18) landed, the single user-approved production change, and the
findings raised separately. All claims below were verified against `git` and the
working tree rather than a written summary.

---

## 1. Scope Confirmation

The effort is confined to the agreed scope: `src/world/**`, `server/**`, and
`shared/**`. **No `client/**` files were touched.**

Verification (`git status --porcelain | Select-String "client/"`) returned **no
matches** — zero client changes, satisfying Requirement 7.2.

The change set is test-only with respect to game logic, **except one
user-approved production fix** in `server/combatExplainer.ts` (see §4). Supporting
non-test changes (tooling/config/docs) are listed in §6 for completeness; none of
them alter game/business logic under `src/world/**` or `shared/**`.

Every touched or added test file is under the 300-line limit (Requirement 4.5 /
1.5); the largest are `repair.test.ts` (293), `compact.test.ts` (289),
`units.test.ts` (288), `combatApi.test.ts` (289).

---

## 2. Per-File Changes (Added / Modified / Removed)

### 2a. Modified test files

| File | Change | Reason |
|---|---|---|
| `src/world/__tests__/repair.test.ts` | **Modified (rewritten)** | Replaced pinned balance-formula outputs (`toBe(2/20/9/5/29/3)`) with Properties 1–4 + one labelled golden smoke test. Retained behavioural `validateRepair`/`resolveRepair` tests (rejection reasons, mutate/non-mutate, not-found). Task 3.1. |
| `src/world/__tests__/vec3.test.ts` | **Modified** | Repaired a *passes-when-broken* midpoint test — assertion did not fail on incorrect output. Task 4.1. |
| `src/world/__tests__/turnState.test.ts` | **Modified** | Replaced pinned `3.75` rotation cost with the `ROTATION_FEE` constant (brittle/pinned → constant-derived). Task 4.1. |
| `src/world/__tests__/units.test.ts` | **Modified** | Replaced a brittle exact attribute-count assertion with structural invariants. Task 4.1. |
| `src/world/__tests__/spawn.test.ts` | **Modified** | Corrected a misleading test name so it describes the behaviour actually asserted. Task 4.1. |
| `src/world/__tests__/combat.test.ts` | **Modified (split)** | Split for the <300-line rule into `combat.test.ts` + `combat.resolve.test.ts` + shared `combat.fixtures.ts`. Task 4.1. |
| `src/world/__tests__/movement.test.ts` | **Modified (split)** | Split for the <300-line rule into `movement.test.ts` + `movement.reach.test.ts` + shared `movement.fixtures.ts`. Task 4.1. |
| `src/world/__tests__/pathfinding.test.ts` | **Modified (extended)** | Added path-validity invariants (contiguity, correct start/end, blocked-tile respect). Task 7.4. |
| `server/__tests__/aiTurn.test.ts` | **Modified** | Replaced a tautological `finalUnits` assertion (restated input) with an observable-damage assertion. Task 4.2. |

No test files were **removed**. The `combat.test.ts` / `movement.test.ts` splits
relocate content into new sibling files rather than deleting coverage.

**Reviewed and intentionally left unchanged (healthy):**
`src/world/__tests__/terrain.test.ts`; `server/__tests__/combat.test.ts`,
`server/__tests__/matchSession.test.ts`, `server/__tests__/moveValidation.test.ts`.

### 2b. Added test files

| File | Property/module added | Task |
|---|---|---|
| `src/world/__tests__/combatFacing.test.ts` | Properties 10, 11 + degenerate-geometry examples (coincident tiles → `NaN`/0) | 2.1 |
| `src/world/__tests__/combatFormula.test.ts` | Properties 5–9 + one golden smoke + constants check | 2.2 |
| `shared/__tests__/rangeCheck.test.ts` | Properties 12–15 | 2.3 |
| `src/world/__tests__/combat.resolve.test.ts` | Split-out resolve behaviour from `combat.test.ts` | 4.1 |
| `src/world/__tests__/combat.fixtures.ts` | Shared generators/builders for the combat split | 4.1 |
| `src/world/__tests__/movement.reach.test.ts` | Split-out reach behaviour from `movement.test.ts` | 4.1 |
| `src/world/__tests__/movement.fixtures.ts` | Shared generators/builders for the movement split | 4.1 |
| `server/__tests__/combatApi.test.ts` | Property 18 + post-attack invariants + e2e wiring | 6.1 |
| `server/__tests__/combatExplainer.test.ts` | Property 17 + representative formatting examples | 6.2 |
| `src/world/__tests__/compact.test.ts` | Property 16 (in-test inverse round-trip) | 7.2 |
| `src/world/__tests__/geodesic.test.ts` | Polyhedron invariants (tile counts, neighbour symmetry) | 7.3 |
| `src/world/__tests__/segmentGeometry.test.ts` | Segment-distance zero/symmetry | 7.3 |
| `shared/__tests__/pathfinding.test.ts` | Path-validity invariants (shared pathfinding) | 7.4 |
| `src/world/__tests__/validate.test.ts` | Malformed-world rejection (no unhandled throw) | 7.5 |
| `shared/__tests__/unitNaming.test.ts` | Deterministic, collision-free naming property | 7.5 |
| `src/world/__tests__/buildings.test.ts` | Attribute-lookup example tests | 7.5 |
| `server/__tests__/generateApi.test.ts` | Generation integration example | 7.6 |
| `server/__tests__/regenerate.test.ts` | Regeneration integration example | 7.6 |
| `server/__tests__/devPlugin.test.ts` | Server-wiring smoke check | 7.6 |

### 2c. Supporting (tooling) change

| File | Change | Reason |
|---|---|---|
| `package.json` | **Modified** | Added `fast-check@4.8.0` (pinned) to devDependencies; added `@vitest/coverage-v8`; added `test:cov` / `test:watch` scripts. Task 1.1 / 1.2. |

---

## 3. Properties Implemented (1–18) and Where

| Property | Summary | File |
|---|---|---|
| 1 | `calculateRepairAmount` monotonic in repair points | `src/world/__tests__/repair.test.ts` |
| 2 | `calculateRepairAmount` monotonic in maximum health | `src/world/__tests__/repair.test.ts` |
| 3 | Repair amount within `[2, 20]` incl. clamping | `src/world/__tests__/repair.test.ts` |
| 4 | `applyRepair` ≤ maxHealth, ≥ clamp(current,0,max) | `src/world/__tests__/repair.test.ts` |
| 5 | Formula damage within `[1, 30]` | `src/world/__tests__/combatFormula.test.ts` |
| 6 | Damage monotonic ↑ attack power, ↓ effective defence | `src/world/__tests__/combatFormula.test.ts` |
| 7 | Drone incoming modifiers order Direct ≤ Splash ≤ Anti-Air, each ≤ non-drone | `src/world/__tests__/combatFormula.test.ts` |
| 8 | `calculateRangeEfficiency(1)=1.0`, non-increasing, ≥0 | `src/world/__tests__/combatFormula.test.ts` |
| 9 | `applyDamage` caps health to `[0, 50]`, ≥ MIN_DAMAGE applied | `src/world/__tests__/combatFormula.test.ts` |
| 10 | Orientation bonus `[0,2]`, head-on→0, rear→2, monotonic | `src/world/__tests__/combatFacing.test.ts` |
| 11 | `classifyArcFromAngle` front/side/rear thresholds (§4) | `src/world/__tests__/combatFacing.test.ts` |
| 12 | `getRangeThreshold` monotonic, `(0)=SEGMENT_RANGE_BASE` | `shared/__tests__/rangeCheck.test.ts` |
| 13 | `elevationRangeMultiplier` `[0.5,1.5]`, monotonic, drone=1.0 | `shared/__tests__/rangeCheck.test.ts` |
| 14 | `isTargetInRange` agrees with elevation-scaled threshold | `shared/__tests__/rangeCheck.test.ts` |
| 15 | `segmentDistance` zero on identity, symmetric | `shared/__tests__/rangeCheck.test.ts` |
| 16 | Compact world serialization round-trips | `src/world/__tests__/compact.test.ts` |
| 17 | Explainer output contains every breakdown component | `server/__tests__/combatExplainer.test.ts` |
| 18 | Weapon-mode selection picks highest score, Anti-Air vs drones | `server/__tests__/combatApi.test.ts` |

All properties use `fast-check` at ≥100 iterations, tagged with their design
property number, with combat constants derived from `COMBAT_RULES.md`.

---

## 4. The One User-Approved Production Change

**File:** `server/combatExplainer.ts` (Splash Fire branch of `explainAttack`).

While authoring Property 17 (task 6.2), the test caught a **genuine production
gap**: the Splash Fire branch omitted the `AttackPower` term from its rendered
breakdown that every other weapon-mode branch includes. With **explicit user
approval**, a one-line production fix was applied so the Splash Fire description
now computes and shows `AttackPower = (baseSplash × chassisModifier ×
rangeEfficiency) + orientationBonus`, making Property 17 hold for splash as well.

This is the **only** production-code change in the entire effort and is an
explicit, user-approved exception to the otherwise test-only scope. It is logged
in `DECISIONS.md`.

---

## 5. Findings Raised Separately

1. **Splash `AttackPower` explainer gap — RESOLVED.** The Property 17 test exposed
   that `explainAttack`'s Splash Fire branch dropped the `AttackPower` term.
   Fixed with user approval (see §4); logged in `DECISIONS.md`.

2. **Latent robustness gap in `src/world/validate.ts` — NOT patched.** `validate`
   *throws* rather than rejecting (returning an error/`false`) on out-of-range
   neighbour ids and `city.tileIndex`. The `validate.test.ts` coverage documents
   the current behaviour; the hardening is left to the user as it is a production
   change outside this test-only effort.

3. **Unreachable defensive code in `src/world/pathfinding.ts:91` — NOT patched.**
   The `: 1` `costFn` fallback is unreachable given current callers (dead
   defensive branch). Noted, not modified.

---

## Verification commands used

```
git status
git diff --stat HEAD
git status --porcelain | Select-String "client/"   # → no matches
git --no-pager diff -- server/combatExplainer.ts
git --no-pager diff -- package.json
# per-file line counts across the three __tests__ trees (all < 300)
```
