/**
 * Segment Graph — shared occupancy-gated segment-to-segment movement primitive.
 *
 * A "segment node" is a (tileIndex, segment) pair. Every segment has at most
 * three neighbours: the two intra-hex segments (segment ± 1, wrapping by
 * tile.sides) and the single cross-hex segment sharing its external face
 * (the "facing" segment on the neighbouring tile).
 *
 * This module is the SINGLE SOURCE OF TRUTH for segment adjacency and
 * occupancy-gated pathfinding over that adjacency graph, so the server,
 * client (movement range/preview), and AI all agree on what a unit can reach
 * and what it costs (Segment-Based Movement spec, Requirement B5).
 *
 * A step onto a segment is legal only when that segment is EMPTY (no unit or
 * building occupant) and its terrain-derived cost (segmentCost from
 * movementConstants.ts) is finite. There is no reachability guarantee beyond
 * that — a segment/area with no open path is simply unreachable.
 */

// ---------------------------------------------------------------------------
// Node encoding
// ---------------------------------------------------------------------------

/** A single segment position. */
export interface SegNode {
  tileIndex: number;
  segment: number;
}

/** Minimal tile shape needed for segment adjacency. */
export interface SegGraphTile {
  sides: number;
  neighbours: number[];
}

/**
 * Encode a segment node as a single number for use as a Map/Set key.
 * Assumes segment < 6 (true for both hexes and pentagons).
 */
export function encodeSeg(tileIndex: number, segment: number): number {
  return tileIndex * 6 + segment;
}

/** Decode a key produced by {@link encodeSeg} back into a SegNode. */
export function decodeSeg(key: number): SegNode {
  return { tileIndex: Math.floor(key / 6), segment: key % 6 };
}

// ---------------------------------------------------------------------------
// Adjacency
// ---------------------------------------------------------------------------

/** The two intra-hex neighbours of a segment (N±1, wrapping by tile.sides). */
function intraHexAdjacent(sides: number, segment: number): [number, number] {
  return [(segment + 1) % sides, (segment - 1 + sides) % sides];
}

/**
 * The ≤3 neighbours of a segment: two intra-hex (segment ± 1) plus the single
 * cross-hex segment sharing its external face. The cross-hex neighbour is
 * omitted when the tile has no neighbour on that face, or the neighbour tile
 * does not list this tile back (graph asymmetry / map edge).
 */
