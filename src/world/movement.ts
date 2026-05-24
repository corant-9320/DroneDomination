/**
 * Movement primitives — move and pivot a unit on the hex grid.
 *
 * These enforce TurnState rules when provided but do NOT resolve
 * reaction fire. Call resolveReactionFire from combat.ts separately
 * if reaction fire is desired after movement.
 */

import { Tile } from './types.js';
import { Unit, HexSegment } from './units.js';
import { TurnState, canMove, canPivot, recordMove, recordPivot } from './turnState.js';
import { getApproachDirection } from './combat.js';

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/**
 * Move a unit to a new hex, updating facing to the direction of movement.
 *
 * If a TurnState is provided, enforces movement rules:
 *  - Inter-hex move requires available movement points.
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
    } else if (segment !== undefined || segment === undefined) {
      // Same-hex reposition is a pivot — check pivot rules
      if (!canPivot(unit, turnState)) return false;
    }
  }

  if (isInterHex) {
    const dir = getApproachDirection(tiles, fromIndex, toTileIndex);
    if (dir >= 0) {
      unit.facing = dir as HexSegment;
    }
    unit.tileIndex = toTileIndex;
    if (turnState) {
      recordMove(unit, turnState);
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
