/**
 * CLI entry point: generate the world and save to disk.
 */

import { generateWorld } from './world/generate.js';
import { validateWorld, printValidation } from './world/validate.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SEED = 42;
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

// Save a compact version (no redundant data)
const compact = {
  seed: world.seed,
  tileCount: world.tiles.length,
  pentagonCount: world.pentagonIndices.length,
  hexCount: world.tiles.length - world.pentagonIndices.length,
  pentagonIndices: world.pentagonIndices,
  cities: world.cities,
  tiles: world.tiles.map((t) => ({
    idx: t.index,
    s: t.sides,
    n: t.neighbours,
    pos: [
      Math.round(t.position3d.x * 1e6) / 1e6,
      Math.round(t.position3d.y * 1e6) / 1e6,
      Math.round(t.position3d.z * 1e6) / 1e6,
    ],
    b: t.boundary.map((v) => [
      Math.round(v.x * 1e5) / 1e5,
      Math.round(v.y * 1e5) / 1e5,
      Math.round(v.z * 1e5) / 1e5,
    ]),
    terrain: t.terrainType,
    elev: Math.round(t.elevation * 1000) / 1000,
    city: t.cityId || undefined,
  })),
};

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
