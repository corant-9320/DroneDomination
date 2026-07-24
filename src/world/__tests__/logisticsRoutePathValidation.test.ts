// Feature: oil-logistics-system, Property 15: Untraversable paths and invalid endpoints are rejected
//
// Validates: Requirements 6.2, 6.3, 9.2, 10.4, 10.5
//
// Property-based test for `validateRoutePath` (src/world/logistics/routes.ts). A route is
// admitted ONLY when both endpoints are valid and the path is physically traversable:
//   - each endpoint kind is a well / refinery / home-city                (Req 6.2)
//   - the two endpoints are distinct structures                          (Req 6.2)
//   - both endpoints belong to the same player                           (Req 6.2)
//   - the path is a contiguous line of adjacent tiles                    (Req 6.1)
//   - no tile is an uncleared Forest_Tile                                (Req 6.3, 9.2)
//   - no tile is unbridged Impassable_Terrain                            (Req 6.3, 10.5)
//   - a cleared forest and a bridged impassable tile are BOTH accepted   (Req 10.4)
// and it rejects with the documented reason otherwise, never mutating its inputs.
//
// No pinned formula values: impassability is decided by the shared
// `isImpassableTerrain` classifier, exercised via terrainType 'ocean'.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { validateRoutePath } from '../logistics/routes.js';
import type { RouteEndpoint, RouteEndpointKind, RouteEndpoints } from '../logistics/routes.js';
import type {
  LogisticsContext,
  LogisticsState,
  LogisticsTile,
} from '../../../shared/logisticsTypes.js';
import { encodeSeg } from '../../../shared/segmentGraph.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = 'p1';
const OTHER = 'p2';
const VALID_KINDS: readonly RouteEndpointKind[] = ['well', 'refinery', 'hub', 'home-city'];
const SEGMENT_COUNT = 6; // a hex

interface TileSpec {
  terrainType: string; // 'plains' (land) | 'ocean' (impassable)
  forested: boolean;
}

/** Build a linear chain of tiles: tile i is adjacent to i-1 and i+1 (Req 6.1). */
function makeChain(specs: readonly TileSpec[], breakAt = -1): LogisticsTile[] {
  return specs.map((spec, i) => {
    const neighbours = [i - 1, i + 1].filter((n) => n >= 0 && n < specs.length);
    // `breakAt` severs the adjacency between (breakAt-1) and breakAt to force a
    // non-contiguous step while keeping every tile in existence.
    const pruned = neighbours.filter(
      (n) => !((i === breakAt && n === breakAt - 1) || (i === breakAt - 1 && n === breakAt)),
    );
    return {
      index: i,
      neighbours: pruned,
      terrainType: spec.terrainType,
      height: 3,
      forested: spec.forested,
      segSteep: new Array<number>(SEGMENT_COUNT).fill(0),
    };
  });
}

function makeState(clearedForests: number[], bridges: number[]): LogisticsState {
  return {
    wells: [],
    refineries: [],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests,
    bridges,
  };
}

function makeContext(
  specs: readonly TileSpec[],
  clearedForests: number[] = [],
  bridges: number[] = [],
  breakAt = -1,
): LogisticsContext {
  return { tiles: makeChain(specs, breakAt), state: makeState(clearedForests, bridges) };
}

function endpoint(
  structureId: string,
  kind: RouteEndpointKind,
  tileIndex: number,
  ownerId: string,
): RouteEndpoint {
  return { structureId, kind, tileIndex, ownerId };
}

/** Endpoints seated at the two ends of a length-`n` path (path[0]=0, path[last]=n-1). */
function endpointsFor(
  n: number,
  fromKind: RouteEndpointKind,
  toKind: RouteEndpointKind,
  fromOwner = OWNER,
  toOwner = OWNER,
  fromId = 'A',
  toId = 'B',
): RouteEndpoints {
  return {
    from: endpoint(fromId, fromKind, 0, fromOwner),
    to: endpoint(toId, toKind, n - 1, toOwner),
  };
}

