/**
 * Route capacity, travel time, creation, path validation & capacity upgrade —
 * Oil Logistics System (Req 6, 7, 9.2, 10.4, 10.5).
 *
 * A Logistics_Route follows a segment-level path through the hex graph (its
 * Route_Segments). The `segments` field on `LogisticsRoute` stores encoded
 * segment keys (`tileIndex * 6 + segment`), matching the `encodeSeg` convention
 * from `shared/segmentGraph.ts`. Each step is from one (tileIndex, segment) to
 * an adjacent (tileIndex, segment) in the segment graph — exactly the same
 * adjacency model unit movement uses (Requirement B5).
 *
 * Its Route_Travel_Time is a pure function of the cumulative Segment_Steepness
 * across those segments, so it is stable and monotone in steepness (Req 7.1, 7.2)
 * and never mutates its inputs.
 *
 * Segment steepness: for a segment node, `tile.segSteep[segment]` is its
 * steepness in radians. A route crossing a series of segment nodes accumulates
 * their steepnesses. Entry/exit face lookup is no longer needed; the segment
 * index directly identifies the face.
 * `neighbours[i]` is the tile reached across that same side. So the face a road
 * crosses toward an adjacent tile `n` on tile `t` is `t.neighbours.indexOf(n)`,
 * and that face's steepness is `t.segSteep[face]`.
 *
 * All route-creation/validation helpers are PURE: they read only their arguments
 * / the read-only LogisticsContext and never mutate inputs (reject-and-preserve),
 * so a rejected build leaves the world untouched.
 *
 * Endpoint shape (design: `validateRoutePath(ctx, path, endpoints)`): rather than
 * re-resolving structures inside the pure engine — the Home_City is a city flag,
 * not a LogisticsState entity, so it cannot be looked up here — the caller passes a
 * `RouteEndpoints` descriptor carrying each endpoint's structure id, kind, tile, and
 * owning faction. The server applier (task 13.2) is responsible for resolving the
 * real structures (well/refinery in state; Home_City via the `isPlayerHome` city
 * flag) and populating this descriptor with the correct `kind`/`ownerId` before
 * calling the validator — the same division of labour used by the occupancy note on
 * the placement validators. This validator then enforces the descriptor-level
 * rules (distinct, valid kinds, single owner, endpoints seated at the path ends).
 *
 * Impassability classification (Req 10.4/10.5): a Road may not cross Impassable_
 * Terrain (water or valley) unless a Bridge has been built there. Rivers/valleys are
 * stored with `terrainType === 'ocean'` (see generate.ts — river tiles are reclassed
 * to ocean so ground units are blocked and engineers can bridge them), so the
 * existing movement gate `isImpassableTerrain(terrainType)` already recognises both
 * water and valley. We reuse it verbatim so route laying mirrors ground movement.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import {
  ROUTE_CAPACITY_MAX,
  ROUTE_CAPACITY_MIN,
  ROUTE_CAPACITY_STEP,
} from '../../../shared/logisticsConstants.js';
import { isImpassableTerrain, MAX_STEEP_WHEELED } from '../../../shared/movementConstants.js';
import {
  encodeSeg,
  decodeSeg,
  segmentNeighbours,
  findSegmentPath,
  NO_OCCUPANCY,
  type SegGraphTile,
  type SegNode,
  type SegOccupiedFn,
} from '../../../shared/segmentGraph.js';
import type {
  LogisticsContext,
  LogisticsRoute,
  LogisticsTile,
  LogisticsValidation,
} from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Segment-key helpers (route path is stored as encodeSeg keys)
// ---------------------------------------------------------------------------

/**
 * Decode an encoded segment key back to (tileIndex, segment).
 * Mirrors `decodeSeg` from shared/segmentGraph.ts — routes store their path as
 * `encodeSeg(tileIndex, segment)` keys so each node identifies a specific triangular
 * face on a specific tile, enabling the same adjacency semantics as unit movement.
 */
