/**
 * Deterministic expansion of an already-decoded `CompactSaveV1` into a
 * complete `WorldData`.
 *
 * Owns: regenerating + validating tiles, validating saved tile references
 * against the regenerated world, removing generated city markers for cities
 * filtered out of the save, applying legacy + logistics bridge/cleared-forest
 * overlays, building `WorldData`, applying city ownership, preserving
 * home-city fallback behaviour, and calling the founding-building
 * compatibility behaviour.
 *
 * Does NOT read storage, write storage, reload the page, or own the world
 * singleton — see `client/world/repository.ts`. No partially-expanded world
 * is returned on failure: every validation happens before `WorldData` is
 * constructed, and errors propagate to the caller instead of returning a
 * partial object.
 */

import { sanitizeCityDistributionHubs } from '../../shared/logisticsSanitization.js';
import type { CompactSaveV1 } from '../../shared/wireTypes.js';
import type { BuildingData, TileData, WorldData } from './model.js';
import { regenerateTilesFromSeed } from './tilesClient.js';
import { fail } from './validation.js';
import { ensureCitiesFounded } from '../buildController.js';

const BUILDING_COMPONENT_KEYS = [
  'kinetic', 'rangeAttack', 'splashAttack', 'antiAir', 'armour', 'defence', 'repair',
] as const;

/**
 * Validate that every building's component values are integers within the
 * allowed 0–5 range. Throws on the first violation so a corrupt or out-of-range
 * save is rejected without mutating the live world (building-damage Req 8.5).
 */
function validateBuildingComponents(buildings: BuildingData[]): void {
  for (const b of buildings) {
    const a = b.attributes;
    if (!a) continue;
    for (const key of BUILDING_COMPONENT_KEYS) {
      const v = a[key];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 0 || v > 5) {
        throw new Error(
          `Invalid building data: ${b.id} component "${key}"=${v} is outside the allowed range 0–5`,
        );
      }
    }
  }
}

/** Validate that a tile index referenced by saved state is in range for the regenerated world. */
function checkTileRef(tileCount: number, idx: number | undefined, path: string): void {
  if (idx === undefined) return;
  if (idx < 0 || idx >= tileCount) fail(path, `tile index ${idx} is out of range (tileCount=${tileCount})`);
}

/**
 * Validate every saved tile reference (cities, units, buildings, battle
 * centre, legacy bridges, logistics overlays/structures/tasks) against the
 * regenerated tile count. Out-of-range indexes throw instead of being
 * silently ignored.
 */
function validateTileReferences(data: CompactSaveV1, tiles: readonly TileData[]): void {
  const tileCount = tiles.length;
  for (const [i, city] of data.cities.entries()) {
    checkTileRef(tileCount, city.tileIndex, `cities[${i}].tileIndex`);
    for (const [j, hex] of (city.ownedHexes ?? []).entries()) {
      checkTileRef(tileCount, hex, `cities[${i}].ownedHexes[${j}]`);
    }
  }
  for (const [i, unit] of data.units.entries()) {
    checkTileRef(tileCount, unit.tileIndex, `units[${i}].tileIndex`);
  }
  for (const [i, building] of (data.buildings ?? []).entries()) {
    checkTileRef(tileCount, building.tileIndex, `buildings[${i}].tileIndex`);
  }
  checkTileRef(tileCount, data.battleCentreTile, 'battleCentreTile');
  for (const [i, idx] of (data.bridges ?? []).entries()) {
    checkTileRef(tileCount, idx, `bridges[${i}]`);
  }

  const l = data.logistics;
  if (!l) return;
  for (const [i, idx] of l.bridges.entries()) checkTileRef(tileCount, idx, `logistics.bridges[${i}]`);
  for (const [i, idx] of l.clearedForests.entries()) checkTileRef(tileCount, idx, `logistics.clearedForests[${i}]`);
  for (const [i, key] of (l.standaloneRoadSegments ?? []).entries()) {
    const tileIndex = Math.floor(key / 6);
    const segment = key % 6;
    checkTileRef(tileCount, tileIndex, `logistics.standaloneRoadSegments[${i}]`);
    const tile = tiles[tileIndex];
    if (tile && segment >= tile.s) {
      fail(`logistics.standaloneRoadSegments[${i}]`, `segment ${segment} is invalid for tile ${tileIndex}`);
    }
  }
  for (const [i, w] of l.wells.entries()) checkTileRef(tileCount, w.tileIndex, `logistics.wells[${i}].tileIndex`);
  for (const [i, r] of l.refineries.entries()) checkTileRef(tileCount, r.tileIndex, `logistics.refineries[${i}].tileIndex`);
  for (const [i, h] of l.hubs.entries()) checkTileRef(tileCount, h.tileIndex, `logistics.hubs[${i}].tileIndex`);
  for (const [i, t] of l.tasks.entries()) checkTileRef(tileCount, t.tileIndex, `logistics.tasks[${i}].tileIndex`);
}

