/**
 * Movement primitives — move and pivot a unit on the hex grid.
 *
 * Movement cost model (segment-distance based):
 *   Cost = segmentDistance × terrainMultiplier
 *
 *   Where segmentDistance is the chord distance between segment centroids
 *   normalised to hex-spacing units (~1.0 for center-to-center of adjacent
 *   tiles), and terrainMultiplier depends on unit type and destination terrain:
 *
 *   Tank (wheeledMovement):
 *     Clear/flat: ×1.75, Hill OR Forest: ×2.5, Hill AND Forest: ×3.5
 *   Spider (limbMovement):
 *     All terrain: ×2.5 (ignores terrain)
 *   Drone (flightMovement):
 *     All terrain: ×1.0 (ignores terrain)
 *
 *   - Mountain and ocean are impassable for ground units.
 *   - Attack requires at least 1 MP remaining after all movement.
 *   - Intra-hex repositioning uses the same formula (short segment distances).
 *
 * These enforce TurnState rules when provided but do NOT resolve
 * reaction fire. Call resolveReactionFire from combat.ts separately
 * if reaction fire is desired after movement.
 */

import { Tile } from './types.js';
import { Unit, HexSegment, MOVEMENT_ATTRIBUTES } from './units.js';
import { TurnState, canMove, canPivot, recordMove, recordPivot, movementRemaining } from './turnState.js';
import { getApproachDirection } from './combat.js';
import { segmentMovementDistance } from './segmentGeometry.js';
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

/** Whether a tile counts as "hill" for movement purposes. */
export function isHillTerrain(tile: Tile): boolean {
  return tile.elevationType === 'hills';
}

/** Whether a tile is impassable (mountain elevation or ocean terrain). */
export function isImpassable(tile: Tile): boolean {
  return tile.elevationType === 'mountain' || tile.terrainType === 'ocean';
}

// ---------------------------------------------------------------------------
// Segment-distance-based movement cost
// ---------------------------------------------------------------------------

/**
 * Terrain multipliers for movement cost calculation.
 * Cost = segmentDistance × terrainMultiplier.
 *
 * These values are calibrated so that with 5 MP on flat terrain:
 *   Tank: ~2.85 hex-distances (≈3 tiles center-to-center)
 *   Spider: 2.0 hex-distances (≈2 tiles)
 *   Drone: 5.0 hex-distances (≈5 tiles)
 */
export const TERRAIN_MULTIPLIER_TANK_FLAT = 1.75;
export const TERRAIN_MULTIPLIER_TANK_HILL = 2.5;
export const TERRAIN_MULTIPLIER_TANK_HILL_FOREST = 3.5;
export const TERRAIN_MULTIPLIER_SPIDER = 2.5;
export const TERRAIN_MULTIPLIER_DRONE = 1.0;

/**
 * Get the terrain multiplier for a destination tile given the movement mode.
 * Returns Infinity for impassable tiles (ground units only).
 */
export function getTerrainMultiplier(tile: Tile, mode: MovementMode): number {
  if (isImpassable(tile) && mode !== 'flight') return Infinity;
  if (mode === 'flight') return TERRAIN_MULTIPLIER_DRONE;
  if (mode === 'limb') return TERRAIN_MULTIPLIER_SPIDER;

  // Tank (wheeled): terrain-dependent
  const hill = isHillTerrain(tile);
  const forested = tile.forested;
  if (hill && forested) return TERRAIN_MULTIPLIER_TANK_HILL_FOREST;
  if (hill || forested) return TERRAIN_MULTIPLIER_TANK_HILL;
  return TERRAIN_MULTIPLIER_TANK_FLAT;
}

/**
 * Compute the MP cost to move from one segment position to another.
 *
 * cost = segmentDistance(from, to) × terrainMultiplier(destinationTile)
 *
 * This is the authoritative server-side cost function. The client uses
 * the legacy hexEntryCost for pathfinding approximation (no boundary data).
 *
 * Returns Infinity if the destination is impassable.
 */
