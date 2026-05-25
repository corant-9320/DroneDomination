/**
 * Movement primitives — move and pivot a unit on the hex grid.
 *
 * Movement cost model (per hex entered):
 *   - First hex is always 1 MP regardless of terrain or unit type.
 *   - Subsequent hexes:
 *       Tank (wheeledMovement):
 *         Clear/flat: 2 MP
 *         Hill OR Forest: 3 MP
 *         Hill AND Forest: 4 MP
 *       Spider (limbMovement):
 *         All terrain: 3 MP (ignores terrain)
 *       Drone (flightMovement):
 *         All terrain: 1 MP (ignores terrain)
 *   - Mountain and ocean are impassable.
 *   - Attack requires at least 1 MP remaining after all movement.
 *
 * These enforce TurnState rules when provided but do NOT resolve
 * reaction fire. Call resolveReactionFire from combat.ts separately
 * if reaction fire is desired after movement.
 */

import { Tile } from './types.js';
import { Unit, HexSegment, MOVEMENT_ATTRIBUTES } from './units.js';
import { TurnState, canMove, canPivot, recordMove, recordPivot, movementRemaining } from './turnState.js';
import { getApproachDirection } from './combat.js';

// ---------------------------------------------------------------------------
// Movement type classification
// ---------------------------------------------------------------------------

export type MovementMode = 'wheeled' | 'limb' | 'flight';

/** Determine a unit's movement mode from its attributes. */
export function getMovementMode(unit: Unit): MovementMode {
  if ((unit.attributes.flightMovement ?? 0) >= 1) return 'flight';
  if ((unit.attributes.limbMovement ?? 0) >= 1) return 'limb';
  return 'wheeled';
}

// ---------------------------------------------------------------------------
// Terrain classification for movement
// ---------------------------------------------------------------------------

/** Whether a tile counts as "hill" for movement purposes. */
export function isHillTerrain(tile: Tile): boolean {
  return tile.elevationType === 'hills';
}

/** Whether a tile is impassable (mountain elevation or ocean terrain). */
export function isImpassable(tile: Tile): boolean {
  return tile.elevationType === 'mountain' || tile.terrainType === 'ocean';
}

// ---------------------------------------------------------------------------
// Movement cost calculation
// ---------------------------------------------------------------------------

/**
 * Cost in MP to enter a tile, given movement mode and whether this is the
 * first hex of the turn.
 *
 * Returns Infinity for impassable tiles.
 */
export function hexEntryCost(
  tile: Tile,
  mode: MovementMode,
  isFirstHex: boolean,
): number {
  // Impassable for ground units; drones fly over everything
  if (isImpassable(tile) && mode !== 'flight') {
    return Infinity;
  }

  // First hex is always 1 MP
  if (isFirstHex) return 1;

  // Drone: 1 MP per hex always
  if (mode === 'flight') return 1;

  // Spider: 3 MP per hex always (terrain-agnostic)
  if (mode === 'limb') return 3;

  // Tank (wheeled): terrain-dependent
  const hill = isHillTerrain(tile);
  const forested = tile.forested === true;

  if (hill && forested) return 4;
  if (hill || forested) return 3;
  return 2; // clear/flat
}

/**
 * Calculate total MP cost for a multi-hex path.
 * path[0] is the starting tile (not counted), path[1..] are tiles entered.
 * hexesMovedBefore = number of hexes already moved this turn (affects first-hex rule).
 *
 * Returns Infinity if any tile in the path is impassable.
 */
export function pathMovementCost(
  tiles: Tile[],
  path: number[],
  mode: MovementMode,
  hexesMovedBefore: number = 0,
): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const isFirst = (hexesMovedBefore + i - 1) === 0;
    const cost = hexEntryCost(tiles[path[i]], mode, isFirst);
    if (cost === Infinity) return Infinity;
    total += cost;
  }
  return total;
}

/**
 * Compute how many hexes a unit can move and still have MP remaining for an attack.
 * Returns the maximum number of hexes reachable with at least 1 MP left over.
 */
