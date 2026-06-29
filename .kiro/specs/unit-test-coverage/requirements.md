# Requirements Document

## Introduction

This feature covers a review and extension of the Vitest unit test suite for the Drone Domination backend and shared logic. The goal is to raise the suite from incidental coverage to meaningful behavioural confidence in correctness, with combat correctness prioritised first. Work is strictly limited to backend and shared code (`src/world/**`, `server/**`, `shared/**`); client code (`client/**`) is out of scope.

The effort has three thrusts: (1) critically review and repair weak existing tests in place, (2) convert balance-formula tests from pinned values to property/range assertions, and (3) add new behavioural coverage for currently untested modules, ordered by combat-correctness priority. All work must honour the repository testing conventions and treat `COMBAT_RULES.md` as the authoritative source for combat formulas and constants.

## Glossary

- **Test_Suite**: The collection of Vitest unit test files covering `src/world/**`, `server/**`, and `shared/**`.
- **Weak_Test**: An existing test that is tautological, mock-only, brittle, implementation-coupled, or passes even when the code under test is broken.
- **Property_Assertion**: An assertion that verifies a structural property of a formula (monotonicity, bounds, relative comparison, capping) rather than a single pinned numeric output.
- **Golden_Smoke_Test**: A single, clearly-labelled test per formula that pins one representative output value and is expected to break on intentional balance changes.
- **Game_Balance_Formula**: A formula whose numeric outputs are tuning values subject to change (e.g. damage, repair, defence calculations).
- **External_Boundary**: A true external dependency — system time, randomness (`src/world/rng.ts`), network, or filesystem.
- **Code_Under_Test**: The production module that a given test is asserting against.
- **In_Scope_Code**: Source under `src/world/**`, `server/**`, and `shared/**`.
- **COMBAT_RULES**: The authoritative `COMBAT_RULES.md` document defining combat formulas, validation rules, and constants.
- **Change_Report**: A summary delivered after the work describing which tests were modified, removed, or added and why.

## Requirements

### Requirement 1: Review and repair weak existing tests

**User Story:** As a developer, I want weak existing tests fixed in place, so that the suite reflects real correctness rather than false confidence.

#### Acceptance Criteria

1. THE Test_Suite SHALL be reviewed for Weak_Tests across all In_Scope_Code.
2. WHEN a Weak_Test is identified, THE Test_Suite SHALL replace the assertion with one that fails if the Code_Under_Test produces incorrect behaviour.
3. WHERE an existing test mocks the Code_Under_Test, THE Test_Suite SHALL remove that mock and exercise the real implementation.
4. WHEN the review and repairs are complete, THE Change_Report SHALL list each modified or removed test with the reason for the change.
5. THE Test_Suite SHALL constrain each test file to fewer than 300 lines.

### Requirement 2: Convert repair formula tests to property assertions

**User Story:** As a developer, I want repair tests expressed as properties rather than pinned values, so that they survive balance tuning while still guarding correctness.

#### Acceptance Criteria

1. THE Test_Suite SHALL replace pinned formula values in `repair.test.ts` with Property_Assertions.
2. THE Test_Suite SHALL assert that repair output increases monotonically as repair points increase.
3. THE Test_Suite SHALL assert that repair output increases monotonically as maximum health increases.
4. THE Test_Suite SHALL assert that repair output remains within defined lower and upper bounds.
5. THE Test_Suite SHALL assert that resulting health is capped at maximum health.
6. THE Test_Suite SHALL retain exactly one labelled Golden_Smoke_Test in `repair.test.ts`.

### Requirement 3: Add combat-correctness coverage first

**User Story:** As a developer, I want new tests added in combat-priority order, so that the highest-risk correctness areas are covered before lower-priority gaps.

#### Acceptance Criteria

1. THE Test_Suite SHALL add behavioural coverage for `src/world/combatFacing.ts`.
2. THE Test_Suite SHALL add behavioural coverage for `src/world/combatFormula.ts`.
3. THE Test_Suite SHALL add behavioural coverage for `shared/rangeCheck.ts`.
4. WHEN combat-module coverage is complete, THE Test_Suite SHALL add behavioural coverage for `server/combatApi.ts` and `server/combatExplainer.ts`.
5. WHEN combat and server combat coverage is complete, THE Test_Suite SHALL add coverage for the remaining untested In_Scope_Code modules.
6. THE Test_Suite SHALL order the addition of coverage so that combat correctness is addressed before non-combat gaps.

### Requirement 4: Honour balance-formula testing conventions

**User Story:** As a developer, I want all new tests to follow the project testing conventions, so that the suite stays maintainable and tuning-resilient.

#### Acceptance Criteria

1. WHERE a test targets a Game_Balance_Formula, THE Test_Suite SHALL use Property_Assertions instead of pinned numeric outputs.
2. THE Test_Suite SHALL include at most one Golden_Smoke_Test per Game_Balance_Formula.
3. WHEN a Golden_Smoke_Test is added, THE Test_Suite SHALL label it as a golden smoke test.
4. THE Test_Suite SHALL assert observable behaviour rather than internal implementation detail.
5. THE Test_Suite SHALL constrain each new test file to fewer than 300 lines.

### Requirement 5: Mock only true external boundaries

**User Story:** As a developer, I want mocks restricted to external boundaries, so that tests verify the real production logic.

#### Acceptance Criteria

1. WHERE a test requires deterministic time, randomness, network, or filesystem behaviour, THE Test_Suite SHALL mock only that External_Boundary.
2. THE Test_Suite SHALL exercise the real Code_Under_Test rather than a substitute.
3. WHEN randomness must be controlled, THE Test_Suite SHALL control it through `src/world/rng.ts`.

### Requirement 6: Treat COMBAT_RULES as authoritative

**User Story:** As a developer, I want combat property assertions derived from COMBAT_RULES, so that tests check intended behaviour rather than invented values.

#### Acceptance Criteria

1. WHEN authoring combat Property_Assertions, THE Test_Suite SHALL derive expected properties and constants from COMBAT_RULES.
2. IF a required combat constant is absent from COMBAT_RULES, THEN THE Test_Suite SHALL avoid asserting an invented value for that constant.

### Requirement 7: Stay within agreed scope

**User Story:** As a developer, I want the work confined to the agreed scope, so that the change set stays focused and reviewable.

#### Acceptance Criteria

1. THE Test_Suite SHALL limit changes to tests covering In_Scope_Code.
2. THE Test_Suite SHALL exclude changes to tests covering `client/**`.
3. WHEN the work is complete, THE Test_Suite SHALL pass under a single `npm test` run.
