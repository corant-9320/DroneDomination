/** 3D position on the unit sphere */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** @deprecated Elevation bands are no longer used — use numeric `height` (0–11). */
export type ElevationType = 'lowlands' | 'rolling' | 'hills' | 'mountain';

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
   * Discrete terrain height, 0–11 (HEIGHT_LEVELS). The authoritative elevation
   * scalar: movement steepness, globe cliff shadows, combat range multiplier,
   * and the first-person terrain mesh all read this directly.
   * Ocean tiles are 0.
   */
  height: number;
  /**
   * Whether this tile has forest cover.
   * Always false for ocean, tundra, and desert.
   */
  forested: boolean;
  /**
   * Downstream neighbour tile index a river on this tile flows toward (toward
   * the sea). Undefined when no river crosses this tile. Set by
   * `generateRivers`; the presence of this field marks a river tile. The final
   * land tile of a river points at the ocean tile it empties into.
   */
  riverTo?: number;
  /**
   * Per-segment visible steepness, in radians, one entry per side (index 0–5
   * for hexes, 0–4 for pentagons). segSteep[N] is the angle between segment N's
   * elevation-adjusted triangle normal and local radial "up" on the sphere:
   * 0 = dead flat, larger = steeper. Computed once at world generation from the
   * elevated-vertex model that mirrors the rendered first-person terrain.
   * Optional only so test/mock tiles can omit it; real generated worlds always
   * set it.
   */
  segSteep?: number[];
  ownerId?: string;
  cityId?: string;
  buildingIds?: string[];
  unitIds?: string[];
  resourceType?: string;
}

/**
 * A building — a full-segment occupant of a hex, like a unit but immobile.
 * Buildings belong to a faction and sit on that faction's city hexes.
 * In this session a building is a single generic occupant with no per-type
 * stats (building types/upgrades are deferred — see the spec).
 */
export interface Building {
  /** Globally unique identifier. */
  id: string;
  /** Owning faction id (equals the founding city's id). */
  ownerId: string;
  /** Tile this building sits on. */
  tileIndex: number;
  /** Triangular segment (0–5) the building occupies. */
  segment: number;
  /**
   * Optional equipment loadout, mirroring units. Only the combat/support
   * attributes apply (movement and engineering are ignored for buildings).
   * Absent = a plain unequipped structure.
   */
  attributes?: import('../../shared/unitTypes.js').UnitAttributes;
}

/** City placed on the world */
export interface City {
  id: string;
  label: string;
  tileIndex: number;
  neighbourCityIds: string[];
  /** Owning faction id. Defaults to the city's own id. */
  ownerId?: string;
  /** Hex indices this city owns (capital + every built-on hex). */
  ownedHexes?: number[];
}

/** The complete authoritative world */
export interface World {
  tiles: Tile[];
  cities: City[];
  units: import('./units.js').Unit[];
  /** Buildings constructed in cities. */
  buildings: Building[];
  seed: number;
  pentagonIndices: number[];
}
