// Feature: oil-logistics-system, Property 11: Refinery eligibility predicate
//
// Validates: Requirements 4.1, 4.8, 4.9, 4.10, 4.11, 4.12
//
// Property-based test for `validateRefineryPlacement` (src/world/logistics.ts). A
// HexTile is eligible to host a NEW Refinery ONLY when every condition holds:
//   - the tile exists                                                    (Req 4.1)
//   - it is not owned by another player                                  (Req 4.11, 12.3)
//   - it is not water ('ocean')                                          (Req 4.12)
//   - it is not an uncleared forest (forested and NOT in clearedForests) (Req 4.12)
//   - it does not already contain a Refinery                             (Req 4.10)
//   - EVERY segment's steepness is <= MAX_STEEP_WHEELED                  (Req 4.11)
//   - no segment is occupied by a well/refinery-segment/hub              (Req 4.11)
// and otherwise it rejects with the documented reason (respecting the validator's
// rejection precedence), never mutating its inputs.
//
// It also covers `validateRefinerySegment` briefly for the 'outside-refinery-tile'
// (segment out of range) and 'refinery-at-capacity' (all segments filled) rejections
// (Req 4.8, 4.9).
//
// No pinned formula values: MAX_STEEP_WHEELED is imported from the shared movement
// constants and used symbolically as the steepness threshold.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateRefineryPlacement, validateRefinerySegment } from '../logistics.js';
import { MAX_STEEP_WHEELED } from '../../../shared/movementConstants.js';
import type {
  LogisticsContext,
  LogisticsState,
  LogisticsTile,
  OilWell,
  Refinery,
} from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MY_FACTION = 'p1';
const OTHER_FACTION = 'p2';
const SEGMENT_COUNT = 6; // a hex

type Owner = 'self' | 'other' | 'unowned';

interface Scenario {
  terrain: string;
  forested: boolean;
  cleared: boolean; // whether the (forested) tile is in clearedForests
  refineryPresent: boolean; // a refinery already occupies the tile
  owner: Owner;
  segSteep: number[]; // length SEGMENT_COUNT
  occupiedSegs: boolean[]; // length SEGMENT_COUNT — a well on that segment
}

function ownerId(owner: Owner): string | undefined {
  if (owner === 'self') return MY_FACTION;
  if (owner === 'other') return OTHER_FACTION;
  return undefined;
}

function makeTile(s: Scenario): LogisticsTile {
  return {
    index: 0,
    neighbours: [1, 2, 3, 4, 5, 6],
    terrainType: s.terrain,
    height: 3,
    forested: s.forested,
    segSteep: s.segSteep.slice(),
    ownerId: ownerId(s.owner),
  };
}

function makeState(s: Scenario): LogisticsState {
  const wells: OilWell[] = [];
  s.occupiedSegs.forEach((occupied, seg) => {
    if (occupied) {
      wells.push({
        id: `well-${seg}`,
        ownerId: MY_FACTION,
        tileIndex: 0,
        segment: seg,
        storedOil: 0,
        hitPoints: 10,
        maxHitPoints: 10,
      });
    }
  });
  const refineries: Refinery[] = s.refineryPresent
    ? [
        {
          id: 'existing-refinery',
          ownerId: MY_FACTION,
          tileIndex: 0,
          segments: [0],
          heldOil: 0,
          refinedProductAvailable: 0,
          hitPoints: 20,
          maxHitPoints: 20,
        },
      ]
    : [];
  return {
    wells,
    refineries,
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: s.forested && s.cleared ? [0] : [],
    bridges: [],
  };
}

function makeContext(s: Scenario): LogisticsContext {
  return { tiles: [makeTile(s)], state: makeState(s) };
}

// ---------------------------------------------------------------------------
// Oracle predicates mirroring the acceptance criteria (Property 11)
// ---------------------------------------------------------------------------

const ownerOk = (o: Owner): boolean => o !== 'other';
const notWater = (s: Scenario): boolean => s.terrain !== 'ocean';
const notUnclearedForest = (s: Scenario): boolean => !(s.forested && !s.cleared);
const noRefinery = (s: Scenario): boolean => !s.refineryPresent;
const allSteepOk = (s: Scenario): boolean => s.segSteep.every((v) => v <= MAX_STEEP_WHEELED);
const noneOccupied = (s: Scenario): boolean => !s.occupiedSegs.some(Boolean);

const isEligible = (s: Scenario): boolean =>
  ownerOk(s.owner) &&
  notWater(s) &&
  notUnclearedForest(s) &&
  noRefinery(s) &&
  allSteepOk(s) &&
  noneOccupied(s);

