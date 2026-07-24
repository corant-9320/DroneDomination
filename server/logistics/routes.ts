/**
 * Route intent appliers (Oil Logistics System — server side):
 * applyBuildRouteIntent, applyUpgradeRouteIntent.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { LogisticsRoute } from '../../shared/logisticsTypes.js';
import { createRoute, upgradeRoute, validateRoutePath, type RouteEndpoints } from '../../src/world/logistics/routes.js';
import {
  realizeTilePathOverSegments,
  encodeSeg,
} from '../../shared/segmentGraph.js';
import { segmentCost } from '../../shared/movementConstants.js';
import {
  chargeConstructionCost,
  ENFORCE_CONSTRUCTION_COSTS,
  genId,
  getHome,
  makeCtx,
  resolveEndpoint,
  type ConstructionCostPolicy,
  type LogisticsApplyResult,
} from './context.js';

/**
 * Build a Logistics_Route as a Road along a contiguous path between two player-owned
 * endpoints (Req 6.1, 6.2, 6.3, 5.2, 5.3, 12.1). Cost is `routeRoadPerSegment` per
 * segment step.
 *
 * The `intent.path` is a tile-index path (sent by the client). The server converts
 * it to a segment-level path via `realizeTilePathOverSegments`, using building
 * occupancy to route through unoccupied segments. Routes now follow the same
 * segment-graph model as unit movement (Segment-Based Movement spec).
 */
export function applyBuildRouteIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildRoute' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const from = resolveEndpoint(state, tiles, intent.fromStructureId);
  const to = resolveEndpoint(state, tiles, intent.toStructureId);
  if (!from || !to) {
    return { error: 'A route must connect an oil well, a refinery, a storage hub, or the home city at each end.' };
  }
  const endpoints: RouteEndpoints = { from, to };

  // A route connects player-owned endpoints (Req 6.2).
  if (from.ownerId !== activeFaction || to.ownerId !== activeFaction) {
    return { error: 'Both route endpoints must belong to you.' };
  }

  if (!intent.path || intent.path.length < 2) {
    return { error: 'A route requires a path of at least 2 tiles.' };
  }

  // Build an occupancy predicate for buildings (logistics structures are part of
  // the route itself and excluded at the endpoint tiles).
  const buildingOccupants = [
    ...state.units.map((u) => ({ tileIndex: u.tileIndex, segment: u.segment })),
    ...state.buildings.map((b) => ({ tileIndex: b.tileIndex, segment: b.segment })),
  ];
  // Endpoint tiles may carry a well/hub — do not block those specific segments.
  const endpointSegments = new Set<number>();
  for (const well of state.logistics.wells) {
    if (well.tileIndex === from.tileIndex || well.tileIndex === to.tileIndex) {
      endpointSegments.add(encodeSeg(well.tileIndex, well.segment));
    }
  }
  for (const hub of state.logistics.hubs) {
    if (hub.tileIndex === from.tileIndex || hub.tileIndex === to.tileIndex) {
      endpointSegments.add(encodeSeg(hub.tileIndex, hub.segment));
    }
  }
  const isOccupied = (tileIndex: number, segment: number): boolean => {
    const key = encodeSeg(tileIndex, segment);
    if (endpointSegments.has(key)) return false;
    return buildingOccupants.some((o) => o.tileIndex === tileIndex && o.segment === segment);
  };

  // Determine the start segment: the endpoint structure's segment when known.
  const startWell = state.logistics.wells.find((w) => w.id === intent.fromStructureId);
  const startHub = state.logistics.hubs.find((h) => h.id === intent.fromStructureId);
  const startSeg = startWell?.segment ?? startHub?.segment ?? 0;

  // Realize the tile path as an occupancy-gated segment path.
  const segResult = realizeTilePathOverSegments(
    tiles,
    { tileIndex: intent.path[0], segment: startSeg },
    intent.path,
    (tile, segment) => segmentCost(tile, segment, 'wheeled'), // roads follow ground-movement cost
    isOccupied,
  );
  if (!segResult) {
    return { error: 'Could not realize a valid segment path for this route — check for blocked segments.' };
  }
  const segmentPath = segResult.path.map((n) => encodeSeg(n.tileIndex, n.segment));

  const ctx = makeCtx(state, tiles);
  const validation = validateRoutePath(ctx, segmentPath, endpoints, isOccupied);
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  const cost = CONSTRUCTION_COST.routeRoadPerSegment * segmentPath.length;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to build this road.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  const route: LogisticsRoute = createRoute(
    {
      id: genId('route'),
      ownerId: activeFaction,
      fromStructureId: intent.fromStructureId,
      toStructureId: intent.toStructureId,
      path: segmentPath,
    },
    tiles,
  );
  state.logistics.routes.push(route);
  return {};
}

/**
 * Upgrade a Logistics_Route one capacity step and render it as a Highway
 * (Req 6.7, 6.8, 5.2, 5.3, 12.3). Rejects at maximum capacity. Cost is
 * `routeUpgradePerSegment` per Route_Segment.
 */
export function applyUpgradeRouteIntent(
  state: MatchState,
  _tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'upgradeRoute' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const idx = state.logistics.routes.findIndex((r) => r.id === intent.routeId);
  if (idx < 0) return { error: 'Route not found' };
  const route = state.logistics.routes[idx];
  if (route.ownerId !== activeFaction) return { error: 'That route is owned by another player.' };

  const upgraded = upgradeRoute(route);
  if (upgraded instanceof Error) return { error: 'The route is already at maximum capacity.' };

  const cost = CONSTRUCTION_COST.routeUpgradePerSegment * route.segments.length;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to upgrade this route.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  state.logistics.routes[idx] = upgraded;
  return {};
}
