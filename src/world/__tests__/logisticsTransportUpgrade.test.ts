import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { upgradeTransport, transportTier } from '../logistics/transport.js';
import type { Transport } from '../../../shared/logisticsTypes.js';
import { TRANSPORT_CARGO_MAX } from '../../../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 19: Transport upgrade strictly improves
// one stat and leaves route capacity untouched
// Validates: Requirements 8.4
//
// upgradeTransport(t, stat) : Transport
//   - EXACTLY the chosen stat strictly increases (cargo→cargoCapacity,
//     speed→speed, defence→defence); the OTHER two stats are unchanged.
//   - `upgrades` increments by 1; `tier` = transportTier(new upgrades).
//   - Route_Capacity is NOT a field of Transport and cannot be touched: the
//     function only receives/returns a Transport and never a route (Req 8.4).
//   - The input transport is not mutated (pure).
//
// Cargo clamps to TRANSPORT_CARGO_MAX (Req 8.3), so cargo fixtures keep
// cargoCapacity strictly below the cap to guarantee a STRICT increase. speed and
// defence have no cap in the implementation, so any starting value works.
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

/**
 * A fully-typed Transport fixture. `cargoCapacity` is kept strictly below
 * TRANSPORT_CARGO_MAX so a cargo upgrade is guaranteed to strictly increase it
 * (the implementation clamps cargo to the cap). `upgrades` ranges across tier
 * boundaries so the recomputed `tier` is exercised at every threshold.
 */
const arbTransport: fc.Arbitrary<Transport> = fc.record({
  id: fc.constant('transport-fixture'),
  ownerId: fc.constant('faction-a'),
  routeId: fc.constant('route-1'),
  cargoType: fc.constantFrom<'oil' | 'product' | null>('oil', 'product', null),
  cargo: fc.integer({ min: 0, max: 100 }),
  // Strictly below the cap: leaves room for at least one full +100 cargo step.
  cargoCapacity: fc.integer({ min: TRANSPORT_CARGO_MAX - 100, max: TRANSPORT_CARGO_MAX - 1 }),
  speed: fc.integer({ min: 1, max: 20 }),
  defence: fc.integer({ min: 0, max: 20 }),
  upgrades: fc.integer({ min: 0, max: 8 }),
  tier: fc.constant('van' as const),
  inTransit: fc.boolean(),
  turnsRemaining: fc.integer({ min: 0, max: 5 }),
  unitId: fc.constant('unit-1'),
}).map((t) => ({ ...t, tier: transportTier(t.upgrades) }));

const arbStat = fc.constantFrom<'cargo' | 'speed' | 'defence'>('cargo', 'speed', 'defence');

describe('logistics transport upgrade (Property 19)', () => {
  it('strictly improves exactly the chosen stat, leaves the others unchanged (Req 8.4)', () => {
    fc.assert(
      fc.property(arbTransport, arbStat, (t, stat) => {
        const next = upgradeTransport(t, stat);

        // Exactly one of the three stats strictly increases; the other two hold.
        if (stat === 'cargo') {
          expect(next.cargoCapacity).toBeGreaterThan(t.cargoCapacity);
          expect(next.speed).toBe(t.speed);
          expect(next.defence).toBe(t.defence);
        } else if (stat === 'speed') {
          expect(next.speed).toBeGreaterThan(t.speed);
          expect(next.cargoCapacity).toBe(t.cargoCapacity);
          expect(next.defence).toBe(t.defence);
        } else {
          expect(next.defence).toBeGreaterThan(t.defence);
          expect(next.cargoCapacity).toBe(t.cargoCapacity);
          expect(next.speed).toBe(t.speed);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('increments upgrades by one and recomputes tier = transportTier(upgrades) (Req 8.4)', () => {
    fc.assert(
      fc.property(arbTransport, arbStat, (t, stat) => {
        const next = upgradeTransport(t, stat);

        expect(next.upgrades).toBe(t.upgrades + 1);
        expect(next.tier).toBe(transportTier(next.upgrades));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('touches no route-capacity field — Transport carries none and none is added (Req 8.4)', () => {
    fc.assert(
      fc.property(arbTransport, arbStat, (t, stat) => {
        const next = upgradeTransport(t, stat);

        // The returned Transport exposes exactly the same keys as the input: the
        // function cannot smuggle a route/route-capacity field onto a Transport.
        expect(Object.keys(next).sort()).toEqual(Object.keys(t).sort());
        // No field implying route capacity exists on a Transport.
        expect('capacity' in next).toBe(false);
        expect('routeCapacity' in next).toBe(false);
        // The route the transport is assigned to is unchanged (id only reference).
        expect(next.routeId).toBe(t.routeId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate the input transport (Req 8.4)', () => {
    fc.assert(
      fc.property(arbTransport, arbStat, (t, stat) => {
        const snapshot = JSON.parse(JSON.stringify(t)) as Transport;
        upgradeTransport(t, stat);
        expect(t).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
