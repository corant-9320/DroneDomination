import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  calculateFormulaDamage,
  calculateRangeEfficiency,
  applyDamage,
  droneIncomingDamageModifier,
  clamp,
  MIN_DAMAGE,
  MAX_DAMAGE,
  DEFENCE_SCALE,
  DAMAGE_PER_ATTACK_POWER,
  SPLASH_SCALE,
  RANGE_FALLOFF_PER_SEGMENT_UNIT,
  DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER,
  DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER,
  DRONE_ANTI_AIR_DAMAGE_MULTIPLIER,
} from '../combatFormula.js';

// ---------------------------------------------------------------------------
// Constants derived from COMBAT_RULES.md (§3, §6, §7, §9, §21).
// These mirror the authoritative document; asserting the module matches them
// keeps the formula module honest against the spec.
// ---------------------------------------------------------------------------
const RULES = {
  MIN_DAMAGE: 1, // §6, §21
  MAX_DAMAGE: 50, // §6, §21
  DEFENCE_SCALE: 0.75, // §5, §21
  DAMAGE_PER_ATTACK_POWER: 6, // §6, §21
  SPLASH_SCALE: 0.3, // §9, §21
  RANGE_FALLOFF_PER_HEX: 0.1, // §3, §21
  DRONE_DIRECT: 0.33, // §7, §21
  DRONE_SPLASH: 0.5, // §7, §21
  DRONE_ANTI_AIR: 1.0, // §7, §21
} as const;

const HEALTH_MIN = 0;
const HEALTH_MAX = 50; // §10: Max HP = size×10, size ∈ [1,5]

// ---------------------------------------------------------------------------
// fast-check generators over the formula input space
// ---------------------------------------------------------------------------
const arbAttackPower = fc.double({ min: 0.01, max: 10, noNaN: true });
const arbEffectiveDefence = fc.double({ min: 0, max: 10, noNaN: true });
const arbDistance = fc.double({ min: 1, max: 6, noNaN: true });
const arbNonNegDelta = fc.double({ min: 0, max: 10, noNaN: true });
const arbDamage = fc.integer({ min: MIN_DAMAGE, max: MAX_DAMAGE });
const arbHealth = fc.double({ min: -10, max: 60, noNaN: true });
const arbAnyDamage = fc.double({ min: -5, max: 100, noNaN: true });
const arbWeaponMode = fc.constantFrom('direct', 'splash', 'antiAir') as fc.Arbitrary<
  'direct' | 'splash' | 'antiAir'
>;
const arbDroneFlag = fc.boolean();

describe('combatFormula — constants match COMBAT_RULES.md', () => {
  it('module constants equal the authoritative §3/§6/§7/§9/§21 values', () => {
    expect(MIN_DAMAGE).toBe(RULES.MIN_DAMAGE);
    expect(MAX_DAMAGE).toBe(RULES.MAX_DAMAGE);
    expect(DEFENCE_SCALE).toBe(RULES.DEFENCE_SCALE);
    expect(DAMAGE_PER_ATTACK_POWER).toBe(RULES.DAMAGE_PER_ATTACK_POWER);
    expect(SPLASH_SCALE).toBe(RULES.SPLASH_SCALE);
    expect(RANGE_FALLOFF_PER_SEGMENT_UNIT).toBe(RULES.RANGE_FALLOFF_PER_HEX);
    expect(DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER).toBe(RULES.DRONE_DIRECT);
    expect(DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER).toBe(RULES.DRONE_SPLASH);
    expect(DRONE_ANTI_AIR_DAMAGE_MULTIPLIER).toBe(RULES.DRONE_ANTI_AIR);
  });
});

