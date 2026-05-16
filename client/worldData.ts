/**
 * Load and parse the world data from the pre-generated JSON.
 */

export interface TileData {
  idx: number;
  s: 5 | 6;
  n: number[];
  pos: [number, number, number];
  /** Boundary polygon vertices [[x,y,z], ...] */
  b: [number, number, number][];
  terrain: string;
  elev: number;
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
  attributes: {
    maxHealth?: number;
    armour?: number;
    meleeAttack?: number;
    rangeAttack?: number;
    wheeledMovement?: number;
    limbMovement?: number;
    flightMovement?: number;
    repair?: number;
    initiative?: number;
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

export async function loadWorld(): Promise<WorldData> {
  if (cachedWorld) return cachedWorld;

  // Check sessionStorage for a freshly generated world
  const stored = sessionStorage.getItem('drone-domination-world');
  if (stored) {
    sessionStorage.removeItem('drone-domination-world');
    const data: WorldData = JSON.parse(stored);
    if (data.cities.length > 0 && !data.cities.some((c) => c.isPlayerHome)) {
      data.cities[0].isPlayerHome = true;
    }
    cachedWorld = data;
    return cachedWorld;
  }

  const response = await fetch('/world.json');
  if (!response.ok) throw new Error(`Failed to load world: ${response.status}`);
  const data: WorldData = await response.json();

  // Designate the first city as the player's home city if none is marked
  if (data.cities.length > 0 && !data.cities.some((c) => c.isPlayerHome)) {
    data.cities[0].isPlayerHome = true;
  }

  cachedWorld = data;
  return cachedWorld;
}

/** Store a new world and reload the page so all views reinitialize. */
export function applyNewWorld(data: unknown): void {
  sessionStorage.setItem('drone-domination-world', JSON.stringify(data));
  window.location.reload();
}
