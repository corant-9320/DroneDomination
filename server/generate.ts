/**
 * World generation API handler.
 *
 * Accepts a config, generates the world, and returns compact JSON.
 * This module is framework-agnostic — it takes a plain object and returns one.
 * It will port directly to a Lambda handler with a thin wrapper.
 */

import { generateWorld } from '../src/world/generate.js';
import { validateWorld } from '../src/world/validate.js';
import { World, City } from '../src/world/types.js';
import { graphDistance } from '../src/world/pathfinding.js';

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
export const MAX_CITIES = 14;

/** Minimum allowed spacing value. */
export const MIN_SPACING = 20;

/** Maximum allowed spacing (roughly half the globe diameter for G(24,0)). */
export const MAX_SPACING = 45;

export function handleGenerate(config: GenerateConfig): GenerateResult {
  // Validate config
  const totalEnemies = Math.max(1, Math.min(MAX_CITIES - 1, Math.round(config.enemies)));

  // When all cities are used, spacing is irrelevant
  const spacingRelevant = totalEnemies < MAX_CITIES - 1;
  const spacing = spacingRelevant
    ? Math.max(MIN_SPACING, Math.min(MAX_SPACING, Math.round(config.spacing)))
    : 0;

  // Generate world with a fresh random seed
  const seed = Date.now() ^ (Math.random() * 0xffffffff);
  const world = generateWorld(seed);

  const result = validateWorld(world);
  if (!result.passed) {
    return { success: false, error: 'World validation failed' };
  }

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

  // Build compact format (same as generate.ts CLI)
  const compact = {
    seed: world.seed,
    tileCount: world.tiles.length,
    pentagonCount: world.pentagonIndices.length,
    hexCount: world.tiles.length - world.pentagonIndices.length,
    pentagonIndices: world.pentagonIndices,
    cities: compactCities,
    units: [],
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
