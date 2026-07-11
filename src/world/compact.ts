/**
 * Compact wire format serialization.
 *
 * Converts authoritative World objects into the minified JSON used by the API
 * and data/world.json. The wire types are defined in `shared/wireTypes.ts` —
 * this module provides the serialization functions that produce them.
 *
 * ── Source of truth ──────────────────────────────────────────────────────────
 * The wire shapes live in `shared/wireTypes.ts` (WireTile / WireUnit /
 * WireBuilding / WireCity / WireWorld / CompactSave). The client imports those
 * types directly; this file only needs the serialization logic.
 *
 * See `shared/wireTypes.ts` for the authoritative → wire field-name mapping
 * (e.g. position3d → pos, terrainType → terrain).
 */

import { Tile, Building } from './types.js';
import { Unit } from './units.js';
import type { WireTile, WireUnit, WireBuilding, WireWorld } from '../../shared/wireTypes.js';
import type { LogisticsState } from '../../shared/logisticsTypes.js';

// Re-export wire types for callers that import from here
export type {
  WireTile as CompactTile,
  WireUnit as CompactUnit,
  WireBuilding as CompactBuilding,
  WireWorld as CompactWorld,
} from '../../shared/wireTypes.js';

/** Serialize a single authoritative Tile into compact wire format. */
export function toCompactTile(t: Tile): WireTile {
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
    h: t.height || undefined,
    f: t.forested || undefined,
    rv: t.riverTo,
    city: t.cityId || undefined,
    resourceType: t.resourceType || undefined,
    ss: t.segSteep
      ? t.segSteep.map((v) => Math.round(v * 1e4) / 1e4)
      : undefined,
  };
}

/** Serialize a single Unit into compact wire format. */
export function toCompactUnit(u: Unit): WireUnit {
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

/** Serialize a single Building into compact wire format. */
export function toCompactBuilding(b: Building): WireBuilding {
  return {
    id: b.id,
    ownerId: b.ownerId,
    tileIndex: b.tileIndex,
    segment: b.segment as 0 | 1 | 2 | 3 | 4 | 5,
    attributes: b.attributes,
  };
}

/**
 * Serialize a full world into the compact wire format.
 * Cities are passed separately because the API may filter/transform them.
 *
 * `logistics` is optional and, when present, is copied straight onto the wire
 * payload: the wire and authoritative LogisticsState shapes are identical
 * (unlike tiles, no field-name mapping is needed). Omitted when not provided so
 * existing consumers and world.json without logistics still parse.
 */
export function toCompactWorld(
  seed: number,
  tiles: Tile[],
  pentagonIndices: number[],
  cities: unknown[],
  units: Unit[],
  buildings: Building[] = [],
  logistics?: LogisticsState,
): WireWorld {
  return {
    seed,
    tileCount: tiles.length,
    pentagonCount: pentagonIndices.length,
    hexCount: tiles.length - pentagonIndices.length,
    pentagonIndices,
    cities: cities as WireWorld['cities'],
    units: units.map(toCompactUnit),
    buildings: buildings.map(toCompactBuilding),
    tiles: tiles.map(toCompactTile),
    logistics,
  };
}