function routeNodeAt(key: number): { tileIndex: number; segment: number } {
  return decodeSeg(key);
}

/**
 * Re-export for callers (server applier, renderer) that need to decode a route
 * segment key to a `{tileIndex, segment}` pair without importing segmentGraph.
 */
export { encodeSeg as encodeRouteNode, decodeSeg as decodeRouteNode } from '../../../shared/segmentGraph.js';

// ---------------------------------------------------------------------------
// Routeability gate: whether a tile is traversable by a logistics route
// ---------------------------------------------------------------------------

/** Whether a tile is Impassable_Terrain (water or valley) for a Road. */
function isImpassableRouteTile(tile: LogisticsTile): boolean {
  return isImpassableTerrain(tile.terrainType);
}

/** Per-segment steepness (radians) for a tile segment; 0 (flat) when absent. */
function segmentSteepnessAt(tile: LogisticsTile, segment: number): number {
  return tile.segSteep?.[segment] ?? 0;
}

/**
 * The Segment_Steepness of a single Route_Segment node (one encoded segment key).
 * Returns `tile.segSteep[segment]` for the decoded segment, or 0 when absent
 * (flat fallback for tiles without steepness data).
 */
export function routeSegmentSteepness(
  tile: LogisticsTile,
  segment: number,
): number {
  return segmentSteepnessAt(tile, segment);
}

/**
 * Derive the per-node Segment_Steepness profile for a route's segment-key path,
 * suitable for passing to {@link routeTravelTime}.
 *
 * `segmentPath` is the ordered list of encoded segment keys stored on
 * `LogisticsRoute.segments`. Each key decodes to `{tileIndex, segment}` and the
 * steepness is `tile.segSteep[segment]` — no entry/exit face lookup is needed.
 * Pure: reads only its arguments; returns a new array.
 *
 * @param segmentPath Ordered encoded segment keys (tileIndex * 6 + segment).
 * @param tiles The authoritative tiles (indexable by tile index).
 * @returns One Segment_Steepness value (radians, `>= 0`) per segment node.
 */
export function routeSteepnessProfile(
  segmentPath: readonly number[],
  tiles: readonly LogisticsTile[],
): number[] {
  return segmentPath.map((key) => {
    const { tileIndex, segment } = routeNodeAt(key);
    const tile = tiles[tileIndex];
    if (!tile) return 0;
    return routeSegmentSteepness(tile, segment);
  });
}

/**
 * Compute a Logistics_Route's Route_Travel_Time from its per-Route_Segment
 * Segment_Steepness values (Req 7.1, 7.2, 7.3, 7.6).
 *
 * Exact specified formula (Req 7.6): the ceiling of the sum, over every
 * Route_Segment, of `(1 + steepness / MAX_STEEP_WHEELED)`, clamped to a minimum of
 * 1 turn. This yields a base of ~1 turn per flat segment and up to ~2 turns per
 * maximally-steep segment (steepness ≈ MAX_STEEP_WHEELED), is a whole number of
 * turns `>= 1` (Req 7.3), and is monotone non-decreasing in cumulative steepness
 * (Req 7.1, 7.2) — adding steepness never lowers the result. Pure: reads only its
 * argument.
 *
 * @param segmentSteepness One Segment_Steepness value (radians, `>= 0`) per
 *   Route_Segment (e.g. from {@link routeSteepnessProfile}).
 * @returns The Route_Travel_Time in whole turns (`>= 1`).
 */
export function routeTravelTime(segmentSteepness: number[]): number {
  const sum = segmentSteepness.reduce((acc, s) => acc + (1 + s / MAX_STEEP_WHEELED), 0);
  return Math.max(1, Math.ceil(sum));
}

/**
 * The structure kinds a Logistics_Route may connect (Req 6.1, 6.2). `'hub'` is
 * included because `resolveLogisticsTurn` already treats a Distribution_Hub id
 * as a valid route endpoint (see `classify`/`otherEndpoint` in `turn.ts`) — a
 * hub can be the direct `fromStructureId`/`toStructureId` of a route, not only
 * connected indirectly via its `routeIds`.
 */
