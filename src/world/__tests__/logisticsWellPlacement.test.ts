// Feature: oil-logistics-system, Property 6: Well placement gate
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 12.2, 12.3
//
// Property-based test for `validateWellPlacement` (src/world/logistics.ts). The gate
// admits a well ONLY when every condition holds simultaneously:
//   - the unit's `engineer` attribute is an integer in 1..5            (Req 2.1, 2.2)
//   - the target segment's steepness is <= MAX_STEEP_WHEELED           (Req 2.3)
//   - the tile is an Oil_Deposit (`resourceType === 'oil'`)            (Req 2.4)
//   - the segment is not already occupied by an existing well         (Req 2.5)
//   - the tile is not owned by another player                          (Req 12.2, 12.3)
// and it rejects with the documented reason (respecting the validator's rejection
// precedence) otherwise, never mutating its inputs.
//
// No pinned formula values: MAX_STEEP_WHEELED is imported from the shared movement
// constants and used symbolically as the steepness threshold.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateWellPlacement } from '../logistics.js';
import { MAX_STEEP_WHEELED } from '../../../shared/movementConstants.js';
import type {
  EngineerUnitRef,
  LogisticsContext,
  LogisticsState,
  LogisticsTile,
  OilWell,
} from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MY_FACTION = 'p1';
const OTHER_FACTION = 'p2';
const SEGMENT_COUNT = 6; // a hex

type Owner = 'self' | 'other' | 'unowned';

interface Scenario {
  engineer: number;
  segment: number;
  steep: number;
  resourceType: string;
  occupied: boolean;
  owner: Owner;
}

function ownerId(owner: Owner): string | undefined {
  if (owner === 'self') return MY_FACTION;
  if (owner === 'other') return OTHER_FACTION;
  return undefined;
}

function makeTile(s: Scenario): LogisticsTile {
  const segSteep = new Array<number>(SEGMENT_COUNT).fill(0);
  // Only the target segment carries the varied steepness; others stay flat so
  // they never influence the single-segment well gate.
  segSteep[s.segment] = s.steep;
  return {
    index: 0,
    neighbours: [1, 2, 3, 4, 5, 6],
    terrainType: 'plains',
    height: 3,
    forested: false,
    segSteep,
    resourceType: s.resourceType,
    ownerId: ownerId(s.owner),
  };
}

function makeState(s: Scenario): LogisticsState {
  const wells: OilWell[] = s.occupied
    ? [
        {
          id: 'existing-well',
          ownerId: MY_FACTION,
          tileIndex: 0,
          segment: s.segment,
          storedOil: 0,
          hitPoints: 10,
          maxHitPoints: 10,
        },
      ]
    : [];
  return {
    wells,
    refineries: [],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

function makeContext(s: Scenario): LogisticsContext {
  return { tiles: [makeTile(s)], state: makeState(s) };
}

function makeUnit(engineer: number): EngineerUnitRef {
  return {
    id: 'engineer-unit',
    ownerId: MY_FACTION,
    tileIndex: 0,
    segment: 0,
    attributes: { size: 3, wheeledMovement: 1, engineer },
  };
}

// Oracle predicates mirroring the acceptance criteria (segment kept in range so
// the `ineligible-tile` guard never fires in these scenarios).
const engineerValid = (e: number): boolean => Number.isInteger(e) && e >= 1 && e <= 5;
const ownerOk = (o: Owner): boolean => o !== 'other';

// ---------------------------------------------------------------------------
// Generators — constrained to the well-placement input space
// ---------------------------------------------------------------------------

// Includes valid (1..5), zero, out-of-range, and non-integer engineer values.
const arbEngineer = fc.oneof(
  fc.integer({ min: -2, max: 8 }),
  fc.double({ min: 0.5, max: 5.5, noNaN: true }),
);
const arbSegment = fc.integer({ min: 0, max: SEGMENT_COUNT - 1 });
// Straddles the MAX_STEEP_WHEELED threshold in both directions.
const arbSteep = fc.double({ min: 0, max: MAX_STEEP_WHEELED * 2, noNaN: true });
const arbResource = fc.constantFrom('oil', 'iron', 'none', 'coal');
const arbOwner = fc.constantFrom<Owner>('self', 'other', 'unowned');

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  engineer: arbEngineer,
  segment: arbSegment,
  steep: arbSteep,
  resourceType: arbResource,
  occupied: fc.boolean(),
  owner: arbOwner,
});

const RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// Property 6: Well placement gate
// ---------------------------------------------------------------------------

