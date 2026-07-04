import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  getRangeThreshold,
  elevationRangeMultiplier,
  isTargetInRange,
  segmentDistance,
  SEGMENT_RANGE_BASE,
  SEGMENT_RANGE_PER_POINT,
  ELEVATION_RANGE_MIN,
  ELEVATION_RANGE_MAX,
  RangeTile,
} from '../rangeCheck.js';

// ---------------------------------------------------------------------------
// Constants (derived from COMBAT_RULES.md §3, §13, §21)
//   §3:  RangeThreshold = rangeAttack × SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE
//        SEGMENT_RANGE_PER_POINT = 0.5, SEGMENT_RANGE_BASE = 1.0
//   §13: rangeMultiplier = clamp(1 + delta × (0.5/3), 0.50, 1.50); drone ⇒ 1.0
// ---------------------------------------------------------------------------

/** Height values matching the old elevation bands: lowlands=1, rolling=4, hills=7, mountain=10. */
const ELEVATION_HEIGHTS = [0, 1, 4, 7, 10, 11];

// ---------------------------------------------------------------------------
// Synthetic RangeTile grid generators — real geometry, no mocks
// ---------------------------------------------------------------------------

const arbVec3 = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.sqrt(x * x + y * y + z * z) > 0.1)
  .map(([x, y, z]): [number, number, number] => {
    const len = Math.sqrt(x * x + y * y + z * z);
    return [x / len, y / len, z / len];
  });

/** A grid of 2–6 hex tiles, each with a full boundary so the real centroid
 *  segment-distance path (not the BFS fallback) is exercised. */
const arbGrid: fc.Arbitrary<RangeTile[]> = fc
  .array(
    fc.record({
      pos: arbVec3,
      boundary: fc.array(arbVec3, { minLength: 6, maxLength: 6 }),
    }),
    { minLength: 2, maxLength: 6 },
  )
  .map((raw) =>
    raw.map((t, i, arr) => ({
      pos: t.pos,
      boundary: t.boundary,
      neighbours: [(i + 1) % arr.length, (i + arr.length - 1) % arr.length],
      sides: 6,
    })),
  );

const arbSegment = fc.integer({ min: 0, max: 5 });

// ===========================================================================
// Property 12 — Range threshold is monotonic and anchored at the base reach
// ===========================================================================

describe('Feature: unit-test-coverage, Property 12: getRangeThreshold monotonic, getRangeThreshold(0) = SEGMENT_RANGE_BASE', () => {
  it('is anchored at SEGMENT_RANGE_BASE (1.0) when rangeAttack = 0', () => {
    expect(getRangeThreshold(0)).toBe(SEGMENT_RANGE_BASE);
    expect(SEGMENT_RANGE_BASE).toBe(1.0);
  });

  it('is non-decreasing as rangeAttack increases', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(getRangeThreshold(lo)).toBeLessThanOrEqual(getRangeThreshold(hi));
          // and matches the documented linear formula
          expect(getRangeThreshold(hi)).toBeCloseTo(
            hi * SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE,
            10,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 13 — Elevation range multiplier is bounded, monotonic, drone-neutral
// ===========================================================================

describe('Feature: unit-test-coverage, Property 13: elevationRangeMultiplier bounded [0.5,1.5], monotonic in delta, 1.0 for drones', () => {
  it('stays within [ELEVATION_RANGE_MIN, ELEVATION_RANGE_MAX] = [0.5, 1.5]', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ELEVATION_HEIGHTS),
        fc.constantFrom(...ELEVATION_HEIGHTS),
        (att, def) => {
          const m = elevationRangeMultiplier(att, def, false);
          expect(m).toBeGreaterThanOrEqual(ELEVATION_RANGE_MIN);
          expect(m).toBeLessThanOrEqual(ELEVATION_RANGE_MAX);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is non-decreasing as the attacker-minus-defender elevation delta increases', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ELEVATION_HEIGHTS),
        fc.constantFrom(...ELEVATION_HEIGHTS),
        fc.constantFrom(...ELEVATION_HEIGHTS),
        (attA, attB, def) => {
          // order the two attacker elevations by their numeric level
          const [lo, hi] = attA <= attB ? [attA, attB] : [attB, attA];
          const mLo = elevationRangeMultiplier(lo, def, false);
          const mHi = elevationRangeMultiplier(hi, def, false);
          expect(mLo).toBeLessThanOrEqual(mHi);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('equals exactly 1.0 whenever either combatant is a drone', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ELEVATION_HEIGHTS),
        fc.constantFrom(...ELEVATION_HEIGHTS),
        (att, def) => {
          expect(elevationRangeMultiplier(att, def, true)).toBe(1.0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 14 — In-range test agrees with the segment-distance threshold
// ===========================================================================

describe('Feature: unit-test-coverage, Property 14: isTargetInRange true exactly when unit has a weapon and segment distance <= elevation-scaled threshold', () => {
  it('agrees with the real segmentDistance vs elevation-scaled getRangeThreshold', () => {
    fc.assert(
      fc.property(
        arbGrid,
        fc.nat(),
        arbSegment,
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        fc.nat(),
        arbSegment,
        fc.constantFrom(0.5, 0.83, 1.0, 1.17, 1.5),
        (grid, aTileRaw, aSeg, rangeAttack, weapon, tTileRaw, tSeg, elevMult) => {
          const aTile = aTileRaw % grid.length;
          const tTile = tTileRaw % grid.length;
          const actual = isTargetInRange(
            grid,
            { tileIndex: aTile, segment: aSeg, rangeAttack, hasWeapon: weapon },
            { tileIndex: tTile, segment: tSeg },
            elevMult,
          );
          const dist = segmentDistance(grid, aTile, aSeg, tTile, tSeg);
          const threshold = getRangeThreshold(rangeAttack) * elevMult;
          const expected = weapon && dist <= threshold;
          expect(actual).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('always returns false when the unit has no weapon', () => {
    fc.assert(
      fc.property(arbGrid, fc.nat(), arbSegment, fc.integer({ min: 0, max: 5 }), (grid, aTileRaw, aSeg, rangeAttack) => {
        const aTile = aTileRaw % grid.length;
        const inRange = isTargetInRange(
          grid,
          { tileIndex: aTile, segment: aSeg, rangeAttack, hasWeapon: false },
          { tileIndex: aTile, segment: aSeg },
        );
        expect(inRange).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 15 — Segment distance is zero for identical positions and symmetric
// ===========================================================================

describe('Feature: unit-test-coverage, Property 15: segmentDistance is 0 for identical positions and symmetric', () => {
  it('is 0 for a position compared with itself', () => {
    fc.assert(
      fc.property(arbGrid, fc.nat(), arbSegment, (grid, tileRaw, seg) => {
        const tile = tileRaw % grid.length;
        expect(segmentDistance(grid, tile, seg, tile, seg)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('is symmetric: d(a, b) === d(b, a)', () => {
    fc.assert(
      fc.property(
        arbGrid,
        fc.nat(),
        arbSegment,
        fc.nat(),
        arbSegment,
        (grid, aTileRaw, aSeg, bTileRaw, bSeg) => {
          const aTile = aTileRaw % grid.length;
          const bTile = bTileRaw % grid.length;
          const ab = segmentDistance(grid, aTile, aSeg, bTile, bSeg);
          const ba = segmentDistance(grid, bTile, bSeg, aTile, aSeg);
          expect(ab).toBeCloseTo(ba, 10);
        },
      ),
      { numRuns: 100 },
    );
  });
});
