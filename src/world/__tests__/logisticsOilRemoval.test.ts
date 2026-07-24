import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { removeOil } from '../logistics/production.js';
import type { OilWell } from '../../../shared/logisticsTypes.js';
import { WELL_STORAGE_CAPACITY } from '../../../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 8: Oil removal conserves and validates
// quantity
// Validates: Requirements 3.4, 3.5
//
// removeOil(well, qty) : { well: OilWell; removed: number } | Error
//   - Valid request   (0 < qty <= storedOil): success — removed === qty, the
//     returned well's storedOil is decreased by qty, mass is conserved
//     (result.well.storedOil + result.removed === original storedOil), and the
//     input well is never mutated (Req 3.4).
//   - Invalid request (qty > storedOil OR qty <= 0): an Error — the input well is
//     left unchanged (storedOil preserved) (Req 3.5).
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

/**
 * Build a fully-typed OilWell fixture with the given stored oil. Field values are
 * arbitrary-but-valid so `tsc` stays clean and removeOil sees a realistic well.
 */
function makeWell(storedOil: number): OilWell {
  return {
    id: 'well-fixture',
    ownerId: 'faction-a',
    tileIndex: 0,
    segment: 0,
    storedOil,
    hitPoints: 100,
    maxHitPoints: 100,
  };
}

// stored oil spans the empty well, typical levels, and the storage cap.
const arbStoredOil = fc.integer({ min: 0, max: WELL_STORAGE_CAPACITY });

describe('logistics oil removal (Property 8)', () => {
  it('valid removal (0 < qty <= storedOil) succeeds, conserves mass, and does not mutate input', () => {
    fc.assert(
      fc.property(
        // Only generate wells with oil to remove, then pick a valid qty in range.
        fc.integer({ min: 1, max: WELL_STORAGE_CAPACITY }).chain((storedOil) =>
          fc.record({
            storedOil: fc.constant(storedOil),
            qty: fc.integer({ min: 1, max: storedOil }),
          }),
        ),
        ({ storedOil, qty }) => {
          const well = makeWell(storedOil);
          const snapshot = { ...well };

          const result = removeOil(well, qty);

          // Success case — not an Error.
          expect(result).not.toBeInstanceOf(Error);
          if (result instanceof Error) return; // narrow for TS

          expect(result.removed).toBe(qty);
          expect(result.well.storedOil).toBe(storedOil - qty);
          // Conservation: remaining + removed === original stored oil (Req 3.4).
          expect(result.well.storedOil + result.removed).toBe(storedOil);

          // Input well is never mutated.
          expect(well).toEqual(snapshot);
          // Every other field is preserved on the returned well.
          expect(result.well.id).toBe(well.id);
          expect(result.well.ownerId).toBe(well.ownerId);
          expect(result.well.tileIndex).toBe(well.tileIndex);
          expect(result.well.segment).toBe(well.segment);
          expect(result.well.hitPoints).toBe(well.hitPoints);
          expect(result.well.maxHitPoints).toBe(well.maxHitPoints);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('over-request (qty > storedOil) returns an Error and leaves stored oil unchanged', () => {
    fc.assert(
      fc.property(
        arbStoredOil.chain((storedOil) =>
          fc.record({
            storedOil: fc.constant(storedOil),
            // Strictly greater than what's stored.
            qty: fc.integer({ min: storedOil + 1, max: storedOil + 1_000_000 }),
          }),
        ),
        ({ storedOil, qty }) => {
          const well = makeWell(storedOil);
          const snapshot = { ...well };

          const result = removeOil(well, qty);

          expect(result).toBeInstanceOf(Error);
          // Input well is unchanged (storedOil preserved) (Req 3.5).
          expect(well).toEqual(snapshot);
          expect(well.storedOil).toBe(storedOil);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('non-positive quantity (qty <= 0) returns an Error and leaves stored oil unchanged', () => {
    fc.assert(
      fc.property(
        arbStoredOil,
        fc.integer({ min: -1_000_000, max: 0 }),
        (storedOil, qty) => {
          const well = makeWell(storedOil);
          const snapshot = { ...well };

          const result = removeOil(well, qty);

          expect(result).toBeInstanceOf(Error);
          expect(well).toEqual(snapshot);
          expect(well.storedOil).toBe(storedOil);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
