/**
 * Deterministic Oil_Deposit generation for the Oil Logistics System.
 *
 * Scatters Oil_Deposits across land HexTiles during world generation, recording
 * each on its tile via `resourceType = 'oil'`. Placement is a pure, deterministic
 * function of the world seed and reuses the engine's existing PRNG and BFS graph
 * helpers rather than inventing parallel ones.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { Tile } from './types.js';
import { mulberry32 } from './rng.js';
import { tilesWithinRadius } from './tilePathfinding.js';
import { DEPOSIT_SPACING } from '../../shared/logisticsConstants.js';

/**
 * A dedicated PRNG salt for deposit placement. XOR-ing it into the seed derives
 * a sub-sequence independent of the terrain/city sequences that consume
 * `mulberry32(seed)` directly, so adding deposits does not perturb the rest of
 * world generation (preserves existing determinism; Req 1.5).
 */
const DEPOSIT_SEED_SALT = 0x0117_0000;

/**
 * Scatter Oil_Deposits across land tiles with at least DEPOSIT_SPACING shortest-path
 * separation, performing a Maximal_Deposit_Fill: deposits are placed greedily until
 * no remaining land tile is >= DEPOSIT_SPACING hops from every already-placed deposit.
 *
 * Pure and deterministic in `seed`. Mutates the passed tiles' `resourceType` in place
 * and returns the placed deposit tile indices, sorted ascending.  (Req 1.1–1.5)
 */
export function placeOilDeposits(tiles: Tile[], seed: number): number[] {
  const rng = mulberry32(seed ^ DEPOSIT_SEED_SALT);

  // Candidate list: every land tile (terrain not ocean/water) — Req 1.1.
  const candidates: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].terrainType !== 'ocean') candidates.push(i);
  }

  // Fisher–Yates shuffle for seed-stable candidate ordering — Req 1.5.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }

  // Greedy maximal packing. `excluded` holds every tile within DEPOSIT_SPACING - 1
  // hops of an already-placed deposit (i.e. strictly closer than DEPOSIT_SPACING);
  // a candidate not in the set is guaranteed >= DEPOSIT_SPACING from all placed
  // deposits, so membership is an O(1) stand-in for a repeated BFS distance check.
  const excluded = new Set<number>();
  const placed: number[] = [];

  for (const c of candidates) {
    if (excluded.has(c)) continue; // too close to an existing deposit — Req 1.2.

    placed.push(c);

    // Mark every tile within DEPOSIT_SPACING - 1 hops (including c itself) as excluded.
    const nearby = tilesWithinRadius(tiles, c, DEPOSIT_SPACING - 1);
    for (const idx of nearby.keys()) excluded.add(idx);
  }
  // Loop naturally saturates: once every remaining candidate is excluded, no land
  // tile is >= DEPOSIT_SPACING from all placed deposits and placement stops — Req 1.4.

  // Record each accepted deposit on its tile — Req 1.3.
  for (const i of placed) {
    tiles[i].resourceType = 'oil';
  }

  return placed.sort((a, b) => a - b);
}
