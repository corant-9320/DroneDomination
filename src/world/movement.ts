/**
 * Movement primitives — move and pivot a unit on the hex grid.
 *
 * Movement cost model (unified segment-step, the single source of truth):
 *   A move is a count of segment steps. Each step — whether to an adjacent
 *   segment within the same hex or across a hex border into the facing
 *   segment of the neighbour — costs segmentCost(destinationTile, mode),
 *   which depends only on the destination terrain and the unit's chassis:
 *
 *   Tank (wheeledMovement):  flat/clear 0.25, hills 0.75, forest/ocean ∞
 *   Spider (limbMovement):   0.50 on any passable terrain, ocean ∞
 *   Drone (flightMovement):  0.25 everywhere
 *
 *   - There is no separate per-hex entry cost; crossing a border is just one step.
 *   - Ocean is impassable for ground units; high elevation is not. Instead, a
 *     border step taller than the chassis climb limit (steepness gate in
 *     segmentCost) is impassable — that is why each cost call passes the origin
 *     tile as well as the destination.
 *   - Attack requires at least 1 MP remaining after all movement.
 *
 * Rotation (changing facing) is charged separately as a flat once-per-turn
 * ROTATION_FEE in turnState.ts — it is not part of the segment-step cost.
 *
 * This is the same segmentCost used by the client and AI (shared/movementConstants.ts),
 * so server, client, and AI always agree on how far a unit can move.
 *
 * These enforce TurnState rules when provided but do NOT resolve
 * reaction fire. Call resolveReactionFire from combat.ts separately
 * if reaction fire is desired after movement.
 */

import { Tile } from './types.js';
import { Unit, HexSegment, MOVEMENT_ATTRIBUTES } from './units.js';
import { TurnState, canMove, canPivot, recordMove, recordPivot, movementRemaining } from './turnState.js';
import { getApproachDirection } from './combat.js';
import {
  MovementMode,
  getMovementMode as getMovementModeFromAttrs,
  hexEntryCost as hexEntryCostShared,
  segmentCost as segmentCostShared,
} from '../../shared/movementConstants.js';

export type { MovementMode };

// ---------------------------------------------------------------------------
// Movement type classification
// ---------------------------------------------------------------------------

/** Determine a unit's movement mode from its attributes. */
export function getMovementMode(unit: Unit): MovementMode {
  return getMovementModeFromAttrs(unit.attributes);
}

// ---------------------------------------------------------------------------
// Terrain classification for movement
// ---------------------------------------------------------------------------

/**
 * Whether a tile is impassable to ground units by virtue of the cell itself.
 * Only ocean qualifies now — high elevation is no longer a blanket block;
 * steep *borders* are blocked per-edge by the segmentCost steepness gate.
 */
export function isImpassable(tile: Tile): boolean {
  return tile.terrainType === 'ocean';
}

// ---------------------------------------------------------------------------
// Segment-step movement cost
// ---------------------------------------------------------------------------

// The per-step cost function lives in shared/movementConstants.ts (segmentCost).
// It is re-used verbatim here so the server charges exactly what the client
// and AI estimate. See pathMovementCost / moveUnit below.

// ---------------------------------------------------------------------------
// Legacy hex entry cost (kept for client compatibility and test fallback)
// ---------------------------------------------------------------------------

/**
 * Cost in MP to enter a tile, given movement mode.
 *
 * Returns Infinity for impassable tiles.
 *
 * @deprecated Use segmentCostShared() or pathMovementCost() directly.
 * Kept for test compatibility.
 */
export function hexEntryCost(
  tile: Tile,
  mode: MovementMode,
  _isFirstHex: boolean,
): number {
  return hexEntryCostShared(tile, mode, _isFirstHex);
}

/**
 * Calculate total MP cost for a multi-hex path (segment cost approximation).
 * path[0] is the starting tile (not counted), path[1..] are tiles entered.
 * Uses segmentCost per tile (arrival segment = neighbour facing back to origin).
 *
 * Returns Infinity if any tile in the path is impassable.
 */
export function pathMovementCost(
  tiles: Tile[],
  path: number[],
  mode: MovementMode,
  _hexesMovedBefore: number = 0,
): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const arrivalSeg = tiles[path[i]].neighbours.indexOf(path[i - 1]);
    const cost = segmentCostShared(tiles[path[i]], arrivalSeg >= 0 ? arrivalSeg : 0, mode);
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
    const arrivalSeg = tiles[path[i]].neighbours.indexOf(path[i - 1]);
    const cost = segmentCostShared(tiles[path[i]], arrivalSeg >= 0 ? arrivalSeg : 0, mode);
    if (cost === Infinity) break;
    spent += cost;
    if (spent + 1 > totalMP) break; // need at least 1 MP remaining for attack
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
    const arrivalSeg = tiles[path[i]].neighbours.indexOf(path[i - 1]);
    const cost = segmentCostShared(tiles[path[i]], arrivalSeg >= 0 ? arrivalSeg : 0, mode);
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
 *  - Inter-hex move cost is computed from segment-to-segment distance × terrain
 *    multiplier (when boundary data available), falling back to legacy hexEntryCost.
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

      const mode = getMovementMode(unit);
      const destTile = tiles[toTileIndex];

      // Unified segment-step cost: arrival segment is the face pointing back
      // toward the origin tile, so the steepness gate applies to the exact
      // segment the unit steps onto.
      const arrivalSeg = destTile.neighbours.indexOf(fromIndex);
      const cost = segmentCostShared(destTile, arrivalSeg >= 0 ? arrivalSeg : 0, mode);

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
      if (!canPivot(unit, turnState, segment)) return false;
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
 * Segment repositioning costs fractional MP based on distance. Facing-only
 * changes are free. Requires movement points remaining and no prior move.
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
    if (!canPivot(unit, turnState, newSegment, newFacing)) return false;
    recordPivot(unit, turnState, newFacing, newSegment);
  } else {
    unit.facing = newFacing;
    if (newSegment !== undefined) {
      unit.segment = newSegment;
    }
  }
  return true;
}
