// Feature: shuttle-transport, regression + property coverage for
// findExistingRoadPath (src/world/logistics/routes.ts) and advanceShuttle
// (src/world/logistics/shuttle.ts).
//
// Regression: creating a shuttle transport must succeed when the two
// structures are connected ONLY by a development standalone-road overlay
// (logistics.standaloneRoadSegments) — not just a real LogisticsRoute. The
// original bug rejected "no road connects those two structures" even when a
// visible road existed, because the check only searched `logistics.routes`.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { findExistingRoadPath } from '../logistics/routes.js';
import { advanceShuttle, createShuttleTransport } from '../logistics/shuttle.js';
import type { LogisticsTile } from '../../../shared/logisticsTypes.js';
import { encodeSeg } from '../../../shared/segmentGraph.js';

const SEGMENT_COUNT = 6;

/** A linear chain of hex tiles: tile i is adjacent to i-1 and i+1. */
function makeChain(n: number): LogisticsTile[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    neighbours: [i - 1, i + 1].filter((x) => x >= 0 && x < n),
    terrainType: 'plains',
    height: 1,
    forested: false,
    segSteep: new Array<number>(SEGMENT_COUNT).fill(0),
  }));
}

/**
 * A genuinely segment-graph-adjacent path of encoded keys along the chain
 * from tile 0 to tile n-1, inclusive — the arrival face on each intermediate
 * tile plus (when it differs) the intra-hex pivot to the departure face
 * toward the next tile, mirroring how a real route path is realized.
 */
function chainRoadKeys(n: number): number[] {
  const tiles = makeChain(n);
  if (n === 1) return [encodeSeg(0, 0)];
  const keys: number[] = [encodeSeg(0, tiles[0].neighbours.indexOf(1))];
  for (let i = 1; i < n; i++) {
    const arrival = tiles[i].neighbours.indexOf(i - 1);
    keys.push(encodeSeg(i, arrival));
    if (i < n - 1) {
      const departure = tiles[i].neighbours.indexOf(i + 1);
      if (departure !== arrival) keys.push(encodeSeg(i, departure));
    }
  }
  return keys;
}

describe('findExistingRoadPath', () => {
  it('regression: connects two structures via a standalone-road overlay only (no LogisticsRoute)', () => {
    const n = 5;
    const tiles = makeChain(n);
    const roadKeys = chainRoadKeys(n);

    // The well sits on tile 0's own segment (not part of the road); the
    // refinery sits on tile (n-1)'s own segment — mirrors how a structure's
    // footprint segment is typically distinct from the adjacent road segment.
    const wellFootprint = [{ tileIndex: 0, segment: (tiles[0].neighbours.indexOf(1) + 1) % SEGMENT_COUNT }];
    const refineryFootprint = [{ tileIndex: n - 1, segment: (tiles[n - 1].neighbours.indexOf(n - 2) + 1) % SEGMENT_COUNT }];

    // No LogisticsRoute at all — only the standalone overlay.
    const path = findExistingRoadPath(tiles, [], roadKeys, wellFootprint, refineryFootprint);

    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null when no road connects the two structures', () => {
    const n = 5;
    const tiles = makeChain(n);
    const wellFootprint = [{ tileIndex: 0, segment: 0 }];
    const refineryFootprint = [{ tileIndex: n - 1, segment: 0 }];

    const path = findExistingRoadPath(tiles, [], [], wellFootprint, refineryFootprint);
    expect(path).toBeNull();
  });

  it('finds a path when the road is split across a LogisticsRoute and a standalone overlay', () => {
    const n = 7;
    const tiles = makeChain(n);
    const allKeys = chainRoadKeys(n);
    const half = Math.floor(allKeys.length / 2);
    const routeSegments = allKeys.slice(0, half);
    const standalone = allKeys.slice(half);

    const wellFootprint = [{ tileIndex: 0, segment: 0 }];
    const refineryFootprint = [{ tileIndex: n - 1, segment: 0 }];
    const path = findExistingRoadPath(tiles, [routeSegments], standalone, wellFootprint, refineryFootprint);
    expect(path).not.toBeNull();
  });

  it('property: any connected chain of road segments yields a non-null path between its ends', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (n) => {
        const tiles = makeChain(n);
        const roadKeys = chainRoadKeys(n);
        const fromFootprint = [{ tileIndex: 0, segment: roadKeys[0] % SEGMENT_COUNT }];
        const lastKey = roadKeys[roadKeys.length - 1];
        const toFootprint = [{ tileIndex: n - 1, segment: lastKey % SEGMENT_COUNT }];
        const path = findExistingRoadPath(tiles, [], roadKeys, fromFootprint, toFootprint);
        expect(path).not.toBeNull();
      }),
      { numRuns: 50 },
    );
  });
});

describe('advanceShuttle', () => {
  const path = chainRoadKeys(6); // 6-node path, indices 0..5

  it('starts at position 0, direction forward', () => {
    const t = createShuttleTransport({
      id: 't1', ownerId: 'p1', shuttlePath: path, cargoCapacity: 5, speed: 1, defence: 1, unitId: 't1-unit',
    });
    expect(t.shuttlePosition).toBe(0);
    expect(t.shuttleDirection).toBe(1);
    expect(t.shuttleMode).toBe(true);
    expect(t.cargo).toBe(0);
    expect(t.cargoType).toBeNull();
  });

  it('advances forward and reverses at the far end', () => {
    const lastIndex = path.length - 1;
    let t = createShuttleTransport({
      id: 't1', ownerId: 'p1', shuttlePath: path, cargoCapacity: 5, speed: 1, defence: 1, unitId: 't1-unit',
    });
    // Advancing exactly to the last index lands there, still travelling forward.
    t = advanceShuttle(t, lastIndex);
    expect(t.shuttlePosition).toBe(lastIndex);
    expect(t.shuttleDirection).toBe(1);

    // One step past the end reflects in place: direction flips to -1, position
    // stays at the boundary (the reflecting step itself doesn't move it).
    t = advanceShuttle(t, 1);
    expect(t.shuttlePosition).toBe(lastIndex);
    expect(t.shuttleDirection).toBe(-1);

    // The following step actually moves away from the boundary.
    t = advanceShuttle(t, 1);
    expect(t.shuttlePosition).toBe(lastIndex - 1);
    expect(t.shuttleDirection).toBe(-1);
  });

  it('never moves once shuttleStopped is set', () => {
    let t = createShuttleTransport({
      id: 't1', ownerId: 'p1', shuttlePath: path, cargoCapacity: 5, speed: 1, defence: 1, unitId: 't1-unit',
    });
    t = { ...t, shuttleStopped: true };
    const before = { ...t };
    t = advanceShuttle(t, 5);
    expect(t).toEqual(before);
  });

  it('property: position always stays within [0, path.length - 1]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 20 }), (n, steps) => {
        const p = chainRoadKeys(n);
        let t = createShuttleTransport({
          id: 't1', ownerId: 'p1', shuttlePath: p, cargoCapacity: 5, speed: 1, defence: 1, unitId: 't1-unit',
        });
        for (const step of steps) {
          t = advanceShuttle(t, step);
          expect(t.shuttlePosition).toBeGreaterThanOrEqual(0);
          expect(t.shuttlePosition).toBeLessThanOrEqual(p.length - 1);
        }
      }),
      { numRuns: 50 },
    );
  });
});
