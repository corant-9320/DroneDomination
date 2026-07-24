/**
 * Development-only CRUD appliers for segment-based oil structures.
 *
 * Wells occupy exactly one segment. Refineries own one or more segments on a
 * tile; creating or deleting a refinery through God Mode affects the selected
 * segment rather than treating the entire tile as a monolithic structure.
 */

import type { Tile } from '../../src/world/types.js';
import { WELL_STORAGE_CAPACITY } from '../../shared/logisticsConstants.js';
import { removeDependentLogisticsRoutes } from '../../shared/logisticsSanitization.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { OilWell, Refinery } from '../../shared/logisticsTypes.js';
import {
  validateRefinerySegment,
  validateRefinerySegmentPlacement,
  validateWellPlacement,
} from '../../src/world/logistics/placement.js';
import {
  buildingOccupies,
  genId,
  makeCtx,
  STRUCTURE_MAX_HIT_POINTS,
  type LogisticsApplyResult,
  type LogisticsIntentPolicy,
} from './context.js';

function godModeEnabled(policy: LogisticsIntentPolicy): boolean {
  return policy.allowRemoteTerrainTasks && policy.waiveRefinedProductCosts;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function segmentHasOtherStructure(
  state: MatchState,
  tileIndex: number,
  segment: number,
  refineryId?: string,
): boolean {
  return state.logistics.wells.some((well) => well.tileIndex === tileIndex && well.segment === segment)
    || state.logistics.hubs.some((hub) => hub.tileIndex === tileIndex && hub.segment === segment)
    || state.logistics.refineries.some((refinery) => (
      refinery.id !== refineryId
      && refinery.tileIndex === tileIndex
      && refinery.segments.includes(segment)
    ));
}

/** Remove route dependencies after a well or final refinery footprint is deleted. */
function removeDependentRoutes(state: MatchState, structureId: string): void {
  state.logistics = removeDependentLogisticsRoutes(state.logistics, new Set([structureId]));
}

/** Create an operational well or refinery segment immediately in development God Mode. */
export function applyGodModeCreateOilBuildingIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'godModeCreateOilBuilding' }>,
  policy: LogisticsIntentPolicy,
): LogisticsApplyResult {
  if (!godModeEnabled(policy)) return { error: 'God Mode entity editing is disabled.' };

  const ctx = makeCtx(state, tiles);
  if (intent.structure === 'well') {
    const validation = validateWellPlacement(ctx, intent.tileIndex, intent.segment, {
      id: 'god-mode',
      ownerId: activeFaction,
      tileIndex: intent.tileIndex,
      segment: intent.segment,
      attributes: { engineer: 1 },
    });
    if (!validation.legal) return { error: validation.message ?? validation.reason };
    if (buildingOccupies(state, intent.tileIndex, intent.segment)) {
      return { error: 'That segment is already occupied by a building.' };
    }

    const well: OilWell = {
      id: genId('well'),
      ownerId: activeFaction,
      tileIndex: intent.tileIndex,
      segment: intent.segment,
      storedOil: 0,
      hitPoints: STRUCTURE_MAX_HIT_POINTS,
      maxHitPoints: STRUCTURE_MAX_HIT_POINTS,
    };
    state.logistics.wells.push(well);
    return {};
  }

  const existing = state.logistics.refineries.find((refinery) => refinery.tileIndex === intent.tileIndex);
  if (existing) {
    const validation = validateRefinerySegment(ctx, existing, intent.segment);
    if (!validation.legal) return { error: validation.message ?? validation.reason };
  } else {
    const validation = validateRefinerySegmentPlacement(ctx, intent.tileIndex, activeFaction, intent.segment);
    if (!validation.legal) return { error: validation.message ?? validation.reason };
  }
  if (buildingOccupies(state, intent.tileIndex, intent.segment) || segmentHasOtherStructure(
    state, intent.tileIndex, intent.segment, existing?.id,
  )) {
    return { error: 'That segment is already occupied by a structure.' };
  }

  if (existing) {
    existing.segments.push(intent.segment);
    return {};
  }
  const refinery: Refinery = {
    id: genId('refinery'), ownerId: activeFaction, tileIndex: intent.tileIndex, segments: [intent.segment],
    heldOil: 0, refinedProductAvailable: 0,
    hitPoints: STRUCTURE_MAX_HIT_POINTS, maxHitPoints: STRUCTURE_MAX_HIT_POINTS,
  };
  state.logistics.refineries.push(refinery);
  return {};
}

