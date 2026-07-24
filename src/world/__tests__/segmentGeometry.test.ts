import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  getSegmentCentroid3D,
  getLocalHexSpacing,
  segmentDistance,
  effectiveCombatDistance,
  segmentMovementDistance,
} from '../segmentGeometry.js';
import type { Tile, Vec3 } from '../types.js';
import type { HexSegment } from '../units.js';

// ---------------------------------------------------------------------------
// Synthetic tile-grid generators — real geometry, no mocks.
//
// CRITICAL: every tile carries a full 6-vertex boundary so the REAL centroid
// segment-distance path (getSegmentCentroid3D centroid branch, getLocalHexSpacing
// neighbour-averaging loop, segmentDistance chord/spacing path) is exercised —
// not the no-boundary BFS fallback that earlier coverage already hit.
// ---------------------------------------------------------------------------

const arbVec3: fc.Arbitrary<Vec3> = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z]) => Math.sqrt(x * x + y * y + z * z) > 0.1)
  .map(([x, y, z]): Vec3 => {
    const len = Math.sqrt(x * x + y * y + z * z);
    return { x: x / len, y: y / len, z: z / len };
  });

function makeTile(
  index: number,
  position3d: Vec3,
  boundary: Vec3[],
  neighbours: number[],
): Tile {
  return {
    id: `tile_${index}`,
    index,
    sides: 6,
    neighbours,
    position3d,
    boundary,
    terrainType: 'plains',
    height: 4,
    forested: false,
  };
}

/**
 * Minimum chord separation between neighbouring tile centres in a generated grid.
 *
 * Two independently-generated unit vectors can land arbitrarily close together,
 * and `v3.distance` squares each component: a separation near the subnormal range
 * (e.g. 5e-323) squares to exactly 0, so the chord distance collapses to 0 even
 * though the coordinates are unequal. Such a grid is not a hex tiling at all, and
 * the production code already treats it as degenerate (`segmentDistance` falls
 * back to graph distance when `avgSpacing < 1e-10`). Requiring a real separation
 * here keeps the generator producing plausible tilings instead of testing
 * float-underflow artefacts.
 */
const MIN_TILE_SEPARATION = 1e-6;