const linearPath = (n: number): number[] => {
  if (n === 0) return [];
  const tiles = Array.from({ length: n }, (_, i) => ({
    sides: SEGMENT_COUNT,
    neighbours: [i - 1, i + 1].filter((x) => x >= 0 && x < n),
  }));
  if (n === 1) return [encodeSeg(0, 0)];

  // Cross each requested tile edge, adding the one intra-tile pivot needed on
  // intermediate chain tiles (arrival face -> departure face).
  const path: number[] = [encodeSeg(0, tiles[0].neighbours.indexOf(1))];
  for (let tileIndex = 1; tileIndex < n; tileIndex++) {
    const arrival = tiles[tileIndex].neighbours.indexOf(tileIndex - 1);
    path.push(encodeSeg(tileIndex, arrival));
    if (tileIndex < n - 1) {
      const departure = tiles[tileIndex].neighbours.indexOf(tileIndex + 1);
      if (departure !== arrival) path.push(encodeSeg(tileIndex, departure));
    }
  }
  return path;
};
const allPlains = (n: number): TileSpec[] =>
  Array.from({ length: n }, () => ({ terrainType: 'plains', forested: false }));

const RUNS = { numRuns: 150 } as const;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbKind = fc.constantFrom<RouteEndpointKind>(...VALID_KINDS);
// A length long enough that at least two distinct interior tiles exist.
const arbLen = fc.integer({ min: 4, max: 7 });

// A path length paired with an offender tile index anywhere along the path (ends
// included), so the property varies which tile carries the untraversable feature.
const arbLenAndOffender = arbLen.chain((n) =>
  fc.integer({ min: 0, max: n - 1 }).map((offender) => ({ n, offender })),
);
// A path length paired with an interior break point (1..n-1) used to sever adjacency.
const arbLenAndBreak = arbLen.chain((n) =>
  fc.integer({ min: 1, max: n - 1 }).map((breakAt) => ({ n, breakAt })),
);

// ---------------------------------------------------------------------------
// Property 15: Untraversable paths and invalid endpoints are rejected
// ---------------------------------------------------------------------------

