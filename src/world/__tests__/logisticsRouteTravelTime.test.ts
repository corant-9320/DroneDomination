// Feature: oil-logistics-system, Property 17: Route travel time is a ceiling formula, >= 1, and monotone in steepness
/**
 * Property test for the route travel-time helper (`routeTravelTime`).
 *
 * Property 17: Route travel time is a ceiling formula, `>= 1`, and monotone in steepness.
 * Validates: Requirements 7.1, 7.2, 7.3, 7.6
 *
 * For arrays of non-negative Segment_Steepness values:
 *   - result === max(1, ceil(Σ (1 + s / MAX_STEEP_WHEELED)))          (Req 7.6 formula)
 *   - result is an integer `>= 1`, even for an empty array            (Req 7.3)
 *   - monotone non-decreasing: raising any segment's steepness, or adding a
 *     segment, never lowers the result — for equal-length A, B with
 *     B[i] >= A[i] for all i, routeTravelTime(B) >= routeTravelTime(A)  (Req 7.1, 7.2)
 *   - equal cumulative steepness → equal travel time                  (Req 7.2)
 *
 * MAX_STEEP_WHEELED is a specification constant imported symbolically (no pinned
 * values). Steepness values are drawn from [0, MAX_STEEP_WHEELED * 2] with noNaN,
 * covering the flat, up-to-max, and beyond-max ranges the formula must handle.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { routeTravelTime } from '../logistics.js';
import { MAX_STEEP_WHEELED } from '../../../shared/movementConstants.js';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generators — non-negative steepness values (radians) spanning the flat →
// beyond-maximally-steep range, and arrays thereof (a route's per-segment
// Segment_Steepness profile). minLength 0 exercises the empty-route case.
// ---------------------------------------------------------------------------

const arbSteepness: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: MAX_STEEP_WHEELED * 2,
  noNaN: true,
  noDefaultInfinity: true,
});

const arbProfile: fc.Arbitrary<number[]> = fc.array(arbSteepness, {
  minLength: 0,
  maxLength: 30,
});

// A non-empty profile plus a per-index non-negative delta, yielding two
// equal-length arrays A and B with B[i] = A[i] + delta[i] >= A[i] for all i.
const arbProfilePair: fc.Arbitrary<{ a: number[]; b: number[] }> = fc
  .array(
    fc.record({
      base: arbSteepness,
      delta: fc.double({ min: 0, max: MAX_STEEP_WHEELED, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 1, maxLength: 30 },
  )
  .map((entries) => ({
    a: entries.map((e) => e.base),
    b: entries.map((e) => e.base + e.delta),
  }));

describe('routeTravelTime (Property 17: ceiling formula, >= 1, monotone in steepness)', () => {
  it('equals max(1, ceil(Σ (1 + s / MAX_STEEP_WHEELED))) (Req 7.6)', () => {
    fc.assert(
      fc.property(arbProfile, (profile) => {
        const sum = profile.reduce((acc, s) => acc + (1 + s / MAX_STEEP_WHEELED), 0);
        const expected = Math.max(1, Math.ceil(sum));
        expect(routeTravelTime(profile)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is an integer >= 1 for any profile (Req 7.3)', () => {
    fc.assert(
      fc.property(arbProfile, (profile) => {
        const result = routeTravelTime(profile);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns >= 1 for the empty route (Req 7.3)', () => {
    expect(routeTravelTime([])).toBe(1);
    expect(Number.isInteger(routeTravelTime([]))).toBe(true);
  });

  it('never decreases when every segment steepness rises (Req 7.1, 7.2)', () => {
    fc.assert(
      fc.property(arbProfilePair, ({ a, b }) => {
        expect(routeTravelTime(b)).toBeGreaterThanOrEqual(routeTravelTime(a));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never decreases when a segment is appended to the route (Req 7.1)', () => {
    fc.assert(
      fc.property(arbProfile, arbSteepness, (profile, extra) => {
        const extended = [...profile, extra];
        expect(routeTravelTime(extended)).toBeGreaterThanOrEqual(routeTravelTime(profile));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('equal cumulative steepness gives equal travel time (Req 7.2)', () => {
    // Two profiles with the same cumulative Segment_Steepness must yield the same
    // Route_Travel_Time. A permutation shares the same multiset of values; because
    // floating-point addition is not associative, the reduced sums can differ by a
    // sub-ulp epsilon that straddles a ceil() boundary, so we require the two
    // cumulative sums to be exactly equal before asserting (the overwhelming
    // majority of cases, and always for equal-valued profiles).
    const cumulative = (p: number[]): number =>
      p.reduce((acc, s) => acc + (1 + s / MAX_STEEP_WHEELED), 0);
    fc.assert(
      fc.property(
        arbProfile.chain((profile) =>
          fc.tuple(
            fc.constant(profile),
            fc.shuffledSubarray(profile, {
              minLength: profile.length,
              maxLength: profile.length,
            }),
          ),
        ),
        ([original, permuted]) => {
          fc.pre(cumulative(original) === cumulative(permuted));
          expect(routeTravelTime(permuted)).toBe(routeTravelTime(original));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
