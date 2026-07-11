/**
 * Load and parse the world data from the pre-generated JSON.
 *
 * All saves use the compact format: seed + cities + units + metadata.
 * Tiles are always regenerated from the seed via POST /api/world-tiles.
 *
 * ── Wire types ───────────────────────────────────────────────────────────────
 * The interfaces below are imported from `shared/wireTypes.ts`, which is the
 * single source of truth for all compact wire shapes (WireTile, WireUnit,
 * WireBuilding, WireCity, CompactSave). Previously they were hand-maintained
 * here as TileData/UnitData/BuildingData/CityData — see shared/wireTypes.ts
 * for the authoritative → wire field-name mapping.
 *
 * Client-only runtime extensions to the wire types (e.g. `bridge?: boolean`
 * on tiles) are added via intersection types below.
 */

import { dbg } from './debug.js';
import { ensureCitiesFounded } from './buildController.js';
import type {
  WireTile,
  WireUnit,
  WireBuilding,
  WireCity,
  CompactSave as WireCompactSave,
} from '../shared/wireTypes.js';
import type {
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
} from '../shared/logisticsTypes.js';

// ─── Public type aliases (preserve the existing names callers use) ────────────

/**
 * A tile in the client's working copy. Extends the wire shape with a runtime
 * `bridge` flag that is NOT part of the wire format — set by the client when
 * a player engineer builds a bridge over a river hex.
 */
export interface TileData extends WireTile {
  /** Runtime flag: a player engineer has built a bridge on this river hex. */
  bridge?: boolean;
  /**
   * Runtime flag: this tile's forest has been cleared by a logistics engineer
   * task (Req 9.4). NOT part of the wire format — applied by the client from
   * `logistics.clearedForests` after loading, exactly as `bridge` is applied
   * from `save.bridges`. Lets the renderer draw the hex as cleared.
   */
  clearedForest?: boolean;
  /**
   * Oil deposit marker. `"oil"` marks an Oil_Deposit (Req 1.3), which the
   * logistics renderer draws pre-drill. Mirrors the authoritative
   * `Tile.resourceType` (`src/world/types.ts`) and is carried on the wire under
   * the identical field name (`WireTile.resourceType`), so it arrives with no
   * remap via `src/world/compact.ts::toCompactTile` and the `/api/world-tiles`
   * regeneration path. The renderer reads `tile.resourceType === 'oil'`.
   */
  resourceType?: string;
}

/** A unit in the client's working copy. Identical to the wire shape. */
export type UnitData = WireUnit;

/** A building in the client's working copy. Identical to the wire shape. */
export type BuildingData = WireBuilding;

/**
 * Create a synthetic UnitData from a BuildingData for use in combat preview
 * and attack resolution. Buildings are treated as stationary "units" with
 * size 1, full health, and their own weapon/defence attributes.
 */
export function buildingAsAttackerUnit(building: BuildingData): UnitData {
  const attrs = building.attributes ?? {};
  return {
    id: building.id,
    label: `Building #${building.id.replace(/^building_/, '')}`,
    ownerId: building.ownerId,
    tileIndex: building.tileIndex,
    segment: building.segment,
    facing: building.segment, // buildings face outward from their segment
    attributes: { ...attrs, size: attrs.size ?? 1 },
    currentHealth: (attrs.size ?? 1) * 10, // buildings are always "full health" for attack purposes
  };
}

/** A city in the client's working copy. Identical to the wire shape. */
export type CityData = WireCity;

// Re-export CompactSave with the same name callers expect
export type CompactSave = WireCompactSave;

// ─── Logistics mirror aliases ─────────────────────────────────────────────────
//
// The Oil Logistics System's wire shapes ARE its authoritative shapes (a straight
// field copy, exactly like WireUnit/WireBuilding), so the client mirrors them by
// re-exporting the shared types directly rather than re-declaring them here. The
// renderer (task 15.2) reads these off `WorldData.logistics`. `Transport` carries
// its `tier` ('van' | 'truck' | 'juggernaut') for model selection (Req 14).
export type {
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
};

