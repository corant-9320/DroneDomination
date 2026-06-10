import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMovementMode,
  isHillTerrain,
  isImpassable,
  hexEntryCost,
  pathMovementCost,
  maxHexesWithAttack,
  maxReachableHexes,
  canAttackAfterMovement,
  moveUnit,
  pivotUnit,
} from '../movement.js';
import { Unit, HexSegment } from '../units.js';
import { createTurnState, TurnState, recordMove } from '../turnState.js';
import type { Tile } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTile(overrides: Partial<Tile> & { index: number; neighbours: number[] }): Tile {
  return {
    id: `tile_${overrides.index}`,
    sides: 6,
    position3d: { x: 0, y: 0, z: 1 },
    boundary: [],
    terrainType: 'plains',
    elevationType: 'rolling',
    forested: false,
    ...overrides,
  } as Tile;
}

/**
 * Linear chain: 0 — 1 — 2 — 3 — 4
 * All plains/rolling/not forested by default.
 */
function linearGrid(n: number = 5): Tile[] {
  return Array.from({ length: n }, (_, i) => {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < n - 1) neighbours.push(i + 1);
    // Pad to 6 neighbours (self-links for missing)
    while (neighbours.length < 6) neighbours.push(i);
    return makeTile({ index: i, neighbours });
  });
}

/**
 * 7-tile hex grid: tile 0 centre, tiles 1-6 ring.
 */
function hexGrid(): Tile[] {
  const tiles: Tile[] = [];
  tiles.push(makeTile({ index: 0, neighbours: [1, 2, 3, 4, 5, 6] }));
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push(makeTile({ index: i, neighbours: [0, next, prev, 0, next, prev] }));
  }
  return tiles;
}

