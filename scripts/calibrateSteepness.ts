/**
 * Calibrate segment-steepness thresholds.
 *
 * Usage:
 *   node scripts/calibrateSteepness.js [seed]
 *
 * Generates a world, collects the steepness distribution over all ground-
 * passable (tile, segment) pairs, and reports:
 *   - Percentile histogram of steepness values
 *   - Suggested MAX_STEEP_WHEELED / MAX_STEEP_LIMB / MAX_BUILD_STEEPNESS
 *     so that the blocked fraction roughly matches the old height-delta gate
 *
 * Outputs the recommended constants — copy them into:
 *   shared/movementConstants.ts  (MAX_STEEP_WHEELED, MAX_STEEP_LIMB)
 *   shared/buildings.ts          (MAX_BUILD_STEEPNESS)
 *
 * Re-run if ELEV_CURVE_EXP, STEEP_VERTICAL_EXAGGERATION, or the terrain
 * generation algorithm changes.
 */

import { generateWorld } from '../src/world/generate.js';
import { MAX_CLIMB_WHEELED, MAX_CLIMB_LIMB } from '../shared/movementConstants.js';

const seed = Number(process.argv[2] ?? 1);
console.log(`\n=== Steepness calibration — seed ${seed} ===\n`);

const world = generateWorld(seed);
const tiles = world.tiles;
const n = tiles.length;

// ─── Collect steepness values ─────────────────────────────────────────────────

const groundPassable: number[] = [];   // all ground-passable segment steepness values
const borderOldWheeled: boolean[] = []; // for each border: was it blocked by old wheeled gate?
const borderOldLimb: boolean[] = [];    // for each border: was it blocked by old limb gate?

for (const tile of tiles) {
  if (tile.terrainType === 'ocean') continue;
  if (!tile.segSteep) continue;
  for (let s = 0; s < tile.sides; s++) {
    groundPassable.push(tile.segSteep[s]);
  }
}

// Old border gate: collect |height delta| for every neighbour pair
for (const tile of tiles) {
  if (tile.terrainType === 'ocean') continue;
  for (const nIdx of tile.neighbours) {
    if (nIdx <= tile.index) continue; // visit each border once
    const nb = tiles[nIdx];
    if (!nb || nb.terrainType === 'ocean') continue;
    const delta = Math.abs((tile.height ?? 0) - (nb.height ?? 0));
    borderOldWheeled.push(delta > MAX_CLIMB_WHEELED);
    borderOldLimb.push(delta > MAX_CLIMB_LIMB);
  }
}

const oldWheelBlockedFrac = borderOldWheeled.filter(Boolean).length / Math.max(1, borderOldWheeled.length);
const oldLimbBlockedFrac  = borderOldLimb.filter(Boolean).length / Math.max(1, borderOldLimb.length);

console.log(`Ground-passable (tile, segment) pairs: ${groundPassable.length}`);
console.log(`Non-ocean borders: ${borderOldWheeled.length}`);
console.log(`Old wheeled blocked fraction: ${(oldWheelBlockedFrac * 100).toFixed(1)}%`);
console.log(`Old limb blocked fraction:    ${(oldLimbBlockedFrac * 100).toFixed(1)}%\n`);

// ─── Histogram ────────────────────────────────────────────────────────────────

groundPassable.sort((a, b) => a - b);
const total = groundPassable.length;

const PERCENTILES = [50, 75, 80, 85, 90, 92, 94, 95, 96, 97, 98, 99];
console.log('Steepness percentiles (ground-passable segments):');
for (const p of PERCENTILES) {
  const idx = Math.floor(p / 100 * total);
  const val = groundPassable[Math.min(idx, total - 1)];
  console.log(`  P${String(p).padStart(2, ' ')}: ${val.toFixed(4)} rad  (${(val * 180 / Math.PI).toFixed(1)}°)`);
}
console.log(`  Max: ${groundPassable[total - 1].toFixed(4)} rad  (${(groundPassable[total - 1] * 180 / Math.PI).toFixed(1)}°)\n`);

// ─── Threshold sweep ──────────────────────────────────────────────────────────

console.log('Blocked fraction by threshold (wheeled / limb / build):');
const thresholds = [0.30, 0.35, 0.40, 0.44, 0.50, 0.55, 0.60, 0.70, 0.79, 0.90];
for (const t of thresholds) {
  const blocked = groundPassable.filter((v) => v > t).length / total;
  console.log(`  ${t.toFixed(2)} rad (${(t * 180 / Math.PI).toFixed(0)}°): ${(blocked * 100).toFixed(1)}% blocked`);
}

// ─── Recommendation ───────────────────────────────────────────────────────────

/**
 * Find the threshold t such that the fraction of segments with steepness > t
 * is approximately equal to `targetFrac`.
 */
function findThreshold(vals: number[], targetFrac: number): number {
  const sorted = vals.slice().sort((a, b) => a - b);
  const idx = Math.floor((1 - targetFrac) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

const recWheeled = findThreshold(groundPassable, oldWheelBlockedFrac);
const recLimb    = findThreshold(groundPassable, oldLimbBlockedFrac);
const recBuild   = recWheeled; // align build with wheeled

console.log('\n=== Recommended constants ===');
console.log(`  MAX_STEEP_WHEELED   = ${recWheeled.toFixed(2)}; // ~${(recWheeled * 180 / Math.PI).toFixed(0)}°`);
console.log(`  MAX_STEEP_LIMB      = ${recLimb.toFixed(2)}; // ~${(recLimb * 180 / Math.PI).toFixed(0)}°`);
console.log(`  MAX_BUILD_STEEPNESS = ${recBuild.toFixed(2)}; // ~${(recBuild * 180 / Math.PI).toFixed(0)}°`);
console.log('\nCopy these into:');
console.log('  shared/movementConstants.ts (MAX_STEEP_WHEELED, MAX_STEEP_LIMB)');
console.log('  shared/buildings.ts         (MAX_BUILD_STEEPNESS)\n');
