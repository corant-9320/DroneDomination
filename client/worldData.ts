/**
 * Load and parse the world data from the pre-generated JSON.
 */

import { dbg } from './debug.js';

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
  attributes: {
    maxHealth?: number;
    attack?: number;
    armour?: number;
    defence?: number;
    splashAttack?: number;
    rangeAttack?: number;
    wheeledMovement?: number;
    limbMovement?: number;
    flightMovement?: number;
    repair?: number;
    antiAir?: number;
  };
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

  dbg.world.log('Fetching /world.json from server');
  const response = await fetch('/world.json?v=' + Date.now());
  if (!response.ok) {
    dbg.world.error('Failed to load /world.json, status:', response.status);
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

/** Store a new world and reload the page so all views reinitialize. */
export function applyNewWorld(data: unknown): void {
  dbg.world.log('applyNewWorld called, storing to sessionStorage and reloading');
  sessionStorage.setItem('drone-domination-world', JSON.stringify(data));
  window.location.reload();
}
