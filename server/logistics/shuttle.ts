/**
 * Shuttle transport intent appliers (Oil Logistics System — server side):
 * applyCreateShuttleTransportIntent, applyStopShuttleTransportIntent.
 *
 * A shuttle is a player-created point-to-point Transportation_Unit that
 * patrols back and forth along a fixed path resolved from ANY already-built
 * road connecting two owned oil structures (well / refinery / storage hub) —
 * a real `LogisticsRoute` or a development `standaloneRoadSegments` overlay,
 * in any combination. It never creates new road. If the two hexes have no
 * completed road between them (by either mechanism), creation is rejected
 * (Req: "use the road connection; if no road exists, don't create transport").
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { SegNode } from '../../shared/segmentGraph.js';
import { createShuttleTransport, stopShuttle } from '../../src/world/logistics/shuttle.js';
import { findExistingRoadPath } from '../../src/world/logistics/routes.js';
import {
  chargeConstructionCost,
  ENFORCE_CONSTRUCTION_COSTS,
  genId,
  getHome,
  makeCtx,
  resolveEndpoint,
  INITIAL_TRANSPORT_CARGO_CAPACITY,
  INITIAL_TRANSPORT_DEFENCE,
  INITIAL_TRANSPORT_SPEED,
  type ConstructionCostPolicy,
  type LogisticsApplyResult,
} from './context.js';

/** Every segment a resolved structure occupies (one for well/hub, 1+ for a refinery). */
function structureFootprint(state: MatchState, structureId: string): SegNode[] {
  const well = state.logistics.wells.find((w) => w.id === structureId);
  if (well) return [{ tileIndex: well.tileIndex, segment: well.segment }];
  const refinery = state.logistics.refineries.find((r) => r.id === structureId);
  if (refinery) return refinery.segments.map((segment) => ({ tileIndex: refinery.tileIndex, segment }));
  const hub = state.logistics.hubs.find((h) => h.id === structureId);
  if (hub) return [{ tileIndex: hub.tileIndex, segment: hub.segment }];
  return [];
}

/**
 * Create a shuttle transport between two owned oil structures (well,
 * refinery, or storage hub), resolving a fixed patrol path over ANY road
 * already connecting them (a real `LogisticsRoute` or a development
 * standalone-road overlay) — no road is built. Rejects when no such path
 * exists, when either endpoint is missing/not owned by `activeFaction`, or
 * when the player cannot afford the standard transport cost.
 */
export function applyCreateShuttleTransportIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'createShuttleTransport' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const from = resolveEndpoint(state, tiles, intent.fromStructureId);
  const to = resolveEndpoint(state, tiles, intent.toStructureId);
  if (!from || !to) {
    return { error: 'A shuttle must connect an oil well, a refinery, or a storage hub at each end.' };
  }
  if (from.ownerId !== activeFaction || to.ownerId !== activeFaction) {
    return { error: 'Both shuttle endpoints must belong to you.' };
  }
  if (from.structureId === to.structureId) {
    return { error: 'A shuttle must connect two different structures.' };
  }

  const fromFootprint = structureFootprint(state, intent.fromStructureId);
  const toFootprint = structureFootprint(state, intent.toStructureId);
  if (fromFootprint.length === 0 || toFootprint.length === 0) {
    return { error: 'A shuttle must connect an oil well, a refinery, or a storage hub at each end.' };
  }

  const ctx = makeCtx(state, tiles);
  const ownedRouteSegments = state.logistics.routes
    .filter((r) => r.ownerId === activeFaction && r.operable !== false)
    .map((r) => r.segments);
  const shuttlePath = findExistingRoadPath(
    ctx.tiles,
    ownedRouteSegments,
    state.logistics.standaloneRoadSegments ?? [],
    fromFootprint,
    toFootprint,
  );
  if (!shuttlePath || shuttlePath.length < 2) {
    return { error: 'No road connects those two structures yet — build a route first.' };
  }

  const cost = CONSTRUCTION_COST.transportUnit;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to create a transport.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  const id = genId('transport');
  const transport = createShuttleTransport({
    id,
    ownerId: activeFaction,
    shuttlePath,
    cargoCapacity: INITIAL_TRANSPORT_CARGO_CAPACITY,
    speed: INITIAL_TRANSPORT_SPEED,
    defence: INITIAL_TRANSPORT_DEFENCE,
    unitId: `${id}-unit`,
  });
  state.logistics.transports.push(transport);
  return {};
}

/** Permanently stop a shuttle transport's automated back-and-forth movement. */
export function applyStopShuttleTransportIntent(
  state: MatchState,
  _tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'stopShuttleTransport' }>,
): LogisticsApplyResult {
  const idx = state.logistics.transports.findIndex((t) => t.id === intent.transportId);
  if (idx < 0) return { error: 'Transport not found' };
  const transport = state.logistics.transports[idx];
  if (transport.ownerId !== activeFaction) return { error: 'That transport is owned by another player.' };
  if (!transport.shuttleMode) return { error: 'That transport is not a shuttle.' };

  state.logistics.transports[idx] = stopShuttle(transport);
  return {};
}
