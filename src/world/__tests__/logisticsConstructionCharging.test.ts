// Feature: oil-logistics-system, Property 12: Construction charges Refined_Product exactly, or rejects
/**
 * Property test for the construction-charging helpers (`canAfford`, `chargeConstruction`).
 *
 * Property 12: Construction charges Refined_Product exactly, or rejects.
 * Validates: Requirements 5.1, 5.2, 5.3, 5.6, 5.8
 *
 * Refined_Product is the sole construction currency (Req 5.1): charging never
 * touches the Home_City's raw `oil` stock. For any HomeStock and cost:
 *   - canAfford(home, cost) === (cost <= home.refinedProduct) (Req 5.2/5.3)
 *   - when affordable, chargeConstruction debits EXACTLY cost from refinedProduct
 *     (result.refinedProduct === original - cost), never goes negative, and leaves
 *     `oil` unchanged (Req 5.1, 5.2, 5.6)
 *   - charging never mutates the input HomeStock
 *   - real CONSTRUCTION_COST table values debit exactly that amount when affordable
 *     (Req 5.8) — these are specification constants, asserted symbolically.
 *
 * HOME_CITY_REFINED_PRODUCT_MAX and CONSTRUCTION_COST are specification constants
 * imported symbolically (no pinned literal values).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { canAfford, chargeConstruction } from '../logistics.js';
import {
  CONSTRUCTION_COST,
  HOME_CITY_REFINED_PRODUCT_MAX,
} from '../../../shared/logisticsConstants.js';
import type { HomeStock } from '../../../shared/logisticsTypes.js';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generators — fully-typed HomeStock fixtures. Both commodity stocks are
// non-negative integers within their valid ranges (refinedProduct bounded by
// HOME_CITY_REFINED_PRODUCT_MAX per Req 5.5); factionId is a non-empty string.
// ---------------------------------------------------------------------------

const arbHome: fc.Arbitrary<HomeStock> = fc.record({
  factionId: fc.string({ minLength: 1, maxLength: 6 }),
  refinedProduct: fc.integer({ min: 0, max: HOME_CITY_REFINED_PRODUCT_MAX }),
  oil: fc.integer({ min: 0, max: 100000 }),
});

// Construction_Cost is an integer >= 1 (Req 5.6); span past the max so both the
// affordable and unaffordable branches are exercised.
const arbCost: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: HOME_CITY_REFINED_PRODUCT_MAX + 5000,
});

// The concrete Construction_Cost table values with a strictly-positive charge
// (Req 5.8). forestClear is 0 (Req 5.9) and is excluded from the "positive cost"
// table assertions here.
const POSITIVE_COSTS: readonly number[] = Object.values(CONSTRUCTION_COST).filter(
  (c) => c > 0,
);

describe('canAfford (Property 12: affordability is cost <= refinedProduct)', () => {
  it('returns cost <= home.refinedProduct for arbitrary stock and cost', () => {
    fc.assert(
      fc.property(arbHome, arbCost, (home, cost) => {
        expect(canAfford(home, cost)).toBe(cost <= home.refinedProduct);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('ignores the raw oil stock entirely (Req 5.1)', () => {
    fc.assert(
      fc.property(arbHome, arbCost, fc.integer({ min: 0, max: 100000 }), (home, cost, otherOil) => {
        const withDifferentOil: HomeStock = { ...home, oil: otherOil };
        expect(canAfford(withDifferentOil, cost)).toBe(canAfford(home, cost));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('chargeConstruction (Property 12: charges Refined_Product exactly, or rejects)', () => {
  it('debits EXACTLY cost from refinedProduct when affordable', () => {
    fc.assert(
      fc.property(arbHome, arbCost, (home, cost) => {
        fc.pre(canAfford(home, cost));
        const result = chargeConstruction(home, cost);
        expect(result.refinedProduct).toBe(home.refinedProduct - cost);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never drives refinedProduct negative (Req 5.5)', () => {
    fc.assert(
      fc.property(arbHome, arbCost, (home, cost) => {
        const result = chargeConstruction(home, cost);
        expect(result.refinedProduct).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never touches the raw oil stock (Req 5.1 — Refined_Product is the sole currency)', () => {
    fc.assert(
      fc.property(arbHome, arbCost, (home, cost) => {
        const result = chargeConstruction(home, cost);
        expect(result.oil).toBe(home.oil);
        expect(result.factionId).toBe(home.factionId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate the input HomeStock', () => {
    fc.assert(
      fc.property(arbHome, arbCost, (home, cost) => {
        const snapshot = { ...home };
        chargeConstruction(home, cost);
        expect(home).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('debits exactly the real CONSTRUCTION_COST table values when affordable (Req 5.8)', () => {
    fc.assert(
      fc.property(
        arbHome,
        fc.constantFrom(...POSITIVE_COSTS),
        (home, cost) => {
          fc.pre(canAfford(home, cost));
          const result = chargeConstruction(home, cost);
          expect(result.refinedProduct).toBe(home.refinedProduct - cost);
          expect(result.oil).toBe(home.oil);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
