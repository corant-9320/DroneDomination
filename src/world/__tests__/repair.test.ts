import { describe, it, expect } from 'vitest';
import {
  roundHalfUp,
  calculateRepairAmount,
  applyRepair,
  validateRepair,
  resolveRepair,
} from '../repair.js';
import { Unit, HexSegment, HP_PER_POINT } from '../units.js';

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
    attributes: { size: 3, wheeledMovement: 1 },
    currentHealth: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repair', () => {
  // =========================================================================
  // roundHalfUp
  // =========================================================================

  describe('roundHalfUp', () => {
    it('rounds 2.5 up to 3', () => {
      expect(roundHalfUp(2.5)).toBe(3);
    });

    it('rounds 2.4 down to 2', () => {
      expect(roundHalfUp(2.4)).toBe(2);
    });

    it('rounds 0.5 up to 1', () => {
      expect(roundHalfUp(0.5)).toBe(1);
    });

    it('integer values are unchanged', () => {
      expect(roundHalfUp(7)).toBe(7);
    });

    it('rounds negative values toward zero', () => {
      expect(roundHalfUp(-0.4)).toBe(0);
    });
  });

  // =========================================================================
  // calculateRepairAmount
  // =========================================================================

  describe('calculateRepairAmount', () => {
    it('RP=1, maxHealth=10 → repair rate = 2, amount = 2', () => {
      // repairRate = 2 + (10-10)/20 = 2
      // amount = roundHalfUp(1 * 2) = 2
      expect(calculateRepairAmount(1, 10)).toBe(2);
    });

    it('RP=5, maxHealth=50 → repair rate = 4, amount = 20', () => {
      // repairRate = 2 + (50-10)/20 = 2 + 2 = 4
      // amount = roundHalfUp(5 * 4) = 20
      expect(calculateRepairAmount(5, 50)).toBe(20);
    });

    it('RP=3, maxHealth=30 → repair rate = 3, amount = 9', () => {
      // repairRate = 2 + (30-10)/20 = 2 + 1 = 3
      // amount = roundHalfUp(3 * 3) = 9
      expect(calculateRepairAmount(3, 30)).toBe(9);
    });

    it('RP=2, maxHealth=20 → repair rate = 2.5, amount = 5', () => {
      // repairRate = 2 + (20-10)/20 = 2 + 0.5 = 2.5
      // amount = roundHalfUp(2 * 2.5) = roundHalfUp(5) = 5
      expect(calculateRepairAmount(2, 20)).toBe(5);
    });

    it('clamps rp below 1 to 1', () => {
      expect(calculateRepairAmount(0, 30)).toBe(calculateRepairAmount(1, 30));
    });

    it('clamps rp above 5 to 5', () => {
      expect(calculateRepairAmount(10, 30)).toBe(calculateRepairAmount(5, 30));
    });

    it('clamps maxHealth below 10 to 10', () => {
      expect(calculateRepairAmount(3, 5)).toBe(calculateRepairAmount(3, 10));
    });

    it('clamps maxHealth above 50 to 50', () => {
      expect(calculateRepairAmount(3, 100)).toBe(calculateRepairAmount(3, 50));
    });
  });

  // =========================================================================
  // applyRepair
  // =========================================================================

  describe('applyRepair', () => {
    it('increases health by repair amount', () => {
      const result = applyRepair(20, 30, 3);
      // repairAmount for rp=3, maxHealth=30 → 9
      expect(result).toBe(29);
    });

    it('caps health at maxHealth', () => {
      // Near full health: 28/30, repair would add 9
      const result = applyRepair(28, 30, 3);
      expect(result).toBe(30);
    });

    it('works at minimum values (currentHealth=1, maxHealth=10, rp=1)', () => {
      const result = applyRepair(1, 10, 1);
      // repairAmount = 2
      expect(result).toBe(3);
    });

    it('clamps currentHealth to valid range before applying', () => {
      // Negative health gets clamped to 0
      const result = applyRepair(-5, 30, 3);
      // 0 + 9 = 9
      expect(result).toBe(9);
    });
  });

  // =========================================================================
  // validateRepair
  // =========================================================================

  describe('validateRepair', () => {
    it('passes for valid same-hex same-faction repair', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', attributes: { size: 3, wheeledMovement: 1 }, currentHealth: 15 });
      expect(validateRepair(repairer, target)).toEqual({ valid: true });
    });

    it('rejects self-repair', () => {
      const unit = makeUnit({ id: 'r', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 15 });
      const result = validateRepair(unit, unit);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self');
    });

    it('rejects when repairer has no repair attribute', () => {
      const repairer = makeUnit({ id: 'r', attributes: { wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', currentHealth: 15 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('repair');
    });

    it('rejects when repairer has repair=0', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 0, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', currentHealth: 15 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
    });

    it('rejects when repairer is destroyed', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 0 });
      const target = makeUnit({ id: 't', currentHealth: 15 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('destroyed');
    });

    it('rejects when target is destroyed', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', currentHealth: 0 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('destroyed');
    });

    it('rejects when repairer and target are different factions', () => {
      const repairer = makeUnit({ id: 'r', ownerId: 'p1', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', ownerId: 'p2', currentHealth: 15 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('enemy');
    });

    it('rejects when repairer and target are on different tiles', () => {
      const repairer = makeUnit({ id: 'r', tileIndex: 0, attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', tileIndex: 5, currentHealth: 15 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('same hex');
    });

    it('rejects when target is already at full health', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', attributes: { size: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const result = validateRepair(repairer, target);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('full health');
    });
  });

  // =========================================================================
  // resolveRepair
  // =========================================================================

  describe('resolveRepair', () => {
    it('heals target and returns correct result', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, size: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', attributes: { size: 3, wheeledMovement: 1 }, currentHealth: 15 });
      const allUnits = [repairer, target];

      const result = resolveRepair('r', 't', allUnits);
      expect(result.wasValid).toBe(true);
      expect(result.repairAmount).toBe(9); // rp=3, maxHP=30
      expect(result.targetHealthBefore).toBe(15);
      expect(result.targetHealthAfter).toBe(24);
      // Verify mutation
      expect(target.currentHealth).toBe(24);
    });

    it('caps healing at max health', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 5, size: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', attributes: { size: 3, wheeledMovement: 1 }, currentHealth: 28 });
      const allUnits = [repairer, target];

      const result = resolveRepair('r', 't', allUnits);
      expect(result.wasValid).toBe(true);
      expect(result.targetHealthAfter).toBe(30); // capped at maxHealth*10
      expect(result.repairAmount).toBe(2); // only healed 2 to reach cap
    });

    it('returns invalid result when repairer not found', () => {
      const target = makeUnit({ id: 't', currentHealth: 15 });
      const result = resolveRepair('nonexistent', 't', [target]);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('not found');
    });

    it('returns invalid result when target not found', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const result = resolveRepair('r', 'nonexistent', [repairer]);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('not found');
    });

    it('returns invalid result when validation fails', () => {
      const repairer = makeUnit({ id: 'r', tileIndex: 0, attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', tileIndex: 5, currentHealth: 15 }); // different tile
      const allUnits = [repairer, target];

      const result = resolveRepair('r', 't', allUnits);
      expect(result.wasValid).toBe(false);
      expect(target.currentHealth).toBe(15); // not mutated
    });

    it('does not mutate target health on invalid repair', () => {
      const repairer = makeUnit({ id: 'r', ownerId: 'p1', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', ownerId: 'p2', currentHealth: 15 }); // enemy
      const allUnits = [repairer, target];

      resolveRepair('r', 't', allUnits);
      expect(target.currentHealth).toBe(15);
    });
  });
});