describe('combatFormula — damage curve', () => {
  // Feature: unit-test-coverage, Property 5: Formula damage stays within
  // [MIN_DAMAGE, MAX_DAMAGE] = [1, 50].
  it('Property 5: damage is always within [MIN_DAMAGE, MAX_DAMAGE]', () => {
    fc.assert(
      fc.property(arbAttackPower, arbEffectiveDefence, (ap, ed) => {
        const dmg = calculateFormulaDamage(ap, ed);
        expect(dmg).toBeGreaterThanOrEqual(MIN_DAMAGE);
        expect(dmg).toBeLessThanOrEqual(MAX_DAMAGE);
        expect(Number.isInteger(dmg)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, Property 6: Damage non-decreasing in attack
  // power, non-increasing in effective defence.
  it('Property 6: damage is non-decreasing in attack power (fixed defence)', () => {
    fc.assert(
      fc.property(arbAttackPower, arbNonNegDelta, arbEffectiveDefence, (ap, delta, ed) => {
        const lower = calculateFormulaDamage(ap, ed);
        const higher = calculateFormulaDamage(ap + delta, ed);
        expect(higher).toBeGreaterThanOrEqual(lower);
      }),
      { numRuns: 200 },
    );
  });

  it('Property 6: damage is non-increasing in effective defence (fixed attack power)', () => {
    fc.assert(
      fc.property(arbAttackPower, arbEffectiveDefence, arbNonNegDelta, (ap, ed, delta) => {
        const lessDefended = calculateFormulaDamage(ap, ed);
        const moreDefended = calculateFormulaDamage(ap, ed + delta);
        expect(moreDefended).toBeLessThanOrEqual(lessDefended);
      }),
      { numRuns: 200 },
    );
  });

  // GOLDEN SMOKE — pins one representative defended-attack damage value.
  // ap=3, ed=3 → maxFormulaDamage=min(50,18)=18, ratio=9/18=0.5,
  // raw=1+17×0.5=9.5 → round=10. EXPECTED TO BREAK on intentional balance
  // changes to the damage formula or its constants.
  it('GOLDEN SMOKE: calculateFormulaDamage(3, 3) === 10 (breaks on balance change)', () => {
    expect(calculateFormulaDamage(3, 3)).toBe(10);
  });
});

describe('combatFormula — drone incoming modifiers', () => {
  // Feature: unit-test-coverage, Property 7: Drone incoming modifiers order
  // damage Direct ≤ Splash ≤ Anti-Air, each ≤ non-drone, never below MIN_DAMAGE.
  it('Property 7: drone modifiers order Direct ≤ Splash ≤ Anti-Air ≤ non-drone, ≥ MIN_DAMAGE', () => {
    fc.assert(
      fc.property(arbDamage, (preDamage) => {
        const direct = droneIncomingDamageModifier('direct', true, preDamage);
        const splash = droneIncomingDamageModifier('splash', true, preDamage);
        const antiAir = droneIncomingDamageModifier('antiAir', true, preDamage);
        const nonDrone = droneIncomingDamageModifier('direct', false, preDamage);

        // Ordering by multiplier (0.33 ≤ 0.50 ≤ 1.00).
        expect(direct).toBeLessThanOrEqual(splash);
        expect(splash).toBeLessThanOrEqual(antiAir);

        // Each drone result ≤ the non-drone (unmodified) result.
        expect(direct).toBeLessThanOrEqual(nonDrone);
        expect(splash).toBeLessThanOrEqual(nonDrone);
        expect(antiAir).toBeLessThanOrEqual(nonDrone);

        // Anti-Air is unpenalised against drones (§7/§8) and equals non-drone.
        expect(antiAir).toBe(nonDrone);

        // Never below MIN_DAMAGE.
        for (const v of [direct, splash, antiAir, nonDrone]) {
          expect(v).toBeGreaterThanOrEqual(MIN_DAMAGE);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Property 7: non-drone targets are never modified by weapon mode', () => {
    fc.assert(
      fc.property(arbDamage, arbWeaponMode, (preDamage, mode) => {
        expect(droneIncomingDamageModifier(mode, false, preDamage)).toBe(preDamage);
      }),
      { numRuns: 100 },
    );
  });
});

describe('combatFormula — range efficiency', () => {
  // Feature: unit-test-coverage, Property 8: calculateRangeEfficiency(1) = 1.0,
  // non-increasing as distance grows, never below 0.
  it('Property 8: efficiency anchored at 1.0 for distance 1, non-increasing, never below 0', () => {
    // Anchor (§3: distance 1 → 1.00).
    expect(calculateRangeEfficiency(1)).toBe(1.0);

    fc.assert(
      fc.property(arbDistance, arbNonNegDelta, (d, delta) => {
        const near = calculateRangeEfficiency(d);
        const far = calculateRangeEfficiency(d + delta);
        // Non-increasing as distance grows.
        expect(far).toBeLessThanOrEqual(near);
        // Never below 0.
        expect(far).toBeGreaterThanOrEqual(0);
        expect(near).toBeGreaterThanOrEqual(0);
        // Distances at or below 1 stay at full efficiency.
        expect(near).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('Property 8: distances at or below 1 all yield full efficiency', () => {
    fc.assert(
      fc.property(fc.double({ min: -3, max: 1, noNaN: true }), (d) => {
        expect(calculateRangeEfficiency(d)).toBe(1.0);
      }),
      { numRuns: 100 },
    );
  });
});

describe('combatFormula — applyDamage health capping', () => {
  // Feature: unit-test-coverage, Property 9: applyDamage caps health to [0, 50]
  // and reflects damage of at least MIN_DAMAGE.
  it('Property 9: result within [0, 50] and reflects at least MIN_DAMAGE of damage', () => {
    fc.assert(
      fc.property(arbHealth, arbAnyDamage, (health, damage) => {
        const result = applyDamage(health, damage);
        // Capped to [0, 50].
        expect(result).toBeGreaterThanOrEqual(HEALTH_MIN);
        expect(result).toBeLessThanOrEqual(HEALTH_MAX);

        // At least MIN_DAMAGE is always reflected: the new health is never
        // higher than the clamped starting health minus MIN_DAMAGE (or 0 floor).
        const startClamped = clamp(health, HEALTH_MIN, HEALTH_MAX);
        expect(result).toBeLessThanOrEqual(Math.max(HEALTH_MIN, startClamped - MIN_DAMAGE));
      }),
      { numRuns: 200 },
    );
  });

  it('Property 9: never returns negative health even for huge damage', () => {
    fc.assert(
      fc.property(arbHealth, fc.double({ min: 50, max: 1000, noNaN: true }), (health, damage) => {
        expect(applyDamage(health, damage)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
