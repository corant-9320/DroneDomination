/**
 * CLI entry point: load a saved world and validate it.
 */

import { World, Tile, City, Vec3 } from './world/types.js';
import { validateWorld, printValidation } from './world/validate.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data');
const worldPath = join(DATA_DIR, 'world.json');

console.log(`Loading world from ${worldPath}...`);
const raw = JSON.parse(readFileSync(worldPath, 'utf-8'));

// Reconstruct tiles
const tiles: Tile[] = raw.tiles.map((t: any) => ({
  id: `tile_${t.idx}`,
  index: t.idx,
  sides: t.s,
  neighbours: t.n,
  position3d: { x: t.pos[0], y: t.pos[1], z: t.pos[2] } as Vec3,
  terrainType: t.terrain,
  elevation: t.elev,
  cityId: t.city,
}));

const cities: City[] = raw.cities;
const pentagonIndices: number[] = raw.pentagonIndices;

const world: World = { tiles, cities, units: raw.units ?? [], seed: raw.seed, pentagonIndices };

const result = validateWorld(world);
printValidation(result);

process.exit(result.passed ? 0 : 1);
