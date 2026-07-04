import { describe, it, expect } from 'vitest';
import {
  getMovementMode,
  isImpassable,
  hexEntryCost,
  pathMovementCost,
} from '../movement.js';
import { makeTile, linearGrid, makeUnit } from './movement.fixtures.js';

// Movement classification and per-hex/path cost rules. Reach calculations and
// the moveUnit/pivotUnit mutators live in `movement.reach.test.ts`.

describe('movement (mode & cost)', () => {
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

  describe('isImpassable', () => {
    it('returns false for high-height tiles (only steepness blocks high ground)', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 10 });
      expect(isImpassable(tile)).toBe(false);
    });

    it('returns true for ocean terrain', () => {
      const tile = makeTile({ index: 0, neighbours: [1], terrainType: 'ocean' });
      expect(isImpassable(tile)).toBe(true);
    });

    it('returns false for plains/rolling', () => {
      const tile = makeTile({ index: 0, neighbours: [1], terrainType: 'plains', height: 4 });
      expect(isImpassable(tile)).toBe(false);
    });

    it('returns false for hills-height terrain', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 7 });
      expect(isImpassable(tile)).toBe(false);
    });
  });

  // =========================================================================
  // Hex entry cost
  // =========================================================================

  describe('hexEntryCost', () => {
    it('flight always costs 0.25', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 7, forested: true });
      expect(hexEntryCost(tile, 'flight', true)).toBe(0.25);
      expect(hexEntryCost(tile, 'flight', false)).toBe(0.25);
    });

    it('flight mode costs 0.25 even on mountain and ocean', () => {
      const mountain = makeTile({ index: 0, neighbours: [1], height: 10 });
      const ocean = makeTile({ index: 0, neighbours: [1], terrainType: 'ocean' });
      expect(hexEntryCost(mountain, 'flight', false)).toBe(0.25);
      expect(hexEntryCost(ocean, 'flight', false)).toBe(0.25);
    });

    it('limb mode always costs 0.50 on passable terrain', () => {
      const flat = makeTile({ index: 0, neighbours: [1], height: 1 });
      const hills = makeTile({ index: 1, neighbours: [0], height: 7, forested: true });
      expect(hexEntryCost(flat, 'limb', false)).toBe(0.50);
      expect(hexEntryCost(hills, 'limb', false)).toBe(0.50);
    });

    it('wheeled on lowlands clear costs 0.25', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 1, forested: false });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(0.25);
    });

    it('wheeled on hills costs 0.75', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 7, forested: false });
      // Hills surcharge removed — tanks pay flat everywhere now (steepness is the gate)
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(0.25);
    });

    it('wheeled on forested terrain is forbidden', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 1, forested: true });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(Infinity);
    });

    it('mountain alone is passable for wheeled (steepness needs an origin tile)', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 10 });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(0.25);
    });

    it('ocean is impassable for wheeled', () => {
      const tile = makeTile({ index: 0, neighbours: [1], terrainType: 'ocean' });
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(Infinity);
    });

    it('mountain alone is passable for limb', () => {
      const tile = makeTile({ index: 0, neighbours: [1], height: 10 });
      expect(hexEntryCost(tile, 'limb', false)).toBe(0.50);
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
      // Ocean is impassable to ground units (mountain is NOT impassable since the
      // steepness gate replaced the old height-delta gate and we have no segSteep here)
      tiles[2] = makeTile({ index: 2, neighbours: [1, 3, 2, 2, 2, 2], terrainType: 'ocean' });
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
});
