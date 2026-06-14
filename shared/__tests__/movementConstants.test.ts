import { describe, it, expect } from 'vitest';
import {
  getMovementMode,
  getMaxMovement,
  isImpassableTerrain,
  segmentCost,
  hexEntryCost,
  COST_DRONE,
  COST_SPIDER,
  COST_TANK_FLAT,
  COST_TANK_HILLS,
  MAX_CLIMB_WHEELED,
  MAX_CLIMB_LIMB,
  HEIGHT_LEVELS,
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
  // segmentCost — the unified per-step cost function
  // =========================================================================

  describe('segmentCost', () => {
    describe('drone (flight)', () => {
      it('costs 0.25 on any terrain', () => {
        expect(segmentCost({ terrain: 'plains', elevType: 'flat' }, 'flight')).toBe(COST_DRONE);
        expect(segmentCost({ elevType: 'hills', f: true }, 'flight')).toBe(COST_DRONE);
        expect(segmentCost({ elevType: 'mountain' }, 'flight')).toBe(COST_DRONE);
        expect(segmentCost({ terrain: 'ocean' }, 'flight')).toBe(COST_DRONE);
      });

      it('equals 0.25', () => {
        expect(COST_DRONE).toBe(0.25);
      });
    });

    describe('spider (limb)', () => {
      it('costs 0.50 on any passable terrain', () => {
        expect(segmentCost({ terrain: 'plains', elevType: 'flat' }, 'limb')).toBe(COST_SPIDER);
        expect(segmentCost({ elevType: 'hills', f: true }, 'limb')).toBe(COST_SPIDER);
        expect(segmentCost({ elevType: 'hills' }, 'limb')).toBe(COST_SPIDER);
      });

      it('equals 0.50', () => {
        expect(COST_SPIDER).toBe(0.50);
      });

      it('mountain alone is passable (only steepness or ocean blocks)', () => {
        expect(segmentCost({ elevType: 'mountain' }, 'limb')).toBe(COST_SPIDER);
      });

      it('ocean is forbidden', () => {
        expect(segmentCost({ terrain: 'ocean' }, 'limb')).toBe(Infinity);
      });
    });

    describe('tank (wheeled)', () => {
      it('costs 0.50 on flat clear terrain', () => {
        expect(segmentCost({ terrain: 'plains', elevType: 'flat' }, 'wheeled')).toBe(COST_TANK_FLAT);
      });

      it('flat clear cost equals 0.25', () => {
        expect(COST_TANK_FLAT).toBe(0.25);
      });

      it('costs 0.75 on hills', () => {
        expect(segmentCost({ elevType: 'hills' }, 'wheeled')).toBe(COST_TANK_HILLS);
      });

      it('hills cost equals 0.75', () => {
        expect(COST_TANK_HILLS).toBe(0.75);
      });

      it('forest is forbidden', () => {
        expect(segmentCost({ elevType: 'flat', f: true }, 'wheeled')).toBe(Infinity);
      });

      it('forested hills is also forbidden', () => {
        expect(segmentCost({ elevType: 'hills', f: true }, 'wheeled')).toBe(Infinity);
      });

      it('mountain alone is passable (only steepness, forest, or ocean blocks)', () => {
        expect(segmentCost({ elevType: 'mountain' }, 'wheeled')).toBe(COST_TANK_FLAT);
      });

      it('ocean is forbidden', () => {
        expect(segmentCost({ terrain: 'ocean' }, 'wheeled')).toBe(Infinity);
      });
    });

    describe('client wire format (terrain/elevType/f fields)', () => {
      it('uses terrain field when terrainType is absent', () => {
        expect(segmentCost({ terrain: 'ocean' }, 'wheeled')).toBe(Infinity);
      });

      it('uses elevType field when elevationType is absent', () => {
        expect(segmentCost({ elevType: 'hills' }, 'wheeled')).toBe(COST_TANK_HILLS);
      });

      it('uses f field when forested is absent', () => {
        expect(segmentCost({ elevType: 'flat', f: true }, 'wheeled')).toBe(Infinity);
      });
    });

    describe('server format (terrainType/elevationType/forested fields)', () => {
      it('uses terrainType field', () => {
        expect(segmentCost({ terrainType: 'ocean' }, 'wheeled')).toBe(Infinity);
      });

      it('uses elevationType field', () => {
        expect(segmentCost({ elevationType: 'hills' }, 'wheeled')).toBe(COST_TANK_HILLS);
      });

      it('uses forested field', () => {
        expect(segmentCost({ elevationType: 'flat', forested: true }, 'wheeled')).toBe(Infinity);
      });
    });

    describe('steepness gate', () => {
      it('blocks a wheeled step taller than the wheeled climb limit', () => {
        const from: MovementTile = { terrain: 'plains', elevType: 'flat', height: 0 };
        const to: MovementTile = { terrain: 'plains', elevType: 'flat', height: MAX_CLIMB_WHEELED + 1 };
        expect(segmentCost(to, 'wheeled', from)).toBe(Infinity);
      });

      it('allows a wheeled step at exactly the climb limit', () => {
        const from: MovementTile = { terrain: 'plains', elevType: 'flat', height: 0 };
        const to: MovementTile = { terrain: 'plains', elevType: 'flat', height: MAX_CLIMB_WHEELED };
        expect(segmentCost(to, 'wheeled', from)).toBe(COST_TANK_FLAT);
      });

      it('a spider climbs a step that blocks a tank', () => {
        const from: MovementTile = { terrain: 'plains', elevType: 'flat', height: 0 };
        const to: MovementTile = { terrain: 'plains', elevType: 'flat', height: MAX_CLIMB_WHEELED + 2 };
        expect(segmentCost(to, 'wheeled', from)).toBe(Infinity);
        expect(segmentCost(to, 'limb', from)).toBe(COST_SPIDER);
      });

      it('blocks a spider step taller than the limb climb limit', () => {
        const from: MovementTile = { terrain: 'plains', elevType: 'flat', height: 0 };
        const to: MovementTile = { terrain: 'plains', elevType: 'flat', height: MAX_CLIMB_LIMB + 1 };
        expect(segmentCost(to, 'limb', from)).toBe(Infinity);
      });

      it('flight ignores steepness entirely', () => {
        const from: MovementTile = { height: 0 };
        const to: MovementTile = { height: HEIGHT_LEVELS - 1 };
        expect(segmentCost(to, 'flight', from)).toBe(COST_DRONE);
      });

      it('descending is gated the same as climbing (absolute delta)', () => {
        const high: MovementTile = { terrain: 'plains', elevType: 'flat', height: MAX_CLIMB_WHEELED + 1 };
        const low: MovementTile = { terrain: 'plains', elevType: 'flat', height: 0 };
        expect(segmentCost(low, 'wheeled', high)).toBe(Infinity);
      });

      it('uses the h wire field for steepness', () => {
        expect(segmentCost({ h: HEIGHT_LEVELS - 1 }, 'wheeled', { h: 0 })).toBe(Infinity);
      });

      it('omitting fromTile skips the steepness gate (intra-hex)', () => {
        expect(segmentCost({ terrain: 'plains', elevType: 'flat', height: 11 }, 'wheeled')).toBe(COST_TANK_FLAT);
      });
    });
  });

  // =========================================================================
  // hexEntryCost (deprecated — forwards to segmentCost)
  // =========================================================================

  describe('hexEntryCost (legacy)', () => {
    it('forwards to segmentCost regardless of isFirstHex', () => {
      const tile: MovementTile = { terrain: 'plains', elevType: 'flat' };
      expect(hexEntryCost(tile, 'wheeled', true)).toBe(segmentCost(tile, 'wheeled'));
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(segmentCost(tile, 'wheeled'));
      expect(hexEntryCost(tile, 'flight', true)).toBe(segmentCost(tile, 'flight'));
    });
  });
});
