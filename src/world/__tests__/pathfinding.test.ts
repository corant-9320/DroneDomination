import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { graphDistance, tilesWithinRadius, findPath } from '../tilePathfinding.js';
import type { Tile } from '../types.js';

/**
 * Build a minimal linear graph of tiles for testing:
 *   0 — 1 — 2 — 3 — 4
 */
function linearGraph(n: number): Tile[] {
  return Array.from({ length: n }, (_, i) => {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < n - 1) neighbours.push(i + 1);
    return {
      id: `tile_${i}`,
      index: i,
      sides: (neighbours.length === 1 ? 5 : 6) as 5 | 6,
      neighbours,
      position3d: { x: Math.cos((i / n) * Math.PI), y: Math.sin((i / n) * Math.PI), z: 0 },
      boundary: [],
      terrainType: 'plains' as const,
      height: 4,
      forested: false,
    };
  });
}

/**
 * Build a small ring graph: 0 — 1 — 2 — 3 — 4 — 0
 */
function ringGraph(n: number): Tile[] {
  return Array.from({ length: n }, (_, i) => {
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const angle = (2 * Math.PI * i) / n;
    return {
      id: `tile_${i}`,
      index: i,
      sides: 6 as 5 | 6,
      neighbours: [prev, next],
      position3d: { x: Math.cos(angle), y: Math.sin(angle), z: 0 },
      boundary: [],
      terrainType: 'plains' as const,
      height: 4,
      forested: false,
    };
  });
}

describe('pathfinding', () => {
  describe('graphDistance', () => {
    it('distance to self is 0', () => {
      const tiles = linearGraph(5);
      expect(graphDistance(tiles, 2, 2)).toBe(0);
    });

    it('adjacent tiles have distance 1', () => {
      const tiles = linearGraph(5);
      expect(graphDistance(tiles, 0, 1)).toBe(1);
    });

    it('computes correct multi-hop distance', () => {
      const tiles = linearGraph(5);
      expect(graphDistance(tiles, 0, 4)).toBe(4);
    });

    it('finds shortest path in a ring', () => {
      const tiles = ringGraph(6);
      // Going 0→1→2→3 = 3, but 0→5→4→3 = 3 as well
      expect(graphDistance(tiles, 0, 3)).toBe(3);
      // 0→5 = 1 (directly adjacent in ring)
      expect(graphDistance(tiles, 0, 5)).toBe(1);
    });

    it('returns -1 for disconnected graph', () => {
      // Two isolated tiles
      const tiles: Tile[] = [
        {
          id: 'a', index: 0, sides: 5, neighbours: [],
          position3d: { x: 1, y: 0, z: 0 }, boundary: [],
          terrainType: 'plains', height: 4, forested: false,
        },
        {
          id: 'b', index: 1, sides: 5, neighbours: [],
          position3d: { x: -1, y: 0, z: 0 }, boundary: [],
          terrainType: 'plains', height: 4, forested: false,
        },
      ];
      expect(graphDistance(tiles, 0, 1)).toBe(-1);
    });
  });

  describe('tilesWithinRadius', () => {
    it('radius 0 returns only the centre', () => {
      const tiles = linearGraph(5);
      const result = tilesWithinRadius(tiles, 2, 0);
      expect(result.size).toBe(1);
      expect(result.get(2)).toBe(0);
    });

    it('radius 1 returns centre and immediate neighbours', () => {
      const tiles = linearGraph(5);
      const result = tilesWithinRadius(tiles, 2, 1);
      expect(result.get(2)).toBe(0);
      expect(result.get(1)).toBe(1);
      expect(result.get(3)).toBe(1);
      expect(result.has(0)).toBe(false);
    });

    it('radius 2 on linear graph extends two steps', () => {
      const tiles = linearGraph(5);
      const result = tilesWithinRadius(tiles, 2, 2);
      expect(result.size).toBe(5); // all tiles reachable in 2 steps from centre of 5-tile line
      expect(result.get(0)).toBe(2);
      expect(result.get(4)).toBe(2);
    });

    it('distances are correct in ring', () => {
      const tiles = ringGraph(6);
      const result = tilesWithinRadius(tiles, 0, 2);
      expect(result.get(0)).toBe(0);
      expect(result.get(1)).toBe(1);
      expect(result.get(5)).toBe(1);
      expect(result.get(2)).toBe(2);
      expect(result.get(4)).toBe(2);
      expect(result.has(3)).toBe(false); // distance 3, out of radius
    });
  });

  describe('findPath', () => {
    it('path to self is [self]', () => {
      const tiles = linearGraph(5);
      expect(findPath(tiles, 2, 2)).toEqual([2]);
    });

    it('finds shortest path in linear graph', () => {
      const tiles = linearGraph(5);
      const path = findPath(tiles, 0, 4);
      expect(path).toEqual([0, 1, 2, 3, 4]);
    });

    it('finds path in ring graph', () => {
      const tiles = ringGraph(6);
      const path = findPath(tiles, 0, 3);
      // Either direction is 3 hops, both valid
      expect(path).not.toBeNull();
      expect(path!.length).toBe(4); // 4 nodes for 3 hops
      expect(path![0]).toBe(0);
      expect(path![path!.length - 1]).toBe(3);
    });

    it('respects cost function (avoids expensive tiles)', () => {
      const tiles = linearGraph(5);
      // Make tile 2 very expensive
      const path = findPath(tiles, 0, 4, (tile) =>
        tile.index === 2 ? 100 : 1
      );
      // In a linear graph there's no alternative, so it still goes through 2
      expect(path).not.toBeNull();
      expect(path).toContain(2);
    });

    it('returns null for impassable path', () => {
      const tiles = linearGraph(5);
      // Make middle tile impassable
      const path = findPath(tiles, 0, 4, (tile) =>
        tile.index === 2 ? Infinity : 1
      );
      expect(path).toBeNull();
    });

    it('returns null for disconnected tiles', () => {
      const tiles: Tile[] = [
        {
          id: 'a', index: 0, sides: 5, neighbours: [],
          position3d: { x: 1, y: 0, z: 0 }, boundary: [],
          terrainType: 'plains', height: 4, forested: false,
        },
        {
          id: 'b', index: 1, sides: 5, neighbours: [],
          position3d: { x: -1, y: 0, z: 0 }, boundary: [],
          terrainType: 'plains', height: 4, forested: false,
        },
      ];
      expect(findPath(tiles, 0, 1)).toBeNull();
    });
  });
});


