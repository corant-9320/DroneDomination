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
 * Build the movement-occupancy predicate for a specific mover, given the
 * living units and buildings on the board. Units block every chassis; a
 * building blocks ground chassis (wheeled/limb) but not flight — drones pass
 * over buildings freely, matching the client's
 * buildOccupiedSegmentSet/buildBuildingSegmentSet convention (server, client,
 * and AI must agree — Requirement B5).
 *
 * `excludeUnitId` omits the mover's own occupant record (a unit occupies its
 * own segment but must be allowed to step off it).
 */
export function buildMovementOccupancy(
  units: ReadonlyArray<{ id: string; tileIndex: number; segment: number }>,
  buildings: ReadonlyArray<{ tileIndex: number; segment: number }>,
  opts: { excludeUnitId?: string; blockBuildings: boolean },
): SegOccupiedFn {
  const occupants: { tileIndex: number; segment: number }[] = [];
  for (const u of units) {
    if (u.id === opts.excludeUnitId) continue;
    occupants.push(u);
  }
  if (opts.blockBuildings) occupants.push(...buildings);
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

/**
 * Among all segments of `targetTile`, find the cheapest occupancy-gated
 * segment path from `from`. Returns null if every segment on the tile is
 * unreachable (occupied or blocked).
 */
function cheapestSegmentOnTile<T extends SegGraphTile>(
  tiles: readonly T[],
  from: SegNode,
  targetTile: number,
  costFn: SegCostFn<T>,
  isOccupied: SegOccupiedFn,
  maxCost: number,
): { segment: number; path: SegNode[]; cost: number } | null {
  const sides = tiles[targetTile].sides;
  let best: { segment: number; path: SegNode[]; cost: number } | null = null;
  for (let seg = 0; seg < sides; seg++) {
    const r = findSegmentPath(tiles, from, { tileIndex: targetTile, segment: seg }, costFn, isOccupied, maxCost);
    if (r && (!best || r.cost < best.cost)) {
      best = { segment: seg, path: r.path, cost: r.cost };
    }
  }
  return best;
}

/**
 * Realize a tile-level path (a list of tile indices, as sent over the wire
 * today) as a concrete occupancy-gated segment-level path.
 *
 * For every intermediate hex, the cheapest reachable segment on that tile is
 * used as the waypoint (the unit may pivot through it to reach a legal
 * position, so which exact segment it passes through mid-route doesn't
 * matter). For the final hex, `finalSegment` is used when given (the caller
 * usually knows exactly which segment it wants to end on); otherwise the
 * cheapest segment is used there too.
 *
 * Returns null when `tilePath` doesn't start at `startSegment.tileIndex`, or
 * when any hop (including reaching the requested final segment) has no legal
 * occupancy-gated route.
 */
/**
 * Walk `tilePath` hex-by-hex, stopping at the farthest tile the mover can
 * afford within `maxCost` under occupancy-gated segment costs. Used by AI
 * movement planning: "how far along this coarse tile-level route can the
 * unit actually afford to go, given occupied segments and terrain cost".
 *
 * Each hop is resolved independently against the cheapest reachable segment
 * on that hex (mirroring `realizeTilePathOverSegments`'s per-hex behaviour),
 * so a hop that turns out unreachable (occupied/impassable, or would exceed
 * the remaining budget) stops the walk there rather than failing the whole
 * path — this matches the previous tile-level `affordableSteps` semantics of
 * "go as far as you can, then stop".
 *
 * Returns `{ tileCount, path, cost }`: `tileCount` is the number of tiles from
 * `tilePath` actually reached (always ≥ 1 — the start tile costs 0), `path`
 * is the concrete segment path walked, and `cost` is its total.
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
    const targetTile = tilePath[i];
    const remaining = maxCost - totalCost;
    const step = cheapestSegmentOnTile(tiles, current, targetTile, costFn, isOccupied, remaining);
    if (!step) break;

    fullPath.push(...step.path.slice(1));
    totalCost += step.cost;
    current = { tileIndex: targetTile, segment: step.segment };
    tileCount = i + 1;
  }

  return { tileCount, path: fullPath, cost: totalCost };
}

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
    const targetTile = tilePath[i];
    const isLast = i === tilePath.length - 1;
    const remaining = maxCost - totalCost;

    let step: { segment: number; path: SegNode[]; cost: number } | null;
    if (isLast && finalSegment !== undefined) {
      const r = findSegmentPath(tiles, current, { tileIndex: targetTile, segment: finalSegment }, costFn, isOccupied, remaining);
      step = r ? { segment: finalSegment, path: r.path, cost: r.cost } : null;
    } else {
      step = cheapestSegmentOnTile(tiles, current, targetTile, costFn, isOccupied, remaining);
    }
    if (!step) return null;

    fullPath.push(...step.path.slice(1));
    totalCost += step.cost;
    current = { tileIndex: targetTile, segment: step.segment };
  }

  return { path: fullPath, cost: totalCost };
}