export type RouteEndpointKind = 'well' | 'refinery' | 'hub' | 'home-city';

/** Derive tile.sides for a LogisticsTile (may omit it; fall back to segment count). */
function logisticsSides(tile: LogisticsTile): number {
  return (tile as { sides?: number }).sides ?? tile.segSteep?.length ?? tile.neighbours.length;
}

/**
 * Build a SegGraphTile[] adapter from a LogisticsTile[] so segment-graph
 * helpers can work with logistics tiles. The returned array has the same
 * indices as `tiles`; gaps are filled with stub entries so the array is
 * contiguous (segmentNeighbours only reads the specific tiles it traverses).
 */
function toSegGraph(tiles: readonly LogisticsTile[]): SegGraphTile[] {
  return tiles.map((t) => t
    ? ({ sides: logisticsSides(t), neighbours: t.neighbours })
    : ({ sides: 6, neighbours: [] }),
  );
}

/**
 * Find the shortest built-road path (an ordered list of encoded segment
 * keys) connecting any segment of `fromFootprint` to any segment of
 * `toFootprint`, travelling only across segments that are ALREADY a road —
 * either part of a `LogisticsRoute` (any tier/owner) or a development
 * `standaloneRoadSegments` overlay — plus the two structures' own footprint
 * segments (so the search can step off a well/refinery/hub's own occupied
 * segment onto the adjacent road segment that serves it; a road is typically
 * built on the segment NEXT TO a structure, not on the structure's own
 * segment, since that segment is already occupied by the structure).
 *
 * This is the single connectivity check a player-created shuttle transport
 * uses: it never lays new road, so a shuttle may only be created between two
 * structures that some existing road already connects, by whichever
 * mechanism built it (a real `LogisticsRoute` or a God Mode standalone
 * overlay). Returns `null` when no such path exists. Pure: reads only its
 * arguments.
 *
 * @param fromFootprint Every segment the "from" structure occupies (one for
 *   a well/hub, one or more for a refinery).
 * @param toFootprint Every segment the "to" structure occupies.
 */
export function findExistingRoadPath(
  tiles: readonly LogisticsTile[],
  routeSegmentSets: ReadonlyArray<readonly number[]>,
  standaloneRoadSegments: readonly number[],
  fromFootprint: readonly SegNode[],
  toFootprint: readonly SegNode[],
): number[] | null {
  const walkable = new Set<number>(standaloneRoadSegments);
  for (const segments of routeSegmentSets) {
    for (const key of segments) walkable.add(key);
  }
  for (const node of fromFootprint) walkable.add(encodeSeg(node.tileIndex, node.segment));
  for (const node of toFootprint) walkable.add(encodeSeg(node.tileIndex, node.segment));

  const segGraph = toSegGraph(tiles);
  const isOccupied: SegOccupiedFn = (tileIndex, segment) => !walkable.has(encodeSeg(tileIndex, segment));

  let best: number[] | null = null;
  for (const from of fromFootprint) {
    for (const to of toFootprint) {
      const result = findSegmentPath(segGraph, from, to, () => 1, isOccupied);
      if (!result) continue;
      if (!best || result.path.length < best.length) {
        best = result.path.map((n) => encodeSeg(n.tileIndex, n.segment));
      }
    }
  }
  return best;
}

/**
 * One endpoint of a proposed Logistics_Route (an Oil_Well, a Refinery, or the
 * Home_City). Supplied by the caller (see the module note above): the pure engine
 * trusts `kind`/`ownerId` and validates the descriptor rather than re-resolving the
 * structure, because the Home_City is not a LogisticsState entity.
 */
export interface RouteEndpoint {
  /** The endpoint structure's id (becomes `LogisticsRoute.fromStructureId`/`toStructureId`). */
  structureId: string;
  /** Whether the endpoint is a well, a refinery, or the Home_City. */
  kind: RouteEndpointKind;
  /** The tile the endpoint sits on; must coincide with the matching end of `path`. */
  tileIndex: number;
  /** Owning faction id (both endpoints must belong to the same player). */
  ownerId: string;
}