// ---------------------------------------------------------------------------
// Generators — constrained to the refinery-placement input space
// ---------------------------------------------------------------------------

const arbTerrain = fc.constantFrom('plains', 'hills', 'desert', 'tundra', 'ocean');
// Straddles the MAX_STEEP_WHEELED threshold in both directions.
const arbSegSteep = fc.array(
  fc.double({ min: 0, max: MAX_STEEP_WHEELED * 2, noNaN: true }),
  { minLength: SEGMENT_COUNT, maxLength: SEGMENT_COUNT },
);
const arbOccupied = fc.array(fc.boolean(), {
  minLength: SEGMENT_COUNT,
  maxLength: SEGMENT_COUNT,
});
const arbOwner = fc.constantFrom<Owner>('self', 'other', 'unowned');

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  terrain: arbTerrain,
  forested: fc.boolean(),
  cleared: fc.boolean(),
  refineryPresent: fc.boolean(),
  owner: arbOwner,
  segSteep: arbSegSteep,
  occupiedSegs: arbOccupied,
});

// Flat, unoccupied segments — used when isolating non-terrain/steepness rejections.
const flatSteep = fc.constant<number[]>(new Array(SEGMENT_COUNT).fill(0));
const noOccupancy = fc.constant<boolean[]>(new Array(SEGMENT_COUNT).fill(false));
// At least one segment strictly above the threshold.
const arbSteepWithOffender = fc
  .tuple(arbSegSteep, fc.integer({ min: 0, max: SEGMENT_COUNT - 1 }))
  .map(([arr, idx]) => {
    const copy = arr.slice();
    copy[idx] = MAX_STEEP_WHEELED + 0.5;
    return copy;
  });
// At least one occupied segment.
const arbOccupiedWithOne = fc
  .tuple(arbOccupied, fc.integer({ min: 0, max: SEGMENT_COUNT - 1 }))
  .map(([arr, idx]) => {
    const copy = arr.slice();
    copy[idx] = true;
    return copy;
  });

const RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// Property 11: Refinery eligibility predicate
// ---------------------------------------------------------------------------