describe('validateRoutePath — Property 15: untraversable paths and invalid endpoints', () => {
  it('rejects identical endpoints (same structureId) with reason "invalid-endpoints" (Req 6.2)', () => {
    fc.assert(
      fc.property(arbLen, arbKind, arbKind, fc.string({ minLength: 1 }), (n, k1, k2, id) => {
        const ctx = makeContext(allPlains(n));
        const endpoints = endpointsFor(n, k1, k2, OWNER, OWNER, id, id);
        const result = validateRoutePath(ctx, linearPath(n), endpoints);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('invalid-endpoints');
      }),
      RUNS,
    );
  });

  it('rejects an endpoint whose kind is not well/refinery/hub/home-city → "invalid-endpoints" (Req 6.2)', () => {
    const arbBadKind = fc
      .constantFrom('city', 'depot', 'oil-well', 'homecity', '')
      .map((k) => k as RouteEndpointKind);
    fc.assert(
      fc.property(arbLen, arbBadKind, arbKind, fc.boolean(), (n, badKind, goodKind, badIsFrom) => {
        const ctx = makeContext(allPlains(n));
        const endpoints = badIsFrom
          ? endpointsFor(n, badKind, goodKind)
          : endpointsFor(n, goodKind, badKind);
        const result = validateRoutePath(ctx, linearPath(n), endpoints);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('invalid-endpoints');
      }),
      RUNS,
    );
  });

  it('rejects endpoints owned by different players → "invalid-endpoints" (Req 6.2)', () => {
    fc.assert(
      fc.property(arbLen, arbKind, arbKind, (n, k1, k2) => {
        const ctx = makeContext(allPlains(n));
        const endpoints = endpointsFor(n, k1, k2, OWNER, OTHER);
        const result = validateRoutePath(ctx, linearPath(n), endpoints);
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('invalid-endpoints');
      }),
      RUNS,
    );
  });

  it('rejects a path crossing an uncleared forest tile → "path-not-traversable" (Req 6.3, 9.2)', () => {
    fc.assert(
      fc.property(arbLenAndOffender, arbKind, arbKind, ({ n, offender }, k1, k2) => {
        const specs = allPlains(n);
        specs[offender] = { terrainType: 'plains', forested: true };
        // Not added to clearedForests → still an uncleared forest.
        const ctx = makeContext(specs);
        const result = validateRoutePath(ctx, linearPath(n), endpointsFor(n, k1, k2));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('path-not-traversable');
      }),
      RUNS,
    );
  });

  it('rejects a path crossing an unbridged impassable tile → "path-not-traversable" (Req 6.3, 10.5)', () => {
    fc.assert(
      fc.property(arbLenAndOffender, arbKind, arbKind, ({ n, offender }, k1, k2) => {
        const specs = allPlains(n);
        specs[offender] = { terrainType: 'ocean', forested: false };
        // Not added to bridges → still unbridged impassable terrain.
        const ctx = makeContext(specs);
        const result = validateRoutePath(ctx, linearPath(n), endpointsFor(n, k1, k2));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('path-not-traversable');
      }),
      RUNS,
    );
  });

  it('rejects a non-contiguous path (a step between non-adjacent tiles) → "path-not-traversable" (Req 6.1)', () => {
    fc.assert(
      // Sever adjacency at an interior step so path[break-1]→path[break] jumps.
      fc.property(arbLenAndBreak, arbKind, arbKind, ({ n, breakAt }, k1, k2) => {
        const ctx = makeContext(allPlains(n), [], [], breakAt);
        const result = validateRoutePath(ctx, linearPath(n), endpointsFor(n, k1, k2));
        expect(result.legal).toBe(false);
        expect(result.reason).toBe('path-not-traversable');
      }),
      RUNS,
    );
  });

  it('accepts a contiguous path over cleared-forest and bridged tiles between valid same-owner endpoints (Req 10.4)', () => {
    // Interior positions for the cleared forest and the bridged impassable tile.
    const arbPositions = arbLen.chain((n) =>
      fc
        .tuple(fc.integer({ min: 1, max: n - 2 }), fc.integer({ min: 1, max: n - 2 }))
        .filter(([a, b]) => a !== b)
        .map(([forestPos, bridgePos]) => ({ n, forestPos, bridgePos })),
    );
    fc.assert(
      fc.property(arbPositions, arbKind, arbKind, ({ n, forestPos, bridgePos }, k1, k2) => {
        const specs = allPlains(n);
        // A cleared forest: forested but recorded in clearedForests (Req 9.2/10.4).
        specs[forestPos] = { terrainType: 'plains', forested: true };
        // A bridged impassable tile: 'ocean' recorded in bridges (Req 10.5/10.4).
        specs[bridgePos] = { terrainType: 'ocean', forested: false };
        const ctx = makeContext(specs, [forestPos], [bridgePos]);
        // Distinct same-owner endpoints seated at the ends (0 and n-1, both plains).
        const result = validateRoutePath(ctx, linearPath(n), endpointsFor(n, k1, k2));
        expect(result.legal).toBe(true);
        expect(result.reason).toBeUndefined();
      }),
      RUNS,
    );
  });

  it('never mutates the context or endpoints', () => {
    fc.assert(
      fc.property(arbLen, arbKind, arbKind, (n, k1, k2) => {
        const specs = allPlains(n);
        specs[1] = { terrainType: 'ocean', forested: false };
        const ctx = makeContext(specs, [], []);
        const endpoints = endpointsFor(n, k1, k2);
        const ctxBefore = structuredClone(ctx);
        const endpointsBefore = structuredClone(endpoints);
        validateRoutePath(ctx, linearPath(n), endpoints);
        expect(ctx).toEqual(ctxBefore);
        expect(endpoints).toEqual(endpointsBefore);
      }),
      RUNS,
    );
  });
});
