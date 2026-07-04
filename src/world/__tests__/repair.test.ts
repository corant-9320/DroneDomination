import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  roundHalfUp,
  calculateRepairAmount,
  applyRepair,
  validateRepair,
  resolveRepair,
} from '../repair.js';
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
    attributes: { size: 3, wheeledMovement: 1 },
    currentHealth: 20,
    ...overrides,
  };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// fast-check generators constrained to the documented input space (COMBAT_RULES §18).
const arbRp = fc.integer({ min: 1, max: 5 });
const arbMaxHealth = fc.integer({ min: 10, max: 50 });
// Includes out-of-range values to exercise the real clamps.
const arbRpUnclamped = fc.integer({ min: -3, max: 12 });
const arbMaxHealthUnclamped = fc.integer({ min: -20, max: 120 });
const arbCurrentHealth = fc.integer({ min: -20, max: 80 });

// Derived bounds from COMBAT_RULES §18: RepairRate = 2 + (maxHealth-10)/20 ∈ [2, 4]
// for maxHealth ∈ [10, 50]; RP ∈ [1, 5] ⇒ RepairAmount ∈ [2, 20].
const REPAIR_AMOUNT_MIN = 2;
const REPAIR_AMOUNT_MAX = 20;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repair', () => {
  // roundHalfUp — deterministic rounding utility (not a balance formula)
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

  // calculateRepairAmount — property assertions (balance formula)
  describe('calculateRepairAmount', () => {
    it('Feature: unit-test-coverage, Property 1: monotonic in repair points', () => {
      fc.assert(
        fc.property(arbMaxHealth, arbRp, arbRp, (maxHealth, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(calculateRepairAmount(lo, maxHealth)).toBeLessThanOrEqual(
            calculateRepairAmount(hi, maxHealth),
          );
        }),
        { numRuns: 200 },
      );
    });

    it('Feature: unit-test-coverage, Property 2: monotonic in maximum health', () => {
      fc.assert(
        fc.property(arbRp, arbMaxHealth, arbMaxHealth, (rp, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(calculateRepairAmount(rp, lo)).toBeLessThanOrEqual(
            calculateRepairAmount(rp, hi),
          );
        }),
        { numRuns: 200 },
      );
    });

    it('Feature: unit-test-coverage, Property 3: amount within [2, 20] incl. clamped inputs', () => {
      fc.assert(
        fc.property(arbRpUnclamped, arbMaxHealthUnclamped, (rp, maxHealth) => {
          const amount = calculateRepairAmount(rp, maxHealth);
          expect(amount).toBeGreaterThanOrEqual(REPAIR_AMOUNT_MIN);
          expect(amount).toBeLessThanOrEqual(REPAIR_AMOUNT_MAX);
        }),
        { numRuns: 200 },
      );
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

    // Exactly one labelled golden smoke test for this balance formula.
    it('GOLDEN SMOKE: rp=3 maxHealth=30 repairs 9 (breaks on balance change)', () => {
      // repairRate = 2 + (30-10)/20 = 3; amount = roundHalfUp(3 * 3) = 9
      expect(calculateRepairAmount(3, 30)).toBe(9);
    });
  });

  // applyRepair — property assertions + observable cap behaviour
  describe('applyRepair', () => {
    it('Feature: unit-test-coverage, Property 4: result ≤ maxHealth and ≥ clamp(currentHealth,0,maxHealth)', () => {
      fc.assert(
        fc.property(arbCurrentHealth, arbMaxHealth, arbRp, (currentHealth, maxHealth, rp) => {
          const result = applyRepair(currentHealth, maxHealth, rp);
          const floor = clampValue(currentHealth, 0, maxHealth);
          expect(result).toBeLessThanOrEqual(maxHealth);
          expect(result).toBeGreaterThanOrEqual(floor);
        }),
        { numRuns: 200 },
      );
    });

    it('caps health at maxHealth', () => {
      // Near full health: 28/30, repair would add 9 → capped at 30
      expect(applyRepair(28, 30, 3)).toBe(30);
    });

    it('clamps negative current health to 0 before applying', () => {
      // Negative health clamps to 0, then repair is applied from there.
      expect(applyRepair(-5, 30, 3)).toBe(applyRepair(0, 30, 3));
    });
  });

  // validateRepair — observable rejection reasons (retained)
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

  // resolveRepair — mutate / non-mutate / not-found (retained)
  describe('resolveRepair', () => {
    it('heals target and mutates its health', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 3, size: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', attributes: { size: 3, wheeledMovement: 1 }, currentHealth: 15 });
      const allUnits = [repairer, target];

      const result = resolveRepair('r', 't', allUnits);
      expect(result.wasValid).toBe(true);
      expect(result.targetHealthBefore).toBe(15);
      // Observable invariant: health rose, capped at max, and matches the mutation.
      expect(result.targetHealthAfter).toBeGreaterThan(result.targetHealthBefore);
      expect(result.targetHealthAfter).toBeLessThanOrEqual(30);
      expect(result.repairAmount).toBe(result.targetHealthAfter - result.targetHealthBefore);
      expect(target.currentHealth).toBe(result.targetHealthAfter);
    });

    it('caps healing at max health', () => {
      const repairer = makeUnit({ id: 'r', attributes: { repair: 5, size: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', attributes: { size: 3, wheeledMovement: 1 }, currentHealth: 28 });
      const allUnits = [repairer, target];

      const result = resolveRepair('r', 't', allUnits);
      expect(result.wasValid).toBe(true);
      expect(result.targetHealthAfter).toBe(30); // capped at size * HP_PER_POINT
      expect(result.repairAmount).toBe(30 - 28); // only healed up to the cap
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

    it('returns invalid result and does not mutate when validation fails (different tile)', () => {
      const repairer = makeUnit({ id: 'r', tileIndex: 0, attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', tileIndex: 5, currentHealth: 15 });
      const allUnits = [repairer, target];

      const result = resolveRepair('r', 't', allUnits);
      expect(result.wasValid).toBe(false);
      expect(target.currentHealth).toBe(15); // not mutated
    });

    it('does not mutate target health on invalid repair (enemy)', () => {
      const repairer = makeUnit({ id: 'r', ownerId: 'p1', attributes: { repair: 3, wheeledMovement: 1 }, currentHealth: 30 });
      const target = makeUnit({ id: 't', ownerId: 'p2', currentHealth: 15 });
      const allUnits = [repairer, target];

      resolveRepair('r', 't', allUnits);
      expect(target.currentHealth).toBe(15);
    });
  });
});