describe('validateRefineryPlacement — Property 11: refinery eligibility predicate', () => {
  it('is legal iff owned-ok, land, non-forest(or cleared), no refinery, all segs ≤ threshold, unoccupied', () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(isEligible(s));
      }),
      RUNS,
    );
  });

  it('rejects a missing tile with reason "ineligible-tile"', () => {
    const ctx: LogisticsContext = {
      tiles: [],
      state: makeState({
        terrain: 'plains',
        forested: false,
        cleared: false,
        refineryPresent: false,
        owner: 'self',
        segSteep: new Array(SEGMENT_COUNT).fill(0),
        occupiedSegs: new Array(SEGMENT_COUNT).fill(false),
      }),
    };
    const result = validateRefineryPlacement(ctx, 5, MY_FACTION);
    expect(result.legal).toBe(false);
    expect(result.reason).toBe('ineligible-tile');
  });

  it('rejects a tile owned by another player with reason "owned-by-other-player"', () => {
    const arb = fc.record({
      terrain: arbTerrain,
      forested: fc.boolean(),
      cleared: fc.boolean(),
      refineryPresent: fc.boolean(),
      owner: fc.constant<Owner>('other'),
      segSteep: arbSegSteep,
      occupiedSegs: arbOccupied,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('owned-by-other-player');
      }),
      RUNS,
    );
  });

  it('rejects water with reason "ineligible-tile" (owner ok)', () => {
    const arb = fc.record({
      terrain: fc.constant('ocean'),
      forested: fc.boolean(),
      cleared: fc.boolean(),
      refineryPresent: fc.boolean(),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
      segSteep: arbSegSteep,
      occupiedSegs: arbOccupied,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('ineligible-tile');
      }),
      RUNS,
    );
  });

  it('rejects an uncleared forest with reason "ineligible-tile" (land, owner ok)', () => {
    const arb = fc.record({
      terrain: fc.constantFrom('plains', 'hills', 'desert', 'tundra'),
      forested: fc.constant(true),
      cleared: fc.constant(false),
      refineryPresent: fc.boolean(),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
      segSteep: arbSegSteep,
      occupiedSegs: arbOccupied,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('ineligible-tile');
      }),
      RUNS,
    );
  });

  it('rejects a tile that already contains a refinery with reason "ineligible-tile"', () => {
    const arb = fc.record({
      terrain: fc.constantFrom('plains', 'hills', 'desert', 'tundra'),
      forested: fc.constant(false),
      cleared: fc.boolean(),
      refineryPresent: fc.constant(true),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
      segSteep: arbSegSteep,
      occupiedSegs: arbOccupied,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('ineligible-tile');
      }),
      RUNS,
    );
  });

  it('rejects too-steep terrain with reason "too-steep" (land, non-forest, no refinery, owner ok)', () => {
    const arb = fc.record({
      terrain: fc.constantFrom('plains', 'hills', 'desert', 'tundra'),
      forested: fc.constant(false),
      cleared: fc.boolean(),
      refineryPresent: fc.constant(false),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
      segSteep: arbSteepWithOffender,
      occupiedSegs: arbOccupied,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('too-steep');
      }),
      RUNS,
    );
  });

  it('rejects an occupied segment with reason "segment-occupied" (all prior gates pass)', () => {
    const arb = fc.record({
      terrain: fc.constantFrom('plains', 'hills', 'desert', 'tundra'),
      forested: fc.constant(false),
      cleared: fc.boolean(),
      refineryPresent: fc.constant(false),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
      segSteep: flatSteep,
      occupiedSegs: arbOccupiedWithOne,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('segment-occupied');
      }),
      RUNS,
    );
  });

  it('accepts an eligible tile (flat, unowned/self, land, no refinery, unoccupied)', () => {
    const arb = fc.record({
      terrain: fc.constantFrom('plains', 'hills', 'desert', 'tundra'),
      forested: fc.boolean(),
      cleared: fc.constant(true), // if forested, it's cleared
      refineryPresent: fc.constant(false),
      owner: fc.constantFrom<Owner>('self', 'unowned'),
      segSteep: flatSteep,
      occupiedSegs: noOccupancy,
    });
    fc.assert(
      fc.property(arb, (s) => {
        const result = validateRefineryPlacement(makeContext(s), 0, MY_FACTION);
        expect(result.legal).toBe(true);
        expect(result.reason).toBeUndefined();
      }),
      RUNS,
    );
  });

  it('never mutates the context', () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const ctx = makeContext(s);
        const before = structuredClone(ctx);
        validateRefineryPlacement(ctx, 0, MY_FACTION);
        expect(ctx).toEqual(before);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// validateRefinerySegment — brief coverage of Req 4.8 / 4.9
// ---------------------------------------------------------------------------

describe('validateRefinerySegment — Req 4.8 / 4.9 rejections', () => {
  function refineryTileCtx(): LogisticsContext {
    const tile: LogisticsTile = {
      index: 0,
      neighbours: [1, 2, 3, 4, 5, 6],
      terrainType: 'plains',
      height: 3,
      forested: false,
      segSteep: new Array(SEGMENT_COUNT).fill(0),
    };
    const state = makeState({
      terrain: 'plains',
      forested: false,
      cleared: false,
      refineryPresent: false,
      owner: 'self',
      segSteep: new Array(SEGMENT_COUNT).fill(0),
      occupiedSegs: new Array(SEGMENT_COUNT).fill(false),
    });
    return { tiles: [tile], state };
  }

  function makeRefinery(segments: number[]): Refinery {
    return {
      id: 'r1',
      ownerId: MY_FACTION,
      tileIndex: 0,
      segments,
      heldOil: 0,
      refinedProductAvailable: 0,
      hitPoints: 20,
      maxHitPoints: 20,
    };
  }

  it('rejects a segment index out of range with reason "outside-refinery-tile"', () => {
    const arbOutside = fc.oneof(
      fc.integer({ min: SEGMENT_COUNT, max: SEGMENT_COUNT + 5 }),
      fc.integer({ min: -5, max: -1 }),
    );
    fc.assert(
      fc.property(arbOutside, (segment) => {
        const result = validateRefinerySegment(refineryTileCtx(), makeRefinery([0]), segment);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('outside-refinery-tile');
      }),
      RUNS,
    );
  });

  it('rejects adding a segment when every segment is filled with reason "refinery-at-capacity"', () => {
    const full = makeRefinery([0, 1, 2, 3, 4, 5]); // all SEGMENT_COUNT segments occupied
    const arbInRange = fc.integer({ min: 0, max: SEGMENT_COUNT - 1 });
    fc.assert(
      fc.property(arbInRange, (segment) => {
        const result = validateRefinerySegment(refineryTileCtx(), full, segment);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('refinery-at-capacity');
      }),
      RUNS,
    );
  });
});