export function segmentNeighbours<T extends SegGraphTile>(
  tiles: readonly T[],
  tileIndex: number,
  segment: number,
): SegNode[] {
  const tile = tiles[tileIndex];
  const out: SegNode[] = [];
  const [a, b] = intraHexAdjacent(tile.sides, segment);
  out.push({ tileIndex, segment: a });
  if (b !== a) out.push({ tileIndex, segment: b });

  const neighbourIndex = tile.neighbours[segment];
  if (neighbourIndex !== undefined) {
    const neighbourTile = tiles[neighbourIndex];
    if (neighbourTile) {
      const facing = neighbourTile.neighbours.indexOf(tileIndex);
      if (facing >= 0) out.push({ tileIndex: neighbourIndex, segment: facing });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export type SegOccupiedFn = (tileIndex: number, segment: number) => boolean;
export type SegCostFn<T> = (tile: T, segment: number) => number;

/**
 * Build an occupancy predicate from a flat list of segment occupants (units
 * and/or buildings, any faction — a segment is either empty or full). Callers
 * must exclude the mover's own occupant from `occupants` before calling this
 * (a unit occupies its own segment but must be allowed to step off it).
 */
export function buildSegmentOccupancy(
  occupants: ReadonlyArray<{ tileIndex: number; segment: number }>,
): SegOccupiedFn {
  const set = new Set<number>();
  for (const o of occupants) set.add(encodeSeg(o.tileIndex, o.segment));
  return (tileIndex, segment) => set.has(encodeSeg(tileIndex, segment));
}

/**
 * Build the movement-occupancy predicate for a specific mover. Every other
 * unit and every building blocks every chassis: movement is between occupied
 * surface segments, so even a flight-capable unit may not step onto a segment
 * that already contains a building (Requirement B2/B5).
 *
 * `excludeUnitId` omits the mover's own occupant record so it may step away
 * from its current segment.
 */
export function buildMovementOccupancy(
  units: ReadonlyArray<{ id: string; tileIndex: number; segment: number }>,
  buildings: ReadonlyArray<{ tileIndex: number; segment: number }>,
  opts: { excludeUnitId?: string } = {},
): SegOccupiedFn {
  const occupants: { tileIndex: number; segment: number }[] = [];
  for (const u of units) {
    if (u.id === opts.excludeUnitId) continue;
    occupants.push(u);
  }
  occupants.push(...buildings);
  return buildSegmentOccupancy(occupants);
}

/** An occupancy predicate that treats every segment as empty. Useful for tests. */
export const NO_OCCUPANCY: SegOccupiedFn = () => false;

// ---------------------------------------------------------------------------
// Dijkstra primitives
// ---------------------------------------------------------------------------

/** Minimal binary-heap-free priority queue — fine for the small frontiers segment graphs produce. */
function popCheapest<K>(pq: { key: K; cost: number }[]): { key: K; cost: number } {
  let mi = 0;
  for (let i = 1; i < pq.length; i++) if (pq[i].cost < pq[mi].cost) mi = i;
  return pq.splice(mi, 1)[0];
}

/**
 * Shortest occupancy-gated path from `from` to `to` over the segment graph.
 * Edge weight is `costFn(destinationTile, destinationSegment)`; an edge with
 * non-finite cost, or leading to an occupied segment, is excluded. Returns
 * null when `to` is unreachable (including when `to` itself is occupied).
 */
export function findSegmentPath<T extends SegGraphTile>(
  tiles: readonly T[],
  from: SegNode,
  to: SegNode,
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
  maxCost: number = Infinity,
): { path: SegNode[]; cost: number } | null {
  const startKey = encodeSeg(from.tileIndex, from.segment);
  const goalKey = encodeSeg(to.tileIndex, to.segment);
  if (startKey === goalKey) return { path: [from], cost: 0 };

  const dist = new Map<number, number>([[startKey, 0]]);
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  const pq: { key: number; cost: number }[] = [{ key: startKey, cost: 0 }];

  while (pq.length > 0) {
    const { key: currentKey, cost: currentCost } = popCheapest(pq);
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    if (currentCost > (dist.get(currentKey) ?? Infinity)) continue;
    if (currentKey === goalKey) break;

    const { tileIndex, segment } = decodeSeg(currentKey);
    for (const n of segmentNeighbours(tiles, tileIndex, segment)) {
      const nKey = encodeSeg(n.tileIndex, n.segment);
      if (isOccupied(n.tileIndex, n.segment)) continue;
      const stepCost = costFn(tiles[n.tileIndex], n.segment);
      if (!Number.isFinite(stepCost)) continue;
      const newCost = currentCost + stepCost;
      if (newCost > maxCost) continue;
      const existing = dist.get(nKey);
      if (existing === undefined || newCost < existing) {
        dist.set(nKey, newCost);
        prev.set(nKey, currentKey);
        pq.push({ key: nKey, cost: newCost });
      }
    }
  }

  if (!dist.has(goalKey)) return null;
  const nodes: SegNode[] = [];
  let step = goalKey;
  while (step !== startKey) {
    nodes.unshift(decodeSeg(step));
    const p = prev.get(step);
    if (p === undefined) return null; // unreachable defensively (should not happen)
    step = p;
  }
  nodes.unshift(from);
  return { path: nodes, cost: dist.get(goalKey)! };
}

/**
 * Occupancy-gated Dijkstra flood fill from `from`, bounded by `maxCost`.
 * Returns a Map from encoded segment key to the cheapest cost to reach it
 * (excludes the start node itself).
 */
export function segmentReachability<T extends SegGraphTile>(
  tiles: readonly T[],
  from: SegNode,
  maxCost: number,
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
): Map<number, number> {
  const startKey = encodeSeg(from.tileIndex, from.segment);
  const dist = new Map<number, number>([[startKey, 0]]);
  const visited = new Set<number>();
  const pq: { key: number; cost: number }[] = [{ key: startKey, cost: 0 }];

  while (pq.length > 0) {
    const { key: currentKey, cost: currentCost } = popCheapest(pq);
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    if (currentCost > (dist.get(currentKey) ?? Infinity)) continue;

    const { tileIndex, segment } = decodeSeg(currentKey);
    for (const n of segmentNeighbours(tiles, tileIndex, segment)) {
      const nKey = encodeSeg(n.tileIndex, n.segment);
      if (isOccupied(n.tileIndex, n.segment)) continue;
      const stepCost = costFn(tiles[n.tileIndex], n.segment);
      if (!Number.isFinite(stepCost)) continue;
      const newCost = currentCost + stepCost;
      if (newCost > maxCost) continue;
      const existing = dist.get(nKey);
      if (existing === undefined || newCost < existing) {
        dist.set(nKey, newCost);
        pq.push({ key: nKey, cost: newCost });
      }
    }
  }

  dist.delete(startKey);
  return dist;
}

// ---------------------------------------------------------------------------
// Tile-level path realization
// ---------------------------------------------------------------------------

/** Find a segment path without leaving one tile. */
function findPathWithinTile<T extends SegGraphTile>(
  tiles: readonly T[],
  from: SegNode,
  to: SegNode,
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
  maxCost: number,
): { path: SegNode[]; cost: number } | null {
  if (from.tileIndex !== to.tileIndex) return null;
  const tileIndex = from.tileIndex;
  return findSegmentPath(
    tiles,
    from,
    to,
    costFn,
    (candidateTile, candidateSegment) =>
      candidateTile !== tileIndex || isOccupied(candidateTile, candidateSegment),
    maxCost,
  );
}

/**
 * Resolve exactly one requested tile hop. The route may pivot within the source
 * tile, crosses the requested shared face once, and stops on the facing segment
 * of the target tile. It cannot detour through tiles absent from the supplied
 * tile path.
 */
function realizeTileHop<T extends SegGraphTile>(
  tiles: readonly T[],
  from: SegNode,
  targetTileIndex: number,
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
  maxCost: number,
): { path: SegNode[]; cost: number } | null {
  const sourceTile = tiles[from.tileIndex];
  const targetTile = tiles[targetTileIndex];
  if (!sourceTile || !targetTile) return null;

  const exitSegment = sourceTile.neighbours.indexOf(targetTileIndex);
  const arrivalSegment = targetTile.neighbours.indexOf(from.tileIndex);
  if (exitSegment < 0 || arrivalSegment < 0) return null;

  const toExit = findPathWithinTile(
    tiles,
    from,
    { tileIndex: from.tileIndex, segment: exitSegment },
    costFn,
    isOccupied,
    maxCost,
  );
  if (!toExit) return null;

  if (isOccupied(targetTileIndex, arrivalSegment)) return null;
  const crossCost = costFn(targetTile, arrivalSegment);
  if (!Number.isFinite(crossCost) || toExit.cost + crossCost > maxCost) return null;

  return {
    path: [...toExit.path, { tileIndex: targetTileIndex, segment: arrivalSegment }],
    cost: toExit.cost + crossCost,
  };
}

/**
 * Walk `tilePath` exactly hex-by-hex, stopping at the farthest requested tile
 * affordable within `maxCost`. Each hop is occupancy- and terrain-gated at
 * segment granularity and cannot leave the supplied tile sequence.
 */
export function farthestAffordablePrefix<T extends SegGraphTile>(
  tiles: readonly T[],
  startSegment: SegNode,
  tilePath: readonly number[],
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
  maxCost: number,
): { tileCount: number; path: SegNode[]; cost: number } {
  if (tilePath.length === 0 || tilePath[0] !== startSegment.tileIndex) {
    return { tileCount: 1, path: [startSegment], cost: 0 };
  }

  let current = startSegment;
  const fullPath: SegNode[] = [current];
  let totalCost = 0;
  let tileCount = 1;

  for (let i = 1; i < tilePath.length; i++) {
    const step = realizeTileHop(
      tiles,
      current,
      tilePath[i],
      costFn,
      isOccupied,
      maxCost - totalCost,
    );
    if (!step) break;

    fullPath.push(...step.path.slice(1));
    totalCost += step.cost;
    current = step.path[step.path.length - 1];
    tileCount = i + 1;
  }

  return { tileCount, path: fullPath, cost: totalCost };
}

/**
 * Realize a client-supplied tile path as an exact segment path. The result's
 * compressed tile projection is exactly `tilePath`: each requested tile edge
 * is crossed once in order, with any required pivots confined to the current
 * tile. When `finalSegment` is supplied, the route then moves within the final
 * tile to that segment. A one-tile path therefore represents a pure intra-hex
 * reposition.
 */
export function realizeTilePathOverSegments<T extends SegGraphTile>(
  tiles: readonly T[],
  startSegment: SegNode,
  tilePath: readonly number[],
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
  finalSegment?: number,
  maxCost: number = Infinity,
): { path: SegNode[]; cost: number } | null {
  if (tilePath.length === 0 || tilePath[0] !== startSegment.tileIndex) return null;

  let current = startSegment;
  const fullPath: SegNode[] = [current];
  let totalCost = 0;

  for (let i = 1; i < tilePath.length; i++) {
    const step = realizeTileHop(
      tiles,
      current,
      tilePath[i],
      costFn,
      isOccupied,
      maxCost - totalCost,
    );
    if (!step) return null;

    fullPath.push(...step.path.slice(1));
    totalCost += step.cost;
    current = step.path[step.path.length - 1];
  }

  if (finalSegment !== undefined) {
    const finalTile = tiles[current.tileIndex];
    if (!finalTile || finalSegment < 0 || finalSegment >= finalTile.sides) return null;
    const finish = findPathWithinTile(
      tiles,
      current,
      { tileIndex: current.tileIndex, segment: finalSegment },
      costFn,
      isOccupied,
      maxCost - totalCost,
    );
    if (!finish) return null;
    fullPath.push(...finish.path.slice(1));
    totalCost += finish.cost;
  }

  return { path: fullPath, cost: totalCost };
}
