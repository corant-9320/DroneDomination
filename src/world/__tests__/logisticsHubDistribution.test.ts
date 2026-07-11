// Feature: oil-logistics-system, Property 23: Distribution hub bounds, distribution, and conservation
//
// Validates: Requirements 11.3, 11.4, 11.5, 11.6, 11.7
//
// distributeHub(hub, inflow, outgoingCaps) : HubDistribution
//   HubDistribution = { amounts, distributedTotal, newBuffer, leftUpstream }
//   For any hub.buffer >= 0, inflow >= 0, and a non-negative outgoingCaps array:
//   - distributedTotal === min(buffer + inflow, Σ caps)                  (Req 11.4)
//   - amounts.length === outgoingCaps.length; each amounts[i] <= caps[i] (Req 11.5)
//     (no route over capacity); Σ amounts === distributedTotal.
//   - 0 <= newBuffer <= HUB_STORAGE_CAPACITY                             (Req 11.3, 11.6)
//   - conservation: distributedTotal + newBuffer + leftUpstream
//       === buffer + inflow                                             (Req 11.7)
//     and leftUpstream >= 0.
//   - distributeHub never mutates the hub or the caps array.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { distributeHub } from '../logistics.js';
import type { DistributionHub } from '../../../shared/logisticsTypes.js';
import { HUB_STORAGE_CAPACITY } from '../../../shared/logisticsConstants.js';

const NUM_RUNS = 200;

/**
 * Build a fully-typed DistributionHub fixture. `routeIds` is sized to match the
 * outgoing route count so the fixture reads like a real hub, though
 * `distributeHub` only consumes `hub.buffer` from this shape.
 */
function makeHub(buffer: number, routeCount: number): DistributionHub {
  return {
    id: 'hub-fixture',
    ownerId: 'faction-a',
    tileIndex: 0,
    segment: 0,
    buffer,
    routeIds: Array.from({ length: routeCount }, (_, i) => `route-${i}`),
    hitPoints: 200,
    maxHitPoints: 200,
  };
}

// Buffer spans empty through the storage cap and a little beyond, to exercise
// the clamp. Inflow spans empty through well above any single-turn capacity.
const arbBuffer = fc.integer({ min: 0, max: HUB_STORAGE_CAPACITY + 500 });
const arbInflow = fc.integer({ min: 0, max: 5000 });
// Outgoing route capacities: possibly empty array, each non-negative.
const arbCaps = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 0, maxLength: 8 });

describe('logistics hub distribution (Property 23)', () => {
  it('bounds distribution, buffers within capacity, and conserves mass without mutating input', () => {
    fc.assert(
      fc.property(arbBuffer, arbInflow, arbCaps, (buffer, inflow, caps) => {
        const hub = makeHub(buffer, caps.length);
        const hubSnapshot = JSON.parse(JSON.stringify(hub)) as DistributionHub;
        const capsSnapshot = [...caps];

        const result = distributeHub(hub, inflow, caps);

        const available = buffer + inflow;
        const totalCapacity = caps.reduce((acc, c) => acc + c, 0);

        // Req 11.4 — distributedTotal is min(available, Σ caps).
        expect(result.distributedTotal).toBe(Math.min(available, totalCapacity));

        // Req 11.5 — one amount per outgoing route, none over its own capacity.
        expect(result.amounts).toHaveLength(caps.length);
        for (let i = 0; i < caps.length; i++) {
          expect(result.amounts[i]).toBeGreaterThanOrEqual(0);
          expect(result.amounts[i]).toBeLessThanOrEqual(caps[i]);
        }
        // Amounts sum to the distributed total.
        const amountsSum = result.amounts.reduce((acc, a) => acc + a, 0);
        expect(amountsSum).toBe(result.distributedTotal);

        // Req 11.3, 11.6 — buffer stays within [0, HUB_STORAGE_CAPACITY].
        expect(result.newBuffer).toBeGreaterThanOrEqual(0);
        expect(result.newBuffer).toBeLessThanOrEqual(HUB_STORAGE_CAPACITY);

        // Req 11.7 — leftover flows upstream, never negative.
        expect(result.leftUpstream).toBeGreaterThanOrEqual(0);

        // Req 11.7 — total conservation: distributed + buffered + upstream === available.
        expect(result.distributedTotal + result.newBuffer + result.leftUpstream).toBe(available);

        // distributeHub does not mutate the hub or the caps array.
        expect(hub).toEqual(hubSnapshot);
        expect(caps).toEqual(capsSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
