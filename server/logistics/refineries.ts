/**
 * Refinery intent appliers (Oil Logistics System — server side):
 * applyBuildRefineryIntent, applyAddRefinerySegmentIntent.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { Refinery } from '../../shared/logisticsTypes.js';
import { validateRefineryPlacement, validateRefinerySegment } from '../../src/world/logistics/placement.js';
import {
  buildingOccupies,
  buildingOnTile,
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
 * Build a new Refinery covering a whole HexTile with one initial Refinery_Segment
 * (Req 4.1, 4.2, 4.10, 4.11, 4.12, 5.2, 5.3, 12.1). The refinery is operational
 * immediately (unlike engineer-driven wells).
 */
export function applyBuildRefineryIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildRefinery' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const ctx = makeCtx(state, tiles);
  const validation = validateRefineryPlacement(ctx, intent.tileIndex, activeFaction);
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  // Building-collision check the pure engine cannot perform (any segment of the tile).
  if (buildingOnTile(state, intent.tileIndex)) {
    return { error: 'A building already occupies this tile.' };
  }

  const cost = CONSTRUCTION_COST.refineryFirstSegment;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to build a refinery.' };

  // ── Commit ── one Refinery_Segment on the first HexSegment (Req 4.2).
  state.logistics.home[activeFaction] = chargedHome;
  const refinery: Refinery = {
    id: genId('refinery'),
    ownerId: activeFaction,
    tileIndex: intent.tileIndex,
    segments: [0],
    heldOil: 0,
    refinedProductAvailable: 0,
    hitPoints: STRUCTURE_MAX_HIT_POINTS,
    maxHitPoints: STRUCTURE_MAX_HIT_POINTS,
  };
  state.logistics.refineries.push(refinery);
  return {};
}

/**
 * Add one Refinery_Segment to an existing Refinery on an unoccupied HexSegment of
 * its tile (Req 4.3, 4.8, 4.9, 5.2, 5.3, 12.3).
 */
export function applyAddRefinerySegmentIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'addRefinerySegment' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const refinery = state.logistics.refineries.find((r) => r.id === intent.refineryId);
  if (!refinery) return { error: 'Refinery not found' };
  if (refinery.ownerId !== activeFaction) return { error: 'That refinery is owned by another player.' };

  const ctx = makeCtx(state, tiles);
  const validation = validateRefinerySegment(ctx, refinery, intent.segment);
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  if (buildingOccupies(state, refinery.tileIndex, intent.segment)) {
    return { error: 'That segment is already occupied by a building.' };
  }

  const cost = CONSTRUCTION_COST.refineryAdditionalSegment;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) {
    return { error: 'Insufficient Refined_Product to add a refinery segment.' };
  }

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  refinery.segments.push(intent.segment);
  return {};
}
