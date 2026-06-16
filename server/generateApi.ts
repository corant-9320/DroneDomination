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
import { spawnInitialUnits } from '../src/world/spawn.js';
import { CITY_COUNT } from '../src/world/generate.js';

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

/** Maximum cities the world generates (derived from src/world/cities.ts). */
export const MAX_CITIES = CITY_COUNT;

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

  // Build compact save format (no tiles — client regenerates from seed)
  const compactUnits = units.map((u) => ({
    id: u.id,
    label: u.label,
    ownerId: u.ownerId,
    tileIndex: u.tileIndex,
    segment: u.segment,
    facing: u.facing,
    attributes: u.attributes,
    currentHealth: u.currentHealth,
  }));

  const compact = {
    format: 'compact',
    seed: world.seed,
    cities: compactCities,
    units: compactUnits,
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


