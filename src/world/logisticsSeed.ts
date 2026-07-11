/**
 * Seeded Default Network — Oil Logistics System (Req 13).
 *
 * `seedDefaultLogisticsNetwork` populates a `LogisticsState` in place with a
 * complete, deterministic example network so the logistics chain is demonstrably
 * operational from the first turn of the Default_Test_World. It is invoked by
 * `generateWorld` ONLY when the world seed equals `DEFAULT_SEED` (Req 13.1, 13.10);
 * every other seed keeps an empty `LogisticsState` and only the standard
 * `placeOilDeposits` deposit placement (Req 13.10).
 *
 * The builder is assembled **exclusively through the pure engine's construction /
 * validation helpers** in `./logistics.js` (`validateWellPlacement` +
 * `completeWellTask`, `validateRefineryPlacement` + `validateRefinerySegment`,
 * `validateRoutePath` + `createRoute`, `upgradeRoute` to reach the Highway tier,
 * `createHub`, and `transportTier` / `upgradeTransport` for the tiered transports),
 * so the seeded state obeys exactly the same field-level invariants and clamps as
 * any player-built network — it never writes a raw field that would bypass a bound
 * (Req 13.1 "fully operational").
 *
 * Determinism (Req 13.9): all anchor choices are a pure function of the tiles and
 * `homeFactionId`. The Home_City tile is recovered from `tiles` via its `cityId`
 * (set by `placeCities`); the well anchor is the nearest `resourceType === 'oil'`
 * tile to the Home_City by graph distance, lowest tile index as the tie-break; and
 * routes are laid with the shared `findPath` over a land-only cost, so no randomness
 * leaks in and repeated invocations produce a deep-equal `LogisticsState`.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { Tile } from './types.js';
import { findPath } from './pathfinding.js';
import { MAX_STEEP_WHEELED } from '../../shared/movementConstants.js';
import {
  completeWellTask,
  createHub,
  createRoute,
  transportTier,
  upgradeRoute,
  upgradeTransport,
  validateRefineryPlacement,
  validateRefinerySegment,
  validateRoutePath,
  type RouteEndpoint,
  type RouteEndpoints,
} from './logistics.js';
import { validateWellPlacement } from './logistics.js';
import type {
  DistributionHub,
  EngineerTask,
  EngineerUnitRef,
  LogisticsContext,
  LogisticsRoute,
  LogisticsState,
  OilWell,
  Refinery,
  Transport,
} from '../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Seed constants (in-domain values for the example network)
// ---------------------------------------------------------------------------

/**
 * Hit points for every seeded structure. Kept within the combat HP domain `[1, 50]`
 * that `applyDamage` clamps into (see docs/architecture/known-issues.md): a value
 * `> 50` would be silently clamped on the first hit.
 */
const SEED_STRUCTURE_HP = 40;

/** Home_City starting Refined_Product (within `[0, HOME_CITY_REFINED_PRODUCT_MAX]`). */
const SEED_HOME_REFINED_PRODUCT = 1000;

/** Cargo capacity of each seeded transport (within `[TRANSPORT_CARGO_MIN, MAX]`). */
const SEED_TRANSPORT_CARGO = 100;

/** The `van`/`truck`/`juggernaut` transports need 0 / 2 / 4 cumulative upgrades. */
const TIER_UPGRADES: ReadonlyArray<{ id: string; upgrades: number }> = [
  { id: 'seed-transport-van', upgrades: 0 },
  { id: 'seed-transport-truck', upgrades: 2 },
  { id: 'seed-transport-juggernaut', upgrades: 4 },
];

// ---------------------------------------------------------------------------
// Empty-state factory
// ---------------------------------------------------------------------------

/**
 * A fresh, empty `LogisticsState`. `generateWorld` attaches one to every world
 * (so `World.logistics` is always present) and seeds it only for `DEFAULT_SEED`
 * (Req 13.10 — an arbitrary seed's logistics content stays empty).
 */