export interface WorldData {
  seed: number;
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
  pentagonIndices: number[];
  cities: CityData[];
  tiles: TileData[];
  units: UnitData[];
  /** Buildings constructed in cities. */
  buildings: BuildingData[];
  /**
   * Planned (not-yet-built) buildings from the City Design planner. Runtime
   * only — rendered greyed out. Persisted separately per seed via cityPlan.ts,
   * not part of the authoritative save.
   */
  plannedBuildings?: BuildingData[];
  /** Player-chosen faction color (hex string). */
  playerColor?: string;
  /**
   * Optional tile index to centre the camera on at startup.
   * Used by battle scenarios to focus on the gap between armies.
   */
  battleCentreTile?: number;
  /**
   * Oil Logistics System state overlay (wells, refineries, routes, transports,
   * hubs, home stocks, tasks, and cleared-forest/bridge index overlays). Copied
   * straight through from `CompactSave.logistics` on load — wire shapes ===
   * authoritative shapes, so no field remapping is needed. Optional so saves
   * without logistics still load. The logistics renderer (task 15.2) reads its
   * entities from here; the `logistics.bridges`/`logistics.clearedForests` index
   * overlays are additionally applied onto tiles below (see `expandCompactSave`).
   */
  logistics?: LogisticsState;
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

async function expandCompactSave(data: CompactSave): Promise<WorldData> {
  const regen = await regenerateTilesFromSeed(data.seed);

  // Reject invalid persisted building component values before mutating any
  // state, so a corrupt save leaves the existing world untouched (Req 8.5).
  validateBuildingComponents(data.buildings ?? []);

  // Apply city markers to tiles (cities may have been filtered by scenario)
  const cityIds = new Set(data.cities.map((c) => c.id));
  for (const tile of regen.tiles) {
    if (tile.city && !cityIds.has(tile.city)) {
      tile.city = undefined;
    }
  }

  // Re-apply player-built bridges (tiles are regenerated from seed, so the
  // bridge flag must be restored from the save).
  if (data.bridges) {
    for (const idx of data.bridges) {
      const tile = regen.tiles[idx];
      if (tile) tile.bridge = true;
    }
  }

  // Re-apply logistics index overlays onto the regenerated tiles, exactly as the
  // player-bridge overlay above is re-applied. Completed logistics bridges reuse
  // the same `bridge` render flag; cleared forests set the `clearedForest` flag
  // (Req 9.4, 10.3). The full logistics payload is copied straight through onto
  // WorldData.logistics below (shapes are identical, so no remapping).
  if (data.logistics) {
    for (const idx of data.logistics.bridges ?? []) {
      const tile = regen.tiles[idx];
      if (tile) tile.bridge = true;
    }
    for (const idx of data.logistics.clearedForests ?? []) {
      const tile = regen.tiles[idx];
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
    tiles: regen.tiles,
    units: data.units,
    buildings: data.buildings ?? [],
    playerColor: data.playerColor,
    battleCentreTile: data.battleCentreTile,
    // Straight copy — CompactSave.logistics and WorldData.logistics are both
    // `LogisticsState`, so no field remapping is required (deferred here from
    // task 12.2's client-expand note).
    logistics: data.logistics,
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

  return world;
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
  const bridges: number[] = [];
  for (const tile of cachedWorld.tiles) {
    if (tile.bridge) bridges.push(tile.idx);
  }
  return {
    format: 'compact',
    seed: cachedWorld.seed,
    cities: cachedWorld.cities,
    units: cachedWorld.units,
    buildings: cachedWorld.buildings,
    playerColor: cachedWorld.playerColor,
    battleCentreTile: cachedWorld.battleCentreTile,
    bridges: bridges.length > 0 ? bridges : undefined,
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

  dbg.world.log('Fetching /default-scenario.json from server');
  const response = await fetch('/default-scenario.json?v=' + Date.now());
  if (!response.ok) {
    dbg.world.error('Failed to load /default-scenario.json, status:', response.status);
    throw new Error(`Failed to load default-scenario.json: ${response.status}`);
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
