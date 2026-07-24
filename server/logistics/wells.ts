/**
 * Oil well intent applier (Oil Logistics System — server side): applyBuildOilWellIntent.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { EngineerTask } from '../../shared/logisticsTypes.js';
import { engineerTaskDuration } from '../../src/world/logistics/tasks.js';
import { validateWellPlacement } from '../../src/world/logistics/placement.js';
import {
  buildingOccupies,
  chargeConstructionCost,
  ENFORCE_CONSTRUCTION_COSTS,
  genId,
  getHome,
  makeCtx,
  resolveEngineer,
  type ConstructionCostPolicy,
  type LogisticsApplyResult,
} from './context.js';

/**
 * Begin drilling an Oil_Well on the acting engineer's current HexSegment
 * (Req 2.1–2.5, 5.2, 5.3, 9.1, 12.1, 12.3). Starts a `well` EngineerTask; the
 * operational well is produced when the task completes in `resolveLogisticsTurn`.
 */
export function applyBuildOilWellIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildOilWell' }>,
  costPolicy: ConstructionCostPolicy = ENFORCE_CONSTRUCTION_COSTS,
): LogisticsApplyResult {
  const resolved = resolveEngineer(state, intent.unitId, activeFaction);
  if ('error' in resolved) return { error: resolved.error };
  const ref = resolved.ref;

  const ctx = makeCtx(state, tiles);
  const validation = validateWellPlacement(ctx, ref.tileIndex, ref.segment, ref);
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  // Building-collision check the pure engine cannot perform.
  if (buildingOccupies(state, ref.tileIndex, ref.segment)) {
    return { error: 'That segment is already occupied by a building.' };
  }

  const cost = CONSTRUCTION_COST.oilWell;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, costPolicy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to drill an oil well.' };

  // ── Commit (reject-and-preserve: nothing above mutated state) ──
  state.logistics.home[activeFaction] = chargedHome;
  const task: EngineerTask = {
    id: genId('task-well'),
    kind: 'well',
    unitId: ref.id,
    tileIndex: ref.tileIndex,
    segment: ref.segment,
    turnsRemaining: engineerTaskDuration(ref.attributes.engineer ?? 0),
    ownerId: activeFaction,
  };
  state.logistics.tasks.push(task);
  return {};
}
