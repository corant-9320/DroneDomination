/**
 * Compact wire format serialization.
 *
 * Converts authoritative World objects into the minified JSON format
 * used by the API and data/world.json. Shared between the CLI generator
 * and the API handler.
 */

import { Tile } from './types.js';
import { Unit } from './units.js';

/** Compact tile representation for the wire format. */
export interface CompactTile {
  idx: number;
  s: 5 | 6;
  n: number[];
  pos: [number, number, number];
  b: [number, number, number][];
  terrain: string;
  elevType: string;
  /** Whether this tile has forest cover. */
  f?: boolean;
  city?: string;
}

/** Compact unit representation for the wire format. */
export interface CompactUnit {
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  facing: number;
  attributes: Unit['attributes'];
  currentHealth: number;
}

/** Full compact world payload sent over the wire. */
export interface CompactWorld {
  seed: number;
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
  pentagonIndices: number[];
  cities: unknown[];
  units: CompactUnit[];
  tiles: CompactTile[];
}

/** Serialize a single authoritative Tile into compact wire format. */
export function toCompactTile(t: Tile): CompactTile {
  return {
    idx: t.index,
    s: t.sides,
    n: t.neighbours,
    pos: [
      Math.round(t.position3d.x * 1e6) / 1e6,
      Math.round(t.position3d.y * 1e6) / 1e6,
      Math.round(t.position3d.z * 1e6) / 1e6,
    ],
    b: t.boundary.map((v) => [
      Math.round(v.x * 1e5) / 1e5,
      Math.round(v.y * 1e5) / 1e5,
      Math.round(v.z * 1e5) / 1e5,
    ]),
    terrain: t.terrainType,
    elevType: t.elevationType,
    f: t.forested || undefined,
    city: t.cityId || undefined,
  };
}

/** Serialize a single Unit into compact wire format. */
export function toCompactUnit(u: Unit): CompactUnit {
  return {
    id: u.id,
    label: u.label,
    ownerId: u.ownerId,
    tileIndex: u.tileIndex,
    segment: u.segment,
    facing: u.facing,
    attributes: u.attributes,
    currentHealth: u.currentHealth,
  };
}

/**
 * Serialize a full world into the compact wire format.
 * Cities are passed separately because the API may filter/transform them.
 */
export function toCompactWorld(
  seed: number,
  tiles: Tile[],
  pentagonIndices: number[],
  cities: unknown[],
  units: Unit[],
): CompactWorld {
  return {
    seed,
    tileCount: tiles.length,
    pentagonCount: pentagonIndices.length,
    hexCount: tiles.length - pentagonIndices.length,
    pentagonIndices,
    cities,
    units: units.map(toCompactUnit),
    tiles: tiles.map(toCompactTile),
  };
}