/** The ordered endpoint pair of a proposed route: `from` seats `path[0]`, `to` the last tile. */
export interface RouteEndpoints {
  from: RouteEndpoint;
  to: RouteEndpoint;
}

/** The endpoint kinds a route may connect (Req 6.1, 6.2). */
const VALID_ENDPOINT_KINDS: ReadonlySet<RouteEndpointKind> = new Set([
  'well',
  'refinery',
  'hub',
  'home-city',
]);

/**
 * Validate a proposed Logistics_Route path between `endpoints`.
 * `path` is an ordered list of encoded segment keys (`tileIndex * 6 + segment`)
 * using the same adjacency model as unit movement (shared/segmentGraph.ts).
 * `isOccupied` (optional) blocks building-occupied segments; omit for tests.
 */
export function validateRoutePath(
  ctx: LogisticsContext,
  path: readonly number[],
  endpoints: RouteEndpoints,
  isOccupied: SegOccupiedFn = NO_OCCUPANCY,
): LogisticsValidation {
  const { from, to } = endpoints;

  // Endpoint kind validation (Req 6.2)
  if (!VALID_ENDPOINT_KINDS.has(from.kind) || !VALID_ENDPOINT_KINDS.has(to.kind)) {
    return { legal: false, reason: 'invalid-endpoints', message: 'A route must connect an oil well, a refinery, or the home city at each end.' };
  }
  if (from.structureId === to.structureId) {
    return { legal: false, reason: 'invalid-endpoints', message: 'A route must connect two different structures.' };
  }
  if (from.ownerId !== to.ownerId) {
    return { legal: false, reason: 'invalid-endpoints', message: 'Both route endpoints must belong to the same player.' };
  }

  if (path.length === 0) {
    return { legal: false, reason: 'path-not-traversable', message: 'The route path is empty.' };
  }

  // Endpoints seated at the ends: the first/last path tile must match from/to tileIndex.
  const firstNode = routeNodeAt(path[0]);
  const lastNode = routeNodeAt(path[path.length - 1]);
  const endsMatch =
    (firstNode.tileIndex === from.tileIndex && lastNode.tileIndex === to.tileIndex) ||
    (firstNode.tileIndex === to.tileIndex && lastNode.tileIndex === from.tileIndex);
  if (!endsMatch) {
    return {
      legal: false,
      reason: 'invalid-endpoints',
      message: 'The path does not start and end at the two endpoints.',
      offendingTiles: [firstNode.tileIndex, lastNode.tileIndex],
    };
  }

  // Check every node and adjacency in the segment graph.
  for (let i = 0; i < path.length; i++) {
    const { tileIndex, segment } = routeNodeAt(path[i]);
    const tile = ctx.tiles[tileIndex];
    if (!tile) {
      return { legal: false, reason: 'path-not-traversable', message: `Route tile ${tileIndex} does not exist.`, offendingTiles: [tileIndex] };
    }

    // Segment-graph adjacency: each node must be a segment-neighbour of the previous.
    if (i > 0) {
      const prev = routeNodeAt(path[i - 1]);
      const neighbours = segmentNeighbours(toSegGraph(ctx.tiles), prev.tileIndex, prev.segment);
      const adjacent = neighbours.some((n) => n.tileIndex === tileIndex && n.segment === segment);
      if (!adjacent) {
        return {
          legal: false,
          reason: 'path-not-traversable',
          message: 'The route path is not a continuous line of adjacent segments.',
          offendingTiles: [prev.tileIndex, tileIndex],
        };
      }
    }
    // Terrain gates per tile (Req 6.3, 9.2, 10.5).
    if (tile.forested && !ctx.state.clearedForests.includes(tileIndex)) {
      return { legal: false, reason: 'path-not-traversable', message: 'Clear the forest before laying a road across this tile.', offendingTiles: [tileIndex] };
    }
    if (isImpassableRouteTile(tile) && !ctx.state.bridges.includes(tileIndex)) {
      return { legal: false, reason: 'path-not-traversable', message: 'Build a bridge before laying a road across this water or valley tile.', offendingTiles: [tileIndex] };
    }

    // Segment occupancy gate: a road may not run through a segment already occupied
    // by a building or logistics structure. Endpoint segments are allowed to be
    // occupied by their own structure (the well/hub/refinery), so the caller must
    // exclude those from the isOccupied predicate.
    if (isOccupied(tileIndex, segment)) {
      return { legal: false, reason: 'path-not-traversable', message: 'A segment along this route is already occupied.', offendingTiles: [tileIndex] };
    }
  }

  return { legal: true };
}

