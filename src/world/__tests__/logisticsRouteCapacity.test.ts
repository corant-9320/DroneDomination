import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createRoute, upgradeRoute, upgradeRouteCapacity } from '../logistics.js';
import type { LogisticsRoute, LogisticsTile } from '../../../shared/logisticsTypes.js';
import {
  ROUTE_CAPACITY_MAX,
  ROUTE_CAPACITY_MIN,
  ROUTE_CAPACITY_STEP,
} from '../../../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 14: Route creation, capacity bounds,
// and upgrade steps
// Validates: Requirements 6.1, 6.4, 6.5, 6.7, 6.8
//
// createRoute(init, tiles) : LogisticsRoute
//   - capacity === ROUTE_CAPACITY_MIN, tier === 'road', operable === true    (Req 6.1, 6.4)
//   - segments deep-equal the supplied path (fresh array, no aliasing)        (Req 6.1)
//   - travelTime is a whole number of turns >= 1                              (Req 6.1)
//
// upgradeRouteCapacity(cap) : number | Error                                  (Req 6.7, 6.8)
//   - cap <  MAX → min(MAX, cap + STEP), always within [MIN, MAX]
//   - cap >= MAX → Error (capacity unchanged by the caller)
//   - repeated from MIN increases by STEP each step until MAX, then Errors
//
// upgradeRoute(route) : LogisticsRoute | Error                               (Req 6.7, 6.8)
//   - below MAX → new route, tier 'highway', capacity bumped, never over MAX
//   - at MAX    → Error and the input route is left unmutated
//   - every reachable capacity stays within [MIN, MAX]                        (Req 6.5)
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

// The number of upgrade steps from MIN to MAX (100 → 1000 by 100 = 9 steps).
const STEPS_TO_MAX = (ROUTE_CAPACITY_MAX - ROUTE_CAPACITY_MIN) / ROUTE_CAPACITY_STEP;

/**
 * Build a minimal, contiguous linear chain of `length` tiles (path 0..length-1).
 * Each tile's `neighbours` point at its path-adjacent tiles and its `segSteep`
 * gives every face the same `steep` value, so `routeSteepnessProfile` recovers a
 * well-defined per-segment steepness for `createRoute`'s travel-time computation.
 */
function makeChain(length: number, steep: number): LogisticsTile[] {
  return Array.from({ length }, (_, k) => {
    const neighbours: number[] = [];
    if (k > 0) neighbours.push(k - 1);
    if (k < length - 1) neighbours.push(k + 1);
    return {
      index: k,
      neighbours,
      terrainType: 'plains',
      height: 0,
      forested: false,
      // One steepness entry per face; equal values keep the segment mean = steep.
      segSteep: neighbours.map(() => steep),
    };
  });
}

/** A LogisticsRoute fixture at a chosen capacity/tier for upgrade testing. */
function makeRoute(capacity: number, tier: 'road' | 'highway'): LogisticsRoute {
  return {
    id: 'route-fixture',
    ownerId: 'faction-a',
    fromStructureId: 'well-1',
    toStructureId: 'city-1',
    segments: [0, 1, 2],
    capacity,
    tier,
    travelTime: 3,
    operable: true,
  };
}

const arbPathLength = fc.integer({ min: 1, max: 8 });
// Steepness from flat up to well past the wheeled gate; only affects travelTime.
const arbSteep = fc.double({ min: 0, max: 0.66, noNaN: true });
// Capacities aligned to the upgrade grid: MIN + k*STEP for k in 0..STEPS_TO_MAX.
const arbStepIndex = fc.integer({ min: 0, max: STEPS_TO_MAX });
// Arbitrary in-range capacities (not necessarily grid-aligned) for bounds checks.
const arbCapacity = fc.integer({ min: ROUTE_CAPACITY_MIN, max: ROUTE_CAPACITY_MAX });

