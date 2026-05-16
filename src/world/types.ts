/** 3D position on the unit sphere */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Terrain types for tiles */
export type TerrainType =
  | 'plains'
  | 'forest'
  | 'mountain'
  | 'desert'
  | 'ocean'
  | 'tundra'
  | 'grassland'
  | 'hills';

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
  elevation: number;
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
