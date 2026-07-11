/**
 * CLI entry point: load a saved world and validate it.
 */

import { World, Tile, City, Vec3, TerrainType } from './world/types.js';
import { validateWorld, printValidation } from './world/validate.js';
import type { WireTile, WireWorld } from '../shared/wireTypes.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// validate.js compiles to dist/src/, so reach the repo-root data/ dir with two
// `..` — matching where generateCli.ts writes world.json (../../data). A single
// `..` pointed at the non-existent dist/data and made `npm run validate` ENOENT.
const DATA_DIR = join(__dirname, '..', '..', 'data');
const worldPath = join(DATA_DIR, 'world.json');

console.log(`Loading world from ${worldPath}...`);
const raw = JSON.parse(readFileSync(worldPath, 'utf-8')) as WireWorld;

// Reconstruct tiles
const tiles: Tile[] = raw.tiles.map((t: WireTile) => ({
  id: `tile_${t.idx}`,
  index: t.idx,
  sides: t.s,
  neighbours: t.n,
  position3d: { x: t.pos[0], y: t.pos[1], z: t.pos[2] } as Vec3,
  boundary: t.b.map((v) => ({ x: v[0], y: v[1], z: v[2] }) as Vec3),
  terrainType: t.terrain as TerrainType,
  height: t.h ?? 0,
  forested: t.f ?? false,
  riverTo: t.rv,
  cityId: t.city,
  segSteep: t.ss,
  resourceType: t.resourceType,
}));

const cities: City[] = raw.cities as unknown as City[];
const pentagonIndices: number[] = raw.pentagonIndices;

const world: World = {
  tiles,
  cities,
  units: raw.units ?? [],
  buildings: raw.buildings ?? [],
  seed: raw.seed,
  pentagonIndices,
};

const result = validateWorld(world);
printValidation(result);

process.exit(result.passed ? 0 : 1);
