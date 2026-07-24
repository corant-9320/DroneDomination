import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { clampTransport } from '../logistics/transport.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 16: Per-turn transport never exceeds
// route capacity; excess is retained
// Validates: Requirements 6.6, 8.1
//
// clampTransport(cargo, capacity) : number
//   For any cargo >= 0 and capacity >= 0:
//   - result === min(cargo, capacity) and result >= 0                     (Req 6.6)
//   - result <= capacity — a turn's transport never exceeds the route's
//     current Route_Capacity                                              (Req 6.6)
//   - excess retained = cargo - result >= 0; when cargo <= capacity the
//     excess is 0, and when cargo > capacity the result equals capacity so
//     the retained excess is exactly cargo - capacity                     (Req 6.6, 8.1)
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

// Non-negative integer amounts of combined Oil/Refined_Product per turn.
const arbCargo = fc.integer({ min: 0, max: 100_000 });
const arbCapacity = fc.integer({ min: 0, max: 100_000 });

describe('logistics per-turn route-capacity limit (Property 16)', () => {
  it('clamps transported quantity to min(cargo, capacity), never negative (Req 6.6)', () => {
    fc.assert(
      fc.property(arbCargo, arbCapacity, (cargo, capacity) => {
        const result = clampTransport(cargo, capacity);

        // Exactly the minimum of demand and capacity, and never negative.
        expect(result).toBe(Math.min(cargo, capacity));
        expect(result).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never transports more than the route capacity in a turn (Req 6.6)', () => {
    fc.assert(
      fc.property(arbCargo, arbCapacity, (cargo, capacity) => {
        const result = clampTransport(cargo, capacity);

        // The per-turn total is capped at the route's current capacity.
        expect(result).toBeLessThanOrEqual(capacity);
        // It also never exceeds the amount actually offered.
        expect(result).toBeLessThanOrEqual(cargo);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('retains all excess at the source: excess = cargo - result >= 0 (Req 6.6, 8.1)', () => {
    fc.assert(
      fc.property(arbCargo, arbCapacity, (cargo, capacity) => {
        const result = clampTransport(cargo, capacity);
        const excess = cargo - result;

        // Nothing is created or lost: retained excess is non-negative.
        expect(excess).toBeGreaterThanOrEqual(0);

        if (cargo <= capacity) {
          // Everything offered fits within capacity — nothing is retained.
          expect(result).toBe(cargo);
          expect(excess).toBe(0);
        } else {
          // Demand exceeds capacity — a full capacity's worth moves and the
          // remainder is retained at the source structure.
          expect(result).toBe(capacity);
          expect(excess).toBe(cargo - capacity);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
