import { describe, it, expect } from 'vitest';
import {
  segmentNeighbours,
  findSegmentPath,
  segmentReachability,
  realizeTilePathOverSegments,
  farthestAffordablePrefix,
  buildSegmentOccupancy,
  encodeSeg,
  decodeSeg,
  NO_OCCUPANCY,
  type SegGraphTile,
} from '../segmentGraph.js';

/** Linear chain of hexes: 0 — 1 — 2 — 3 — 4. Segment 0 always faces "next". */
function linearTiles(n: number): SegGraphTile[] {
  return Array.from({ length: n }, (_, i) => {
    const neighbours: number[] = new Array<number>(6).fill(-1);
    if (i + 1 < n) neighbours[0] = i + 1;
    if (i - 1 >= 0) neighbours[3] = i - 1;
    return { sides: 6, neighbours };
  });
}

const flatCost = () => 1;

describe('segmentGraph — encode/decode', () => {
  it('round-trips tileIndex/segment through encodeSeg/decodeSeg', () => {
    const key = encodeSeg(42, 3);
    expect(decodeSeg(key)).toEqual({ tileIndex: 42, segment: 3 });
  });
});

describe('segmentGraph — segmentNeighbours', () => {
  it('returns 2 intra-hex + 1 cross-hex neighbour for an interior segment', () => {
    const tiles = linearTiles(3);
    const neighbours = segmentNeighbours(tiles, 1, 0);
    // Intra-hex: segments 1 and 5. Cross-hex: tile 2, facing segment (tile2.neighbours[3] === 1).
    expect(neighbours).toContainEqual({ tileIndex: 1, segment: 1 });
    expect(neighbours).toContainEqual({ tileIndex: 1, segment: 5 });
    expect(neighbours).toContainEqual({ tileIndex: 2, segment: 3 });
    expect(neighbours.length).toBe(3);
  });

  it('omits the cross-hex neighbour at a map edge (no neighbour on that face)', () => {
    const tiles = linearTiles(3);
    // Tile 2 is the last tile; segment 0 has no neighbour (n[0] === -1, out of range).
    const neighbours = segmentNeighbours(tiles, 2, 0);
    expect(neighbours.length).toBe(2);
    expect(neighbours).toContainEqual({ tileIndex: 2, segment: 1 });
    expect(neighbours).toContainEqual({ tileIndex: 2, segment: 5 });
  });
});