describe('validateWellPlacement — Property 6: well placement gate', () => {
  it('is legal iff engineer∈1..5, steep≤threshold, oil, unoccupied, and not other-owned', () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const result = validateWellPlacement(makeContext(s), 0, s.segment, makeUnit(s.engineer));
        const expected =
          engineerValid(s.engineer) &&
          s.steep <= MAX_STEEP_WHEELED &&
          s.resourceType === 'oil' &&
          !s.occupied &&
          ownerOk(s.owner);
        expect(result.legal).toBe(expected);
      }),
      RUNS,
    );
  });

  it('rejects a non-engineer (engineer∉1..5) with reason "lacks-engineer" regardless of other fields', () => {
    const arbInvalidEngineer = fc.oneof(
      fc.integer({ min: -2, max: 0 }),
      fc.integer({ min: 6, max: 8 }),
      fc.double({ min: 0.5, max: 5.5, noNaN: true }).filter((e) => !Number.isInteger(e)),
    );
    fc.assert(
      fc.property(arbScenario, arbInvalidEngineer, (s, engineer) => {
        const result = validateWellPlacement(makeContext(s), 0, s.segment, makeUnit(engineer));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('lacks-engineer');
      }),
      RUNS,
    );
  });

  it('rejects too-steep terrain with reason "too-steep" (engineer valid, owner ok)', () => {
    const arbSteepScenario = fc.record({
      engineer: fc.integer({ min: 1, max: 5 }),
      segment: arbSegment,
      // Strictly above the threshold.
      steep: fc.double({ min: MAX_STEEP_WHEELED + 0.01, max: MAX_STEEP_WHEELED * 2, noNaN: true }),
      resourceType: arbResource,
      occupied: fc.boolean(),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
    });
    fc.assert(
      fc.property(arbSteepScenario, (s) => {
        const result = validateWellPlacement(makeContext(s), 0, s.segment, makeUnit(s.engineer));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('too-steep');
      }),
      RUNS,
    );
  });

  it('rejects a non-oil tile with reason "no-deposit" (engineer valid, owner ok, not too steep)', () => {
    const arbNoDepositScenario = fc.record({
      engineer: fc.integer({ min: 1, max: 5 }),
      segment: arbSegment,
      steep: fc.double({ min: 0, max: MAX_STEEP_WHEELED, noNaN: true }),
      resourceType: fc.constantFrom('iron', 'none', 'coal'),
      occupied: fc.boolean(),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
    });
    fc.assert(
      fc.property(arbNoDepositScenario, (s) => {
        const result = validateWellPlacement(makeContext(s), 0, s.segment, makeUnit(s.engineer));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('no-deposit');
      }),
      RUNS,
    );
  });

  it('rejects an occupied segment with reason "segment-occupied" (all prior gates pass)', () => {
    const arbOccupiedScenario = fc.record({
      engineer: fc.integer({ min: 1, max: 5 }),
      segment: arbSegment,
      steep: fc.double({ min: 0, max: MAX_STEEP_WHEELED, noNaN: true }),
      resourceType: fc.constant('oil'),
      occupied: fc.constant(true),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
    });
    fc.assert(
      fc.property(arbOccupiedScenario, (s) => {
        const result = validateWellPlacement(makeContext(s), 0, s.segment, makeUnit(s.engineer));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('segment-occupied');
      }),
      RUNS,
    );
  });

  it('rejects a tile owned by another player with reason "owned-by-other-player"', () => {
    const arbOtherOwnedScenario = fc.record({
      engineer: fc.integer({ min: 1, max: 5 }),
      segment: arbSegment,
      steep: fc.double({ min: 0, max: MAX_STEEP_WHEELED * 2, noNaN: true }),
      resourceType: arbResource,
      occupied: fc.boolean(),
      owner: fc.constant<Owner>('other'),
    });
    fc.assert(
      fc.property(arbOtherOwnedScenario, (s) => {
        const result = validateWellPlacement(makeContext(s), 0, s.segment, makeUnit(s.engineer));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('owned-by-other-player');
      }),
      RUNS,
    );
  });

  it('never mutates the context or unit', () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const ctx = makeContext(s);
        const unit = makeUnit(s.engineer);
        const ctxBefore = structuredClone(ctx);
        const unitBefore = structuredClone(unit);
        validateWellPlacement(ctx, 0, s.segment, unit);
        expect(ctx).toEqual(ctxBefore);
        expect(unit).toEqual(unitBefore);
      }),
      RUNS,
    );
  });
});