/** Chord (straight-line) distance between two points — mirrors `v3.distance`. */
function chord(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A ring of 2–6 hex tiles, each with a full 6-vertex boundary (real path). */
const arbBoundaryGrid: fc.Arbitrary<Tile[]> = fc
  .array(
    fc.record({
      pos: arbVec3,
      boundary: fc.array(arbVec3, { minLength: 6, maxLength: 6 }),
    }),
    { minLength: 2, maxLength: 6 },
  )
  .map((raw) =>
    raw.map((t, i, arr) =>
      makeTile(i, t.pos, t.boundary, [
        (i + 1) % arr.length,
        (i + arr.length - 1) % arr.length,
      ]),
    ),
  )
  .filter((grid) =>
    grid.every((tile) =>
      tile.neighbours.every(
        (n) => chord(tile.position3d, grid[n].position3d) >= MIN_TILE_SEPARATION,
      ),
    ),
  );

const arbSegment = fc.integer({ min: 0, max: 5 }).map((n) => n as HexSegment);

function vlen(p: Vec3): number {
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

// ===========================================================================
// Property 15 — Segment distance is zero for identical positions and symmetric
// (exercises the boundary-present centroid path, not the BFS fallback)
// ===========================================================================

describe('Feature: unit-test-coverage, Property 15: segmentDistance is 0 for identical positions and symmetric', () => {
  it('is 0 for a (tile, segment) position compared with itself', () => {
    fc.assert(
      fc.property(arbBoundaryGrid, fc.nat(), arbSegment, (grid, tileRaw, seg) => {
        const tile = tileRaw % grid.length;
        expect(segmentDistance(grid, tile, seg, tile, seg)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('is symmetric: d(a, b) === d(b, a)', () => {
    fc.assert(
      fc.property(
        arbBoundaryGrid,
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

  it('is non-negative and finite for boundary-present grids', () => {
    fc.assert(
      fc.property(
        arbBoundaryGrid,
        fc.nat(),
        arbSegment,
        fc.nat(),
        arbSegment,
        (grid, aTileRaw, aSeg, bTileRaw, bSeg) => {
          const d = segmentDistance(
            grid,
            aTileRaw % grid.length,
            aSeg,
            bTileRaw % grid.length,
            bSeg,
          );
          expect(d).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(d)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// getSegmentCentroid3D — real centroid branch vs graceful fallback
// ===========================================================================

describe('getSegmentCentroid3D', () => {
  it('projects the segment centroid back onto the unit sphere when boundary is present', () => {
    fc.assert(
      fc.property(arbBoundaryGrid, fc.nat(), arbSegment, (grid, tileRaw, seg) => {
        const tile = grid[tileRaw % grid.length];
        const c = getSegmentCentroid3D(tile, seg);
        // Normalised result lies on the unit sphere.
        expect(vlen(c)).toBeCloseTo(1, 9);
      }),
      { numRuns: 100 },
    );
  });

  it('falls back to the tile centre when boundary data is missing', () => {
    const tile = makeTile(0, { x: 1, y: 0, z: 0 }, [], [1]);
    expect(getSegmentCentroid3D(tile, 0)).toEqual(tile.position3d);
  });

  it('falls back to the tile centre when boundary is shorter than sides', () => {
    const partial: Vec3[] = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];
    const tile = makeTile(0, { x: 0, y: 0, z: 1 }, partial, [1]);
    expect(getSegmentCentroid3D(tile, 0)).toEqual(tile.position3d);
  });
});

// ===========================================================================
// getLocalHexSpacing — neighbour-averaging loop vs no-neighbour default
// ===========================================================================

describe('getLocalHexSpacing', () => {
  it('returns the mean chord distance to neighbours (positive, finite)', () => {
    fc.assert(
      // `arbBoundaryGrid` guarantees every neighbour is at least
      // MIN_TILE_SEPARATION away, so a positive mean spacing is unconditional.
      fc.property(arbBoundaryGrid, fc.nat(), (grid, tileRaw) => {
        const tile = grid[tileRaw % grid.length];
        const spacing = getLocalHexSpacing(tile, grid);
        expect(spacing).toBeGreaterThan(0);
        expect(Number.isFinite(spacing)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('equals the exact average for a hand-built two-neighbour tile', () => {
    const centre = makeTile(0, { x: 0, y: 0, z: 1 }, [], [1, 2]);
    const tiles: Tile[] = [
      centre,
      makeTile(1, { x: 1, y: 0, z: 0 }, [], [0]),
      makeTile(2, { x: 0, y: 1, z: 0 }, [], [0]),
    ];
    // both neighbours are at chord distance sqrt(2) from the centre
    expect(getLocalHexSpacing(centre, tiles)).toBeCloseTo(Math.SQRT2, 12);
  });

  it('returns the default spacing (0.1) when a tile has no neighbours', () => {
    const lone = makeTile(0, { x: 1, y: 0, z: 0 }, [], []);
    expect(getLocalHexSpacing(lone, [lone])).toBe(0.1);
  });
});

// ===========================================================================
// effectiveCombatDistance / segmentMovementDistance delegate to segmentDistance
// ===========================================================================

describe('effectiveCombatDistance and segmentMovementDistance', () => {
  it('both equal segmentDistance for the same arguments', () => {
    fc.assert(
      fc.property(
        arbBoundaryGrid,
        fc.nat(),
        arbSegment,
        fc.nat(),
        arbSegment,
        (grid, aTileRaw, aSeg, bTileRaw, bSeg) => {
          const aTile = aTileRaw % grid.length;
          const bTile = bTileRaw % grid.length;
          const base = segmentDistance(grid, aTile, aSeg, bTile, bSeg);
          const combat = effectiveCombatDistance(
            grid,
            { tileIndex: aTile, segment: aSeg },
            { tileIndex: bTile, segment: bSeg },
          );
          const movement = segmentMovementDistance(grid, aTile, aSeg, bTile, bSeg);
          expect(combat).toBe(base);
          expect(movement).toBe(base);
        },
      ),
      { numRuns: 100 },
    );
  });
});
