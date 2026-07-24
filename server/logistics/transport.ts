/**
 * Transport intent appliers (Oil Logistics System — server side):
 * applyPurchaseTransportIntent, applyUpgradeTransportIntent.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { Transport } from '../../shared/logisticsTypes.js';
import { canAssignTransport, transportTier, upgradeTransport } from '../../src/world/logistics/transport.js';
import {
  chargeConstructionCost,
  ENFORCE_CONSTRUCTION_COSTS,
  genId,
  getHome,
  INITIAL_TRANSPORT_CARGO_CAPACITY,
  INITIAL_TRANSPORT_DEFENCE,
  INITIAL_TRANSPORT_SPEED,
  type ConstructionCostPolicy,
  type LogisticsApplyResult,
} from './context.js';

/**
 * Purchase a Transportation_Unit and assign it to a Logistics_Route (Req 8.11, 8.12,
 * 5.2, 5.3). Rejects when the route already has `MAX_TRANSPORTS_PER_ROUTE` assigned
 * (reason `route-transport-full`). New transports start at tier `van` (0 upgrades).
 */
export function applyPurchaseTransportIntent(
  state: MatchState,
  _tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'purchaseTransport' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const route = state.logistics.routes.find((r) => r.id === intent.routeId);
  if (!route) return { error: 'Route not found' };
  if (route.ownerId !== activeFaction) return { error: 'That route is owned by another player.' };

  // Req 8.12 — reject once the route is full.
  if (!canAssignTransport(route, state.logistics.transports)) {
    return { error: 'This route already has the maximum number of transports.' };
  }

  const cost = CONSTRUCTION_COST.transportUnit;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to purchase a transport.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  const id = genId('transport');
  const transport: Transport = {
    id,
    ownerId: activeFaction,
    routeId: route.id,
    cargoType: null,
    cargo: 0,
    cargoCapacity: INITIAL_TRANSPORT_CARGO_CAPACITY,
    speed: INITIAL_TRANSPORT_SPEED,
    defence: INITIAL_TRANSPORT_DEFENCE,
    upgrades: 0,
    tier: transportTier(0),
    inTransit: false,
    turnsRemaining: 0,
    unitId: `${id}-unit`,
  };
  state.logistics.transports.push(transport);
  return {};
}

/**
 * Upgrade a Transportation_Unit, strictly improving one of cargo / speed / defence
 * and recomputing its Transport_Tier (Req 8.4, 5.2, 5.3, 12.3, 14.5). Leaves the
 * assigned route's Route_Capacity untouched.
 */
export function applyUpgradeTransportIntent(
  state: MatchState,
  _tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'upgradeTransport' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const idx = state.logistics.transports.findIndex((t) => t.id === intent.transportId);
  if (idx < 0) return { error: 'Transport not found' };
  const transport = state.logistics.transports[idx];
  if (transport.ownerId !== activeFaction) {
    return { error: 'That transport is owned by another player.' };
  }

  const cost = CONSTRUCTION_COST.transportUpgrade;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to upgrade a transport.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  state.logistics.transports[idx] = upgradeTransport(transport, intent.stat);
  return {};
}
