/**
 * Turn State — per-unit movement tracking within a single turn.
 *
 * Rules enforced:
 *  1. A unit may only pivot (change facing/segment in its current hex)
 *     if it has movement points remaining AND has not yet moved this turn.
 *  2. Once a unit moves to a different hex, its facing and segment are
 *     locked for the remainder of the turn.
 *  3. Movement between hexes costs movement points; pivoting does not.
 */

import { Unit, HexSegment, getMovement } from './units.js';

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
 * Pivoting is free but requires:
 *  - The unit has movement points remaining (not fully spent).
 *  - The unit has NOT moved to a different hex this turn.
 */
export function canPivot(unit: Unit, state: TurnState): boolean {
  const record = getRecord(state, unit.id);
  if (record.hasMoved) return false;
  return hasMovementPoints(unit, state);
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
 * Record that a unit has pivoted. Does not cost movement points but the
 * caller must have verified `canPivot` first.
 */
export function recordPivot(unit: Unit, state: TurnState, newFacing: HexSegment, newSegment?: HexSegment): void {
  // No movement point cost, but we don't change hasMoved (pivot != move).
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
