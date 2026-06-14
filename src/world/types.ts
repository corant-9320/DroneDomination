/** 3D position on the unit sphere */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Elevation layers for terrain height */
export type ElevationType = 'flat' | 'rolling' | 'hills' | 'mountain';

/**
 * Terrain types — the 5 base surface types.
 * Elevation and vegetation are separate dimensions on the Tile.
 *
 * Constraints:
 *   ocean   — no elevation, no vegetation
 *   tundra  — has elevation, no vegetation
 *   desert  — has elevation, no vegetation
 *   plains  — has elevation, has vegetation (clear or forested)
 *   grassland — has elevation, has vegetation (clear or forested)
 */
export type TerrainType =
  | 'grassland'
  | 'plains'
  | 'tundra'
  | 'desert'
  | 'ocean';

/** A single authoritative tile in the Goldberg graph */
export interface Tile {
  id: string;
  index: number;
  sides: 5 | 6;
  neighbours: number[];
  position3d: Vec3;
  /** Ordered polygon boundary vertices on the unit sphere */
  boundary: Vec3[];
  terrainType: TerrainType;
  /**
   * Elevation layer. Always set, but semantically ignored for ocean tiles.
   * Derived band over `height` (see HEIGHT_LEVELS): used for textures, terrain
   * classification, and the combat elevation-advantage multiplier.
   */
  elevationType: ElevationType;
  /**
   * Discrete terrain height, 0–11 (HEIGHT_LEVELS). The authoritative elevation
   * scalar: movement steepness, globe cliff shadows, and the continuous
   * first-person terrain mesh all read this. `elevationType` is a 4-way band
   * derived from it. Optional only so test/mock tiles can omit it; real
   * generated worlds always set it. Ocean tiles are 0.
   */
  height?: number;
  /**
   * Whether this tile has forest cover.
   * Always false for ocean, tundra, and desert.
   */
  forested: boolean;
  ownerId?: string;
  cityId?: string;
  buildingIds?: string[];
  unitIds?: string[];
  resourceType?: string;
}

/** City placed on the world */
export interface City {
  id: string;
  label: string;
  tileIndex: number;
  neighbourCityIds: string[];
}

/** The complete authoritative world */
export interface World {
  tiles: Tile[];
  cities: City[];
  units: import('./units.js').Unit[];
  seed: number;
  pentagonIndices: number[];
}