export function createEmptyLogisticsState(): LogisticsState {
  return {
    wells: [],
    refineries: [],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** The number of HexSegments on a tile (segSteep length, else neighbour count). */
function tileSegmentCount(tile: Tile): number {
  if (tile.segSteep && tile.segSteep.length > 0) return tile.segSteep.length;
  return tile.neighbours.length;
}

/** Per-segment steepness (radians); 0 (flat) when absent. */
function segmentSteepnessAt(tile: Tile, segment: number): number {
  return tile.segSteep?.[segment] ?? 0;
}

/**
 * The flattest segment of a tile (lowest steepness, lowest index as the tie-break).
 * Used to seat wells and hubs on the most-buildable segment deterministically.
 */
function flattestSegment(tile: Tile): { segment: number; steepness: number } {
  const sides = tileSegmentCount(tile);
  let bestSeg = 0;
  let bestSteep = segmentSteepnessAt(tile, 0);
  for (let s = 1; s < sides; s++) {
    const steep = segmentSteepnessAt(tile, s);
    if (steep < bestSteep) {
      bestSteep = steep;
      bestSeg = s;
    }
  }
  return { segment: bestSeg, steepness: bestSteep };
}

/** A land tile a Road may cross: not water/valley (`ocean`) and not a forest. */
function isTraversableRouteTile(tile: Tile): boolean {
  return tile.terrainType !== 'ocean' && !tile.forested;
}

/**
 * Per-tile A* cost that keeps a laid route on traversable land: an ocean/valley or
 * forested tile is `Infinity` (impassable), every other tile costs 1. A path found
 * under this cost therefore satisfies `validateRoutePath` (no uncleared forest, no
 * unbridged impassable tile — the seeded network builds neither bridges nor cleared
 * forests).
 */
function landRouteCost(tile: Tile): number {
  return isTraversableRouteTile(tile) ? 1 : Infinity;
}

/**
 * Distance in graph hops from `source` to every tile (`-1` when unreachable), via a
 * single BFS over the full tile adjacency — the same metric as `graphDistance`, but
 * computed once for all tiles so anchor sorting stays cheap and deterministic.
 */
function bfsDistances(tiles: Tile[], source: number): Int32Array {
  const dist = new Int32Array(tiles.length).fill(-1);
  dist[source] = 0;
  const queue: number[] = [source];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist[cur];
    for (const nb of tiles[cur].neighbours) {
      if (dist[nb] === -1) {
        dist[nb] = d + 1;
        queue.push(nb);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Transport factory (tiers built through the pure engine)
// ---------------------------------------------------------------------------

/**
 * A seeded Transportation_Unit whose visual `tier` is derived by applying
 * `upgradeTransport` `upgrades` times to a base van, so `tier === transportTier(upgrades)`
 * holds by construction (Req 13.7, 14.3–14.5). Upgrades target `speed` so the cargo
 * capacity stays at its in-domain seed value.
 */
function makeTieredTransport(
  id: string,
  routeId: string,
  ownerId: string,
  upgrades: number,
): Transport {
  let transport: Transport = {
    id,
    ownerId,
    routeId,
    cargoType: null,
    cargo: 0,
    cargoCapacity: SEED_TRANSPORT_CARGO,
    speed: 1,
    defence: 1,
    upgrades: 0,
    tier: transportTier(0),
    inTransit: false,
    turnsRemaining: 0,
    unitId: `${id}-unit`,
  };
  for (let i = 0; i < upgrades; i++) {
    transport = upgradeTransport(transport, 'speed');
  }
  return transport;
}

// ---------------------------------------------------------------------------
// Network builder
// ---------------------------------------------------------------------------

/**
 * A fully-built candidate network (all entities validated) awaiting commit into the
 * caller's `LogisticsState`.
 */
interface BuiltNetwork {
  well: OilWell;
  refinery: Refinery;
  hub: DistributionHub;
  routes: LogisticsRoute[];
  transports: Transport[];
}

/**
 * Attempt to build the complete example network anchored on `wellTile` (an oil
 * tile) and terminating at `homeTile`. Returns the built entities on success, or
 * `null` when the terrain around this anchor cannot host the network (caller then
 * tries the next-nearest oil tile). Every step goes through a pure engine helper
 * and is validated first, so a returned network is invariant-legal.
 */
function tryBuildNetwork(
  tiles: Tile[],
  homeFactionId: string,
  homeTile: number,
  wellTile: number,
): BuiltNetwork | null {
  // A working state so occupancy-aware validators (refinery placement) see the
  // entities placed so far. `ctx.state` aliases `work`, so in-place updates are
  // visible to the validators immediately.
  const work = createEmptyLogisticsState();
  const ctx: LogisticsContext = { tiles, state: work };

  // ── Oil_Well on the anchor oil tile (Req 13.2) ──────────────────────────────
  const wellSeg = flattestSegment(tiles[wellTile]).segment;
  const engineer: EngineerUnitRef = {
    id: 'seed-engineer',
    ownerId: homeFactionId,
    tileIndex: wellTile,
    segment: wellSeg,
    attributes: { engineer: 5 },
  };
  if (!validateWellPlacement(ctx, wellTile, wellSeg, engineer).legal) return null;
  const wellTask: EngineerTask = {
    id: 'seed-well-0-task',
    kind: 'well',
    unitId: 'seed-engineer',
    tileIndex: wellTile,
    segment: wellSeg,
    turnsRemaining: 0,
    ownerId: homeFactionId,
  };
  const well = completeWellTask(wellTask, {
    id: 'seed-well-0',
    maxHitPoints: SEED_STRUCTURE_HP,
  });
  work.wells.push(well);

  // ── The land path Well → Home_City the routes will follow ───────────────────
  const path = findPath(tiles, wellTile, homeTile, landRouteCost);
  // Need room for well (path[0]), refinery (interior), and home (last): >= 3 tiles.
  if (!path || path.length < 3) return null;
  const lastIdx = path.length - 1;

  // ── Refinery on an interior path tile (Req 13.3) ────────────────────────────
  // First interior tile (nearest the well) whose whole hex can host a refinery,
  // leaving at least one further interior tile before the Home_City for the route.
  let refPos = -1;
  for (let i = 1; i <= lastIdx - 1; i++) {
    if (validateRefineryPlacement(ctx, path[i], homeFactionId).legal) {
      refPos = i;
      break;
    }
  }
  if (refPos < 0) return null;
  const refTile = path[refPos];

  // Build the refinery with its first segment, then add a second through the
  // segment validator so it has >= 2 Refinery_Segments (Req 13.3).
  const refinery: Refinery = {
    id: 'seed-refinery-0',
    ownerId: homeFactionId,
    tileIndex: refTile,
    segments: [0],
    heldOil: 0,
    refinedProductAvailable: 0,
    hitPoints: SEED_STRUCTURE_HP,
    maxHitPoints: SEED_STRUCTURE_HP,
  };
  if (!validateRefinerySegment(ctx, refinery, 1).legal) return null;
  refinery.segments.push(1);
  work.refineries.push(refinery);

  // ── Endpoint descriptors ────────────────────────────────────────────────────
  const wellEndpoint: RouteEndpoint = {
    structureId: well.id,
    kind: 'well',
    tileIndex: wellTile,
    ownerId: homeFactionId,
  };
  const refineryEndpoint: RouteEndpoint = {
    structureId: refinery.id,
    kind: 'refinery',
    tileIndex: refTile,
    ownerId: homeFactionId,
  };
  const homeEndpoint: RouteEndpoint = {
    structureId: homeFactionId, // the Home_City's id (== the home faction id)
    kind: 'home-city',
    tileIndex: homeTile,
    ownerId: homeFactionId,
  };

  // ── Route 1: Well → Refinery, laid as a Road (Req 13.4) ─────────────────────
  const roadPath = path.slice(0, refPos + 1);
  const roadEndpoints: RouteEndpoints = { from: wellEndpoint, to: refineryEndpoint };
  if (!validateRoutePath(ctx, roadPath, roadEndpoints).legal) return null;
  const road = createRoute(
    {
      id: 'seed-route-road',
      ownerId: homeFactionId,
      fromStructureId: well.id,
      toStructureId: refinery.id,
      path: roadPath,
    },
    tiles,
  );

  // ── Route 2: Refinery → Home_City, upgraded to a Highway (Req 13.5, 13.8) ────
  const highwayPath = path.slice(refPos); // refTile … homeTile
  const highwayEndpoints: RouteEndpoints = { from: refineryEndpoint, to: homeEndpoint };
  if (!validateRoutePath(ctx, highwayPath, highwayEndpoints).legal) return null;
  const highwayRoad = createRoute(
    {
      id: 'seed-route-highway',
      ownerId: homeFactionId,
      fromStructureId: refinery.id,
      toStructureId: homeEndpoint.structureId,
      path: highwayPath,
    },
    tiles,
  );
  const upgraded = upgradeRoute(highwayRoad);
  if (upgraded instanceof Error) return null;
  const highway = upgraded;

  work.routes.push(road, highway);

  // ── Distribution_Hub connecting both routes (Req 13.6) ──────────────────────
  // Seated ON the Home_City tile (in the city) so it fuels the Home_City's
  // upgrades, per the placement rule that at least one hub must sit inside the
  // city. The Home_City tile is the Highway's terminal, so the hub still sits on
  // the network it balances. Its segment is the flattest one on the city tile;
  // at world-gen time no buildings exist yet, so the segment is free (the
  // default-scenario builder reserves this segment before placing city buildings,
  // keeping the hub from sharing a segment with a building).
  const hubTile = homeTile;
  const hub = createHub({
    id: 'seed-hub-0',
    ownerId: homeFactionId,
    tileIndex: hubTile,
    segment: flattestSegment(tiles[hubTile]).segment,
    routeIds: [road.id, highway.id],
    maxHitPoints: SEED_STRUCTURE_HP,
  });
  work.hubs.push(hub);

  // ── One Transportation_Unit per tier, assigned to routes (Req 13.7) ─────────
  // van → road; truck + juggernaut → highway. Each route stays within
  // MAX_TRANSPORTS_PER_ROUTE (road: 1, highway: 2).
  const routeForTier = [road.id, highway.id, highway.id];
  const transports = TIER_UPGRADES.map((t, i) =>
    makeTieredTransport(t.id, routeForTier[i], homeFactionId, t.upgrades),
  );
  work.transports.push(...transports);

  return { well, refinery, hub, routes: work.routes, transports };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Populate `state` with a complete, deterministic example logistics network:
 * `>= 1` operational Oil_Well on an oil tile, a Refinery with `>= 2` segments, a
 * Road and a Highway, a Distribution_Hub connecting both routes, and one
 * Transportation_Unit of each Transport_Tier — all owned by `homeFactionId` and
 * chained through to the Home_City (Req 13.1–13.9). Mutates only `state`; pure and
 * deterministic in `(tiles, homeFactionId)`.
 *
 * The Home_City tile is derived from `tiles` via its `cityId` (set by
 * `placeCities`): the tile whose `cityId === homeFactionId`. If no such tile exists
 * or the world holds no oil deposits, the network cannot be anchored and `state` is
 * left empty.
 */
export function seedDefaultLogisticsNetwork(
  state: LogisticsState,
  tiles: Tile[],
  homeFactionId: string,
): void {
  // Home_City tile: the tile carrying the home faction's city id.
  const homeTileEntry = tiles.find((t) => t.cityId === homeFactionId);
  if (!homeTileEntry) return;
  const homeTile = homeTileEntry.index;

  // Oil anchors: every 'oil' tile, ordered by graph distance to the Home_City
  // (nearest first), lowest tile index as the deterministic tie-break (Req 13.9).
  const distances = bfsDistances(tiles, homeTile);
  const oilTiles = tiles.filter((t) => t.resourceType === 'oil').map((t) => t.index);
  if (oilTiles.length === 0) return;
  oilTiles.sort((a, b) => {
    const da = distances[a] < 0 ? Number.POSITIVE_INFINITY : distances[a];
    const db = distances[b] < 0 ? Number.POSITIVE_INFINITY : distances[b];
    if (da !== db) return da - db;
    return a - b;
  });

  // Try each anchor nearest-first; commit the first that yields a full network.
  for (const wellTile of oilTiles) {
    const built = tryBuildNetwork(tiles, homeFactionId, homeTile, wellTile);
    if (!built) continue;

    state.wells.push(built.well);
    state.refineries.push(built.refinery);
    state.hubs.push(built.hub);
    state.routes.push(...built.routes);
    state.transports.push(...built.transports);
    state.home[homeFactionId] = {
      factionId: homeFactionId,
      refinedProduct: SEED_HOME_REFINED_PRODUCT,
      oil: 0,
    };
    return;
  }
}