describe('segmentGraph — findSegmentPath', () => {
  it('finds a direct path across two hexes', () => {
    const tiles = linearTiles(2);
    const r = findSegmentPath(tiles, { tileIndex: 0, segment: 0 }, { tileIndex: 1, segment: 3 }, flatCost, NO_OCCUPANCY);
    expect(r).not.toBeNull();
    expect(r!.path[0]).toEqual({ tileIndex: 0, segment: 0 });
    expect(r!.path[r!.path.length - 1]).toEqual({ tileIndex: 1, segment: 3 });
  });

  it('returns cost 0 and a 1-node path when from === to', () => {
    const tiles = linearTiles(2);
    const r = findSegmentPath(tiles, { tileIndex: 0, segment: 2 }, { tileIndex: 0, segment: 2 }, flatCost, NO_OCCUPANCY);
    expect(r).toEqual({ path: [{ tileIndex: 0, segment: 2 }], cost: 0 });
  });

  it('routes around an occupied segment to reach an adjacent open one', () => {
    const tiles = linearTiles(2);
    // Intra-hex route from segment 0 to segment 3 normally goes via 1→2 (or
    // 5→4, same length). Block segment 1 so the only route is via 5→4.
    const isOccupied = (t: number, s: number) => t === 0 && s === 1;
    const r = findSegmentPath(tiles, { tileIndex: 0, segment: 0 }, { tileIndex: 0, segment: 3 }, flatCost, isOccupied);
    expect(r).not.toBeNull();
    // Every intermediate + final node must avoid the occupied segment.
    for (const node of r!.path) {
      expect(isOccupied(node.tileIndex, node.segment)).toBe(false);
    }
    expect(r!.path.map((n) => n.segment)).toEqual([0, 5, 4, 3]);
  });

  it('returns null when the destination segment itself is occupied', () => {
    const tiles = linearTiles(2);
    const isOccupied = (t: number, s: number) => t === 1 && s === 3;
    const r = findSegmentPath(tiles, { tileIndex: 0, segment: 0 }, { tileIndex: 1, segment: 3 }, flatCost, isOccupied);
    expect(r).toBeNull();
  });

  it('returns null when every path is walled off (fully sealed pocket)', () => {
    const tiles = linearTiles(2);
    // Occupy every segment of tile 1 except none — seal all 6.
    const isOccupied = (t: number) => t === 1;
    const r = findSegmentPath(tiles, { tileIndex: 0, segment: 0 }, { tileIndex: 1, segment: 0 }, flatCost, isOccupied);
    expect(r).toBeNull();
  });

  it('respects a finite maxCost budget', () => {
    const tiles = linearTiles(5);
    const r = findSegmentPath(
      tiles, { tileIndex: 0, segment: 0 }, { tileIndex: 4, segment: 0 }, flatCost, NO_OCCUPANCY, 2,
    );
    expect(r).toBeNull(); // needs > 2 cost to reach tile 4
  });

  it('excludes edges whose destination cost is Infinity', () => {
    const tiles = linearTiles(2);
    const costFn = (_: SegGraphTile, seg: number) => (seg === 3 ? Infinity : 1);
    const r = findSegmentPath(tiles, { tileIndex: 0, segment: 0 }, { tileIndex: 1, segment: 3 }, costFn, NO_OCCUPANCY);
    expect(r).toBeNull();
  });
});

describe('segmentGraph — segmentReachability', () => {
  it('excludes the start node and includes reachable nodes within budget', () => {
    const tiles = linearTiles(3);
    const dist = segmentReachability(tiles, { tileIndex: 0, segment: 0 }, 2, flatCost, NO_OCCUPANCY);
    expect(dist.has(encodeSeg(0, 0))).toBe(false); // start excluded
    expect(dist.has(encodeSeg(0, 1))).toBe(true); // 1 step
    expect(dist.get(encodeSeg(0, 1))).toBe(1);
  });

  it('never includes an occupied segment in the reachable set', () => {
    const tiles = linearTiles(3);
    const isOccupied = (t: number, s: number) => t === 0 && s === 1;
    const dist = segmentReachability(tiles, { tileIndex: 0, segment: 0 }, 5, flatCost, isOccupied);
    expect(dist.has(encodeSeg(0, 1))).toBe(false);
  });
});

describe('segmentGraph — buildSegmentOccupancy', () => {
  it('marks every occupant segment as occupied', () => {
    const occ = buildSegmentOccupancy([{ tileIndex: 3, segment: 2 }, { tileIndex: 5, segment: 0 }]);
    expect(occ(3, 2)).toBe(true);
    expect(occ(5, 0)).toBe(true);
    expect(occ(3, 3)).toBe(false);
  });
});

