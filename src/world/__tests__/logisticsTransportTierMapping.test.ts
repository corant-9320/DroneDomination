import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { transportTier } from '../logistics/transport.js';
import {
  TRANSPORT_TIER_THRESHOLDS,
  type TransportTier,
} from '../../../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 29 (engine part): transportTier is total and monotonic
// Validates: Requirements 14.3, 14.5
//
// transportTier(upgrades: number) : TransportTier
//   - TOTALITY: for any integer upgrades >= 0, the result is exactly one of the
//     three tiers {'van','truck','juggernaut'} (Req 14.3 — a distinct tier exists
//     for every upgrade count).
//   - THRESHOLD CORRECTNESS (symbolic, inclusive lower bounds):
//       upgrades >= TRANSPORT_TIER_THRESHOLDS.juggernaut          → 'juggernaut'
//       truck <= upgrades < juggernaut                            → 'truck'
//       0 <= upgrades < truck                                     → 'van'
//   - MONOTONICITY: for a <= b, tierRank(transportTier(a)) <= tierRank(transportTier(b))
//     where van < truck < juggernaut; an upgrade never lowers the tier (Req 14.5).
//
// The thresholds are used symbolically (TRANSPORT_TIER_THRESHOLDS) so this test
// stays correct if the numeric boundaries are retuned, as long as they remain
// ordered van < truck < juggernaut (asserted below as a precondition).
// ---------------------------------------------------------------------------

const NUM_RUNS = 300;

const ALL_TIERS: readonly TransportTier[] = ['van', 'truck', 'juggernaut'];

/** Ordinal rank of a tier for monotonicity comparisons: van < truck < juggernaut. */
function tierRank(tier: TransportTier): number {
  return ALL_TIERS.indexOf(tier);
}

// The symbolic thresholds must stay strictly ordered for the mapping to be a
// well-formed total, monotonic step function. Guard it so a bad retune is caught.
const { van, truck, juggernaut } = TRANSPORT_TIER_THRESHOLDS;

/** Non-negative upgrade counts, spanning below/at/above every tier boundary. */
const arbUpgrades: fc.Arbitrary<number> = fc.integer({ min: 0, max: juggernaut + 20 });

describe('logistics transportTier mapping (Property 29, engine part)', () => {
  it('has strictly ordered symbolic thresholds (van < truck < juggernaut)', () => {
    expect(van).toBe(0);
    expect(van).toBeLessThan(truck);
    expect(truck).toBeLessThan(juggernaut);
  });

  it('is total: every upgrades >= 0 maps to exactly one of the three tiers (Req 14.3)', () => {
    fc.assert(
      fc.property(arbUpgrades, (upgrades) => {
        const tier = transportTier(upgrades);
        // Membership in the closed set of three tiers = exactly one tier returned.
        expect(ALL_TIERS).toContain(tier);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('respects the symbolic inclusive-lower-bound thresholds (Req 14.3)', () => {
    fc.assert(
      fc.property(arbUpgrades, (upgrades) => {
        const tier = transportTier(upgrades);
        if (upgrades >= juggernaut) {
          expect(tier).toBe('juggernaut');
        } else if (upgrades >= truck) {
          expect(tier).toBe('truck');
        } else {
          expect(tier).toBe('van');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is monotonic: for a <= b the tier never decreases (Req 14.5)', () => {
    fc.assert(
      fc.property(arbUpgrades, arbUpgrades, (x, y) => {
        const a = Math.min(x, y);
        const b = Math.max(x, y);
        expect(tierRank(transportTier(a))).toBeLessThanOrEqual(tierRank(transportTier(b)));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never lowers the tier when a single upgrade is added (Req 14.5)', () => {
    fc.assert(
      fc.property(arbUpgrades, (upgrades) => {
        expect(tierRank(transportTier(upgrades + 1))).toBeGreaterThanOrEqual(
          tierRank(transportTier(upgrades)),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
