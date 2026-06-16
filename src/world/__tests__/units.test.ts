import { describe, it, expect } from 'vitest';
import {
  isValidAttribute,
  validateAttributes,
  getMovement,
  canPlaceUnit,
  firstFreeSegment,
  ATTRIBUTE_RANGES,
  MOVEMENT_ATTRIBUTES,
  MAX_UNITS_PER_TILE,
  type UnitAttributes,
  type Unit,
  type HexSegment,
} from '../units.js';

describe('units', () => {
  describe('isValidAttribute', () => {
    it('accepts values within range', () => {
      expect(isValidAttribute('maxHealth', 1)).toBe(true);
      expect(isValidAttribute('maxHealth', 5)).toBe(true);
      expect(isValidAttribute('armour', 0)).toBe(true);
      expect(isValidAttribute('armour', 5)).toBe(true);
    });

    it('rejects values below minimum', () => {
      expect(isValidAttribute('maxHealth', 0)).toBe(false);
    });

    it('rejects values above maximum', () => {
      expect(isValidAttribute('armour', 6)).toBe(false);
    });

    it('rejects non-integer values', () => {
      expect(isValidAttribute('splashAttack', 2.5)).toBe(false);
    });

    it('rejects negative values', () => {
      expect(isValidAttribute('repair', -1)).toBe(false);
    });
  });

  describe('validateAttributes', () => {
    it('passes for valid unit with movement', () => {
      const attrs: UnitAttributes = {
        maxHealth: 3,
        limbMovement: 2,
        splashAttack: 1,
      };
      expect(validateAttributes(attrs)).toEqual([]);
    });

    it('fails when no movement attribute is present', () => {
      const attrs: UnitAttributes = {
        maxHealth: 3,
        splashAttack: 2,
      };
      const errors = validateAttributes(attrs);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('movement');
    });

    it('fails when all movement values are zero', () => {
      const attrs: UnitAttributes = {
        maxHealth: 2,
        wheeledMovement: 0,
        limbMovement: 0,
        flightMovement: 0,
      };
      const errors = validateAttributes(attrs);
      expect(errors.some((e) => e.includes('movement'))).toBe(true);
    });

    it('reports out-of-range attribute values', () => {
      const attrs: UnitAttributes = {
        maxHealth: 10,
        limbMovement: 1,
      };
      const errors = validateAttributes(attrs);
      expect(errors.some((e) => e.includes('maxHealth'))).toBe(true);
    });

    it('reports multiple errors', () => {
      const attrs: UnitAttributes = {
        maxHealth: 0,
        armour: 7,
        // no movement
      };
      const errors = validateAttributes(attrs);
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });

    it('passes with only flightMovement', () => {
      const attrs: UnitAttributes = { flightMovement: 3 };
      expect(validateAttributes(attrs)).toEqual([]);
    });

    it('passes with only wheeledMovement', () => {
      const attrs: UnitAttributes = { wheeledMovement: 1 };
      expect(validateAttributes(attrs)).toEqual([]);
    });
  });

  describe('getMovement', () => {
    it('returns the highest movement value', () => {
      const unit = {
        attributes: { wheeledMovement: 2, limbMovement: 4, flightMovement: 1 },
      } as Unit;
      expect(getMovement(unit)).toBe(4);
    });

    it('returns 0 when no movement attributes defined', () => {
      const unit = { attributes: {} } as Unit;
      expect(getMovement(unit)).toBe(0);
    });

    it('handles single movement type', () => {
      const unit = { attributes: { flightMovement: 5 } } as Unit;
      expect(getMovement(unit)).toBe(5);
    });
  });

  describe('canPlaceUnit', () => {
    it('allows placement when tile has room', () => {
      expect(canPlaceUnit([0, 1, 2])).toBe(true);
    });

    it('allows placement on empty tile', () => {
      expect(canPlaceUnit([])).toBe(true);
    });

    it('denies placement when tile is full (5 units)', () => {
      expect(canPlaceUnit([0, 1, 2, 3, 4])).toBe(false);
    });

    it('denies placement when all 6 segments occupied', () => {
      expect(canPlaceUnit([0, 1, 2, 3, 4, 5])).toBe(false);
    });

    it('allows placement with 4 occupied segments', () => {
      expect(canPlaceUnit([0, 1, 2, 3])).toBe(true);
    });
  });

  describe('firstFreeSegment', () => {
    it('returns 0 on empty tile', () => {
      expect(firstFreeSegment([])).toBe(0);
    });

    it('skips occupied segments', () => {
      expect(firstFreeSegment([0, 1, 2])).toBe(3);
    });

    it('finds gaps in occupied list', () => {
      expect(firstFreeSegment([0, 2, 4])).toBe(1);
    });

    it('returns undefined when full', () => {
      expect(firstFreeSegment([0, 1, 2, 3, 4, 5])).toBeUndefined();
    });
  });

  describe('constants', () => {
    it('MAX_UNITS_PER_TILE is 5', () => {
      expect(MAX_UNITS_PER_TILE).toBe(5);
    });

    it('MOVEMENT_ATTRIBUTES has 3 entries', () => {
      expect(MOVEMENT_ATTRIBUTES).toHaveLength(3);
    });

    it('ATTRIBUTE_RANGES covers all keys', () => {
      const keys = Object.keys(ATTRIBUTE_RANGES);
      expect(keys).toContain('maxHealth');
      expect(keys).toContain('armour');
      expect(keys).toContain('defence');
      expect(keys).toContain('splashAttack');
      expect(keys).toContain('wheeledMovement');
      expect(keys).toContain('limbMovement');
      expect(keys).toContain('flightMovement');
      expect(keys).toContain('repair');
    });

    it('ATTRIBUTE_RANGES has 12 total attribute keys', () => {
      expect(Object.keys(ATTRIBUTE_RANGES)).toHaveLength(12);
    });
  });

  describe('defence attribute', () => {
    it('ATTRIBUTE_RANGES includes defence with range [0, 5]', () => {
      expect(ATTRIBUTE_RANGES).toHaveProperty('defence');
      expect(ATTRIBUTE_RANGES.defence).toEqual([0, 5]);
    });

    it('isValidAttribute accepts defence = 0', () => {
      expect(isValidAttribute('defence', 0)).toBe(true);
    });

    it('isValidAttribute accepts defence = 5', () => {
      expect(isValidAttribute('defence', 5)).toBe(true);
    });

    it('isValidAttribute rejects defence = -1', () => {
      expect(isValidAttribute('defence', -1)).toBe(false);
    });

    it('isValidAttribute rejects defence = 6', () => {
      expect(isValidAttribute('defence', 6)).toBe(false);
    });

    it('isValidAttribute rejects non-integer defence', () => {
      expect(isValidAttribute('defence', 2.5)).toBe(false);
    });

    it('validateAttributes passes with defence in valid range', () => {
      const attrs: UnitAttributes = {
        maxHealth: 2,
        wheeledMovement: 1,
        defence: 3,
      };
      expect(validateAttributes(attrs)).toEqual([]);
    });

    it('validateAttributes reports defence out of range', () => {
      const attrs: UnitAttributes = {
        maxHealth: 2,
        wheeledMovement: 1,
        defence: 7,
      };
      const errors = validateAttributes(attrs);
      expect(errors.some((e) => e.includes('defence'))).toBe(true);
    });
  });

  describe('splashAttack attribute', () => {
    it('ATTRIBUTE_RANGES includes splashAttack with range [0, 5]', () => {
      expect(ATTRIBUTE_RANGES).toHaveProperty('splashAttack');
      expect(ATTRIBUTE_RANGES.splashAttack).toEqual([0, 5]);
    });

    it('isValidAttribute accepts splashAttack = 0', () => {
      expect(isValidAttribute('splashAttack', 0)).toBe(true);
    });

    it('isValidAttribute accepts splashAttack = 5', () => {
      expect(isValidAttribute('splashAttack', 5)).toBe(true);
    });

    it('isValidAttribute rejects splashAttack = 6', () => {
      expect(isValidAttribute('splashAttack', 6)).toBe(false);
    });

    it('isValidAttribute rejects non-integer splashAttack', () => {
      expect(isValidAttribute('splashAttack', 1.5)).toBe(false);
    });

    it('validateAttributes passes with splashAttack in valid range', () => {
      const attrs: UnitAttributes = {
        maxHealth: 1,
        limbMovement: 2,
        splashAttack: 4,
      };
      expect(validateAttributes(attrs)).toEqual([]);
    });

    it('validateAttributes reports splashAttack out of range', () => {
      const attrs: UnitAttributes = {
        maxHealth: 1,
        limbMovement: 1,
        splashAttack: 10,
      };
      const errors = validateAttributes(attrs);
      expect(errors.some((e) => e.includes('splashAttack'))).toBe(true);
    });
  });
});
