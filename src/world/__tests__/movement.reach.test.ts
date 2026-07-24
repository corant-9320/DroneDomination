import { describe, it, expect, beforeEach } from 'vitest';
import {
  maxHexesWithAttack,
  maxReachableHexes,
  canAttackAfterMovement,
  moveUnit,
  pivotUnit,
} from '../movement.js';
import { HexSegment } from '../units.js';
import { createTurnState, recordMove } from '../turnState.js';
import { buildSegmentOccupancy } from '../../../shared/segmentGraph.js';
import type { Tile } from '../types.js';
import { makeTile, linearGrid, hexGrid, makeUnit } from './movement.fixtures.js';

// Reach calculations and the moveUnit/pivotUnit mutators. Mode/cost rules live
// in `movement.test.ts`.

describe('movement (reach & mutation)', () => {
  // =========================================================================
  // maxHexesWithAttack — how far you can move and still have 1 MP to attack
  // =========================================================================

  describe('maxHexesWithAttack', () => {
    it('drone with 4 MP can move many hexes (0.25 each) and still have 1 MP for attack', () => {
      const tiles = linearGrid();
      // 4 MP, need 1 for attack → 3 MP for movement → 3/0.25 = 12 steps, but path only has 4 hops
      expect(maxHexesWithAttack(4, 'flight', tiles, [0, 1, 2, 3, 4])).toBe(4);
    });

    it('wheeled with 3 MP on flat: cost 0.25/hex, need 1 for attack → many hexes', () => {
      const tiles = linearGrid();
      // 3 MP, reserve 1 for attack → 2 MP budget, 0.25/hex → 8 hexes but path only 3 long
      expect(maxHexesWithAttack(3, 'wheeled', tiles, [0, 1, 2, 3])).toBe(3);
    });

    it('returns 0 if even first hex costs all MP leaving none for attack', () => {
      const tiles = linearGrid();
      // wheeled with 0.5 MP: 0.25 for hex + need 1 for attack → 0.25 + 1 > 0.5 → can't move
      expect(maxHexesWithAttack(0.5, 'wheeled', tiles, [0, 1, 2])).toBe(0);
    });

    it('stops at impassable tile', () => {
      const tiles = linearGrid();
      tiles[2] = makeTile({ index: 2, neighbours: [1, 3, 2, 2, 2, 2], terrainType: 'ocean' });
      expect(maxHexesWithAttack(10, 'wheeled', tiles, [0, 1, 2, 3])).toBe(1);
    });
  });

  // =========================================================================
  // maxReachableHexes — how far you can move (no attack requirement)
  // =========================================================================

  describe('maxReachableHexes', () => {
    it('drone with 4 MP can reach all 4 hexes in path (0.25 each = 1.0 total)', () => {
      const tiles = linearGrid();
      expect(maxReachableHexes(4, 'flight', tiles, [0, 1, 2, 3, 4])).toBe(4);
    });

    it('wheeled with 3 MP on flat: 0.25/hex → can reach all in path', () => {
      const tiles = linearGrid();
      expect(maxReachableHexes(3, 'wheeled', tiles, [0, 1, 2, 3])).toBe(3);
    });

    it('returns 0 when 0 MP', () => {
      const tiles = linearGrid();
      expect(maxReachableHexes(0, 'flight', tiles, [0, 1, 2])).toBe(0);
    });

    it('stops at impassable tile', () => {
      const tiles = linearGrid();
      tiles[2] = makeTile({ index: 2, neighbours: [1, 3, 2, 2, 2, 2], terrainType: 'ocean' });
      expect(maxReachableHexes(10, 'limb', tiles, [0, 1, 2, 3])).toBe(1);
    });
  });

  // =========================================================================
  // canAttackAfterMovement
  // =========================================================================

  describe('canAttackAfterMovement', () => {
    it('returns true when unit has not moved', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      expect(canAttackAfterMovement(unit, state)).toBe(true);
    });

    it('returns true when unit has MP remaining', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      recordMove(unit, state, 2);
      expect(canAttackAfterMovement(unit, state)).toBe(true);
    });

    it('returns false when all MP spent', () => {
      const unit = makeUnit({ id: 'u', attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      recordMove(unit, state, 3);
      expect(canAttackAfterMovement(unit, state)).toBe(false);
    });
  });

  // =========================================================================
  // moveUnit
  // =========================================================================

  describe('moveUnit', () => {
    let tiles: Tile[];

    beforeEach(() => {
      tiles = hexGrid();
    });

    it('moves unit to adjacent tile (no turn state)', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0 });
      const result = moveUnit(unit, 1, tiles);
      expect(result).toBe(true);
      expect(unit.tileIndex).toBe(1);
    });

    it('updates facing toward destination (no turn state)', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, facing: 3 as HexSegment });
      moveUnit(unit, 1, tiles);
      // Direction from tile 0 to tile 1 is neighbour index 0
      expect(unit.facing).toBe(0);
    });

    it('accepts the facing segment when explicitly provided', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, segment: 0 as HexSegment });
      const arrivalSegment = tiles[1].neighbours.indexOf(0) as HexSegment;
      const moved = moveUnit(unit, 1, tiles, arrivalSegment);
      expect(moved).toBe(true);
      expect(unit.segment).toBe(arrivalSegment);
    });

    it('with turn state: deducts movement cost', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      const result = moveUnit(unit, 1, tiles, undefined, state);
      expect(result).toBe(true);
      expect(unit.tileIndex).toBe(1);
    });

    it('with turn state: rejects move when insufficient MP', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 0.25 } });
      const state = createTurnState();
      // Flat terrain costs 0.25 per hex. Unit has 0.25 MP → can do 1 hop.
      const first = moveUnit(unit, 1, tiles, undefined, state); // spent 0.25
      expect(first).toBe(true);
      // Second move: MP exhausted
      const result = moveUnit(unit, 2, tiles, undefined, state);
      expect(result).toBe(false);
    });

    it('with turn state: rejects move to impassable tile', () => {
      // Ocean is the remaining impassable terrain for ground units
      tiles[1] = makeTile({ index: 1, neighbours: [0, 2, 6, 0, 2, 6], terrainType: 'ocean' });
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      const result = moveUnit(unit, 1, tiles, undefined, state);
      expect(result).toBe(false);
      expect(unit.tileIndex).toBe(0);
    });

    it('wheeled costs 0.25 per flat hex regardless of position in sequence', () => {
      tiles[1] = makeTile({ index: 1, neighbours: [0, 2, 6, 0, 2, 6], height: 1, forested: false });
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 1 } });
      const state = createTurnState();
      const result = moveUnit(unit, 1, tiles, undefined, state);
      // Cost = 0.25 per flat hex, unit has 1 MP → should succeed
      expect(result).toBe(true);
    });

    // =========================================================================
    // moveUnit — occupancy gating (Segment-Based Movement spec, B2/B4)
    // =========================================================================

    it('rejects a move onto an occupied landing segment (no turn state)', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, segment: 0 as HexSegment });
      // Landing segment on tile 1 defaults to the arrival face (tile1.neighbours.indexOf(0)).
      const arrivalSeg = tiles[1].neighbours.indexOf(0);
      const isOccupied = buildSegmentOccupancy([{ tileIndex: 1, segment: arrivalSeg }]);
      const result = moveUnit(unit, 1, tiles, undefined, undefined, isOccupied);
      expect(result).toBe(false);
      expect(unit.tileIndex).toBe(0); // unchanged
    });

    it('rejects an explicit non-adjacent segment on the destination tile', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, segment: 0 as HexSegment });
      const arrivalSeg = tiles[1].neighbours.indexOf(0);
      const isOccupied = buildSegmentOccupancy([{ tileIndex: 1, segment: arrivalSeg }]);
      const nonAdjacentSeg = ((arrivalSeg + 1) % 6) as HexSegment;
      const result = moveUnit(unit, 1, tiles, nonAdjacentSeg, undefined, isOccupied);
      expect(result).toBe(false);
      expect(unit.tileIndex).toBe(0);
      expect(unit.segment).toBe(0);
    });

    it('with turn state: rejects a move onto an occupied segment even with MP available', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      const arrivalSeg = tiles[1].neighbours.indexOf(0);
      const isOccupied = buildSegmentOccupancy([{ tileIndex: 1, segment: arrivalSeg }]);
      const result = moveUnit(unit, 1, tiles, undefined, state, isOccupied);
      expect(result).toBe(false);
      expect(unit.tileIndex).toBe(0);
    });
  });

  // =========================================================================
  // pivotUnit
  // =========================================================================

  describe('pivotUnit', () => {
    it('changes facing (no turn state)', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment });
      const result = pivotUnit(unit, 3 as HexSegment);
      expect(result).toBe(true);
      expect(unit.facing).toBe(3);
    });

    it('changes segment when provided (no turn state)', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, segment: 0 as HexSegment });
      pivotUnit(unit, 2 as HexSegment, 4 as HexSegment);
      expect(unit.facing).toBe(2);
      expect(unit.segment).toBe(4);
    });

    it('with turn state: succeeds when unit has not moved', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, attributes: { wheeledMovement: 3 } });
      const state = createTurnState();
      const result = pivotUnit(unit, 3 as HexSegment, undefined, state);
      expect(result).toBe(true);
      expect(unit.facing).toBe(3);
    });

    it('with turn state: still allowed after moving (move does not lock rotation)', () => {
      const tiles = hexGrid();
      const unit = makeUnit({ id: 'u', tileIndex: 0, facing: 0 as HexSegment, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      moveUnit(unit, 1, tiles, undefined, state);
      const result = pivotUnit(unit, 4 as HexSegment, undefined, state);
      expect(result).toBe(true);
      expect(unit.facing).toBe(4);
    });

    it('with turn state: fails when no MP remaining', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, attributes: { wheeledMovement: 1 } });
      const state = createTurnState();
      recordMove(unit, state, 1); // spend all MP
      const result = pivotUnit(unit, 3 as HexSegment, undefined, state);
      expect(result).toBe(false);
    });

    it('rejects a pivot onto an occupied segment (B6)', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, segment: 0 as HexSegment });
      const isOccupied = buildSegmentOccupancy([{ tileIndex: unit.tileIndex, segment: 4 }]);
      const result = pivotUnit(unit, 2 as HexSegment, 4 as HexSegment, undefined, isOccupied);
      expect(result).toBe(false);
      expect(unit.segment).toBe(0); // unchanged
    });

    it('with turn state: rejects a pivot onto an occupied segment even with MP available', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, segment: 0 as HexSegment, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      const isOccupied = buildSegmentOccupancy([{ tileIndex: unit.tileIndex, segment: 4 }]);
      const result = pivotUnit(unit, 2 as HexSegment, 4 as HexSegment, state, isOccupied);
      expect(result).toBe(false);
    });
  });
});