export function segmentMoveCost(
  tiles: Tile[],
  fromTileIndex: number,
  fromSegment: HexSegment,
  toTileIndex: number,
  toSegment: HexSegment,
  mode: MovementMode,
): number {
  const destTile = tiles[toTileIndex];
  const multiplier = getTerrainMultiplier(destTile, mode);
  if (multiplier === Infinity) return Infinity;

  const dist = segmentMovementDistance(tiles, fromTileIndex, fromSegment, toTileIndex, toSegment);
  return dist * multiplier;
}

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
 * Uses segmentCost per tile (no pivot cost, no segment-distance calculation).
 *
 * Returns Infinity if any tile in the path is impassable.
 *
 * For full segment-aware cost, use pathSegmentMovementCost instead.
 */
export function pathMovementCost(
  tiles: Tile[],
  path: number[],
  mode: MovementMode,
  _hexesMovedBefore: number = 0,
): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const cost = segmentCostShared(tiles[path[i]], mode);
    if (cost === Infinity) return Infinity;
    total += cost;
  }
  return total;
}

/**
 * Calculate total MP cost for a multi-hex path using segment-aware distances.
 *
 * Computes segment-to-segment cost for each hop, assuming the unit occupies
 * `startSegment` at the beginning and uses the facing-aligned segment at
 * each intermediate tile.
 *
 * path[0] is the starting tile (not counted), path[1..] are tiles entered.
 * Returns Infinity if any tile in the path is impassable.
 */
export function pathSegmentMovementCost(
  tiles: Tile[],
  path: number[],
  mode: MovementMode,
  startSegment: HexSegment,
  arrivalSegments?: HexSegment[],
): number {
  if (path.length <= 1) return 0;

  let total = 0;
  let currentTile = path[0];
  let currentSegment = startSegment;

  for (let i = 1; i < path.length; i++) {
    const nextTile = path[i];
    // Default arrival segment: the segment facing back toward where we came from
    const arrivalSeg = arrivalSegments?.[i - 1] ?? getArrivalSegment(tiles, currentTile, nextTile);
    const cost = segmentMoveCost(tiles, currentTile, currentSegment, nextTile, arrivalSeg, mode);
    if (cost === Infinity) return Infinity;
    total += cost;
    currentTile = nextTile;
    currentSegment = arrivalSeg;
  }
  return total;
}

/**
 * Determine the natural arrival segment when entering a tile from a given source.
 * Returns the segment facing back toward the source tile (i.e. the segment
 * whose edge is closest to where the unit came from).
 */
function getArrivalSegment(tiles: Tile[], fromTileIndex: number, toTileIndex: number): HexSegment {
  const toTile = tiles[toTileIndex];
  const dirFromTo = toTile.neighbours.indexOf(fromTileIndex);
  if (dirFromTo >= 0) return dirFromTo as HexSegment;
  return 0 as HexSegment; // fallback
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
    const cost = segmentCostShared(tiles[path[i]], mode);
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
    const cost = segmentCostShared(tiles[path[i]], mode);
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
      const destSegment = segment ?? unit.segment;

      // Use segment-aware cost if boundary data is available, else legacy
      let cost: number;
      const hasBoundary = destTile.boundary && destTile.boundary.length >= destTile.sides
        && tiles[fromIndex].boundary && tiles[fromIndex].boundary.length >= tiles[fromIndex].sides;

      if (hasBoundary) {
        cost = segmentMoveCost(tiles, fromIndex, unit.segment, toTileIndex, destSegment, mode);
      } else {
        // Legacy fallback (test grids without boundary data)
        cost = segmentCostShared(destTile, mode);
      }

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
    if (!canPivot(unit, turnState, newSegment)) return false;
    recordPivot(unit, turnState, newFacing, newSegment);
  } else {
    unit.facing = newFacing;
    if (newSegment !== undefined) {
      unit.segment = newSegment;
    }
  }
  return true;
}
