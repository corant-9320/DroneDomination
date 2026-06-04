/**
 * Shared movement constants and pure movement helpers.
 *
 * Used by both:
 *   - src/world/movement.ts  (server-side movement resolution)
 *   - client/aiTurn.ts       (client-side AI pathfinding cost estimation)
 *
 * These functions operate only on attribute data and tile metadata that is
 * available on both sides of the wire — no src/ or server/ types are imported.
 */

import type { UnitAttributes } from './unitTypes.js';

// ---------------------------------------------------------------------------
// Movement mode
// ---------------------------------------------------------------------------

export type MovementMode = 'wheeled' | 'limb' | 'flight';

/** The attribute keys that count as movement categories. */
export const MOVEMENT_ATTRIBUTES: (keyof UnitAttributes)[] = [
  'wheeledMovement',
  'limbMovement',
  'flightMovement',
];

/**
 * Determine a unit's movement mode from its attributes.
 * Accepts any object that has the three movement attribute fields.
 */
export function getMovementMode(attrs: UnitAttributes): MovementMode {
  if ((attrs.flightMovement ?? 0) >= 1) return 'flight';
  if ((attrs.limbMovement ?? 0) >= 1) return 'limb';
  return 'wheeled';
}

// ---------------------------------------------------------------------------
// Tile shape needed for hex entry cost
// ---------------------------------------------------------------------------

/**
 * Minimal tile shape required by hexEntryCost.
 * Both TileData (client) and Tile (src/world/types.ts) satisfy this.
 */
export interface MovementTile {
  /** Elevation type string — 'mountain' | 'hills' | 'flat' | … */
  elevationType?: string;
  /** Terrain type string — 'ocean' | 'plains' | … */
  terrainType?: string;
  /** Elevation type as used in the compact/client wire format. */
  elevType?: string;
  /** Terrain type as used in the compact/client wire format. */
  terrain?: string;
  /** Whether this tile has forest cover. */
  forested?: boolean;
  /** Forest flag as used in the compact/client wire format. */
  f?: boolean;
}

// ---------------------------------------------------------------------------
// Terrain helpers
// ---------------------------------------------------------------------------

/** Whether a tile counts as "hill" for movement purposes. */
function isHill(tile: MovementTile): boolean {
  const elev = tile.elevationType ?? tile.elevType ?? '';
  return elev === 'hills';
}

/** Whether a tile is impassable for ground units. */
function isImpassable(tile: MovementTile): boolean {
  const elev = tile.elevationType ?? tile.elevType ?? '';
  const terrain = tile.terrainType ?? tile.terrain ?? '';
  return elev === 'mountain' || terrain === 'ocean';
}

/** Whether a tile has forest cover. */
function isForested(tile: MovementTile): boolean {
  return (tile.forested ?? tile.f) === true;
}

// ---------------------------------------------------------------------------
// Exported top-level helpers (used by client + server)
// ---------------------------------------------------------------------------

/**
 * Get the maximum movement points for a unit from its attributes.
 * Returns at least 1 so every unit can move.
 */
export function getMaxMovement(attrs: UnitAttributes): number {
  return Math.max(
    attrs.wheeledMovement ?? 0,
    attrs.limbMovement ?? 0,
    attrs.flightMovement ?? 0,
    1,
  );
}

/**
 * Whether a terrain type string is impassable for ground units.
 * Matches the client's TileData.terrain / MapViewInterface signature.
 */
export function isImpassableTerrain(terrain: string): boolean {
  return terrain === 'mountain' || terrain === 'ocean';
}

// ---------------------------------------------------------------------------
// Hex entry cost
// ---------------------------------------------------------------------------

/**
 * Cost in MP to enter a tile, given movement mode and whether this is the
 * first hex of the turn.
 *
 * Returns Infinity for impassable tiles (ground units only).
 *
 * Cost model:
 *   - First hex is always 1 MP regardless of terrain or unit type.
 *   - Drone: 1 MP per hex always (ignores terrain).
 *   - Spider (limb): 3 MP per hex always (terrain-agnostic).
 *   - Tank (wheeled): Clear/flat=2, Hill OR Forest=3, Hill AND Forest=4.
 *   - Mountain and ocean are impassable for ground units.
 */
export function hexEntryCost(
  tile: MovementTile,
  mode: MovementMode,
  isFirstHex: boolean,
): number {
  if (isImpassable(tile) && mode !== 'flight') return Infinity;
  if (isFirstHex) return 1;
  if (mode === 'flight') return 1;
  if (mode === 'limb') return 3;

  // Tank (wheeled): terrain-dependent
  const hill = isHill(tile);
  const forested = isForested(tile);
  if (hill && forested) return 4;
  if (hill || forested) return 3;
  return 2;
}