/**
 * Caller-supplied initialisation for a new Logistics_Route (Req 6.1, 6.4). The `id`,
 * owner, endpoint ids, and the segment-level `path` are provided by the caller; the
 * pure engine fills the derived fields (capacity, tier, travel time, operability).
 */
export interface RouteCreationInit {
  id: string;
  ownerId: string;
  fromStructureId: string;
  toStructureId: string;
  /**
   * Ordered segment-key path — each entry is `encodeSeg(tileIndex, segment)`.
   * Must be validated with {@link validateRoutePath} before passing here.
   */
  path: readonly number[];
}

/**
 * Create a new Logistics_Route as a Road along `init.path` (Req 6.1, 6.4, 7.6).
 * `init.path` is an ordered list of encoded segment keys (`tileIndex * 6 + segment`).
 * Pure: copies `init.path` into a fresh `segments` array and mutates nothing.
 */
export function createRoute(
  init: RouteCreationInit,
  tiles: readonly LogisticsTile[],
): LogisticsRoute {
  const travelTime = routeTravelTime(routeSteepnessProfile(init.path, tiles));
  return {
    id: init.id,
    ownerId: init.ownerId,
    fromStructureId: init.fromStructureId,
    toStructureId: init.toStructureId,
    segments: [...init.path],
    capacity: ROUTE_CAPACITY_MIN,
    tier: 'road',
    travelTime,
    operable: true,
  };
}

/**
 * The next Route_Capacity after one upgrade step (Req 6.7, 6.8).
 *
 * Returns `min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP)` for a route below the
 * maximum. When `cap` is already at or above `ROUTE_CAPACITY_MAX`, returns an `Error`
 * (rather than throwing) so the caller can branch and leave the capacity unchanged
 * (Req 6.8 — reject at max). Returning an `Error` matches the design's declared
 * `number | Error` return type; callers use `result instanceof Error`. Pure.
 *
 * @param cap The route's current Route_Capacity.
 * @returns The upgraded capacity, or an `Error` when already at the maximum.
 */
export function upgradeRouteCapacity(cap: number): number | Error {
  if (cap >= ROUTE_CAPACITY_MAX) {
    return new Error(`Route is already at its maximum capacity (${ROUTE_CAPACITY_MAX}).`);
  }
  return Math.min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP);
}

/**
 * Upgrade a Logistics_Route one capacity step and render it as a Highway
 * (Req 6.7, 6.8).
 *
 * Applies {@link upgradeRouteCapacity} to the route's current capacity: on success
 * returns a new route with the bumped `capacity` and `tier: 'highway'`; when the
 * route is already at `ROUTE_CAPACITY_MAX` returns the `Error` from
 * `upgradeRouteCapacity` and the route is left unchanged (Req 6.8). Pure — returns a
 * new route and never mutates the input.
 *
 * @param route The route to upgrade.
 * @returns A new Highway-tier `LogisticsRoute` with increased capacity, or an
 *   `Error` when the route is already at the maximum capacity.
 */
export function upgradeRoute(route: LogisticsRoute): LogisticsRoute | Error {
  const next = upgradeRouteCapacity(route.capacity);
  if (next instanceof Error) return next;
  return { ...route, capacity: next, tier: 'highway' };
}
