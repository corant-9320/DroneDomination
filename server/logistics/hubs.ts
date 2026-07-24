/**
 * Distribution hub intent applier (Oil Logistics System — server side):
 * applyBuildDistributionHubIntent.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { DistributionHub } from '../../shared/logisticsTypes.js';
import { createHub } from '../../src/world/logistics/hubs.js';
import { validateDistributionHubPlacement } from '../../src/world/logistics/placement.js';
import {
  buildingOccupies,
  chargeConstructionCost,
  ENFORCE_CONSTRUCTION_COSTS,
  genId,
  getHome,
  makeCtx,
  STRUCTURE_MAX_HIT_POINTS,
  type ConstructionCostPolicy,
  type LogisticsApplyResult,
} from './context.js';

/**
 * Build a Distribution_Hub (oil storage) on a HexSegment, connecting two-or-more
 * Logistics_Routes (Req 11.1, 11.2, 5.2, 5.3, 12.1). Shared placement validation
 * enforces map-only placement, exclusive oil-tile designation, and one reserved
 * road segment; this applier adds the authoritative ordinary-building collision
 * check before mutation.
 */
export function applyBuildDistributionHubIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildDistributionHub' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const ctx = makeCtx(state, tiles);
  const validation = validateDistributionHubPlacement(
    ctx,
    intent.tileIndex,
    activeFaction,
    intent.segment,
  );
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  // Main-game buildings are outside LogisticsState, so retain the authoritative
  // collision check after the shared storage-placement validation.
  if (buildingOccupies(state, intent.tileIndex, intent.segment)) {
    return { error: 'Invalid hub placement: that segment is already occupied.' };
  }

  const cost = CONSTRUCTION_COST.distributionHub;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) {
    return { error: 'Insufficient Refined_Product to build a distribution hub.' };
  }

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  const hub: DistributionHub = createHub({
    id: genId('hub'),
    ownerId: activeFaction,
    tileIndex: intent.tileIndex,
    segment: intent.segment,
    routeIds: [...intent.routeIds],
    maxHitPoints: STRUCTURE_MAX_HIT_POINTS,
  });
  state.logistics.hubs.push(hub);
  return {};
}
