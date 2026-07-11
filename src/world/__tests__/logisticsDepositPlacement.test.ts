/**
 * Property test for Oil_Deposit placement — Oil Logistics System.
 *
 * Feature: oil-logistics-system, Property 1: Deposits are on land and adequately spaced
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 *   1.1 — every placed Oil_Deposit sits on a land HexTile (terrainType !== 'ocean').
 *   1.2 — every pair of placed Oil_Deposits is separated by a shortest-path tile
 *         distance of at least DEPOSIT_SPACING hops.
 *   1.3 — every placed tile records the deposit via resourceType === 'oil'.
 *
 * Test strategy
 * -------------
 * `placeOilDeposits` needs real tiles with a neighbour graph so `graphDistance`
 * is meaningful. The Goldberg geometry (sphere + dual) is seed-INDEPENDENT, so we
 * build it ONCE and reuse it across every iteration; only `generateTerrain`
 * (which classifies ocean vs land) depends on the seed, so it is the sole per-seed
 * cost. This mirrors the caching approach in `geodesic.test.ts`.
 *
 * A full `generateWorld` is fixed at FREQUENCY=100 (~100k tiles) — far too large to
 * regenerate per iteration and to run all-pairs `graphDistance` over. We therefore
 * use the smallest frequency that still yields a sphere whose diameter comfortably
 * exceeds DEPOSIT_SPACING (so more than one deposit can be placed and the spacing
 * invariant is genuinely exercised). Because terrain generation is the dominant
 * cost, we assert the invariants EXHAUSTIVELY per world but sample a modest number
 * of seeds rather than the usual 100+ iterations — correctness of the invariants
 * matters more here than raw iteration count.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { generateTerrain } from '../generate.js';
import { generateGeodesicSphere, computeDual } from '../geodesic.js';
import { graphDistance } from '../pathfinding.js';
import { placeOilDeposits } from '../logisticsGen.js';
import { DEPOSIT_SPACING } from '../../../shared/logisticsConstants.js';
import type { Tile } from '../types.js';

// ---------------------------------------------------------------------------
// Seed-independent geometry — built ONCE and shared by every iteration.
// FREQUENCY 18 → 10·18²+2 = 3242 tiles; pole-to-pole ≈ 36 hops, comfortably
// larger than DEPOSIT_SPACING (20) so multiple deposits fit and pairwise
// spacing is a real constraint.
// ---------------------------------------------------------------------------
const FREQUENCY = 18;
const dualTiles = computeDual(generateGeodesicSphere(FREQUENCY));
const positions = dualTiles.map((t) => t.position3d);
const neighbours = dualTiles.map((t) => t.neighbours);
const sides = dualTiles.map((t) => t.sides);

/** Build a fresh, deposit-free authoritative tile array for a given seed. */
function buildWorldTiles(seed: number): Tile[] {
  const terrain = generateTerrain(positions, neighbours, sides, seed);
  return dualTiles.map((dt, i) => ({
    id: `tile_${dt.index}`,
    index: dt.index,
    sides: dt.sides,
    neighbours: dt.neighbours,
    position3d: dt.position3d,
    boundary: dt.boundary,
    terrainType: terrain[i].terrainType,
    height: terrain[i].height,
    forested: terrain[i].forested,
  }));
}

describe('placeOilDeposits — Property 1: deposits on land and adequately spaced', () => {
  it('places every deposit on land, records resourceType oil, and spaces them >= DEPOSIT_SPACING', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const tiles = buildWorldTiles(seed);
        const placed = placeOilDeposits(tiles, seed);

        // Req 1.1 — every returned deposit index is a land tile.
        for (const idx of placed) {
          expect(tiles[idx].terrainType).not.toBe('ocean');
        }

        // Req 1.3 — every placed tile is marked with resourceType 'oil', and no
        // un-placed tile was mutated to 'oil'.
        const placedSet = new Set(placed);
        for (let i = 0; i < tiles.length; i++) {
          if (placedSet.has(i)) {
            expect(tiles[i].resourceType).toBe('oil');
          } else {
            expect(tiles[i].resourceType).not.toBe('oil');
          }
        }

        // Req 1.2 — every pair of placed deposits is >= DEPOSIT_SPACING hops apart.
        // The sphere graph is fully connected (adjacency ignores terrain), so
        // graphDistance never returns -1 between two real tiles.
        for (let a = 0; a < placed.length; a++) {
          for (let b = a + 1; b < placed.length; b++) {
            const d = graphDistance(tiles, placed[a], placed[b]);
            expect(d).toBeGreaterThanOrEqual(DEPOSIT_SPACING);
          }
        }
      }),
      // Modest iteration count: each run regenerates terrain over 3242 tiles.
      // Invariants are checked exhaustively per world (all placed tiles, all pairs).
      { numRuns: 20 },
    );
  });

  it('produces at least one deposit and exercises the spacing constraint on a representative world', () => {
    // A concrete anchor case guaranteeing the spacing loop runs on >= 2 deposits
    // for at least one world, so the pairwise invariant is not vacuously true.
    let sawMultiDepositWorld = false;
    for (const seed of [1, 7, 42, 99, 2024, 31337]) {
      const tiles = buildWorldTiles(seed);
      const placed = placeOilDeposits(tiles, seed);
      expect(placed.length).toBeGreaterThanOrEqual(1);
      if (placed.length >= 2) {
        sawMultiDepositWorld = true;
        for (let a = 0; a < placed.length; a++) {
          for (let b = a + 1; b < placed.length; b++) {
            expect(graphDistance(tiles, placed[a], placed[b])).toBeGreaterThanOrEqual(
              DEPOSIT_SPACING,
            );
          }
        }
      }
    }
    expect(sawMultiDepositWorld).toBe(true);
  });
});
