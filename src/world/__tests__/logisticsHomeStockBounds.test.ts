import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { accrueRefinedProduct, accrueOil } from '../logistics.js';
import type { HomeStock } from '../../../shared/logisticsTypes.js';
import { HOME_CITY_REFINED_PRODUCT_MAX } from '../../../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 13: Home stock stays within [0, 100000]
// and discards overflow
// Validates: Requirements 5.4, 5.5, 5.7, 6.9
//
// accrueRefinedProduct(home, qty) : HomeStock
//   For any home stock (refinedProduct, oil >= 0) and arriving qty >= 0:
//   - result.refinedProduct === min(home.refinedProduct + qty,
//       HOME_CITY_REFINED_PRODUCT_MAX)                                    (Req 5.4)
//   - result.refinedProduct stays in [0, HOME_CITY_REFINED_PRODUCT_MAX]   (Req 5.5)
//   - overflow beyond the max is discarded, not retained                  (Req 5.7)
//   - `oil` is left unchanged; the input is never mutated.
//
// accrueOil(home, qty) : HomeStock
//   For any home stock and arriving qty >= 0:
//   - result.oil === home.oil + qty (no stated maximum)                   (Req 6.9)
//   - `refinedProduct` is left unchanged; the input is never mutated.
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;
const MAX = HOME_CITY_REFINED_PRODUCT_MAX; // 100000

/** Build a fully-typed HomeStock fixture so `tsc` stays clean. */
function makeHome(refinedProduct: number, oil: number): HomeStock {
  return { factionId: 'faction-a', refinedProduct, oil };
}

// Existing refined-product stock spans empty through the ceiling.
const arbRefined = fc.integer({ min: 0, max: MAX });
// Existing oil stock spans empty through well above any single delivery.
const arbOil = fc.integer({ min: 0, max: 1_000_000 });
// Arriving quantity spans zero through a value large enough to force the clamp.
const arbQty = fc.integer({ min: 0, max: 2 * MAX });

describe('logistics home stock bounds (Property 13)', () => {
  it('accrueRefinedProduct clamps to [0, MAX], discards overflow, leaves oil unchanged, no mutation', () => {
    fc.assert(
      fc.property(arbRefined, arbOil, arbQty, (refinedProduct, oil, qty) => {
        const home = makeHome(refinedProduct, oil);
        const snapshot = JSON.parse(JSON.stringify(home)) as HomeStock;

        const result = accrueRefinedProduct(home, qty);

        // Req 5.4 — clamped sum.
        expect(result.refinedProduct).toBe(Math.min(refinedProduct + qty, MAX));
        // Req 5.5 — result always lands within the inclusive [0, MAX] bound.
        expect(result.refinedProduct).toBeGreaterThanOrEqual(0);
        expect(result.refinedProduct).toBeLessThanOrEqual(MAX);
        // Req 5.7 — any product beyond the ceiling is discarded, not retained.
        if (refinedProduct + qty > MAX) {
          expect(result.refinedProduct).toBe(MAX);
        }

        // Raw oil is untouched by refined-product accrual.
        expect(result.oil).toBe(oil);
        // Input is never mutated.
        expect(home).toEqual(snapshot);
        expect(result.factionId).toBe(home.factionId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accrueRefinedProduct discards overflow when original + qty exceeds MAX (explicit clamp case)', () => {
    // original + qty guaranteed > MAX: original in [1, MAX], qty in [MAX, 2*MAX].
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX }),
        fc.integer({ min: MAX, max: 2 * MAX }),
        arbOil,
        (refinedProduct, qty, oil) => {
          const home = makeHome(refinedProduct, oil);
          const result = accrueRefinedProduct(home, qty);

          // The sum exceeds the ceiling, so the stock pins at MAX and the excess is dropped.
          expect(refinedProduct + qty).toBeGreaterThan(MAX);
          expect(result.refinedProduct).toBe(MAX);
          expect(result.oil).toBe(oil);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accrueOil adds qty to oil (no maximum), leaves refinedProduct unchanged, no mutation (Req 6.9)', () => {
    fc.assert(
      fc.property(arbRefined, arbOil, arbQty, (refinedProduct, oil, qty) => {
        const home = makeHome(refinedProduct, oil);
        const snapshot = JSON.parse(JSON.stringify(home)) as HomeStock;

        const result = accrueOil(home, qty);

        // Req 6.9 — delivered oil accrues with no stated ceiling.
        expect(result.oil).toBe(oil + qty);
        // Refined product is untouched by oil accrual.
        expect(result.refinedProduct).toBe(refinedProduct);
        // Input is never mutated.
        expect(home).toEqual(snapshot);
        expect(result.factionId).toBe(home.factionId);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
