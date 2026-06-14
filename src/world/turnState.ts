/**
 * Turn State — per-unit movement tracking within a single turn.
 *
 * Rules enforced:
 *  1. Movement is a count of segment steps. Each step (to an adjacent segment
 *     in the same hex, or across a hex border) costs segmentCost(destTile,mode).
 *     Repositioning to a different segment within the current hex is movement
 *     and is charged per segment step (pivotStepCost × steps).
 *  2. Rotation (changing facing) costs a flat ROTATION_FEE, charged once per
 *     unit per turn. After the fee is paid, all further facing changes that
 *     turn are free (lets the player correct orientation mistakes for free).
 *  3. Moving does NOT lock rotation — a unit may move and rotate in any order
 *     while it has movement points remaining.
 */

import { Unit, HexSegment, getMovement } from './units.js';
import { getMovementMode, pivotStepCost, ROTATION_FEE } from '../../shared/movementConstants.js';

export { ROTATION_FEE };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MP cost per segment step when repositioning to a different segment within a
 * hex. Moving one segment position (±1) costs this much MP; the opposite
 * segment (3 steps around) costs 3× this. This is movement, not rotation.
 */
export const PIVOT_COST_PER_SEGMENT_STEP = 0.25;

// ---------------------------------------------------------------------------
// Per-unit turn record
// ---------------------------------------------------------------------------

export interface UnitTurnRecord {
  /** Movement points spent so far this turn. */
  movementSpent: number;
  /** Whether this unit has moved to a different hex this turn (informational). */
  hasMoved: boolean;
  /** Whether the once-per-turn rotation fee has already been paid this turn. */
  hasRotated: boolean;
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
    record = { movementSpent: 0, hasMoved: false, hasRotated: false };
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
 * Check whether a unit may pivot — reposition to a different segment and/or
 * change facing — within its current hex.
 *
 * Requires enough movement points remaining to cover the combined cost:
 *   segment-reposition movement (per step) + rotation fee (if facing changes
 *   and the fee has not yet been paid this turn).
 *
 * Moving earlier this turn does NOT prevent pivoting.
 */
export function canPivot(
  unit: Unit,
  state: TurnState,
  newSegment?: HexSegment,
  newFacing?: HexSegment,
): boolean {
  const remaining = movementRemaining(unit, state);
  if (remaining <= 0) return false;
  const facing = newFacing ?? unit.facing;
  const cost = pivotCost(unit, state, facing, newSegment);
  return remaining >= cost;
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
 * Compute the MP cost of a pivot action within the current hex.
 *
 * Cost has two independent parts:
 *   - Segment reposition (movement): per-step cost for the unit's chassis ×
 *     the minimum arc distance between the current and new segment.
 *   - Rotation fee: a flat ROTATION_FEE if the facing actually changes AND the
 *     once-per-turn fee has not already been paid. Otherwise free.
 *
 * Facing-only changes after the fee is paid cost 0. Segment-only moves never
 * incur the rotation fee.
 */
export function pivotCost(
  unit: Unit,
  state: TurnState,
  newFacing: HexSegment,
  newSegment?: HexSegment,
): number {
  let cost = 0;

  // Segment reposition is movement.
  if (newSegment !== undefined && newSegment !== unit.segment) {
    const diff = Math.abs(newSegment - unit.segment);
    const steps = Math.min(diff, 6 - diff); // shortest arc around the hex
    cost += steps * pivotStepCost(getMovementMode(unit.attributes));
  }

  // Rotation fee: flat, once per turn.
  if (newFacing !== unit.facing && !getRecord(state, unit.id).hasRotated) {
    cost += ROTATION_FEE;
  }

  return cost;
}

/**
 * Record that a unit has pivoted: charges the combined segment-reposition +
 * rotation cost, marks the rotation fee as paid (if a facing change triggered
 * it), and applies the facing/segment change. The caller must have verified
 * `canPivot` first.
 */
export function recordPivot(unit: Unit, state: TurnState, newFacing: HexSegment, newSegment?: HexSegment): void {
  const record = getRecord(state, unit.id);
  const cost = pivotCost(unit, state, newFacing, newSegment);
  record.movementSpent += cost;

  // The fee is paid the first time facing changes in a turn.
  if (newFacing !== unit.facing && !record.hasRotated) {
    record.hasRotated = true;
  }

  // Apply the facing/segment change on the unit directly.
  unit.facing = newFacing;
  if (newSegment !== undefined) {
    unit.segment = newSegment;
  }
}

/**
 * Record that a unit has moved one segment step. Costs the given MP and marks
 * hasMoved = true (informational only — moving no longer locks rotation).
 * The caller must have verified `canMove` first.
 */
export function recordMove(unit: Unit, state: TurnState, cost: number = 1): void {
  const record = getRecord(state, unit.id);
  record.movementSpent += cost;
  record.hasMoved = true;
}
