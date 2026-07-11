/**
 * Property 3: Deposit generation is deterministic in the seed.
 *
 * Feature: oil-logistics-system, Property 3: Deposit generation is deterministic in the seed
 *
 * Validates: Requirement 1.5 — a world generated from a given seed produces an
 * identical set of Oil_Deposit tile positions on every generation with that seed.
 *
 * Test strategy
 * -------------
 * `placeOilDeposits(tiles, seed)` is a pure, deterministic function of the seed
 * and the tile graph it is handed. To prove determinism we must feed it two
 * BYTE-IDENTICAL fresh tile sets for the same seed, then assert both runs agree
 * on (a) the returned placed-index arrays (deep-equal) and (b) exactly which
 * tiles get `resourceType === 'oil'`.
 *
 * The Goldberg geometry (sphere + dual) is seed-INDEPENDENT, so it is built ONCE
 * and shared. Only the terrain + river passes depend on the seed, so they are
 * the sole per-seed cost. Two `buildWorld(seed)` calls therefore yield fresh,
 * mutation-free, byte-identical tile arrays before placement — mirroring the
 * fixture approach in `logisticsDepositPlacement.test.ts` and
 * `logisticsDepositPacking.test.ts`.
 *
 * Iteration count is modest (world-gen over ~4000 tiles per seed is the dominant
 * cost); the determinism invariant is a strong per-seed equality check, plus a
 * fixed-seed determinism pair anchors the property concretely.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { placeOilDeposits } from '../logisticsGen.js';
import { generateGeodesicSphere, computeDual } from '../geodesic.js';
import { generateTerrain, generateRivers } from '../generate.js';
import type { Tile } from '../types.js';

// ---------------------------------------------------------------------------
// Seed-independent geometry — built ONCE and shared by every iteration.
// T = 20 → 4002 tiles; graph diameter (~3·T ≈ 60 hops) comfortably exceeds
// DEPOSIT_SPACING (20), so several deposits are placed and the determinism
// check is exercised over a non-trivial deposit set.
// ---------------------------------------------------------------------------
const WORLD_FREQUENCY = 20;

const MESH = generateGeodesicSphere(WORLD_FREQUENCY);
const DUAL = computeDual(MESH);

/**
 * Build a fresh, seed-specific, deposit-free world. Fresh tiles each call so the
 * in-place `resourceType` mutation of `placeOilDeposits` never leaks between the
 * two runs being compared. Assembly mirrors `generateWorld`: terrain pass then
 * river pass, finalising the land/ocean split before deposit placement.
 */
function buildWorld(seed: number): Tile[] {
  const positions = DUAL.map((t) => t.position3d);
  const neighbours = DUAL.map((t) => t.neighbours);
  const sides = DUAL.map((t) => t.sides);
  const terrain = generateTerrain(positions, neighbours, sides, seed);

  const tiles: Tile[] = DUAL.map((dt, i) => ({
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

  generateRivers(tiles, seed);
  for (const t of tiles) {
    if (t.riverTo !== undefined) {
      t.terrainType = 'ocean';
      t.forested = false;
    }
  }
  return tiles;
}

/** Indices of tiles carrying an oil deposit, ascending. */
function oilTileIndices(tiles: Tile[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].resourceType === 'oil') out.push(i);
  }
  return out;
}

describe('placeOilDeposits — Property 3: deposit generation is deterministic in the seed', () => {
  // Feature: oil-logistics-system, Property 3: Deposit generation is deterministic in the seed
  // Validates: Requirement 1.5
  it('two independent runs on identical fresh tile sets for the same seed produce identical deposits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        // Two freshly-built, byte-identical tile sets for the SAME seed.
        const tilesA = buildWorld(seed);
        const tilesB = buildWorld(seed);

        // Sanity: the two fresh worlds are identical BEFORE placement, so any
        // divergence after placement is attributable to placeOilDeposits alone.
        expect(tilesB.map((t) => t.terrainType)).toEqual(tilesA.map((t) => t.terrainType));

        const placedA = placeOilDeposits(tilesA, seed);
        const placedB = placeOilDeposits(tilesB, seed);

        // (a) Returned placed-index arrays are deep-equal.
        expect(placedB).toEqual(placedA);

        // (b) Exactly the same tiles are marked resourceType === 'oil'.
        expect(oilTileIndices(tilesB)).toEqual(oilTileIndices(tilesA));

        // The returned indices and the marked tiles must also agree with each
        // other (return value is the source of truth for placement).
        expect(oilTileIndices(tilesA)).toEqual(placedA);

        return true;
      }),
      // Modest iteration count: each run rebuilds terrain + rivers over ~4000
      // tiles twice. The per-seed equality check is a strong assertion.
      { numRuns: 15 },
    );
  });

  it('is deterministic for a fixed seed and different seeds usually differ', () => {
    // Fixed-seed determinism pair — a concrete anchor independent of fast-check.
    const FIXED_SEED = 4242;
    const run1 = placeOilDeposits(buildWorld(FIXED_SEED), FIXED_SEED);
    const run2 = placeOilDeposits(buildWorld(FIXED_SEED), FIXED_SEED);
    expect(run2).toEqual(run1);
    expect(run1.length).toBeGreaterThanOrEqual(1);

    // Optional: two different seeds usually differ. Not the core property (a
    // seed collision is theoretically possible), so we only require that ACROSS
    // a spread of distinct seeds at least one placement set differs from the
    // FIXED_SEED result — guarding against a degenerate seed-independent stub.
    const others = [1, 7, 99, 2024, 31337].map((s) => placeOilDeposits(buildWorld(s), s));
    const sameAsFixed = others.every((p) => JSON.stringify(p) === JSON.stringify(run1));
    expect(sameAsFixed).toBe(false);
  });
});
