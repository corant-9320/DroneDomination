/**
 * Load and parse the world data from the pre-generated JSON.
 *
 * All saves use the compact format: seed + cities + units + metadata.
 * Tiles are always regenerated from the seed via POST /api/world-tiles.
 *
 * ── Compact wire-format mirror ──────────────────────────────────────────────
 * The interfaces below MIRROR the authoritative server types. The wire format
 * is produced by `src/world/compact.ts` (toCompactTile/toCompactUnit). When you
 * rename or add a field on either side, update BOTH or the client silently reads
 * `undefined`. Field name mapping (authoritative → wire/client):
 *
 *   Tile (src/world/types.ts)      → TileData (here) / CompactTile (compact.ts)
 *     index            → idx
 *     sides            → s
 *     neighbours       → n
 *     position3d {x,y,z} → pos [x,y,z]
 *     boundary [{x,y,z}] → b [[x,y,z]]
 *     terrainType      → terrain
 *     elevationType    → elevType
 *     forested         → f        (omitted when false)
 *     cityId           → city
 *
 *   Unit (src/world/units.ts)      → UnitData (here) / CompactUnit (compact.ts)
 *     same field names; attributes is UnitAttributes (shared/unitTypes.ts).
 */

import { dbg } from './debug.js';
import type { UnitAttributes } from '../shared/unitTypes.js';

export interface TileData {
  idx: number;
  s: 5 | 6;
  n: number[];
  pos: [number, number, number];
  /** Boundary polygon vertices [[x,y,z], ...] */
  b: [number, number, number][];
  terrain: string;
  elevType: string;
  /** Whether this tile has forest cover. */
  f?: boolean;
  city?: string;
}

export interface CityData {
  id: string;
  label: string;
  tileIndex: number;
  neighbourCityIds: string[];
  /** True if this is the player's home city. */
  isPlayerHome?: boolean;
}

export interface UnitData {
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: 0 | 1 | 2 | 3 | 4 | 5;
  facing: 0 | 1 | 2 | 3 | 4 | 5;
  attributes: UnitAttributes;
  currentHealth: number;
}

export interface WorldData {
  seed: number;
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
  pentagonIndices: number[];
  cities: CityData[];
  tiles: TileData[];
  units: UnitData[];
  /** Player-chosen faction color (hex string). */
  playerColor?: string;
  /**
   * Optional tile index to centre the camera on at startup.
   * Used by battle scenarios to focus on the gap between armies.
   */
  battleCentreTile?: number;
}

/**
 * Compact save format — omits tiles (regenerated from seed on load).
 * This is the only save format used by localStorage saves and bundled scenarios.
 */
export interface CompactSave {
  format: 'compact';
  seed: number;
  cities: CityData[];
  units: UnitData[];
  playerColor?: string;
  battleCentreTile?: number;
}

/**
 * Regenerate tiles from a seed by calling the server.
 * Returns the full tile array in compact wire format.
 */
async function regenerateTilesFromSeed(seed: number): Promise<{
  tiles: TileData[];
  pentagonIndices: number[];
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
}> {
  dbg.world.log('Regenerating tiles from seed:', seed);
  dbg.world.time('regenerate');
  const response = await fetch('/api/world-tiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seed }),
  });
  if (!response.ok) {
    throw new Error(`Failed to regenerate tiles: ${response.status}`);
  }
  const result = await response.json();
  dbg.world.timeEnd('regenerate');
  dbg.world.log('Regenerated', result.tileCount, 'tiles from seed', seed);
  return result;
}

/**
 * Expand a compact save into a full WorldData by regenerating tiles from the seed.
 */
async function expandCompactSave(data: CompactSave): Promise<WorldData> {
  const regen = await regenerateTilesFromSeed(data.seed);

  // Apply city markers to tiles (cities may have been filtered by scenario)
  const cityIds = new Set(data.cities.map((c) => c.id));
  for (const tile of regen.tiles) {
    if (tile.city && !cityIds.has(tile.city)) {
      tile.city = undefined;
    }
  }

  return {
    seed: data.seed,
    tileCount: regen.tileCount,
    pentagonCount: regen.pentagonCount,
    hexCount: regen.hexCount,
    pentagonIndices: regen.pentagonIndices,
    cities: data.cities,
    tiles: regen.tiles,
    units: data.units,
    playerColor: data.playerColor,
    battleCentreTile: data.battleCentreTile,
  };
}

let cachedWorld: WorldData | null = null;

/** Returns the currently loaded world, or null if not yet loaded. */
export function getWorld(): WorldData | null {
  return cachedWorld;
}

/**
 * Returns a compact save representation of the current world state.
 * Omits tiles (they can be regenerated from the seed).
 */
export function getCompactSave(): CompactSave | null {
  if (!cachedWorld) return null;
  return {
    format: 'compact',
    seed: cachedWorld.seed,
    cities: cachedWorld.cities,
    units: cachedWorld.units,
    playerColor: cachedWorld.playerColor,
    battleCentreTile: cachedWorld.battleCentreTile,
  };
}

export async function loadWorld(): Promise<WorldData> {
  if (cachedWorld) {
    dbg.world.log('Returning cached world');
    return cachedWorld;
  }

  // Check sessionStorage for a freshly generated world
  const stored = sessionStorage.getItem('drone-domination-world');
  if (stored) {
    dbg.world.log('Loading world from sessionStorage');
    sessionStorage.removeItem('drone-domination-world');
    const raw: CompactSave = JSON.parse(stored);
    const data = await expandCompactSave(raw);

    if (!data.units) data.units = [];
    if (data.cities.length > 0 && !data.cities.some((c) => c.isPlayerHome)) {
      dbg.world.warn('No player home city marked, assigning first city');
      data.cities[0].isPlayerHome = true;
    }
    dbg.world.log('Loaded from sessionStorage:', {
      seed: data.seed,
      tiles: data.tileCount,
      cities: data.cities.length,
      units: data.units.length,
    });
    cachedWorld = data;
    return cachedWorld;
  }

  dbg.world.log('Fetching /battle-20v20.json from server');
  const response = await fetch('/battle-20v20.json?v=' + Date.now());
  if (!response.ok) {
    dbg.world.error('Failed to load /battle-20v20.json, status:', response.status);
    throw new Error(`Failed to load battle-20v20.json: ${response.status}`);
  }
  const raw: CompactSave = await response.json();
  const data = await expandCompactSave(raw);

  if (!data.units) data.units = [];
  if (data.cities.length > 0 && !data.cities.some((c) => c.isPlayerHome)) {
    dbg.world.warn('No player home city marked, assigning first city');
    data.cities[0].isPlayerHome = true;
  }

  dbg.world.log('Loaded world:', {
    seed: data.seed,
    tiles: data.tileCount,
    pentagons: data.pentagonCount,
    cities: data.cities.length,
    units: data.units.length,
  });

  cachedWorld = data;
  return cachedWorld;
}

/** Store a new world and reload the page so all views reinitialize.
 *
 * A full page reload is intentional here. The Three.js GlobeView and the
 * Canvas 2D LocalMapView both build their geometry once at construction time
 * from the world data. There is no hot-swap path — reinitializing them in
 * place would require tearing down and rebuilding all WebGL buffers, event
 * listeners, and cached tile projections. A reload is simpler and more
 * reliable. The new world is passed via sessionStorage so it survives the
 * reload without a round-trip to the server.
 */
export function applyNewWorld(data: unknown): void {
  dbg.world.log('applyNewWorld called, storing to sessionStorage and reloading');
  sessionStorage.setItem('drone-domination-world', JSON.stringify(data));
  window.location.reload();
}
