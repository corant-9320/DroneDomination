import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  graphDistance,
  tilesWithinRadius,
  findPath,
  type PathTile,
} from '../pathfinding.js';

/**
 * Path-validity invariants for the canonical shared pathfinding algorithms.
 *
 * Strategy: build random 2D grid graphs (4-neighbour adjacency) with optional
 * blocked tiles. Grids are small but varied so A* exercises its open-set,
 * gScore/fScore fallback, and reconstruction branches across many shapes.
 * No mocks — the real algorithms run on synthetic but fully-real graphs.
 */

// ---------------------------------------------------------------------------
// Synthetic grid graph
// ---------------------------------------------------------------------------

interface Grid {
  tiles: PathTile[];
  width: number;
  height: number;
}

/** Build a W×H grid graph with 4-neighbour adjacency. */
function buildGrid(width: number, height: number): Grid {
  const tiles: PathTile[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const neighbours: number[] = [];
      if (c > 0) neighbours.push(r * width + (c - 1));
      if (c < width - 1) neighbours.push(r * width + (c + 1));
      if (r > 0) neighbours.push((r - 1) * width + c);
      if (r < height - 1) neighbours.push((r + 1) * width + c);
      // Position on the unit sphere — distinct, normalized, valid for heuristic.
      const x = c + 1;
      const y = r + 1;
      const z = 1;
      const len = Math.sqrt(x * x + y * y + z * z);
      tiles.push({ neighbours, pos: [x / len, y / len, z / len] });
    }
  }
  return { tiles, width, height };
}

const arbGrid = fc
  .tuple(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 2, max: 6 }))
  .map(([width, height]) => buildGrid(width, height));

/** A grid plus a valid from/to index pair and a set of blocked tiles. */
const arbScenario = arbGrid.chain((grid) => {
  const n = grid.tiles.length;
  return fc
    .record({
      from: fc.integer({ min: 0, max: n - 1 }),
      to: fc.integer({ min: 0, max: n - 1 }),
      blocked: fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), {
        maxLength: Math.floor(n / 2),
      }),
    })
    .map(({ from, to, blocked }) => {
      // Never block the endpoints — keeps the scenario meaningful.
      const blockedSet = new Set(blocked.filter((b) => b !== from && b !== to));
      return { grid, from, to, blockedSet };
    });
});

function assertContiguous(tiles: PathTile[], path: number[]): void {
  for (let i = 1; i < path.length; i++) {
    expect(tiles[path[i - 1]].neighbours).toContain(path[i]);
  }
}

describe('shared/pathfinding path-validity invariants', () => {
  // Feature: unit-test-coverage, a returned path is contiguous (each step is a neighbour of the previous)
  it('returned path is contiguous', () => {
    fc.assert(
      fc.property(arbScenario, ({ grid, from, to }) => {
        const path = findPath(grid.tiles, from, to);
        if (path === null) return;
        assertContiguous(grid.tiles, path);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, a returned path starts at `from` and ends at `to`
  it('returned path starts at from and ends at to', () => {
    fc.assert(
      fc.property(arbScenario, ({ grid, from, to }) => {
        const path = findPath(grid.tiles, from, to);
        if (path === null) return;
        expect(path[0]).toBe(from);
        expect(path[path.length - 1]).toBe(to);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, a returned path never revisits a tile
  it('returned path has no repeated tiles', () => {
    fc.assert(
      fc.property(arbScenario, ({ grid, from, to }) => {
        const path = findPath(grid.tiles, from, to);
        if (path === null) return;
        expect(new Set(path).size).toBe(path.length);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, a returned path never steps onto an impassable (blocked) tile
  it('returned path respects blocked tiles', () => {
    fc.assert(
      fc.property(arbScenario, ({ grid, from, to, blockedSet }) => {
        const costFn = (t: PathTile): number =>
          blockedSet.has(grid.tiles.indexOf(t)) ? Infinity : 1;
        const path = findPath(grid.tiles, from, to, costFn);
        if (path === null) return;
        // The start may be queried but blocked tiles are never entered as steps.
        for (const idx of path) {
          if (idx === from) continue;
          expect(blockedSet.has(idx)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, a found uniform-cost path is never shorter than the BFS shortest distance
  it('uniform-cost path length is at least the BFS graph distance', () => {
    fc.assert(
      fc.property(arbScenario, ({ grid, from, to }) => {
        const path = findPath(grid.tiles, from, to);
        const dist = graphDistance(grid.tiles, from, to);
        if (path === null) {
          expect(dist).toBe(-1);
          return;
        }
        expect(dist).toBeGreaterThanOrEqual(0);
        // hops = nodes - 1; a valid path can never beat the true shortest path.
        expect(path.length - 1).toBeGreaterThanOrEqual(dist);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, blocking all neighbours of the source yields no path
  it('returns null when the source is fully walled off', () => {
    fc.assert(
      fc.property(arbScenario, ({ grid, from, to }) => {
        if (from === to) return;
        const neighbourSet = new Set(grid.tiles[from].neighbours);
        const costFn = (t: PathTile): number =>
          neighbourSet.has(grid.tiles.indexOf(t)) ? Infinity : 1;
        expect(findPath(grid.tiles, from, to, costFn)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});

describe('shared/pathfinding distance invariants', () => {
  // Feature: unit-test-coverage, graph distance to self is always zero
  it('graphDistance to self is 0', () => {
    fc.assert(
      fc.property(
        arbGrid,
        fc.nat(),
        (grid, raw) => {
          const idx = raw % grid.tiles.length;
          expect(graphDistance(grid.tiles, idx, idx)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, tilesWithinRadius distances never exceed the radius and the centre is distance 0
  it('tilesWithinRadius respects the radius bound', () => {
    fc.assert(
      fc.property(
        arbGrid,
        fc.nat(),
        fc.integer({ min: 0, max: 6 }),
        (grid, raw, radius) => {
          const centre = raw % grid.tiles.length;
          const result = tilesWithinRadius(grid.tiles, centre, radius);
          expect(result.get(centre)).toBe(0);
          for (const dist of result.values()) {
            expect(dist).toBeGreaterThanOrEqual(0);
            expect(dist).toBeLessThanOrEqual(radius);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
