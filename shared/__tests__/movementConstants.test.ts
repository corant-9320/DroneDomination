import { describe, it, expect } from 'vitest';
import {
  getMovementMode,
  getMaxMovement,
  isImpassableTerrain,
  hexEntryCost,
  type MovementMode,
  type MovementTile,
} from '../movementConstants.js';
import type { UnitAttributes } from '../unitTypes.js';

describe('movementConstants (shared)', () => {
  // =========================================================================
  // getMovementMode
  // =========================================================================

  describe('getMovementMode', () => {
    it('flight takes priority over all others', () => {
      const attrs: UnitAttributes = { flightMovement: 1, limbMovement: 5, wheeledMovement: 5 };
      expect(getMovementMode(attrs)).toBe('flight');
    });

    it('limb takes priority over wheeled', () => {
      const attrs: UnitAttributes = { limbMovement: 1, wheeledMovement: 5 };
      expect(getMovementMode(attrs)).toBe('limb');
    });

    it('returns wheeled by default', () => {
      const attrs: UnitAttributes = { wheeledMovement: 3 };
      expect(getMovementMode(attrs)).toBe('wheeled');
    });

    it('returns wheeled when no movement attributes at all', () => {
      const attrs: UnitAttributes = {};
      expect(getMovementMode(attrs)).toBe('wheeled');
    });

    it('zero-valued flight does not count', () => {
      const attrs: UnitAttributes = { flightMovement: 0, limbMovement: 2 };
      expect(getMovementMode(attrs)).toBe('limb');
    });
  });

  // =========================================================================
  // getMaxMovement
  // =========================================================================

  describe('getMaxMovement', () => {
    it('returns the highest movement value', () => {
      const attrs: UnitAttributes = { wheeledMovement: 2, limbMovement: 4, flightMovement: 1 };
      expect(getMaxMovement(attrs)).toBe(4);
    });

    it('returns at least 1 even when all movement is 0', () => {
      const attrs: UnitAttributes = { wheeledMovement: 0, limbMovement: 0, flightMovement: 0 };
      expect(getMaxMovement(attrs)).toBe(1);
    });

    it('returns at least 1 when no movement attributes present', () => {
      const attrs: UnitAttributes = {};
      expect(getMaxMovement(attrs)).toBe(1);
    });

    it('returns single movement value when only one is set', () => {
      const attrs: UnitAttributes = { flightMovement: 5 };
      expect(getMaxMovement(attrs)).toBe(5);
    });
  });

  // =========================================================================
  // isImpassableTerrain
  // =========================================================================

  describe('isImpassableTerrain', () => {
    it('mountain is impassable', () => {
      expect(isImpassableTerrain('mountain')).toBe(true);
    });

    it('ocean is impassable', () => {
      expect(isImpassableTerrain('ocean')).toBe(true);
    });

    it('plains is passable', () => {
      expect(isImpassableTerrain('plains')).toBe(false);
    });

    it('grassland is passable', () => {
      expect(isImpassableTerrain('grassland')).toBe(false);
    });

    it('desert is passable', () => {
      expect(isImpassableTerrain('desert')).toBe(false);
    });

    it('empty string is passable', () => {
      expect(isImpassableTerrain('')).toBe(false);
    });
  });

  // =========================================================================
  // hexEntryCost — tests using the compact/client wire format fields
  // =========================================================================

  describe('hexEntryCost', () => {
    describe('first hex rule', () => {
      it('always costs 1 for any terrain and any mode', () => {
        const tile: MovementTile = { elevType: 'hills', f: true };
        expect(hexEntryCost(tile, 'wheeled', true)).toBe(1);
        expect(hexEntryCost(tile, 'limb', true)).toBe(1);
        expect(hexEntryCost(tile, 'flight', true)).toBe(1);
      });

      it('even impassable terrain costs 1 on first hex for flight', () => {
        const tile: MovementTile = { terrain: 'ocean' };
        expect(hexEntryCost(tile, 'flight', true)).toBe(1);
      });
    });

    describe('flight mode', () => {
      it('costs 1 per hex regardless of terrain', () => {
        expect(hexEntryCost({ elevType: 'hills', f: true }, 'flight', false)).toBe(1);
        expect(hexEntryCost({ terrain: 'ocean' }, 'flight', false)).toBe(1);
        expect(hexEntryCost({ elevType: 'mountain' }, 'flight', false)).toBe(1);
      });
    });

    describe('limb mode', () => {
      it('costs 3 per hex regardless of terrain', () => {
        expect(hexEntryCost({ terrain: 'plains', elevType: 'flat' }, 'limb', false)).toBe(3);
        expect(hexEntryCost({ elevType: 'hills', f: true }, 'limb', false)).toBe(3);
      });

      it('mountain is impassable', () => {
        expect(hexEntryCost({ elevType: 'mountain' }, 'limb', false)).toBe(Infinity);
      });

      it('ocean is impassable', () => {
        expect(hexEntryCost({ terrain: 'ocean' }, 'limb', false)).toBe(Infinity);
      });
    });

    describe('wheeled mode', () => {
      it('flat clear costs 2', () => {
        expect(hexEntryCost({ terrain: 'plains', elevType: 'flat' }, 'wheeled', false)).toBe(2);
      });

      it('hills costs 3', () => {
        expect(hexEntryCost({ elevType: 'hills' }, 'wheeled', false)).toBe(3);
      });

      it('forested flat costs 3', () => {
        expect(hexEntryCost({ elevType: 'flat', f: true }, 'wheeled', false)).toBe(3);
      });

      it('forested hills costs 4', () => {
        expect(hexEntryCost({ elevType: 'hills', f: true }, 'wheeled', false)).toBe(4);
      });

      it('mountain is impassable', () => {
        expect(hexEntryCost({ elevType: 'mountain' }, 'wheeled', false)).toBe(Infinity);
      });

      it('ocean is impassable', () => {
        expect(hexEntryCost({ terrain: 'ocean' }, 'wheeled', false)).toBe(Infinity);
      });
    });

    describe('client wire format (terrain/elevType/f fields)', () => {
      it('uses terrain field when terrainType is absent', () => {
        expect(hexEntryCost({ terrain: 'ocean' }, 'wheeled', false)).toBe(Infinity);
      });

      it('uses elevType field when elevationType is absent', () => {
        expect(hexEntryCost({ elevType: 'mountain' }, 'limb', false)).toBe(Infinity);
      });

      it('uses f field when forested is absent', () => {
        expect(hexEntryCost({ elevType: 'flat', f: true }, 'wheeled', false)).toBe(3);
      });
    });

    describe('server format (terrainType/elevationType/forested fields)', () => {
      it('uses terrainType field', () => {
        expect(hexEntryCost({ terrainType: 'ocean' }, 'wheeled', false)).toBe(Infinity);
      });

      it('uses elevationType field', () => {
        expect(hexEntryCost({ elevationType: 'hills' }, 'wheeled', false)).toBe(3);
      });

      it('uses forested field', () => {
        expect(hexEntryCost({ elevationType: 'flat', forested: true }, 'wheeled', false)).toBe(3);
      });
    });
  });
});
