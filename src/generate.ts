/**
 * CLI entry point: generate the world and save to disk.
 */

import { generateWorld } from './world/generate.js';
import { validateWorld, printValidation } from './world/validate.js';
import { Tile, City } from './world/types.js';
import { Unit, HexSegment } from './world/units.js';
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

// Spawn initial units for all cities
const units = spawnInitialUnits(world.tiles, world.cities.map((c) => ({ id: c.id, tileIndex: c.tileIndex })));

// Save a compact version (no redundant data)
const compact = {
  seed: world.seed,
  tileCount: world.tiles.length,
  pentagonCount: world.pentagonIndices.length,
  hexCount: world.tiles.length - world.pentagonIndices.length,
  pentagonIndices: world.pentagonIndices,
  cities: world.cities,
  units: units.map((u) => ({
    id: u.id,
    label: u.label,
    ownerId: u.ownerId,
    tileIndex: u.tileIndex,
    segment: u.segment,
    attributes: u.attributes,
    currentHealth: u.currentHealth,
  })),
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

/**
 * Spawn 6 initial units around each city:
 * - 3 Melee (attack 1) + 3 Ranged (attack 1), all maxHealth 1
 * - Each type: 2 wheeled + 1 legged
 * - Placed in 3 alternating neighbour hexes around the city centre
 * - Each unit occupies an outward-facing segment
 */
function spawnInitialUnits(tiles: Tile[], cities: { id: string; tileIndex: number }[]): Unit[] {
  const units: Unit[] = [];
  let unitCounter = 0;

  const templates: { prefix: string; attrs: Unit['attributes'] }[] = [
    { prefix: 'MW', attrs: { maxHealth: 1, meleeAttack: 1, wheeledMovement: 1 } },
    { prefix: 'MW', attrs: { maxHealth: 1, meleeAttack: 1, wheeledMovement: 1 } },
    { prefix: 'ML', attrs: { maxHealth: 1, meleeAttack: 1, limbMovement: 1 } },
    { prefix: 'RW', attrs: { maxHealth: 1, rangeAttack: 1, wheeledMovement: 1 } },
    { prefix: 'RW', attrs: { maxHealth: 1, rangeAttack: 1, wheeledMovement: 1 } },
    { prefix: 'RL', attrs: { maxHealth: 1, rangeAttack: 1, limbMovement: 1 } },
  ];

  for (const city of cities) {
    const cityTile = tiles[city.tileIndex];
    const neighbours = cityTile.neighbours;
    const selectedNeighbours = [
      neighbours[0],
      neighbours[2 % neighbours.length],
      neighbours[4 % neighbours.length],
    ];

    for (let i = 0; i < 3; i++) {
      const tileIndex = selectedNeighbours[i];
      const tile = tiles[tileIndex];
      const outwardSegment = findOutwardSegment(tiles, tileIndex, city.tileIndex);
      const seg1 = outwardSegment;
      const seg2 = ((outwardSegment + 1) % tile.sides) as HexSegment;

      const t1 = templates[i * 2];
      const t2 = templates[i * 2 + 1];

      units.push({
        id: `unit_${unitCounter++}`,
        label: `${t1.prefix}${unitCounter}`,
        ownerId: city.id,
        tileIndex,
        segment: seg1,
        attributes: { ...t1.attrs },
        currentHealth: t1.attrs.maxHealth!,
      });

      units.push({
        id: `unit_${unitCounter++}`,
        label: `${t2.prefix}${unitCounter}`,
        ownerId: city.id,
        tileIndex,
        segment: seg2,
        attributes: { ...t2.attrs },
        currentHealth: t2.attrs.maxHealth!,
      });
    }
  }

  return units;
}

function findOutwardSegment(tiles: Tile[], tileIndex: number, cityTileIndex: number): HexSegment {
  const tile = tiles[tileIndex];
  const cityDir = tile.neighbours.indexOf(cityTileIndex);
  if (cityDir === -1) return 0;
  const outward = (cityDir + Math.floor(tile.sides / 2)) % tile.sides;
  return outward as HexSegment;
}
