// Feature: oil-logistics-system, Property 18: Cargo capacity is bounded and loads/deliveries clamp with conservation
/**
 * Property test for the transport-loading and delivery helpers (`loadTransport`,
 * `deliver`).
 *
 * Property 18: Cargo capacity is bounded and loads/deliveries clamp with conservation.
 * Validates: Requirements 8.2, 8.3, 8.9, 8.10
 *
 * loadTransport(t, supply, cargoType?) → { t, loaded }:
 *   - loaded === max(0, min(cargoCapacity - t.cargo, supply))
 *   - resulting t.cargo <= cargoCapacity (never exceeds capacity, Req 8.3)
 *   - loaded <= supply and loaded >= 0
 *   - conservation: new cargo === old cargo + loaded
 *
 * deliver(dest, cargo) → { dest, remainder }:
 *   - accepted = min(dest.capacity - dest.stored, cargo)
 *   - result.dest.stored <= capacity (clamped, Req 8.10)
 *   - remainder === cargo - accepted (retained on transport, Req 8.10)
 *   - conservation: result.dest.stored + remainder === dest.stored + cargo
 *   - result.dest.stored >= dest.stored (delivery never removes stock)
 *
 * TRANSPORT_CARGO_MIN/MAX are specification constants imported symbolically
 * (no pinned values).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadTransport, deliver } from '../logistics.js';
import type { StorageLike } from '../logistics.js';
import {
  TRANSPORT_CARGO_MIN,
  TRANSPORT_CARGO_MAX,
} from '../../../shared/logisticsConstants.js';
import type { TransportTier } from '../../../shared/logisticsConstants.js';
import type { Transport } from '../../../shared/logisticsTypes.js';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbTier: fc.Arbitrary<TransportTier> = fc.constantFrom('van', 'truck', 'juggernaut');
const arbCargoType: fc.Arbitrary<'oil' | 'product' | null> = fc.constantFrom(
  'oil',
  'product',
  null,
);

// Fully-typed Transport whose cargo is constrained to [0, cargoCapacity] so every
// fixture is a well-formed Transport (Req 8.3 invariant holds on the input).
const arbTransport: fc.Arbitrary<Transport> = fc
  .record({
    cargoCapacity: fc.integer({ min: TRANSPORT_CARGO_MIN, max: TRANSPORT_CARGO_MAX }),
    cargoFraction: fc.integer({ min: 0, max: TRANSPORT_CARGO_MAX }),
    id: fc.string({ minLength: 1, maxLength: 8 }),
    ownerId: fc.string({ minLength: 1, maxLength: 6 }),
    routeId: fc.string({ minLength: 1, maxLength: 8 }),
    cargoType: arbCargoType,
    speed: fc.integer({ min: 1, max: 10 }),
    defence: fc.integer({ min: 0, max: 50 }),
    upgrades: fc.integer({ min: 0, max: 10 }),
    tier: arbTier,
    inTransit: fc.boolean(),
    turnsRemaining: fc.integer({ min: 0, max: 20 }),
    unitId: fc.string({ minLength: 1, maxLength: 8 }),
  })
  .map(({ cargoFraction, cargoCapacity, ...rest }) => ({
    ...rest,
    cargoCapacity,
    cargo: Math.min(cargoFraction, cargoCapacity),
  }));

// supply may be negative, zero, or exceed capacity — the clamp must cope.
const arbSupply: fc.Arbitrary<number> = fc.integer({ min: -500, max: TRANSPORT_CARGO_MAX + 500 });

// Fully-typed StorageLike with stored constrained to [0, capacity].
const arbDest: fc.Arbitrary<StorageLike> = fc
  .record({
    capacity: fc.integer({ min: 0, max: 100000 }),
    storedFraction: fc.integer({ min: 0, max: 100000 }),
  })
  .map(({ storedFraction, capacity }) => ({
    capacity,
    stored: Math.min(storedFraction, capacity),
  }));

// cargo being delivered may be zero or exceed remaining free space.
const arbCargo: fc.Arbitrary<number> = fc.integer({ min: 0, max: 100000 });

// ---------------------------------------------------------------------------
// loadTransport (Req 8.2, 8.3)
// ---------------------------------------------------------------------------

describe('loadTransport (Property 18: cargo capacity is bounded, loads clamp with conservation)', () => {
  it('loads max(0, min(cargoCapacity - cargo, supply))', () => {
    fc.assert(
      fc.property(arbTransport, arbSupply, (t, supply) => {
        const { loaded } = loadTransport(t, supply);
        const expected = Math.max(0, Math.min(t.cargoCapacity - t.cargo, supply));
        expect(loaded).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never lets resulting cargo exceed cargoCapacity (Req 8.3)', () => {
    fc.assert(
      fc.property(arbTransport, arbSupply, (t, supply) => {
        const { t: next } = loadTransport(t, supply);
        expect(next.cargo).toBeLessThanOrEqual(t.cargoCapacity);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('loads a non-negative amount not exceeding supply', () => {
    fc.assert(
      fc.property(arbTransport, arbSupply, (t, supply) => {
        const { loaded } = loadTransport(t, supply);
        expect(loaded).toBeGreaterThanOrEqual(0);
        expect(loaded).toBeLessThanOrEqual(Math.max(0, supply));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('conserves cargo: new cargo === old cargo + loaded, and does not mutate input', () => {
    fc.assert(
      fc.property(arbTransport, arbSupply, (t, supply) => {
        const snapshot = { ...t };
        const { t: next, loaded } = loadTransport(t, supply);
        expect(next.cargo).toBe(t.cargo + loaded);
        expect(t).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// deliver (Req 8.9, 8.10)
// ---------------------------------------------------------------------------

describe('deliver (Property 18: deliveries clamp to capacity with conservation)', () => {
  it('accepts min(capacity - stored, cargo) and never overflows capacity (Req 8.10)', () => {
    fc.assert(
      fc.property(arbDest, arbCargo, (dest, cargo) => {
        const { dest: next } = deliver(dest, cargo);
        const accepted = Math.min(dest.capacity - dest.stored, cargo);
        expect(next.stored).toBe(dest.stored + accepted);
        expect(next.stored).toBeLessThanOrEqual(dest.capacity);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns remainder === cargo - accepted, retained on the transport (Req 8.10)', () => {
    fc.assert(
      fc.property(arbDest, arbCargo, (dest, cargo) => {
        const { dest: next, remainder } = deliver(dest, cargo);
        const accepted = next.stored - dest.stored;
        expect(remainder).toBe(cargo - accepted);
        expect(remainder).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('conserves quantity: result.dest.stored + remainder === dest.stored + cargo', () => {
    fc.assert(
      fc.property(arbDest, arbCargo, (dest, cargo) => {
        const { dest: next, remainder } = deliver(dest, cargo);
        expect(next.stored + remainder).toBe(dest.stored + cargo);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never removes stock: result.dest.stored >= dest.stored, and does not mutate input', () => {
    fc.assert(
      fc.property(arbDest, arbCargo, (dest, cargo) => {
        const snapshot = { ...dest };
        const { dest: next } = deliver(dest, cargo);
        expect(next.stored).toBeGreaterThanOrEqual(dest.stored);
        expect(dest).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