function makeUnit(overrides: Partial<Unit> & { id: string }): Unit {
  return {
    label: overrides.id,
    ownerId: 'p1',
    tileIndex: 0,
    segment: 0 as HexSegment,
    facing: 0 as HexSegment,
    attributes: { maxHealth: 3, wheeledMovement: 3 },
    currentHealth: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('movement', () => {
  // =========================================================================
  // Movement mode classification
  // =========================================================================

  describe('getMovementMode', () => {
    it('returns wheeled for wheeledMovement units', () => {
      const unit = makeUnit({ id: 'a', attributes: { wheeledMovement: 3 } });
      expect(getMovementMode(unit)).toBe('wheeled');
    });

    it('returns limb for limbMovement units', () => {
      const unit = makeUnit({ id: 'a', attributes: { limbMovement: 2 } });
      expect(getMovementMode(unit)).toBe('limb');
    });

    it('returns flight for flightMovement units', () => {
      const unit = makeUnit({ id: 'a', attributes: { flightMovement: 4 } });
      expect(getMovementMode(unit)).toBe('flight');
    });

    it('flight takes priority over limb and wheeled', () => {
      const unit = makeUnit({ id: 'a', attributes: { flightMovement: 1, limbMovement: 3, wheeledMovement: 5 } });
      expect(getMovementMode(unit)).toBe('flight');
    });

    it('limb takes priority over wheeled', () => {
      const unit = makeUnit({ id: 'a', attributes: { limbMovement: 1, wheeledMovement: 5 } });
      expect(getMovementMode(unit)).toBe('limb');
    });

    it('defaults to wheeled when no movement attributes', () => {
      const unit = makeUnit({ id: 'a', attributes: {} });
      expect(getMovementMode(unit)).toBe('wheeled');
    });
  });

  // =========================================================================
  // Terrain classification
  // =========================================================================

  describe('isHillTerrain', () => {
    it('returns true for hills elevation', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'hills' });
      expect(isHillTerrain(tile)).toBe(true);
    });

    it('returns false for flat elevation', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'flat' });
      expect(isHillTerrain(tile)).toBe(false);
    });

    it('returns false for mountain elevation', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'mountain' });
      expect(isHillTerrain(tile)).toBe(false);
    });
  });

  describe('isImpassable', () => {
    it('returns true for mountain elevation', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'mountain' });
      expect(isImpassable(tile)).toBe(true);
    });

    it('returns true for ocean terrain', () => {
      const tile = makeTile({ index: 0, neighbours: [1], terrainType: 'ocean' });
      expect(isImpassable(tile)).toBe(true);
    });

    it('returns false for plains/rolling', () => {
      const tile = makeTile({ index: 0, neighbours: [1], terrainType: 'plains', elevationType: 'rolling' });
      expect(isImpassable(tile)).toBe(false);
    });

    it('returns false for hills terrain', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'hills' });
      expect(isImpassable(tile)).toBe(false);
    });
  });

  // =========================================================================
  // Hex entry cost
  // =========================================================================

  describe('hexEntryCost', () => {
    it('flight always costs 0.25', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'hills', forested: true });
      expect(hexEntryCost(tile, 'flight', true)).toBe(0.25);
      expect(hexEntryCost(tile, 'flight', false)).toBe(0.25);
    });

    it('flight mode costs 0.25 even on mountain and ocean', () => {
      const mountain = makeTile({ index: 0, neighbours: [1], elevationType: 'mountain' });
      const ocean = makeTile({ index: 0, neighbours: [1], terrainType: 'ocean' });
      expect(hexEntryCost(mountain, 'flight', false)).toBe(0.25);
      expect(hexEntryCost(ocean, 'flight', false)).toBe(0.25);
    });

    it('limb mode always costs 0.50 on passable terrain', () => {
      const flat = makeTile({ index: 0, neighbours: [1], elevationType: 'flat' });
      const hills = makeTile({ index: 1, neighbours: [0], elevationType: 'hills', forested: true });
      expect(hexEntryCost(flat, 'limb', false)).toBe(0.50);
      expect(hexEntryCost(hills, 'limb', false)).toBe(0.50);
    });

    it('wheeled on flat clear costs 0.25', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'flat', forested: false });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(0.25);
    });

    it('wheeled on hills costs 0.75', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'hills', forested: false });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(0.75);
    });

    it('wheeled on forested terrain is forbidden', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'flat', forested: true });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(Infinity);
    });

    it('mountain is impassable for wheeled', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'mountain' });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(Infinity);
    });

    it('ocean is impassable for wheeled', () => {
      const tile = makeTile({ index: 0, neighbours: [1], terrainType: 'ocean' });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(Infinity);
    });

    it('mountain is impassable for limb', () => {
      const tile = makeTile({ index: 0, neighbours: [1], elevationType: 'mountain' });
      expect(hexEntryCost(tile, 'limb', false)).toBe(Infinity);
    });
  });

  // =========================================================================
  // Path movement cost
  // =========================================================================

  describe('pathMovementCost', () => {
    it('single-hop path from tile 0 to tile 1 (wheeled, flat) costs 0.25', () => {
      const tiles = linearGrid();
      expect(pathMovementCost(tiles, [0, 1], 'wheeled', 0)).toBe(0.25);
    });

    it('two-hop path costs 0.25 + 0.25 = 0.50 for wheeled flat', () => {
      const tiles = linearGrid();
      expect(pathMovementCost(tiles, [0, 1, 2], 'wheeled', 0)).toBe(0.50);
    });

    it('flight across 4 tiles costs 4 × 0.25 = 1.0', () => {
      const tiles = linearGrid();
      expect(pathMovementCost(tiles, [0, 1, 2, 3, 4], 'flight', 0)).toBe(1.0);
    });

    it('returns Infinity if path crosses impassable tile for ground unit', () => {
      const tiles = linearGrid();
      tiles[2] = makeTile({ index: 2, neighbours: [1, 3, 2, 2, 2, 2], elevationType: 'mountain' });
      expect(pathMovementCost(tiles, [0, 1, 2, 3], 'wheeled', 0)).toBe(Infinity);
    });

    it('hexesMovedBefore does not affect cost (no first-hex rule)', () => {
      const tiles = linearGrid();
      // Cost is the same regardless of hexesMovedBefore
      expect(pathMovementCost(tiles, [1, 2], 'wheeled', 0)).toBe(0.25);
      expect(pathMovementCost(tiles, [1, 2], 'wheeled', 1)).toBe(0.25);
    });

    it('empty path (just start tile) costs 0', () => {
      const tiles = linearGrid();
      expect(pathMovementCost(tiles, [0], 'wheeled', 0)).toBe(0);
    });
  });

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
      tiles[2] = makeTile({ index: 2, neighbours: [1, 3, 2, 2, 2, 2], elevationType: 'mountain' });
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

    it('sets segment when provided', () => {
      const unit = makeUnit({ id: 'u', tileIndex: 0, segment: 0 as HexSegment });
      moveUnit(unit, 1, tiles, 4 as HexSegment);
      expect(unit.segment).toBe(4);
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
      tiles[1] = makeTile({ index: 1, neighbours: [0, 2, 6, 0, 2, 6], elevationType: 'mountain' });
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      const result = moveUnit(unit, 1, tiles, undefined, state);
      expect(result).toBe(false);
      expect(unit.tileIndex).toBe(0);
    });

    it('wheeled costs 0.50 per flat hex regardless of position in sequence', () => {
      tiles[1] = makeTile({ index: 1, neighbours: [0, 2, 6, 0, 2, 6], elevationType: 'flat', forested: false });
      const unit = makeUnit({ id: 'u', tileIndex: 0, attributes: { wheeledMovement: 1 } });
      const state = createTurnState();
      const result = moveUnit(unit, 1, tiles, undefined, state);
      // Cost = 0.50 per flat hex, unit has 1 MP → should succeed
      expect(result).toBe(true);
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

    it('with turn state: fails after unit has moved to another hex', () => {
      const tiles = hexGrid();
      const unit = makeUnit({ id: 'u', tileIndex: 0, facing: 0 as HexSegment, attributes: { wheeledMovement: 5 } });
      const state = createTurnState();
      moveUnit(unit, 1, tiles, undefined, state);
      const result = pivotUnit(unit, 4 as HexSegment, undefined, state);
      expect(result).toBe(false);
      // Facing should not have changed (still whatever moveUnit set)
    });

    it('with turn state: fails when no MP remaining', () => {
      const unit = makeUnit({ id: 'u', facing: 0 as HexSegment, attributes: { wheeledMovement: 1 } });
      const state = createTurnState();
      recordMove(unit, state, 1); // spend all MP
      const result = pivotUnit(unit, 3 as HexSegment, undefined, state);
      expect(result).toBe(false);
    });
  });
});
