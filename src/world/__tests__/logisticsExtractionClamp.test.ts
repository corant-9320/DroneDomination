// Feature: oil-logistics-system, Property 7: Extraction increases stored oil and clamps to capacity
/**
 * Property test for the well extraction helper (`extract`).
 *
 * Property 7: Extraction increases stored oil and clamps to capacity.
 * Validates: Requirements 3.1, 3.2, 3.3, 3.6
 *
 * For any well whose storedOil lies in [0, WELL_STORAGE_CAPACITY]:
 *   - new storedOil === min(storedOil + EXTRACTION_RATE, WELL_STORAGE_CAPACITY) (Req 3.1)
 *   - the result never exceeds WELL_STORAGE_CAPACITY and never drops below the
 *     input storedOil (Req 3.2, monotone accrual)
 *   - when already at capacity, storedOil holds at capacity (Req 3.3)
 *   - extract does not mutate the input well and preserves every other field (Req 3.6)
 *
 * EXTRACTION_RATE and WELL_STORAGE_CAPACITY are specification constants imported
 * symbolically (no pinned values).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { extract } from '../logistics.js';
import {
  EXTRACTION_RATE,
  WELL_STORAGE_CAPACITY,
} from '../../../shared/logisticsConstants.js';
import type { OilWell } from '../../../shared/logisticsTypes.js';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generator — fully-typed OilWell fixtures with storedOil constrained to the
// valid [0, WELL_STORAGE_CAPACITY] range (Req 3.2/3.6). maxHitPoints is a
// positive integer and hitPoints is bounded by it, so every fixture is a
// well-formed OilWell (no undefined where a number is required).
// ---------------------------------------------------------------------------

const arbWell: fc.Arbitrary<OilWell> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    ownerId: fc.string({ minLength: 1, maxLength: 6 }),
    tileIndex: fc.integer({ min: 0, max: 5000 }),
    segment: fc.integer({ min: 0, max: 5 }),
    storedOil: fc.integer({ min: 0, max: WELL_STORAGE_CAPACITY }),
    maxHitPoints: fc.integer({ min: 1, max: 500 }),
    hitPointsFraction: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ hitPointsFraction, maxHitPoints, ...rest }) => ({
    ...rest,
    maxHitPoints,
    hitPoints: Math.min(hitPointsFraction, maxHitPoints),
  }));

// A well pinned exactly at capacity, to exercise the Req 3.3 hold-at-cap case.
const arbFullWell: fc.Arbitrary<OilWell> = arbWell.map((well) => ({
  ...well,
  storedOil: WELL_STORAGE_CAPACITY,
}));

describe('extract (Property 7: extraction increases stored oil and clamps to capacity)', () => {
  it('sets storedOil to min(storedOil + EXTRACTION_RATE, WELL_STORAGE_CAPACITY)', () => {
    fc.assert(
      fc.property(arbWell, (well) => {
        const result = extract(well);
        const expected = Math.min(well.storedOil + EXTRACTION_RATE, WELL_STORAGE_CAPACITY);
        expect(result.storedOil).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never exceeds capacity and never decreases below the input storedOil', () => {
    fc.assert(
      fc.property(arbWell, (well) => {
        const result = extract(well);
        expect(result.storedOil).toBeLessThanOrEqual(WELL_STORAGE_CAPACITY);
        expect(result.storedOil).toBeGreaterThanOrEqual(well.storedOil);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('holds at capacity when the well is already full (Req 3.3)', () => {
    fc.assert(
      fc.property(arbFullWell, (well) => {
        const result = extract(well);
        expect(result.storedOil).toBe(WELL_STORAGE_CAPACITY);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate the input well and preserves every other field (Req 3.6)', () => {
    fc.assert(
      fc.property(arbWell, (well) => {
        const snapshot = { ...well };
        const result = extract(well);
        // Input untouched.
        expect(well).toEqual(snapshot);
        // Every field other than storedOil is carried through unchanged.
        expect(result.id).toBe(well.id);
        expect(result.ownerId).toBe(well.ownerId);
        expect(result.tileIndex).toBe(well.tileIndex);
        expect(result.segment).toBe(well.segment);
        expect(result.hitPoints).toBe(well.hitPoints);
        expect(result.maxHitPoints).toBe(well.maxHitPoints);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