// ---------------------------------------------------------------------------
// Path-validity invariants on the server Tile adapter (exercises the costFn
// adapter path in findPath that wraps shared findPath with index lookup).
// ---------------------------------------------------------------------------

/** Build a W×H grid of server Tiles with 4-neighbour adjacency. */
function tileGrid(width: number, height: number): Tile[] {
  const tiles: Tile[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const neighbours: number[] = [];
      if (c > 0) neighbours.push(r * width + (c - 1));
      if (c < width - 1) neighbours.push(r * width + (c + 1));
      if (r > 0) neighbours.push((r - 1) * width + c);
      if (r < height - 1) neighbours.push((r + 1) * width + c);
      const x = c + 1;
      const y = r + 1;
      const len = Math.sqrt(x * x + y * y + 1);
      tiles.push({
        id: `tile_${r}_${c}`,
        index: r * width + c,
        sides: 6,
        neighbours,
        position3d: { x: x / len, y: y / len, z: 1 / len },
        boundary: [],
        terrainType: 'plains',
        height: 4,
        forested: false,
      });
    }
  }
  return tiles;
}

const arbTileScenario = fc
  .tuple(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 2, max: 6 }))
  .chain(([width, height]) => {
    const n = width * height;
    return fc.record({
      tiles: fc.constant(tileGrid(width, height)),
      from: fc.integer({ min: 0, max: n - 1 }),
      to: fc.integer({ min: 0, max: n - 1 }),
      blocked: fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), {
        maxLength: Math.floor(n / 2),
      }),
    });
  })
  .map(({ tiles, from, to, blocked }) => ({
    tiles,
    from,
    to,
    blockedSet: new Set(blocked.filter((b) => b !== from && b !== to)),
  }));

describe('pathfinding path-validity invariants (Tile adapter)', () => {
  // Feature: unit-test-coverage, adapter path with a costFn is contiguous, correctly bounded, and avoids blocked tiles
  it('costFn path is contiguous, bounded, and avoids blocked tiles', () => {
    fc.assert(
      fc.property(arbTileScenario, ({ tiles, from, to, blockedSet }) => {
        const path = findPath(tiles, from, to, (t) =>
          blockedSet.has(t.index) ? Infinity : 1,
        );
        if (path === null) return;
        expect(path[0]).toBe(from);
        expect(path[path.length - 1]).toBe(to);
        for (let i = 1; i < path.length; i++) {
          expect(tiles[path[i - 1]].neighbours).toContain(path[i]);
        }
        for (const idx of path) {
          if (idx === from) continue;
          expect(blockedSet.has(idx)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: unit-test-coverage, a found uniform-cost adapter path is never shorter than the BFS distance
  it('uniform-cost path length is at least the graph distance', () => {
    fc.assert(
      fc.property(arbTileScenario, ({ tiles, from, to }) => {
        const path = findPath(tiles, from, to);
        const dist = graphDistance(tiles, from, to);
        if (path === null) {
          expect(dist).toBe(-1);
          return;
        }
        expect(path.length - 1).toBeGreaterThanOrEqual(dist);
      }),
      { numRuns: 200 },
    );
  });
});
