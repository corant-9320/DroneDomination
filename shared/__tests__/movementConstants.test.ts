import { describe, it, expect } from 'vitest';
import {
  getMovementMode,
  getMaxMovement,
  isImpassableTerrain,
  segmentCost,
  segmentSteepness,
  hexEntryCost,
  COST_DRONE,
  COST_SPIDER,
  COST_TANK_FLAT,
  COST_TANK_HILLS,
  MAX_STEEP_WHEELED,
  MAX_STEEP_LIMB,
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
  // segmentSteepness helper
  // =========================================================================

  describe('segmentSteepness', () => {
    it('returns 0 when tile has no segSteep or ss', () => {
      expect(segmentSteepness({}, 0)).toBe(0);
    });

    it('returns the segSteep value at the given segment', () => {
      const tile: MovementTile = { segSteep: [0.1, 0.5, 0.3, 0.0, 0.8, 0.2] };
      expect(segmentSteepness(tile, 0)).toBe(0.1);
      expect(segmentSteepness(tile, 4)).toBe(0.8);
    });

    it('reads ss (wire format) when segSteep is absent', () => {
      const tile: MovementTile = { ss: [0.2, 0.4, 0.6, 0.1, 0.7, 0.3] };
      expect(segmentSteepness(tile, 2)).toBe(0.6);
    });

    it('returns 0 for out-of-bounds segment', () => {
      const tile: MovementTile = { segSteep: [0.1, 0.2] };
      expect(segmentSteepness(tile, 5)).toBe(0);
      expect(segmentSteepness(tile, -1)).toBe(0);
    });
  });

  // =========================================================================
  // segmentCost — new signature: (toTile, toSegment, mode)
  // =========================================================================

  describe('segmentCost', () => {
    // Property 6: drones ignore steepness entirely
    describe('Property 6 — drone (flight)', () => {
      it('costs COST_DRONE on any terrain', () => {
        expect(segmentCost({ terrain: 'plains', h: 1 }, 0, 'flight')).toBe(COST_DRONE);
        expect(segmentCost({ h: 7, f: true }, 0, 'flight')).toBe(COST_DRONE);
        expect(segmentCost({ h: 10 }, 0, 'flight')).toBe(COST_DRONE);
        expect(segmentCost({ terrain: 'ocean' }, 0, 'flight')).toBe(COST_DRONE);
      });

      it('ignores steep segments', () => {
        const tile: MovementTile = { terrain: 'plains', segSteep: [1.5, 1.5, 1.5, 1.5, 1.5, 1.5] };
        expect(segmentCost(tile, 0, 'flight')).toBe(COST_DRONE);
      });
    });

    // Property 7: chassis ordering — wheeled blocked ⇒ limb blocked too? No — limb > wheeled limit
    describe('Property 7 — chassis ordering', () => {
      it('if wheeled is allowed, limb is also allowed (MAX_STEEP_WHEELED < MAX_STEEP_LIMB)', () => {
        expect(MAX_STEEP_WHEELED).toBeLessThan(MAX_STEEP_LIMB);
        // A segment just under the wheeled limit → both pass
        const gentleTile: MovementTile = { terrain: 'plains', segSteep: [MAX_STEEP_WHEELED - 0.01] };
        expect(segmentCost(gentleTile, 0, 'wheeled')).not.toBe(Infinity);
        expect(segmentCost(gentleTile, 0, 'limb')).not.toBe(Infinity);
      });

      it('a segment between wheeled and limb limits blocks wheeled but not limb', () => {
        const midTile: MovementTile = {
          terrain: 'plains',
          segSteep: [MAX_STEEP_WHEELED + 0.01],
        };
        expect(segmentCost(midTile, 0, 'wheeled')).toBe(Infinity);
        expect(segmentCost(midTile, 0, 'limb')).not.toBe(Infinity);
      });

      it('a segment above both limits blocks both', () => {
        const steepTile: MovementTile = {
          terrain: 'plains',
          segSteep: [MAX_STEEP_LIMB + 0.01],
        };
        expect(segmentCost(steepTile, 0, 'wheeled')).toBe(Infinity);
        expect(segmentCost(steepTile, 0, 'limb')).toBe(Infinity);
      });
    });

    // Property 8: gate is destination-only
    describe('Property 8 — destination-only gate', () => {
      it('cost depends only on (toTile, toSegment, mode), not on origin', () => {
        const flatTile: MovementTile = { terrain: 'plains', segSteep: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1] };
        // Same result regardless of what the origin tile was
        const c1 = segmentCost(flatTile, 0, 'wheeled');
        const c2 = segmentCost(flatTile, 0, 'wheeled');
        expect(c1).toBe(c2);
        expect(c1).not.toBe(Infinity);
      });
    });

    // Property 9: ocean and forest gates preserved
    describe('Property 9 — ocean and forest gates preserved', () => {
      it('ocean is Infinity for ground modes', () => {
        expect(segmentCost({ terrain: 'ocean' }, 0, 'wheeled')).toBe(Infinity);
        expect(segmentCost({ terrain: 'ocean' }, 0, 'limb')).toBe(Infinity);
      });

      it('ocean is COST_DRONE for flight', () => {
        expect(segmentCost({ terrain: 'ocean' }, 0, 'flight')).toBe(COST_DRONE);
      });

      it('forest is Infinity for wheeled', () => {
        expect(segmentCost({ f: true, terrain: 'plains' }, 0, 'wheeled')).toBe(Infinity);
        expect(segmentCost({ forested: true, terrainType: 'plains' }, 0, 'wheeled')).toBe(Infinity);
      });

      it('forest is allowed for limb', () => {
        expect(segmentCost({ f: true, terrain: 'plains' }, 0, 'limb')).not.toBe(Infinity);
      });
    });

    // Property 12: intra-hex steep segment is blocked
    describe('Property 12 — intra-hex steep segments are blocked', () => {
      it('a steep intra-hex segment blocks wheeled', () => {
        const tile: MovementTile = {
          terrain: 'plains',
          segSteep: [MAX_STEEP_WHEELED + 0.1, 0, 0, 0, 0, 0],
        };
        expect(segmentCost(tile, 0, 'wheeled')).toBe(Infinity);
      });
    });

    // Bridge overrides steepness gate
    describe('bridge bypasses steepness gate', () => {
      it('a bridged tile ignores steepness for ground units', () => {
        const tile: MovementTile = {
          terrain: 'ocean',
          bridge: true,
          segSteep: [MAX_STEEP_LIMB + 0.5, MAX_STEEP_LIMB + 0.5, MAX_STEEP_LIMB + 0.5,
                     MAX_STEEP_LIMB + 0.5, MAX_STEEP_LIMB + 0.5, MAX_STEEP_LIMB + 0.5],
        };
        expect(segmentCost(tile, 0, 'wheeled')).toBe(COST_TANK_FLAT);
        expect(segmentCost(tile, 0, 'limb')).toBe(COST_SPIDER);
      });
    });

    // Flat cost — hills surcharge removed
    describe('flat cost model (hills surcharge removed)', () => {
      it('tanks pay COST_TANK_FLAT everywhere passable, regardless of height', () => {
        expect(segmentCost({ h: 7 }, 0, 'wheeled')).toBe(COST_TANK_FLAT);
        expect(segmentCost({ h: 10 }, 0, 'wheeled')).toBe(COST_TANK_FLAT);
        expect(segmentCost({ h: 1 }, 0, 'wheeled')).toBe(COST_TANK_FLAT);
      });
    });

    // Reads both wire format and server format
    describe('wire format fields', () => {
      it('uses terrain field', () => {
        expect(segmentCost({ terrain: 'ocean' }, 0, 'wheeled')).toBe(Infinity);
      });

      it('uses terrainType field', () => {
        expect(segmentCost({ terrainType: 'ocean' }, 0, 'wheeled')).toBe(Infinity);
      });

      it('uses ss wire field for steepness', () => {
        const tile: MovementTile = { terrain: 'plains', ss: [MAX_STEEP_WHEELED + 0.1, 0, 0, 0, 0, 0] };
        expect(segmentCost(tile, 0, 'wheeled')).toBe(Infinity);
        expect(segmentCost(tile, 1, 'wheeled')).toBe(COST_TANK_FLAT);
      });

      it('missing segSteep/ss falls back to flat (0), never blocks', () => {
        const tile: MovementTile = { terrain: 'plains' };
        expect(segmentCost(tile, 0, 'wheeled')).toBe(COST_TANK_FLAT);
        expect(segmentCost(tile, 0, 'limb')).toBe(COST_SPIDER);
      });
    });
  });

  // =========================================================================
  // hexEntryCost (deprecated — forwards to segmentCost with segment 0)
  // =========================================================================

  describe('hexEntryCost (legacy)', () => {
    it('forwards to segmentCost with segment 0 regardless of isFirstHex', () => {
      const tile: MovementTile = { terrain: 'plains', h: 1 };
      expect(hexEntryCost(tile, 'wheeled', true)).toBe(segmentCost(tile, 0, 'wheeled'));
      expect(hexEntryCost(tile, 'wheeled', false)).toBe(segmentCost(tile, 0, 'wheeled'));
      expect(hexEntryCost(tile, 'flight', true)).toBe(segmentCost(tile, 0, 'flight'));
    });
  });
});