describe('logistics route creation & capacity bounds (Property 14)', () => {
  it('createRoute starts at MIN capacity, road tier, operable, with travelTime >= 1 and segments = path (Req 6.1, 6.4)', () => {
    fc.assert(
      fc.property(arbPathLength, arbSteep, (length, steep) => {
        const tiles = makeChain(length, steep);
        const path = tiles.map((t) => t.index);
        const route = createRoute(
          {
            id: 'r1',
            ownerId: 'faction-a',
            fromStructureId: 'well-1',
            toStructureId: 'city-1',
            path,
          },
          tiles,
        );

        // Req 6.4 — a new Road opens at the base capacity, rendered as a road.
        expect(route.capacity).toBe(ROUTE_CAPACITY_MIN);
        expect(route.tier).toBe('road');
        expect(route.operable).toBe(true);

        // Req 6.5 — the created capacity is within the allowed band.
        expect(route.capacity).toBeGreaterThanOrEqual(ROUTE_CAPACITY_MIN);
        expect(route.capacity).toBeLessThanOrEqual(ROUTE_CAPACITY_MAX);

        // Req 6.1 — segments follow the supplied path exactly, as a fresh array.
        expect(route.segments).toEqual(path);
        expect(route.segments).not.toBe(path);

        // Endpoints/owner carried through unchanged.
        expect(route.ownerId).toBe('faction-a');
        expect(route.fromStructureId).toBe('well-1');
        expect(route.toStructureId).toBe('city-1');

        // Req 6.1 — travelTime is a whole number of turns >= 1.
        expect(Number.isInteger(route.travelTime)).toBe(true);
        expect(route.travelTime).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('upgradeRouteCapacity bumps by STEP within [MIN, MAX] and Errors at MAX (Req 6.5, 6.7, 6.8)', () => {
    fc.assert(
      fc.property(arbCapacity, (cap) => {
        const result = upgradeRouteCapacity(cap);

        if (cap >= ROUTE_CAPACITY_MAX) {
          // Req 6.8 — at the maximum the upgrade is rejected.
          expect(result).toBeInstanceOf(Error);
          return;
        }

        // Req 6.7 — below the maximum, capacity rises by one step, clamped to MAX.
        expect(result).toBe(Math.min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP));
        // Req 6.5 — the result never leaves the allowed band.
        const next = result as number;
        expect(next).toBeGreaterThanOrEqual(ROUTE_CAPACITY_MIN);
        expect(next).toBeLessThanOrEqual(ROUTE_CAPACITY_MAX);
        // A single step never overshoots the maximum.
        expect(next).toBeLessThanOrEqual(cap + ROUTE_CAPACITY_STEP);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('grid-aligned capacities upgrade by exactly one STEP until MAX (Req 6.7, 6.8)', () => {
    fc.assert(
      fc.property(arbStepIndex, (k) => {
        const cap = ROUTE_CAPACITY_MIN + k * ROUTE_CAPACITY_STEP;

        if (cap >= ROUTE_CAPACITY_MAX) {
          expect(upgradeRouteCapacity(cap)).toBeInstanceOf(Error);
        } else {
          // Grid-aligned below MAX: increases by exactly one full step.
          expect(upgradeRouteCapacity(cap)).toBe(cap + ROUTE_CAPACITY_STEP);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('repeated upgradeRouteCapacity from MIN increases by STEP each turn until MAX, then Errors (Req 6.7, 6.8)', () => {
    let cap = ROUTE_CAPACITY_MIN;
    for (let i = 0; i < STEPS_TO_MAX; i++) {
      const next = upgradeRouteCapacity(cap);
      expect(next).not.toBeInstanceOf(Error);
      expect(next).toBe(cap + ROUTE_CAPACITY_STEP);
      cap = next as number;
      // Req 6.5 — never leaves the band on the way up.
      expect(cap).toBeLessThanOrEqual(ROUTE_CAPACITY_MAX);
      expect(cap).toBeGreaterThanOrEqual(ROUTE_CAPACITY_MIN);
    }
    // Reached the maximum exactly; a further upgrade is rejected.
    expect(cap).toBe(ROUTE_CAPACITY_MAX);
    expect(upgradeRouteCapacity(cap)).toBeInstanceOf(Error);
  });
});

describe('logistics route upgrade to highway (Property 14)', () => {
  it('upgradeRoute renders a highway, bumps capacity within [MIN, MAX], and never mutates the input (Req 6.5, 6.7)', () => {
    fc.assert(
      fc.property(arbStepIndex, (k) => {
        const cap = ROUTE_CAPACITY_MIN + k * ROUTE_CAPACITY_STEP;
        const route = makeRoute(cap, 'road');
        const snapshot = JSON.parse(JSON.stringify(route)) as LogisticsRoute;

        const result = upgradeRoute(route);

        if (cap >= ROUTE_CAPACITY_MAX) {
          // Req 6.8 — at MAX the upgrade is rejected and the route is untouched.
          expect(result).toBeInstanceOf(Error);
          expect(route).toEqual(snapshot);
          return;
        }

        // Req 6.7 — upgraded route is a highway with a bumped capacity.
        const upgraded = result as LogisticsRoute;
        expect(upgraded.tier).toBe('highway');
        expect(upgraded.capacity).toBe(Math.min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP));
        // Req 6.5 — capacity stays within the allowed band.
        expect(upgraded.capacity).toBeGreaterThanOrEqual(ROUTE_CAPACITY_MIN);
        expect(upgraded.capacity).toBeLessThanOrEqual(ROUTE_CAPACITY_MAX);
        // Non-capacity/tier fields are preserved; input is not mutated.
        expect(route).toEqual(snapshot);
        expect(upgraded.id).toBe(route.id);
        expect(upgraded.segments).toEqual(route.segments);
        expect(upgraded.operable).toBe(route.operable);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('repeated upgradeRoute never exceeds MAX and Errors once at MAX (Req 6.5, 6.8)', () => {
    let route: LogisticsRoute = makeRoute(ROUTE_CAPACITY_MIN, 'road');
    for (let i = 0; i < STEPS_TO_MAX; i++) {
      const result = upgradeRoute(route);
      expect(result).not.toBeInstanceOf(Error);
      route = result as LogisticsRoute;
      expect(route.tier).toBe('highway');
      // Every reachable capacity stays within the band and never overshoots MAX.
      expect(route.capacity).toBeGreaterThanOrEqual(ROUTE_CAPACITY_MIN);
      expect(route.capacity).toBeLessThanOrEqual(ROUTE_CAPACITY_MAX);
    }
    expect(route.capacity).toBe(ROUTE_CAPACITY_MAX);
    // At MAX the next upgrade Errors and leaves the route unchanged.
    const atMax = JSON.parse(JSON.stringify(route)) as LogisticsRoute;
    expect(upgradeRoute(route)).toBeInstanceOf(Error);
    expect(route).toEqual(atMax);
  });
});
