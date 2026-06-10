/**
 * Turn State — per-unit movement tracking within a single turn.
 *
 * Rules enforced:
 *  1. A unit may pivot (change facing/segment in its current hex)
 *     if it has movement points remaining AND has not yet moved this turn.
 *     Pivoting costs a fractional MP proportional to the segment distance
 *     traversed (PIVOT_COST_PER_SEGMENT_STEP × steps).
 *  2. Once a unit moves to a different hex, its facing and segment are
 *     locked for the remainder of the turn.
 *  3. Movement between hexes costs movement points based on terrain.
 */

import { Unit, HexSegment, getMovement } from './units.js';
import { getMovementMode, pivotStepCost } from '../../shared/movementConstants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MP cost per segment step when pivoting within a hex.
 * Moving one segment position (±1) costs this much MP.
 * Opposite segment (3 steps around) costs 3× this.
 *
 * Value 0.25 means:
 *   - Adjacent segment: 0.25 MP
 *   - Two segments away: 0.50 MP
 *   - Opposite segment: 0.75 MP
 *
 * This makes intra-hex repositioning meaningful but not crippling.
 */
export const PIVOT_COST_PER_SEGMENT_STEP = 0.25;

// ---------------------------------------------------------------------------
// Per-unit turn record
// ---------------------------------------------------------------------------

export interface UnitTurnRecord {
  /** Movement points spent so far this turn. */
  movementSpent: number;
  /** Whether this unit has moved to a different hex this turn. */
  hasMoved: boolean;
}

// ---------------------------------------------------------------------------
// Turn state container
// ---------------------------------------------------------------------------

/** Tracks per-unit movement state for the current turn. Keyed by unit id. */
export type TurnState = Map<string, UnitTurnRecord>;

/** Create a fresh turn state (call at the start of each turn). */
export function createTurnState(): TurnState {
  return new Map();
}

/** Get or initialize the turn record for a unit. */
export function getRecord(state: TurnState, unitId: string): UnitTurnRecord {
  let record = state.get(unitId);
  if (!record) {
    record = { movementSpent: 0, hasMoved: false };
    state.set(unitId, record);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Remaining movement points for a unit this turn. */
export function movementRemaining(unit: Unit, state: TurnState): number {
  const budget = getMovement(unit);
  const record = getRecord(state, unit.id);
  return Math.max(0, budget - record.movementSpent);
}

/** Whether the unit still has any movement points available. */
export function hasMovementPoints(unit: Unit, state: TurnState): boolean {
  return movementRemaining(unit, state) > 0;
}

// ---------------------------------------------------------------------------
// Guard functions
// ---------------------------------------------------------------------------

/**
 * Check whether a unit may pivot (change facing or segment within its hex).
 * Pivoting requires:
 *  - The unit has movement points remaining (enough for the pivot cost).
 *  - The unit has NOT moved to a different hex this turn.
 *
 * If newSegment is provided, checks affordability. Otherwise just checks
 * that some MP remains (facing-only pivots are free).
 */
export function canPivot(unit: Unit, state: TurnState, newSegment?: HexSegment): boolean {
  const record = getRecord(state, unit.id);
  if (record.hasMoved) return false;
  const remaining = movementRemaining(unit, state);
  if (remaining <= 0) return false;
  if (newSegment !== undefined) {
    const cost = pivotCost(unit.segment, newSegment, unit);
    return remaining >= cost;
  }
  return true;
}

/**
 * Check whether a unit may move to an adjacent hex.
 * Requires at least 1 movement point remaining.
 * (A unit that has already moved may continue moving if points remain.)
 */
export function canMove(unit: Unit, state: TurnState): boolean {
  return hasMovementPoints(unit, state);
}

// ---------------------------------------------------------------------------
// State mutation (called after validated actions)
// ---------------------------------------------------------------------------

/**
 * Compute the MP cost of a pivot to a new segment within the same hex.
 * Cost = per-step cost for the unit's chassis × (minimum arc distance).
 * Facing-only changes (same segment) cost 0.
 */
export function pivotCost(currentSegment: HexSegment, newSegment: HexSegment | undefined, unit: Unit): number {
  if (newSegment === undefined || newSegment === currentSegment) return 0;
  const diff = Math.abs(newSegment - currentSegment);
  const steps = Math.min(diff, 6 - diff); // shortest arc around the hex
  const mode = getMovementMode(unit.attributes);
  return steps * pivotStepCost(mode);
}

/**
 * Record that a unit has pivoted. Costs fractional MP based on segment
 * distance traversed. Facing-only changes (no segment move) are free.
 * The caller must have verified `canPivot` first.
 */
export function recordPivot(unit: Unit, state: TurnState, newFacing: HexSegment, newSegment?: HexSegment): void {
  const cost = pivotCost(unit.segment, newSegment, unit);
  if (cost > 0) {
    const record = getRecord(state, unit.id);
    record.movementSpent += cost;
  }
  // Apply the facing/segment change on the unit directly.
  unit.facing = newFacing;
  if (newSegment !== undefined) {
    unit.segment = newSegment;
  }
}

/**
 * Record that a unit has moved one hex. Costs 1 movement point and sets
 * hasMoved = true (locking further pivots this turn).
 * The caller must have verified `canMove` first.
 */
export function recordMove(unit: Unit, state: TurnState, cost: number = 1): void {
  const record = getRecord(state, unit.id);
  record.movementSpent += cost;
  record.hasMoved = true;
}
