// Feature: oil-logistics-system, Property 9: Refinery throughput is linear in segment count
/**
 * Property test for the refinery throughput helper (`refineryThroughput`).
 *
 * Property 9: Refinery throughput is linear in segment count.
 * Validates: Requirements 4.4
 *
 * For any non-negative integer segment count n, a Refinery's processing
 * throughput equals `n * REFINERY_THROUGHPUT_RATE`. REFINERY_THROUGHPUT_RATE is
 * a specification constant and may be asserted exactly (it is not a balance
 * formula output). Linearity implies additivity across segment counts and
 * monotonic non-decreasing behaviour in n.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { refineryThroughput } from '../logistics/production.js';
import { REFINERY_THROUGHPUT_RATE } from '../../../shared/logisticsConstants.js';

describe('refineryThroughput (Property 9: linear in segment count)', () => {
  it('equals n * REFINERY_THROUGHPUT_RATE for any non-negative segment count', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100000 }), (n) => {
        // Exact specification relation (Req 4.4): N segments process N * 20 oil/turn.
        expect(refineryThroughput(n)).toBe(n * REFINERY_THROUGHPUT_RATE);
      }),
      { numRuns: 200 },
    );
  });

  it('is additive: throughput(a + b) === throughput(a) + throughput(b)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100000 }), fc.nat({ max: 100000 }), (a, b) => {
        expect(refineryThroughput(a + b)).toBe(
          refineryThroughput(a) + refineryThroughput(b),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('is monotonically non-decreasing in segment count', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100000 }), fc.nat({ max: 100000 }), (x, y) => {
        const lo = Math.min(x, y);
        const hi = Math.max(x, y);
        expect(refineryThroughput(hi)).toBeGreaterThanOrEqual(
          refineryThroughput(lo),
        );
      }),
      { numRuns: 200 },
    );
  });
});