/** Update the editable operational state of an existing oil structure. */
export function applyGodModeEditOilBuildingIntent(
  state: MatchState,
  _tiles: Tile[],
  _activeFaction: string,
  intent: Extract<Intent, { kind: 'godModeEditOilBuilding' }>,
  policy: LogisticsIntentPolicy,
): LogisticsApplyResult {
  if (!godModeEnabled(policy)) return { error: 'God Mode entity editing is disabled.' };

  if (intent.structure === 'well') {
    const well = state.logistics.wells.find((candidate) => candidate.id === intent.structureId);
    if (!well) return { error: 'Oil well not found.' };
    if (!Number.isInteger(intent.hitPoints) || intent.hitPoints < 1 || intent.hitPoints > well.maxHitPoints) {
      return { error: `Hit points must be an integer from 1 to ${well.maxHitPoints}.` };
    }
    if (!Number.isInteger(intent.storedOil) || intent.storedOil < 0 || intent.storedOil > WELL_STORAGE_CAPACITY) {
      return { error: `Stored oil must be an integer from 0 to ${WELL_STORAGE_CAPACITY}.` };
    }
    well.hitPoints = intent.hitPoints;
    well.storedOil = intent.storedOil;
    return {};
  }

  const refinery = state.logistics.refineries.find((candidate) => candidate.id === intent.structureId);
  if (!refinery) return { error: 'Refinery not found.' };
  if (!Number.isInteger(intent.hitPoints) || intent.hitPoints < 1 || intent.hitPoints > refinery.maxHitPoints) {
    return { error: `Hit points must be an integer from 1 to ${refinery.maxHitPoints}.` };
  }
  if (!nonNegativeSafeInteger(intent.heldOil) || !nonNegativeSafeInteger(intent.refinedProductAvailable)) {
    return { error: 'Refinery stores must be non-negative safe integers.' };
  }
  refinery.hitPoints = intent.hitPoints;
  refinery.heldOil = intent.heldOil;
  refinery.refinedProductAvailable = intent.refinedProductAvailable;
  return {};
}

/** Delete a well or the selected refinery segment in development God Mode. */
export function applyGodModeDeleteOilBuildingIntent(
  state: MatchState,
  _tiles: Tile[],
  _activeFaction: string,
  intent: Extract<Intent, { kind: 'godModeDeleteOilBuilding' }>,
  policy: LogisticsIntentPolicy,
): LogisticsApplyResult {
  if (!godModeEnabled(policy)) return { error: 'God Mode entity editing is disabled.' };

  if (intent.structure === 'well') {
    const exists = state.logistics.wells.some((candidate) => candidate.id === intent.structureId);
    if (!exists) return { error: 'Oil well not found.' };
    state.logistics.wells = state.logistics.wells.filter((candidate) => candidate.id !== intent.structureId);
    removeDependentRoutes(state, intent.structureId);
    return {};
  }

  const refinery = state.logistics.refineries.find((candidate) => candidate.id === intent.structureId);
  if (!refinery) return { error: 'Refinery not found.' };
  if (!refinery.segments.includes(intent.segment)) return { error: 'Refinery does not occupy that segment.' };

  if (refinery.segments.length > 1) {
    refinery.segments = refinery.segments.filter((segment) => segment !== intent.segment);
    return {};
  }
  state.logistics.refineries = state.logistics.refineries.filter((candidate) => candidate.id !== refinery.id);
  removeDependentRoutes(state, refinery.id);
  return {};
}
