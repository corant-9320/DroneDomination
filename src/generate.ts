/**
 * CLI entry point: generate the world and save to disk.
 */

import { generateWorld } from './world/generate.js';
import { validateWorld, printValidation } from './world/validate.js';
import { spawnInitialUnits } from './world/spawn.js';
import { toCompactWorld } from './world/compact.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SEED = 137;
const OUTPUT_DIR = join(__dirname, '..', 'data');

// Generate
const world = generateWorld(SEED);

// Validate
const result = validateWorld(world);
printValidation(result);

if (!result.passed) {
  console.error('World validation FAILED. Not saving.');
  process.exit(1);
}

// Save
mkdirSync(OUTPUT_DIR, { recursive: true });

// Spawn initial units for all cities
const units = spawnInitialUnits(world.tiles, world.cities.map((c) => ({ id: c.id, tileIndex: c.tileIndex })));

// Save a compact version (no redundant data)
const compact = toCompactWorld(
  world.seed,
  world.tiles,
  world.pentagonIndices,
  world.cities,
  units,
);

const outPath = join(OUTPUT_DIR, 'world.json');
writeFileSync(outPath, JSON.stringify(compact));
console.log(`\nWorld saved to ${outPath} (${(JSON.stringify(compact).length / 1024 / 1024).toFixed(1)} MB)`);

// Also save a summary
const summary = {
  seed: SEED,
  tileCount: world.tiles.length,
  pentagonCount: world.pentagonIndices.length,
  hexCount: world.tiles.length - world.pentagonIndices.length,
  cityCount: world.cities.length,
  cities: world.cities.map((c) => ({
    id: c.id,
    label: c.label,
    tileIndex: c.tileIndex,
    neighbourCount: c.neighbourCityIds.length,
    terrain: world.tiles[c.tileIndex].terrainType,
  })),
  terrainDistribution: Object.fromEntries(
    Object.entries(
      world.tiles.reduce(
        (acc, t) => {
          acc[t.terrainType] = (acc[t.terrainType] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      )
    ).sort(([, a], [, b]) => (b as number) - (a as number))
  ),
};

writeFileSync(join(OUTPUT_DIR, 'world-summary.json'), JSON.stringify(summary, null, 2));
console.log('Summary saved to data/world-summary.json');