/**
 * Expand a decoded compact save into a full `WorldData` by regenerating tiles
 * from the seed, validating all saved references against the regenerated
 * world, and applying overlays. Throws (never returns a partial `WorldData`)
 * on any validation failure.
 */
export async function expandCompactSave(data: CompactSaveV1): Promise<WorldData> {
  const regen = await regenerateTilesFromSeed(data.seed);
  // `TileData` extends `WireTile` with client-only runtime flags (bridge,
  // clearedForest) that the server never sends — safe to treat the freshly
  // regenerated wire tiles as the client's working copy, which is exactly
  // where those flags get set below.
  const tiles = regen.tiles as TileData[];

  // Reject invalid persisted building component values before mutating any
  // state, so a corrupt save leaves the existing world untouched (Req 8.5).
  validateBuildingComponents(data.buildings ?? []);

  // Reject out-of-range saved tile references before mutating any state.
  validateTileReferences(data, tiles);

  const cityTileIndices = new Set<number>();
  for (const city of data.cities) {
    for (const hex of city.ownedHexes ?? [city.tileIndex]) cityTileIndices.add(hex);
  }
  // Preserve the caller's decoded save while migrating invalid legacy storage
  // hubs out of city footprints before overlays or WorldData consume it.
  const logistics = data.logistics
    ? sanitizeCityDistributionHubs(data.logistics, cityTileIndices)
    : undefined;

  // Apply city markers to tiles (cities may have been filtered by scenario)
  const cityIds = new Set(data.cities.map((c) => c.id));
  for (const tile of tiles) {
    if (tile.city && !cityIds.has(tile.city)) {
      tile.city = undefined;
    }
  }

  // Re-apply player-built bridges (tiles are regenerated from seed, so the
  // bridge flag must be restored from the save).
  if (data.bridges) {
    for (const idx of data.bridges) {
      const tile = tiles[idx];
      if (tile) tile.bridge = true;
    }
  }

  // Re-apply logistics index overlays onto the regenerated tiles, exactly as the
  // player-bridge overlay above is re-applied. Completed logistics bridges reuse
  // the same `bridge` render flag; cleared forests set the `clearedForest` flag
  // (Req 9.4, 10.3).
  if (logistics) {
    for (const idx of logistics.bridges) {
      const tile = tiles[idx];
      if (tile) tile.bridge = true;
    }
    for (const idx of logistics.clearedForests) {
      const tile = tiles[idx];
      if (tile) tile.clearedForest = true;
    }
  }

  const world: WorldData = {
    seed: data.seed,
    tileCount: regen.tileCount,
    pentagonCount: regen.pentagonCount,
    hexCount: regen.hexCount,
    pentagonIndices: regen.pentagonIndices,
    cities: data.cities,
    tiles,
    units: data.units,
    buildings: data.buildings ?? [],
    playerColor: data.playerColor,
    battleCentreTile: data.battleCentreTile,
    logistics,
  };

  // Mark city-owned hexes on the regenerated tiles, then ensure every city has
  // its founding building (no-op for already-founded worlds).
  for (const city of world.cities) {
    for (const hex of city.ownedHexes ?? [city.tileIndex]) {
      const tile = world.tiles[hex];
      if (tile) tile.city = city.id;
    }
  }
  ensureCitiesFounded(world);

  // Home-city fallback: preserve the existing behaviour of assigning the
  // first city as the player home when none is marked (older saves).
  if (world.units === undefined) world.units = [];
  if (world.cities.length > 0 && !world.cities.some((c) => c.isPlayerHome)) {
    world.cities[0].isPlayerHome = true;
  }

  return world;
}