describe('segmentGraph — realizeTilePathOverSegments', () => {
  it('realizes a tile path as a concrete segment path, ending on the requested final segment', () => {
    const tiles = linearTiles(3);
    const r = realizeTilePathOverSegments(
      tiles, { tileIndex: 0, segment: 0 }, [0, 1, 2], flatCost, NO_OCCUPANCY, 4,
    );
    expect(r).not.toBeNull();
    expect(r!.path[r!.path.length - 1]).toEqual({ tileIndex: 2, segment: 4 });
  });

  it('picks the cheapest reachable segment on the final hex when none is requested', () => {
    const tiles = linearTiles(2);
    const r = realizeTilePathOverSegments(tiles, { tileIndex: 0, segment: 0 }, [0, 1], flatCost, NO_OCCUPANCY);
    expect(r).not.toBeNull();
    expect(r!.path[r!.path.length - 1].tileIndex).toBe(1);
  });

  it('returns null when the tile path does not start at the mover\'s tile', () => {
    const tiles = linearTiles(3);
    const r = realizeTilePathOverSegments(tiles, { tileIndex: 0, segment: 0 }, [1, 2], flatCost, NO_OCCUPANCY);
    expect(r).toBeNull();
  });

  it('returns null when the requested final segment is occupied', () => {
    const tiles = linearTiles(2);
    const isOccupied = (t: number, s: number) => t === 1 && s === 3;
    const r = realizeTilePathOverSegments(tiles, { tileIndex: 0, segment: 0 }, [0, 1], flatCost, isOccupied, 3);
    expect(r).toBeNull();
  });

  it('returns null when an intermediate hex is fully sealed', () => {
    const tiles = linearTiles(3);
    const isOccupied = (t: number) => t === 1;
    const r = realizeTilePathOverSegments(tiles, { tileIndex: 0, segment: 0 }, [0, 1, 2], flatCost, isOccupied);
    expect(r).toBeNull();
  });

  it('supports a pure intra-hex move represented by a one-tile path', () => {
    const tiles = linearTiles(2);
    const r = realizeTilePathOverSegments(
      tiles,
      { tileIndex: 0, segment: 0 },
      [0],
      flatCost,
      NO_OCCUPANCY,
      2,
    );
    expect(r).not.toBeNull();
    expect(r!.path.map((node) => node.tileIndex)).toEqual([0, 0, 0]);
    expect(r!.path[r!.path.length - 1]).toEqual({ tileIndex: 0, segment: 2 });
  });

  it('keeps the compressed segment-path projection on the requested tile path', () => {
    const tiles = linearTiles(3);
    const requested = [0, 1, 2];
    const r = realizeTilePathOverSegments(
      tiles,
      { tileIndex: 0, segment: 0 },
      requested,
      flatCost,
      NO_OCCUPANCY,
      4,
    );
    expect(r).not.toBeNull();
    const projected: number[] = [];
    for (const node of r!.path) {
      if (projected[projected.length - 1] !== node.tileIndex) projected.push(node.tileIndex);
    }
    expect(projected).toEqual(requested);
  });
});

describe('segmentGraph — farthestAffordablePrefix', () => {
  it('walks the full path when budget and occupancy allow it', () => {
    const tiles = linearTiles(4);
    const r = farthestAffordablePrefix(tiles, { tileIndex: 0, segment: 0 }, [0, 1, 2, 3], flatCost, NO_OCCUPANCY, 100);
    expect(r.tileCount).toBe(4);
    expect(r.path[r.path.length - 1].tileIndex).toBe(3);
  });

  it('stops at the farthest tile affordable within budget', () => {
    const tiles = linearTiles(4);
    // Each hop costs ≥1 (intra-hex pivot + cross-hex step); a budget of 1
    // should not reach tile 3.
    const r = farthestAffordablePrefix(tiles, { tileIndex: 0, segment: 0 }, [0, 1, 2, 3], flatCost, NO_OCCUPANCY, 1);
    expect(r.tileCount).toBeLessThan(4);
    expect(r.tileCount).toBeGreaterThanOrEqual(1);
  });

  it('stops before a sealed intermediate hex rather than failing entirely', () => {
    const tiles = linearTiles(4);
    const isOccupied = (t: number) => t === 2;
    const r = farthestAffordablePrefix(tiles, { tileIndex: 0, segment: 0 }, [0, 1, 2, 3], flatCost, isOccupied, 100);
    expect(r.tileCount).toBe(2); // reaches tile 1, blocked from tile 2
    expect(r.path[r.path.length - 1].tileIndex).toBe(1);
  });

  it('returns tileCount 1 (start only) at cost 0 when the path does not start at the mover', () => {
    const tiles = linearTiles(3);
    const r = farthestAffordablePrefix(tiles, { tileIndex: 0, segment: 0 }, [1, 2], flatCost, NO_OCCUPANCY, 100);
    expect(r).toEqual({ tileCount: 1, path: [{ tileIndex: 0, segment: 0 }], cost: 0 });
  });
});
