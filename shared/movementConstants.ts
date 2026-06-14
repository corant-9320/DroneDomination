/**
 * Shared movement constants and pure movement helpers.
 *
 * Used by both:
 *   - src/world/movement.ts  (server-side movement resolution)
 *   - client/aiTurn.ts       (client-side AI pathfinding cost estimation)
 *
 * These functions operate only on attribute data and tile metadata that is
 * available on both sides of the wire — no src/ or server/ types are imported.
 *
 * ─── SEGMENT-BASED COST MODEL ────────────────────────────────────────────────
 *
 * Every move is one segment step — either to an adjacent segment within the
 * same hex, or across the hex border to the facing segment in the adjacent hex.
 * Cost is determined by the destination segment's tile terrain + movement mode.
 *
 *   Drone (flight):  0.25 per step always. Can fly over ocean but cannot
 *                    finish a turn on ocean (enforced at turn-state level).
 *   Spider (limb):   0.50 per step always. Forbidden: mountain, ocean.
 *   Tank (wheeled):  0.25 on flat/clear.
 *                    0.75 on hills.
 *                    Forbidden: forest, mountain, ocean.
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
// Tile shape needed for segment cost
// ---------------------------------------------------------------------------

/**
 * Minimal tile shape required by segmentCost.
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

/** Whether a tile is mountain. */
function isMountain(tile: MovementTile): boolean {
  const elev = tile.elevationType ?? tile.elevType ?? '';
  return elev === 'mountain';
}

/** Whether a tile is ocean. */
function isOcean(tile: MovementTile): boolean {
  const terrain = tile.terrainType ?? tile.terrain ?? '';
  return terrain === 'ocean';
}

/** Whether a tile has forest cover. */
function isForested(tile: MovementTile): boolean {
  return (tile.forested ?? tile.f) === true;
}

// ---------------------------------------------------------------------------
// Segment-based cost constants
// ---------------------------------------------------------------------------

/** Cost per segment step for drone (flight). */
export const COST_DRONE = 0.25;

/** Cost per segment step for spider (limb). */
export const COST_SPIDER = 0.50;

/** Cost per segment step for tank on flat/clear terrain. */
export const COST_TANK_FLAT = 0.25;

/** Cost per segment step for tank on hills. */
export const COST_TANK_HILLS = 0.75;

/**
 * Flat MP cost to rotate (change facing), charged once per unit per turn.
 * Terrain-independent. After the fee is paid, all further facing changes that
 * turn are free — this lets the player freely correct orientation mistakes
 * without extra cost. Changing which segment a unit occupies is movement, not
 * rotation, and is charged per segment step via segmentCost().
 */
export const ROTATION_FEE = 0.25;

/**
 * Base intra-hex pivot cost per segment step for a given movement mode.
 * Tanks use their flat cost (they're already on the tile, terrain doesn't change).
 */
export function pivotStepCost(mode: MovementMode): number {
  switch (mode) {
    case 'flight': return COST_DRONE;
    case 'limb': return COST_SPIDER;
    case 'wheeled': return COST_TANK_FLAT;
  }
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
// Segment step cost (unified model)
// ---------------------------------------------------------------------------

/**
 * Cost to move one segment step into a destination tile, given the unit's
 * movement mode. The destination tile's terrain determines the cost.
 *
 * For intra-hex moves (same tile), pass the current tile as destination.
 *
 * Returns Infinity if the destination is forbidden for this movement mode.
 *
 * Drones can traverse ocean segments but cannot end a turn there — that
 * restriction is enforced at the turn-state level, not here.
 */
export function segmentCost(tile: MovementTile, mode: MovementMode): number {
  // Drones can go anywhere (ocean end-of-turn restriction is separate)
  if (mode === 'flight') {
    return COST_DRONE;
  }

  // Ground units cannot enter ocean or mountain
  if (isOcean(tile)) return Infinity;
  if (isMountain(tile)) return Infinity;

  // Spider: constant cost, any non-mountain non-ocean terrain
  if (mode === 'limb') {
    return COST_SPIDER;
  }

  // Tank (wheeled): forbidden from forest
  if (isForested(tile)) return Infinity;

  // Tank: hills
  if (isHill(tile)) {
    return COST_TANK_HILLS;
  }

  // Tank: flat/clear
  return COST_TANK_FLAT;
}

// ---------------------------------------------------------------------------
// Legacy hex entry cost (deprecated — forwards to segmentCost)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use segmentCost() instead. Kept for call sites not yet migrated.
 */
export function hexEntryCost(
  tile: MovementTile,
  mode: MovementMode,
  _isFirstHex: boolean,
): number {
  return segmentCost(tile, mode);
}

// ---------------------------------------------------------------------------
// Convenience constants and helpers
// ---------------------------------------------------------------------------

/**
 * Compute the MP cost to traverse from one segment to another within the same hex.
 * Uses the shortest arc (min clockwise vs counter-clockwise distance).
 * Returns 0 if segments are identical.
 *
 * NOTE: This uses COST_DRONE (0.25) per step as a lower bound. For the actual
 * terrain-aware intra-hex cost, use pivotStepCost(mode) per step.
 */
export function segmentStepCost(fromSegment: number, toSegment: number): number {
  if (fromSegment === toSegment) return 0;
  const diff = Math.abs(toSegment - fromSegment);
  const steps = Math.min(diff, 6 - diff);
  return steps * COST_DRONE;
}
