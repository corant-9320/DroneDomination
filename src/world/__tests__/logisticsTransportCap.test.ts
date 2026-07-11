import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { canAssignTransport } from '../logistics.js';
import { MAX_TRANSPORTS_PER_ROUTE } from '../../../shared/logisticsConstants.js';
import type { LogisticsRoute, Transport } from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 21: Transports per route are capped at 3
// Validates: Requirements 8.11, 8.12, 8.13
//
// canAssignTransport(route, transports) : boolean
//   Let n = number of transports with routeId === route.id.
//   - result === (n < MAX_TRANSPORTS_PER_ROUTE)                          (Req 8.11)
//   - once n >= MAX_TRANSPORTS_PER_ROUTE the result is false             (Req 8.12)
//   - transports assigned to OTHER routes do not count toward this
//     route's cap (Req 8.11–8.13 per-route accounting)
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

/** Build a fully-typed LogisticsRoute fixture with the given id. */
function makeRoute(id: string): LogisticsRoute {
  return {
    id,
    ownerId: 'faction-a',
    fromStructureId: 'well-1',
    toStructureId: 'home-1',
    segments: [0, 1, 2],
    capacity: 100,
    tier: 'road',
    travelTime: 1,
    operable: true,
  };
}

/** Build a fully-typed Transport fixture assigned to `routeId`. */
function makeTransport(id: string, routeId: string): Transport {
  return {
    id,
    ownerId: 'faction-a',
    routeId,
    cargoType: null,
    cargo: 0,
    cargoCapacity: 100,
    speed: 1,
    defence: 1,
    upgrades: 0,
    tier: 'van',
    inTransit: false,
    turnsRemaining: 0,
    unitId: `unit-${id}`,
  };
}

const ROUTE_ID = 'route-under-test';
const OTHER_ROUTE_ID = 'route-other';

describe('logistics per-route transport cap (Property 21)', () => {
  it('is true iff same-route assigned count is below MAX_TRANSPORTS_PER_ROUTE (Req 8.11, 8.12)', () => {
    fc.assert(
      fc.property(
        // Same-route transports (0..2x the cap covers below, at, and above).
        fc.integer({ min: 0, max: MAX_TRANSPORTS_PER_ROUTE * 2 }),
        // Transports on an unrelated route — must not affect the decision.
        fc.integer({ min: 0, max: MAX_TRANSPORTS_PER_ROUTE * 2 }),
        (sameRoute, otherRoute) => {
          const route = makeRoute(ROUTE_ID);
          const transports: Transport[] = [];
          for (let i = 0; i < sameRoute; i++) {
            transports.push(makeTransport(`s-${i}`, ROUTE_ID));
          }
          for (let i = 0; i < otherRoute; i++) {
            transports.push(makeTransport(`o-${i}`, OTHER_ROUTE_ID));
          }

          const result = canAssignTransport(route, transports);

          // The decision depends only on the same-route count.
          expect(result).toBe(sameRoute < MAX_TRANSPORTS_PER_ROUTE);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects once the route has reached its maximum of MAX_TRANSPORTS_PER_ROUTE (Req 8.12)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_TRANSPORTS_PER_ROUTE, max: MAX_TRANSPORTS_PER_ROUTE * 3 }),
        (sameRoute) => {
          const route = makeRoute(ROUTE_ID);
          const transports = Array.from({ length: sameRoute }, (_, i) =>
            makeTransport(`s-${i}`, ROUTE_ID),
          );

          // At or above the cap, assignment is always rejected.
          expect(canAssignTransport(route, transports)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('ignores transports assigned to other routes when counting the cap (Req 8.11–8.13)', () => {
    fc.assert(
      fc.property(
        // Keep the route strictly under-capacity with same-route transports…
        fc.integer({ min: 0, max: MAX_TRANSPORTS_PER_ROUTE - 1 }),
        // …and add arbitrarily many transports on other routes.
        fc.integer({ min: 0, max: MAX_TRANSPORTS_PER_ROUTE * 4 }),
        (sameRoute, otherRoute) => {
          const route = makeRoute(ROUTE_ID);
          const transports: Transport[] = [];
          for (let i = 0; i < sameRoute; i++) {
            transports.push(makeTransport(`s-${i}`, ROUTE_ID));
          }
          for (let i = 0; i < otherRoute; i++) {
            transports.push(makeTransport(`o-${i}`, OTHER_ROUTE_ID));
          }

          // Other-route transports never push this route over its cap.
          expect(canAssignTransport(route, transports)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
