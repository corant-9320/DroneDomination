/**
 * Uniform dispatcher for logistics intents (Oil Logistics System — server side).
 *
 * Routes a logistics `Intent` to its applier. Used by `matchApi.ts` routing
 * (task 13.3). Reject-and-preserve is guaranteed by each applier.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import {
  ENFORCE_LOGISTICS_POLICY,
  type LogisticsIntentPolicy,
  type LogisticsApplyResult,
} from './context.js';
import { applyBuildOilWellIntent } from './wells.js';
import {
  applyBuildBridgeIntent,
  applyBuildRoadSegmentIntent,
  applyClearForestIntent,
  applyGodModeBuildRoadIntent,
} from './bridgesAndForest.js';
import { applyBuildRefineryIntent, applyAddRefinerySegmentIntent } from './refineries.js';
import {
  applyGodModeCreateOilBuildingIntent,
  applyGodModeEditOilBuildingIntent,
  applyGodModeDeleteOilBuildingIntent,
} from './structures.js';
import { applyBuildRouteIntent, applyUpgradeRouteIntent } from './routes.js';
import { applyBuildDistributionHubIntent } from './hubs.js';
import { applyPurchaseTransportIntent, applyUpgradeTransportIntent } from './transport.js';
import { applyCreateShuttleTransportIntent, applyStopShuttleTransportIntent } from './shuttle.js';

/** Every logistics `Intent` kind this module handles. */
export type LogisticsIntentKind =
  | 'buildOilWell'
  | 'buildRefinery'
  | 'addRefinerySegment'
  | 'buildRoute'
  | 'upgradeRoute'
  | 'buildDistributionHub'
  | 'buildBridge'
  | 'clearForest'
  | 'buildRoadSegment'
  | 'godModeBuildRoad'
  | 'godModeCreateOilBuilding'
  | 'godModeEditOilBuilding'
  | 'godModeDeleteOilBuilding'
  | 'purchaseTransport'
  | 'upgradeTransport'
  | 'createShuttleTransport'
  | 'stopShuttleTransport';

/** A logistics intent (any variant this module applies). */
export type LogisticsIntent = Extract<Intent, { kind: LogisticsIntentKind }>;

/** Type guard: whether an arbitrary intent is a logistics intent handled here. */
export function isLogisticsIntent(intent: Intent): intent is LogisticsIntent {
  switch (intent.kind) {
    case 'buildOilWell':
    case 'buildRefinery':
    case 'addRefinerySegment':
    case 'buildRoute':
    case 'upgradeRoute':
    case 'buildDistributionHub':
    case 'buildBridge':
    case 'clearForest':
    case 'buildRoadSegment':
    case 'godModeBuildRoad':
    case 'godModeCreateOilBuilding':
    case 'godModeEditOilBuilding':
    case 'godModeDeleteOilBuilding':
    case 'purchaseTransport':
    case 'upgradeTransport':
    case 'createShuttleTransport':
    case 'stopShuttleTransport':
      return true;
    default:
      return false;
  }
}

/**
 * Route a logistics intent to its applier (used by `matchApi.ts::handleMatchIntent`
 * in task 13.3). Reject-and-preserve is guaranteed by each applier.
 */
export function applyLogisticsIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: LogisticsIntent,
  policy: LogisticsIntentPolicy = ENFORCE_LOGISTICS_POLICY,
): LogisticsApplyResult {
  switch (intent.kind) {
    case 'buildOilWell':
      return applyBuildOilWellIntent(state, tiles, activeFaction, intent, policy);
    case 'buildRefinery':
      return applyBuildRefineryIntent(state, tiles, activeFaction, intent, policy);
    case 'addRefinerySegment':
      return applyAddRefinerySegmentIntent(state, tiles, activeFaction, intent, policy);
    case 'buildRoute':
      return applyBuildRouteIntent(state, tiles, activeFaction, intent, policy);
    case 'upgradeRoute':
      return applyUpgradeRouteIntent(state, tiles, activeFaction, intent, policy);
    case 'buildDistributionHub':
      return applyBuildDistributionHubIntent(state, tiles, activeFaction, intent, policy);
    case 'buildBridge':
      return applyBuildBridgeIntent(state, tiles, activeFaction, intent, policy);
    case 'clearForest':
      return applyClearForestIntent(state, tiles, activeFaction, intent, policy);
    case 'buildRoadSegment':
      return applyBuildRoadSegmentIntent(state, tiles, activeFaction, intent, policy);
    case 'godModeBuildRoad':
      return applyGodModeBuildRoadIntent(state, tiles, activeFaction, intent, policy);
    case 'godModeCreateOilBuilding':
      return applyGodModeCreateOilBuildingIntent(state, tiles, activeFaction, intent, policy);
    case 'godModeEditOilBuilding':
      return applyGodModeEditOilBuildingIntent(state, tiles, activeFaction, intent, policy);
    case 'godModeDeleteOilBuilding':
      return applyGodModeDeleteOilBuildingIntent(state, tiles, activeFaction, intent, policy);
    case 'purchaseTransport':
      return applyPurchaseTransportIntent(state, tiles, activeFaction, intent, policy);
    case 'upgradeTransport':
      return applyUpgradeTransportIntent(state, tiles, activeFaction, intent, policy);
    case 'createShuttleTransport':
      return applyCreateShuttleTransportIntent(state, tiles, activeFaction, intent, policy);
    case 'stopShuttleTransport':
      return applyStopShuttleTransportIntent(state, tiles, activeFaction, intent);
  }
}
