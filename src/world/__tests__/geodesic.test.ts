import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateGeodesicSphere, computeDual, DualTile } from '../geodesic.js';

// ---------------------------------------------------------------------------
// Goldberg polyhedron invariants.
//
// The dual of a frequency-T subdivided icosahedron is a Goldberg polyhedron:
//   - exactly 12 pentagonal tiles (at the original icosahedron vertices)
//   - the rest hexagonal
//   - total tiles = 10·T² + 2
//
// Generating a polyhedron is moderately expensive, so we build a few small
// subdivisions ONCE here and reuse them across every property/example below.
// fast-check then samples random tile indices from the cached tile sets,
// giving >=100 iterations without regenerating geometry per run.
// ---------------------------------------------------------------------------

function buildTiles(T: number): DualTile[] {
  return computeDual(generateGeodesicSphere(T));
}

const TILES_BY_T = new Map<number, DualTile[]>([
  [1, buildTiles(1)],
  [2, buildTiles(2)],
  [3, buildTiles(3)],
  [4, buildTiles(4)],
]);

// The largest cached set drives the per-tile property tests.
const BIG_T = 4;
const BIG_TILES = TILES_BY_T.get(BIG_T)!;

function expectedTileCount(T: number): number {
  return 10 * T * T + 2;
}

describe('geodesic Goldberg polyhedron — tile counts', () => {
  it('produces 10·T²+2 tiles for each frequency', () => {
    for (const [T, tiles] of TILES_BY_T) {
      expect(tiles.length).toBe(expectedTileCount(T));
    }
  });

  it('assigns a contiguous 0-based index to every tile', () => {
    BIG_TILES.forEach((tile, i) => {
      expect(tile.index).toBe(i);
    });
  });
});

describe('geodesic Goldberg polyhedron — pentagon/hexagon split', () => {
  it('has exactly 12 pentagons, the rest hexagons, for every frequency', () => {
    for (const [, tiles] of TILES_BY_T) {
      const pentagons = tiles.filter((t) => t.sides === 5);
      const hexagons = tiles.filter((t) => t.sides === 6);
      expect(pentagons.length).toBe(12);
      expect(hexagons.length).toBe(tiles.length - 12);
      // sides is only ever 5 or 6
      expect(pentagons.length + hexagons.length).toBe(tiles.length);
    }
  });
});

describe('geodesic Goldberg polyhedron — per-tile structural invariants', () => {
  it('neighbour count equals the tile side count (property, >=100 iterations)', () => {
    fc.assert(
      fc.property(fc.nat(), (raw) => {
        const tile = BIG_TILES[raw % BIG_TILES.length];
        expect(tile.neighbours.length).toBe(tile.sides);
      }),
      { numRuns: 100 },
    );
  });

  it('boundary vertex count equals the tile side count (property, >=100 iterations)', () => {
    fc.assert(
      fc.property(fc.nat(), (raw) => {
        const tile = BIG_TILES[raw % BIG_TILES.length];
        expect(tile.boundary.length).toBe(tile.sides);
      }),
      { numRuns: 100 },
    );
  });

  it('neighbours are valid, distinct, and never self-referential (property, >=100 iterations)', () => {
    fc.assert(
      fc.property(fc.nat(), (raw) => {
        const tile = BIG_TILES[raw % BIG_TILES.length];
        const unique = new Set(tile.neighbours);
        expect(unique.size).toBe(tile.neighbours.length);
        for (const n of tile.neighbours) {
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThan(BIG_TILES.length);
          expect(n).not.toBe(tile.index);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('tile centres lie on the unit sphere (property, >=100 iterations)', () => {
    fc.assert(
      fc.property(fc.nat(), (raw) => {
        const p = BIG_TILES[raw % BIG_TILES.length].position3d;
        const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
        expect(len).toBeCloseTo(1, 9);
      }),
      { numRuns: 100 },
    );
  });
});

describe('geodesic Goldberg polyhedron — neighbour symmetry', () => {
  it('adjacency is mutual: if j ∈ neighbours(i) then i ∈ neighbours(j) (property, >=100 iterations)', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (tileRaw, slotRaw) => {
        const tile = BIG_TILES[tileRaw % BIG_TILES.length];
        const j = tile.neighbours[slotRaw % tile.neighbours.length];
        expect(BIG_TILES[j].neighbours).toContain(tile.index);
      }),
      { numRuns: 100 },
    );
  });

  it('adjacency is fully symmetric across every tile in every cached frequency', () => {
    for (const [, tiles] of TILES_BY_T) {
      for (const tile of tiles) {
        for (const j of tile.neighbours) {
          expect(tiles[j].neighbours).toContain(tile.index);
        }
      }
    }
  });
});
