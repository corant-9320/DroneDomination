/**
 * Load and parse the world data from the pre-generated JSON.
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

let cachedWorld: WorldData | null = null;

/** Returns the currently loaded world, or null if not yet loaded. */
export function getWorld(): WorldData | null {
  return cachedWorld;
}

export async function loadWorld(): Promise<WorldData> {
  if (cachedWorld) {
    dbg.world.log('Returning cached world');
    return cachedWorld;
  }

  // Check sessionStorage for a freshly generated world
  const stored = sessionStorage.getItem('drone-domination-world');
  if (stored) {
    dbg.world.log('Loading world from sessionStorage (freshly generated)');
    sessionStorage.removeItem('drone-domination-world');
    const data: WorldData = JSON.parse(stored);
    if (!data.units) data.units = [];
    if (data.cities.length > 0 && !data.cities.some((c) => c.isPlayerHome)) {
      dbg.world.warn('No player home city marked, assigning first city');
      data.cities[0].isPlayerHome = true;
    }
    dbg.world.log('Parsed sessionStorage world:', {
      seed: data.seed,
      tiles: data.tileCount,
      cities: data.cities.length,
      units: data.units.length,
    });
    cachedWorld = data;
    return cachedWorld;
  }

  dbg.world.log('Fetching /battle-30v30.json from server');
  const response = await fetch('/battle-30v30.json?v=' + Date.now());
  if (!response.ok) {
    dbg.world.error('Failed to load /battle-30v30.json, status:', response.status);
    throw new Error(`Failed to load world: ${response.status}`);
  }
  const data: WorldData = await response.json();

  // Ensure units array exists (older world files may omit it)
  if (!data.units) {
    dbg.world.warn('world.json missing units array, initializing empty');
    data.units = [];
  }

  // Designate the first city as the player's home city if none is marked
  if (data.cities.length > 0 && !data.cities.some((c) => c.isPlayerHome)) {
    dbg.world.warn('No player home city marked, assigning first city');
    data.cities[0].isPlayerHome = true;
  }

  dbg.world.log('Loaded world.json:', {
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
