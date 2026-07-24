// Feature: oil-logistics-system, Property 22: Undelivered cargo is retained at the source within storage capacity
/**
 * Property test for the undelivered-cargo retention helper (`retainAtSource`).
 *
 * Property 22: Undelivered cargo is retained at the source within storage capacity.
 * Validates: Requirements 8.7, 8.8
 *
 * For any stored in [0, capacity], capacity >= 0, undelivered >= 0:
 *   - result === min(capacity, stored + undelivered) (Req 8.7)
 *   - result <= capacity (never exceeds Storage_Capacity) and result >= 0
 *   - result >= stored (retention never reduces what's stored) when undelivered >= 0
 *   - when stored + undelivered > capacity, result === capacity and the excess
 *     (stored + undelivered - capacity) is discarded, not accrued (Req 8.8)
 *   - when stored + undelivered <= capacity, result === stored + undelivered (all retained)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { retainAtSource } from '../logistics/transport.js';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generator — a well-formed retention scenario: a non-negative capacity, a
// stored quantity constrained to [0, capacity] (the source never starts over
// its own cap), and a non-negative undelivered quantity that could not ship
// this turn (Req 8.7). Built as one record so `stored` depends on `capacity`.
// ---------------------------------------------------------------------------

const arbScenario: fc.Arbitrary<{ stored: number; capacity: number; undelivered: number }> = fc
  .record({
    capacity: fc.integer({ min: 0, max: 100_000 }),
    storedFraction: fc.integer({ min: 0, max: 100_000 }),
    undelivered: fc.integer({ min: 0, max: 100_000 }),
  })
  .map(({ capacity, storedFraction, undelivered }) => ({
    capacity,
    stored: Math.min(storedFraction, capacity),
    undelivered,
  }));

describe('retainAtSource (Property 22: undelivered cargo is retained within storage capacity)', () => {
  it('returns min(capacity, stored + undelivered) (Req 8.7)', () => {
    fc.assert(
      fc.property(arbScenario, ({ stored, capacity, undelivered }) => {
        const result = retainAtSource(stored, capacity, undelivered);
        expect(result).toBe(Math.min(capacity, stored + undelivered));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never exceeds capacity and is never negative', () => {
    fc.assert(
      fc.property(arbScenario, ({ stored, capacity, undelivered }) => {
        const result = retainAtSource(stored, capacity, undelivered);
        expect(result).toBeLessThanOrEqual(capacity);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never reduces what is already stored when undelivered >= 0', () => {
    fc.assert(
      fc.property(arbScenario, ({ stored, capacity, undelivered }) => {
        const result = retainAtSource(stored, capacity, undelivered);
        expect(result).toBeGreaterThanOrEqual(stored);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('holds at capacity and discards the excess when over capacity (Req 8.8)', () => {
    fc.assert(
      fc.property(
        arbScenario.filter(({ stored, capacity, undelivered }) => stored + undelivered > capacity),
        ({ stored, capacity, undelivered }) => {
          const result = retainAtSource(stored, capacity, undelivered);
          // Held exactly at the cap...
          expect(result).toBe(capacity);
          // ...and the overflow is dropped, not accrued.
          const excess = stored + undelivered - capacity;
          expect(excess).toBeGreaterThan(0);
          expect(result).toBe(stored + undelivered - excess);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('retains everything when the total fits within capacity', () => {
    fc.assert(
      fc.property(
        arbScenario.filter(({ stored, capacity, undelivered }) => stored + undelivered <= capacity),
        ({ stored, capacity, undelivered }) => {
          const result = retainAtSource(stored, capacity, undelivered);
          expect(result).toBe(stored + undelivered);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
