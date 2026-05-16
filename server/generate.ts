/**
 * World generation API handler.
 *
 * Accepts a config, generates the world, and returns compact JSON.
 * This module is framework-agnostic — it takes a plain object and returns one.
 * It will port directly to a Lambda handler with a thin wrapper.
 */

import { generateWorld } from '../src/world/generate.js';
import { validateWorld } from '../src/world/validate.js';
import { World, City, Tile } from '../src/world/types.js';
import { graphDistance } from '../src/world/pathfinding.js';
import { Unit, HexSegment } from '../src/world/units.js';

export interface GenerateConfig {
  /** Number of enemy cities (1 to MAX_CITIES - 1). */
  enemies: number;
  /** Minimum graph-distance between player city and nearest enemy. Only applies when enemies < MAX_CITIES - 1. */
  spacing: number;
}

export interface GenerateResult {
  success: boolean;
  world?: unknown; // compact world JSON
  error?: string;
}

/** Total cities the generator produces. */
export const MAX_CITIES = 12;

/** Minimum allowed spacing value. */
export const MIN_SPACING = 20;

/** Maximum allowed spacing (roughly half the globe diameter for G(24,0)). */
export const MAX_SPACING = 45;

export function handleGenerate(config: GenerateConfig): GenerateResult {
  const startMs = Date.now();
  console.log('[DD][api] handleGenerate called:', JSON.stringify(config));

  // Validate config
  const totalEnemies = Math.max(1, Math.min(MAX_CITIES - 1, Math.round(config.enemies)));

  // When all cities are used, spacing is irrelevant
  const spacingRelevant = totalEnemies < MAX_CITIES - 1;
  const spacing = spacingRelevant
    ? Math.max(MIN_SPACING, Math.min(MAX_SPACING, Math.round(config.spacing)))
    : 0;

  console.log('[DD][api] Clamped params: enemies=%d spacing=%d', totalEnemies, spacing);

  // Generate world with a fresh random seed
  const seed = Date.now() ^ (Math.random() * 0xffffffff);
  console.log('[DD][api] Generating world with seed:', seed);
  const genStart = Date.now();
  const world = generateWorld(seed);
  console.log('[DD][api] generateWorld took %dms, tiles: %d', Date.now() - genStart, world.tiles.length);

  const result = validateWorld(world);
  if (!result.passed) {
    console.error('[DD][api] World validation FAILED');
    return { success: false, error: 'World validation failed' };
  }
  console.log('[DD][api] World validation passed');

  // Pick player city (first city)
  // Then select enemy cities based on spacing from the player
  const playerCity = world.cities[0];
  const enemyCities = selectEnemyCities(world, playerCity, totalEnemies, spacing);

  // Mark roles on the cities: player, enemy, or unused (removed)
  const activeCityIds = new Set([playerCity.id, ...enemyCities.map((c) => c.id)]);

  // Strip unused cities from the world
  const filteredCities = world.cities.filter((c) => activeCityIds.has(c.id));

  // Mark player home
  const compactCities = filteredCities.map((c) => ({
    id: c.id,
    label: c.label,
    tileIndex: c.tileIndex,
    neighbourCityIds: c.neighbourCityIds.filter((nid) => activeCityIds.has(nid)),
    isPlayerHome: c.id === playerCity.id || undefined,
  }));

  // Clear cityId on tiles for removed cities
  for (const tile of world.tiles) {
    if (tile.cityId && !activeCityIds.has(tile.cityId)) {
      tile.cityId = undefined;
    }
  }

  // Spawn initial units for each active city
  const units = spawnInitialUnits(world.tiles, filteredCities);
  console.log('[DD][api] Spawned %d units for %d cities', units.length, filteredCities.length);

  // Build compact format (same as generate.ts CLI)
  const compact = {
    seed: world.seed,
    tileCount: world.tiles.length,
    pentagonCount: world.pentagonIndices.length,
    hexCount: world.tiles.length - world.pentagonIndices.length,
    pentagonIndices: world.pentagonIndices,
    cities: compactCities,
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

  console.log('[DD][api] handleGenerate complete in %dms — cities: %d, units: %d',
    Date.now() - startMs, compactCities.length, units.length);
  return { success: true, world: compact };
}

/**
 * Select enemy cities based on spacing.
 * Spacing is treated as the *target* distance — we pick cities closest to
 * that target value. E.g. spacing=20 means "enemy ~20 tiles from home".
 */
function selectEnemyCities(
  world: World,
  playerCity: City,
  count: number,
  targetSpacing: number,
): City[] {
  const candidates = world.cities.filter((c) => c.id !== playerCity.id);

  // Compute graph distance from player to each candidate
  const withDist = candidates.map((c) => ({
    city: c,
    dist: graphDistance(world.tiles, playerCity.tileIndex, c.tileIndex),
  }));

  if (targetSpacing > 0) {
    // Sort by how close each city's distance is to the target spacing
    withDist.sort((a, b) => Math.abs(a.dist - targetSpacing) - Math.abs(b.dist - targetSpacing));
  } else {
    // No spacing preference — spread them out (farthest first)
    withDist.sort((a, b) => b.dist - a.dist);
  }

  return withDist.slice(0, count).map((wd) => wd.city);
}

/**
 * Spawn 6 initial units around each city:
 * - 3 Melee (attack 1) + 3 Ranged (attack 1), all maxHealth 1
 * - Each type: 2 wheeled + 1 legged
 * - Placed in 3 alternating neighbour hexes around the city centre
 * - Each unit occupies an outward-facing segment (the segment facing away from city)
 */
function spawnInitialUnits(tiles: Tile[], cities: { id: string; tileIndex: number }[]): Unit[] {
  const units: Unit[] = [];
  let unitCounter = 0;

  // Unit templates: [label prefix, attributes]
  const templates: { prefix: string; attrs: Unit['attributes'] }[] = [
    // Melee wheeled
    { prefix: 'MW', attrs: { maxHealth: 1, meleeAttack: 1, wheeledMovement: 1 } },
    // Melee wheeled
    { prefix: 'MW', attrs: { maxHealth: 1, meleeAttack: 1, wheeledMovement: 1 } },
    // Melee legged
    { prefix: 'ML', attrs: { maxHealth: 1, meleeAttack: 1, limbMovement: 1 } },
    // Ranged wheeled
    { prefix: 'RW', attrs: { maxHealth: 1, rangeAttack: 1, wheeledMovement: 1 } },
    // Ranged wheeled
    { prefix: 'RW', attrs: { maxHealth: 1, rangeAttack: 1, wheeledMovement: 1 } },
    // Ranged legged
    { prefix: 'RL', attrs: { maxHealth: 1, rangeAttack: 1, limbMovement: 1 } },
  ];

  for (const city of cities) {
    const cityTile = tiles[city.tileIndex];
    const neighbours = cityTile.neighbours;

    // Pick 3 alternating neighbours (indices 0, 2, 4 from the neighbour list)
    const selectedNeighbours = [
      neighbours[0],
      neighbours[2 % neighbours.length],
      neighbours[4 % neighbours.length],
    ];

    // Place 2 units per selected neighbour tile
    for (let i = 0; i < 3; i++) {
      const tileIndex = selectedNeighbours[i];
      const tile = tiles[tileIndex];

      // Find the segment that faces away from the city (outward-facing)
      // The outward segment is the one whose neighbour direction points away from city
      const outwardSegment = findOutwardSegment(tiles, tileIndex, city.tileIndex);

      // Two units per tile: one at outward segment, one at the adjacent segment
      const seg1 = outwardSegment;
      const seg2 = ((outwardSegment + 1) % tile.sides) as HexSegment;

      const t1 = templates[i * 2];     // first unit for this tile
      const t2 = templates[i * 2 + 1]; // second unit for this tile

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

/**
 * Find the segment index that faces away from a reference tile (the city centre).
 * The outward segment is the one opposite to the neighbour direction pointing toward the city.
 */
function findOutwardSegment(tiles: Tile[], tileIndex: number, cityTileIndex: number): HexSegment {
  const tile = tiles[tileIndex];
  // Find which neighbour slot points toward the city
  const cityDir = tile.neighbours.indexOf(cityTileIndex);
  if (cityDir === -1) {
    // Not direct neighbour — fallback to segment 0
    return 0;
  }
  // Outward = opposite direction (3 steps around for a hex)
  const outward = (cityDir + Math.floor(tile.sides / 2)) % tile.sides;
  return outward as HexSegment;
}
