import { describe, it, expect } from 'vitest';
import {
  createTurnState,
  getRecord,
  movementRemaining,
  hasMovementPoints,
  canPivot,
  canMove,
  recordPivot,
  recordMove,
} from '../turnState.js';
import { Unit, HexSegment } from '../units.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnit(overrides: Partial<Unit> & { id: string }): Unit {
  return {
    label: overrides.id,
    ownerId: 'p1',
    tileIndex: 0,
    segment: 0 as HexSegment,
    facing: 0 as HexSegment,
    attributes: { size: 3, wheeledMovement: 3 },
    currentHealth: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('turnState', () => {
  // =========================================================================
  // createTurnState
  // =========================================================================

  describe('createTurnState', () => {
    it('creates an empty map', () => {
      const state = createTurnState();
      expect(state.size).toBe(0);
    });
  });

  // =========================================================================
  // getRecord
  // =========================================================================

  describe('getRecord', () => {
    it('initializes a fresh record for an unknown unit', () => {
      const state = createTurnState();
      const record = getRecord(state, 'unit1');
      expect(record.movementSpent).toBe(0);
      expect(record.hasMoved).toBe(false);
    });

    it('returns the same record on subsequent calls', () => {
      const state = createTurnState();
      const record1 = getRecord(state, 'unit1');
      record1.movementSpent = 2;
      const record2 = getRecord(state, 'unit1');
      expect(record2.movementSpent).toBe(2);
    });

    it('different units get independent records', () => {
      const state = createTurnState();
      const r1 = getRecord(state, 'u1');
      const r2 = getRecord(state, 'u2');
      r1.movementSpent = 5;
      expect(r2.movementSpent).toBe(0);
    });
  });

  // =========================================================================
  // movementRemaining
  // =========================================================================

  describe('movementRemaining', () => {
    it('equals full budget at start of turn', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 4 } });
      const state = createTurnState();
      expect(movementRemaining(unit, state)).toBe(4);
    });

    it('decreases after spending movement', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 4 } });
      const state = createTurnState();
      recordMove(unit, state, 2);
      expect(movementRemaining(unit, state)).toBe(2);
    });

    it('never goes below 0', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      recordMove(unit, state, 5); // overspend
      expect(movementRemaining(unit, state)).toBe(0);
    });

    it('uses highest movement attribute as budget', () => {
      // Unit has limbMovement=4 (highest), wheeledMovement shouldn't matter
      const unit = makeUnit({ id: 'u', attributes: { limbMovement: 4, wheeledMovement: 2 } });
      const state = createTurnState();
      expect(movementRemaining(unit, state)).toBe(4);
    });
  });

  // =========================================================================
  // hasMovementPoints
  // =========================================================================

  describe('hasMovementPoints', () => {
    it('true at start of turn', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      expect(hasMovementPoints(unit, state)).toBe(true);
    });

    it('false when all MP spent', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      recordMove(unit, state, 3);
      expect(hasMovementPoints(unit, state)).toBe(false);
    });

    it('true when partial MP spent', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      recordMove(unit, state, 1);
      expect(hasMovementPoints(unit, state)).toBe(true);
    });
  });

  // =========================================================================
  // canPivot
  // =========================================================================

  describe('canPivot', () => {
    it('allowed at start of turn (has MP, has not moved)', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      expect(canPivot(unit, state)).toBe(true);
    });

    it('still allowed after an inter-hex move (move does not lock rotation)', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      recordMove(unit, state, 1);
      expect(canPivot(unit, state)).toBe(true);
    });

    it('disallowed when no MP remaining (even without moving)', () => {
      // Edge case: can't pivot even if unit hasn't physically moved,
      // if somehow all MP are spent
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 0 } });
      const state = createTurnState();
      expect(canPivot(unit, state)).toBe(false);
    });
  });

  // =========================================================================
  // canMove
  // =========================================================================

  describe('canMove', () => {
    it('allowed at start of turn', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      expect(canMove(unit, state)).toBe(true);
    });

    it('allowed after partial move (MP remaining)', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      recordMove(unit, state, 2);
      expect(canMove(unit, state)).toBe(true);
    });

    it('disallowed when all MP spent', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      recordMove(unit, state, 3);
      expect(canMove(unit, state)).toBe(false);
    });
  });

  // =========================================================================
  // recordPivot
  // =========================================================================

  describe('recordPivot', () => {
    it('updates unit facing', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment });
      const state = createTurnState();
      recordPivot(unit, state, 4 as HexSegment);
      expect(unit.facing).toBe(4);
    });

    it('updates unit segment when provided', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, segment: 1 as HexSegment });
      const state = createTurnState();
      recordPivot(unit, state, 3 as HexSegment, 5 as HexSegment);
      expect(unit.facing).toBe(3);
      expect(unit.segment).toBe(5);
    });

    it('first facing change costs the flat rotation fee', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, attributes: { wheeledMovement: 4 } });
      const state = createTurnState();
      recordPivot(unit, state, 2 as HexSegment);
      expect(movementRemaining(unit, state)).toBe(3.75); // 4 - ROTATION_FEE(0.25)
    });

    it('further facing changes in the same turn are free', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, attributes: { wheeledMovement: 4 } });
      const state = createTurnState();
      recordPivot(unit, state, 2 as HexSegment); // pays 0.25
      recordPivot(unit, state, 5 as HexSegment); // free
      recordPivot(unit, state, 1 as HexSegment); // free
      expect(movementRemaining(unit, state)).toBe(3.75);
      expect(unit.facing).toBe(1);
    });

    it('does not set hasMoved', () => {
      const unit = makeUnit({ id: 'u' });
      const state = createTurnState();
      recordPivot(unit, state, 2 as HexSegment);
      expect(canPivot(unit, state)).toBe(true); // still can pivot
    });
  });

  // =========================================================================
  // recordMove
  // =========================================================================

  describe('recordMove', () => {
    it('spends specified movement cost', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      recordMove(unit, state, 3);
      expect(movementRemaining(unit, state)).toBe(2);
    });

    it('sets hasMoved flag without locking rotation', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      recordMove(unit, state, 1);
      expect(getRecord(state, unit.id).hasMoved).toBe(true);
      expect(canPivot(unit, state)).toBe(true); // moving no longer prevents pivot
    });

    it('accumulates across multiple moves', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 10 } });
      const state = createTurnState();
      recordMove(unit, state, 2);
      recordMove(unit, state, 3);
      expect(movementRemaining(unit, state)).toBe(5);
    });

    it('defaults cost to 1 when not specified', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      recordMove(unit, state);
      expect(movementRemaining(unit, state)).toBe(4);
    });
  });
});