export function maxHexesWithAttack(
  totalMP: number,
  mode: MovementMode,
  tiles: Tile[],
  path: number[],
): number {
  let spent = 0;
  let hexes = 0;
  for (let i = 1; i < path.length; i++) {
    const isFirst = (i - 1) === 0;
    const cost = hexEntryCost(tiles[path[i]], mode, isFirst);
    if (cost === Infinity) break;
    spent += cost;
    if (spent >= totalMP) break; // no MP left, can't even finish this move + attack
    hexes++;
  }
  return hexes;
}

/**
 * Determine maximum reachable hexes from a given path (regardless of attack).
 */
export function maxReachableHexes(
  totalMP: number,
  mode: MovementMode,
  tiles: Tile[],
  path: number[],
): number {
  let spent = 0;
  let hexes = 0;
  for (let i = 1; i < path.length; i++) {
    const isFirst = (i - 1) === 0;
    const cost = hexEntryCost(tiles[path[i]], mode, isFirst);
    if (cost === Infinity) break;
    spent += cost;
    if (spent > totalMP) break;
    hexes++;
  }
  return hexes;
}

/**
 * Check if a unit can still attack this turn (has >= 1 MP remaining).
 */
export function canAttackAfterMovement(unit: Unit, state: TurnState): boolean {
  return movementRemaining(unit, state) >= 1;
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/**
 * Move a unit to a new hex, updating facing to the direction of movement.
 *
 * If a TurnState is provided, enforces movement rules:
 *  - Inter-hex move requires sufficient movement points for the terrain cost.
 *  - Records the move (locks pivot for the rest of the turn).
 * Returns false if the move was rejected by turn-state rules.
 */
export function moveUnit(
  unit: Unit,
  toTileIndex: number,
  tiles: Tile[],
  segment?: HexSegment,
  turnState?: TurnState,
): boolean {
  const fromIndex = unit.tileIndex;
  const isInterHex = fromIndex !== toTileIndex;

  if (turnState) {
    if (isInterHex) {
      if (!canMove(unit, turnState)) return false;

      // Calculate cost for this single hex move
      const mode = getMovementMode(unit);
      const record = turnState.get(unit.id);
      const hexesMoved = record ? (record.hasMoved ? 1 : 0) : 0;
      // If this is the unit's first inter-hex move this turn, it's the "first hex"
      const isFirstHex = !record?.hasMoved;
      const cost = hexEntryCost(tiles[toTileIndex], mode, isFirstHex);
      if (cost === Infinity) return false;

      const remaining = movementRemaining(unit, turnState);
      if (cost > remaining) return false;

      // Apply the move
      const dir = getApproachDirection(tiles, fromIndex, toTileIndex);
      if (dir >= 0) {
        unit.facing = dir as HexSegment;
      }
      unit.tileIndex = toTileIndex;
      recordMove(unit, turnState, cost);
    } else if (segment !== undefined || segment === undefined) {
      // Same-hex reposition is a pivot — check pivot rules
      if (!canPivot(unit, turnState)) return false;
    }
  } else {
    // No turn state — legacy/test path
    if (isInterHex) {
      const dir = getApproachDirection(tiles, fromIndex, toTileIndex);
      if (dir >= 0) {
        unit.facing = dir as HexSegment;
      }
      unit.tileIndex = toTileIndex;
    }
  }

  if (segment !== undefined) {
    unit.segment = segment;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

/**
 * Pivot a unit within its current hex (change facing and/or segment).
 * Free action but requires movement points remaining and no prior move.
 *
 * If no TurnState is provided, always succeeds (legacy/test usage).
 * Returns false if turn-state rules reject the pivot.
 */
export function pivotUnit(
  unit: Unit,
  newFacing: HexSegment,
  newSegment?: HexSegment,
  turnState?: TurnState,
): boolean {
  if (turnState) {
    if (!canPivot(unit, turnState)) return false;
    recordPivot(unit, turnState, newFacing, newSegment);
  } else {
    unit.facing = newFacing;
    if (newSegment !== undefined) {
      unit.segment = newSegment;
    }
  }
  return true;
}
