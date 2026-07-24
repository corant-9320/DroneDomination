import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { refine, refineryThroughput } from '../logistics/production.js';
import type { Refinery } from '../../../shared/logisticsTypes.js';
import { CONVERSION_RATIO } from '../../../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 10: Refining consumes the correct oil
// and converts it one-for-one to petrol.
// Validates: Requirements 4.5, 4.6, 4.7
//
// refine(refinery) : Refinery
//   For any refinery with segments (length >= 1) and heldOil >= 0:
//     consumed = min(refineryThroughput(segments.length), heldOil)
//   - result.heldOil === heldOil - consumed                              (Req 4.6)
//   - result.refinedProductAvailable ===
//       original + floor(consumed * CONVERSION_RATIO)                    (Req 4.5)
//   - every processed oil unit produces one petrol unit (CONVERSION_RATIO = 1).
//   - heldOil === 0 is a no-op: heldOil and refinedProductAvailable unchanged (Req 4.7)
//   - refine never mutates its input.
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

/**
 * Build a fully-typed Refinery fixture. `segmentCount` occupied segment indices
 * (0..segmentCount-1) give a realistic, in-range segment list so `tsc` stays clean
 * and `refineryThroughput(segments.length)` sees the intended throughput.
 */
function makeRefinery(
  segmentCount: number,
  heldOil: number,
  refinedProductAvailable: number,
): Refinery {
  const segments = Array.from({ length: segmentCount }, (_, i) => i);
  return {
    id: 'refinery-fixture',
    ownerId: 'faction-a',
    tileIndex: 0,
    segments,
    heldOil,
    refinedProductAvailable,
    hitPoints: 100,
    maxHitPoints: 100,
  };
}

// A refinery has 1..6 segments (pentagon has 5, hexagon 6; at least one to refine).
const arbSegmentCount = fc.integer({ min: 1, max: 6 });
// heldOil spans empty through well above any single-turn throughput.
const arbHeldOil = fc.integer({ min: 0, max: 100_000 });
const arbProductAvailable = fc.integer({ min: 0, max: 100_000 });

describe('logistics refining conservation (Property 10)', () => {
  it('consumes min(throughput, heldOil), converts one-for-one, and does not mutate input', () => {
    fc.assert(
      fc.property(
        arbSegmentCount,
        arbHeldOil,
        arbProductAvailable,
        (segmentCount, heldOil, productAvailable) => {
          const refinery = makeRefinery(segmentCount, heldOil, productAvailable);
          const snapshot = JSON.parse(JSON.stringify(refinery)) as Refinery;

          const throughput = refineryThroughput(segmentCount);
          const consumed = Math.min(throughput, heldOil);
          const expectedProduct = Math.floor(consumed * CONVERSION_RATIO);

          const result = refine(refinery);

          // Req 4.6 — held oil is reduced by exactly the consumed amount.
          expect(result.heldOil).toBe(heldOil - consumed);
          // Req 4.5 — product increases by floor(consumed * 0.5).
          expect(result.refinedProductAvailable).toBe(productAvailable + expectedProduct);

          const producedThisTurn = result.refinedProductAvailable - productAvailable;
          // The oil economy uses a one-to-one conversion: every processed oil unit
          // becomes one unit of petrol, with no rounding loss.
          expect(producedThisTurn).toBe(consumed);

          // Product is always a whole number of units.
          expect(Number.isInteger(result.refinedProductAvailable)).toBe(true);

          // Input refinery is never mutated.
          expect(refinery).toEqual(snapshot);
          // Untouched fields are preserved on the returned refinery.
          expect(result.id).toBe(refinery.id);
          expect(result.ownerId).toBe(refinery.ownerId);
          expect(result.tileIndex).toBe(refinery.tileIndex);
          expect(result.segments).toEqual(refinery.segments);
          expect(result.hitPoints).toBe(refinery.hitPoints);
          expect(result.maxHitPoints).toBe(refinery.maxHitPoints);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is a no-op when heldOil === 0: held oil and product are unchanged (Req 4.7)', () => {
    fc.assert(
      fc.property(arbSegmentCount, arbProductAvailable, (segmentCount, productAvailable) => {
        const refinery = makeRefinery(segmentCount, 0, productAvailable);
        const snapshot = JSON.parse(JSON.stringify(refinery)) as Refinery;

        const result = refine(refinery);

        // No oil to consume — held oil stays at 0 and no product is produced.
        expect(result.heldOil).toBe(0);
        expect(result.refinedProductAvailable).toBe(productAvailable);
        // Input is not mutated.
        expect(refinery).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
