/**
 * Property 2: Deposit placement is a valid maximal packing.
 *
 * Feature: oil-logistics-system, Property 2: Deposit placement is a valid
 * maximal packing. Validates Requirements 1.2, 1.4.
 *
 * After `placeOilDeposits(tiles, seed)` runs on a real generated world:
 *   (spacing)     every pair of placed deposits is >= DEPOSIT_SPACING apart
 *                 (shortest-path / graph distance) — Req 1.2.
 *   (maximality)  no remaining land tile could host another deposit without
 *                 violating spacing, i.e. every land tile that was NOT chosen
 *                 has at least one placed deposit strictly closer than
 *                 DEPOSIT_SPACING (graphDistance < DEPOSIT_SPACING) — Req 1.4.
 *
 * Named exports only; `.js` import extensions throughout.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { placeOilDeposits } from '../logisticsGen.js';
import { tilesWithinRadius } from '../pathfinding.js';
import { generateGeodesicSphere, computeDual } from '../geodesic.js';
import { generateTerrain, generateRivers } from '../generate.js';
import { DEPOSIT_SPACING } from '../../../shared/logisticsConstants.js';
import type { Tile } from '../types.js';

// ---------------------------------------------------------------------------
// World fixture.
//
// A full generated world is G(100,0) = ~100k tiles — far too expensive to
// rebuild per seed. The geodesic mesh and its dual depend only on the
// subdivision frequency (not the seed), so we build them ONCE at a modest
// frequency and only re-run the seed-dependent terrain/river passes per seed.
//
// T = 20 → 4002 tiles. The world's graph diameter (~3·T ≈ 60 hops) comfortably
// exceeds DEPOSIT_SPACING (20), so several deposits are placed and the spacing
// invariant is exercised non-trivially while BFS stays cheap.
// ---------------------------------------------------------------------------

const WORLD_FREQUENCY = 20;

const MESH = generateGeodesicSphere(WORLD_FREQUENCY);
const DUAL = computeDual(MESH);

/**
 * Build a fresh, seed-specific world (fresh tiles so `placeOilDeposits`'s
 * in-place `resourceType` mutation never leaks between seeds), mirroring how
 * `generateWorld` assembles tiles: terrain pass then river pass, so ocean
 * classification is final before deposit placement.
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

  // Rivers become ocean (impassable), finalising the land/ocean split exactly
  // as generateWorld does before placeOilDeposits runs.
  generateRivers(tiles, seed);
  for (const t of tiles) {
    if (t.riverTo !== undefined) {
      t.terrainType = 'ocean';
      t.forested = false;
    }
  }
  return tiles;
}

describe('logisticsGen — Property 2: deposit placement is a valid maximal packing', () => {
  // Feature: oil-logistics-system, Property 2: Deposit placement is a valid
  // maximal packing. Validates Requirements 1.2, 1.4.
  //
  // World-gen (terrain + rivers) is the dominant cost, so we use a modest
  // number of seeds rather than 100 full worlds. The maximality invariant is a
  // whole-world coverage check (every land tile is covered), so each single
  // seed is already a strong assertion — correctness of the invariant matters
  // more than raw iteration count here.
  it('every pair of placed deposits is >= DEPOSIT_SPACING apart, and no land tile could host another deposit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const tiles = buildWorld(seed);

        const placed = placeOilDeposits(tiles, seed);

        // Every returned index must actually be a recorded oil deposit on land.
        for (const idx of placed) {
          expect(tiles[idx].resourceType).toBe('oil');
          expect(tiles[idx].terrainType).not.toBe('ocean');
        }

        // One BFS flood per placed deposit: coverage[d] = all tiles at
        // graphDistance <= DEPOSIT_SPACING - 1 (i.e. strictly < DEPOSIT_SPACING).
        // This single map serves BOTH invariants below and avoids an O(land²)
        // pairwise-distance sweep.
        const placedSet = new Set(placed);
        const covered = new Set<number>(); // union of all coverage discs
        const coverages: Array<Map<number, number>> = [];

        for (const d of placed) {
          const disc = tilesWithinRadius(tiles, d, DEPOSIT_SPACING - 1);
          coverages.push(disc);
          for (const idx of disc.keys()) covered.add(idx);
        }

        // (spacing) Req 1.2 — no other placed deposit lies within a deposit's
        // "< DEPOSIT_SPACING" disc, so every pair is >= DEPOSIT_SPACING apart.
        for (let i = 0; i < placed.length; i++) {
          const disc = coverages[i];
          for (const other of placed) {
            if (other === placed[i]) continue;
            expect(disc.has(other)).toBe(false);
          }
        }

        // (maximality) Req 1.4 — every land tile that was NOT chosen must be
        // strictly closer than DEPOSIT_SPACING to some placed deposit; otherwise
        // it could host another deposit without violating spacing. Equivalently:
        // every land tile is either placed or inside some coverage disc.
        for (let i = 0; i < tiles.length; i++) {
          if (tiles[i].terrainType === 'ocean') continue; // land only — Req 1.1
          if (placedSet.has(i)) continue;
          expect(covered.has(i)).toBe(true);
        }

        return true;
      }),
      // Modest seed count (see comment above): world-gen cost dominates and the
      // maximality check is already whole-world per seed.
      { numRuns: 6 },
    );
  });
});
