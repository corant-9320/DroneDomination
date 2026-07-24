/**
 * Bridge & forest-clearing intent appliers (Oil Logistics System — server side):
 * applyBuildBridgeIntent, applyClearForestIntent.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { isImpassableTerrain } from '../../shared/movementConstants.js';
import { encodeSeg } from '../../shared/segmentGraph.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../../shared/matchTypes.js';
import type { EngineerTask } from '../../shared/logisticsTypes.js';
import { engineerTaskDuration } from '../../src/world/logistics/tasks.js';
import {
  chargeConstructionCost,
  ENFORCE_LOGISTICS_POLICY,
  genId,
  getHome,
  hasEngineer,
  resolveEngineer,
  type LogisticsIntentPolicy,
  type LogisticsApplyResult,
} from './context.js';

interface TerrainTaskActor {
  id: string;
  engineer: number;
  tileIndex?: number;
}

/**
 * Resolve a real engineer or, only under the server-owned God Mode policy,
 * create a virtual engineer-1 actor for a remote terrain task. The virtual
 * actor preserves the standard five-turn task duration without pretending a
 * player unit exists at the target tile.
 */
function resolveTerrainTaskActor(
  state: MatchState,
  activeFaction: string,
  unitId: string | undefined,
  policy: LogisticsIntentPolicy,
): TerrainTaskActor | { error: string } {
  if (unitId !== undefined) {
    const resolved = resolveEngineer(state, unitId, activeFaction);
    if ('error' in resolved) return { error: resolved.error };
    if (hasEngineer(resolved.ref)) {
      return {
        id: resolved.ref.id,
        engineer: resolved.ref.attributes.engineer ?? 0,
        tileIndex: resolved.ref.tileIndex,
      };
    }
  }

  if (!policy.allowRemoteTerrainTasks) {
    return { error: 'Only an engineer unit (engineer attribute 1–5) can perform this terrain task.' };
  }

  return { id: `god-mode:${activeFaction}`, engineer: 1 };
}

/**
 * Begin building a Bridge across an Impassable_Terrain HexTile (Req 10.1, 10.6,
 * 5.2, 5.3, 12.1). Starts a `bridge` EngineerTask; the tile becomes crossable when
 * the task completes in `resolveLogisticsTurn`.
 */
export function applyBuildBridgeIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildBridge' }>,
  policy: LogisticsIntentPolicy = ENFORCE_LOGISTICS_POLICY,
): LogisticsApplyResult {
  const actor = resolveTerrainTaskActor(state, activeFaction, intent.unitId, policy);
  if ('error' in actor) return { error: actor.error };

  const tile = tiles[intent.tileIndex];
  if (!tile) return { error: `Tile ${intent.tileIndex} does not exist.` };
  // A bridge is only meaningful across Impassable_Terrain (water/valley) (Req 10).
  if (!isImpassableTerrain(tile.terrainType)) {
    return { error: 'A bridge can only be built across impassable water or valley terrain.' };
  }
  if (state.logistics.bridges.includes(intent.tileIndex)) {
    return { error: 'This tile already has a bridge.' };
  }
  if (state.logistics.tasks.some((task) => task.kind === 'bridge' && task.tileIndex === intent.tileIndex)) {
    return { error: 'A bridge task is already pending on this tile.' };
  }

  const cost = CONSTRUCTION_COST.bridge;
  const chargedHome = chargeConstructionCost(getHome(state, activeFaction), cost, policy);
  if (!chargedHome) return { error: 'Insufficient Refined_Product to build a bridge.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  const task: EngineerTask = {
    id: genId('task-bridge'),
    kind: 'bridge',
    unitId: actor.id,
    tileIndex: intent.tileIndex,
    turnsRemaining: engineerTaskDuration(actor.engineer),
    ownerId: activeFaction,
  };
  state.logistics.tasks.push(task);
  return {};
}

/**
 * Begin clearing a Forest_Tile (Req 9.1, 9.6, 5.9, 12.1). In normal gameplay
 * the target is the engineer's tile; God Mode may queue the same timed task on
 * any selected forest without a nearby unit.
 */
export function applyClearForestIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'clearForest' }>,
  policy: LogisticsIntentPolicy = ENFORCE_LOGISTICS_POLICY,
): LogisticsApplyResult {
  const actor = resolveTerrainTaskActor(state, activeFaction, intent.unitId, policy);
  if ('error' in actor) return { error: actor.error };

  const tileIndex = intent.tileIndex ?? actor.tileIndex;
  if (tileIndex === undefined) return { error: 'A forest tile must be selected.' };
  if (!policy.allowRemoteTerrainTasks && tileIndex !== actor.tileIndex) {
    return { error: 'An engineer can only clear the forest on its current tile.' };
  }

  const tile = tiles[tileIndex];
  if (!tile) return { error: `Tile ${tileIndex} does not exist.` };
  if (!tile.forested || state.logistics.clearedForests.includes(tileIndex)) {
    return { error: 'There is no uncleared forest on this tile.' };
  }
  if (state.logistics.tasks.some((task) => task.kind === 'clearForest' && task.tileIndex === tileIndex)) {
    return { error: 'A forest-clearing task is already pending on this tile.' };
  }

  const chargedHome = chargeConstructionCost(
    getHome(state, activeFaction),
    CONSTRUCTION_COST.forestClear,
    policy,
  );
  if (!chargedHome) return { error: 'Insufficient Refined_Product to clear a forest.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargedHome;
  const task: EngineerTask = {
    id: genId('task-clear'),
    kind: 'clearForest',
    unitId: actor.id,
    tileIndex,
    turnsRemaining: engineerTaskDuration(actor.engineer),
    ownerId: activeFaction,
  };
  state.logistics.tasks.push(task);
  return {};
}

/**
 * Shared road-segment validation for both the engineer-built (`buildRoadSegment`)
 * and development God Mode (`godModeBuildRoad`) paths, so the two can never
 * disagree on where a road may legally go. Returns an error message, or
 * `{ key }` with the encoded segment key on success.
 *
 * `excludeUnitId` lets the acting engineer be ignored when checking unit
 * occupancy — see `applyBuildRoadSegmentIntent` for why that matters.
 */
function validateRoadSegment(
  state: MatchState,
  tiles: Tile[],
  tileIndex: number,
  segment: number,
  excludeUnitId?: string,
): { key: number } | { error: string } {
  const tile = tiles[tileIndex];
  if (!tile) return { error: `Tile ${tileIndex} does not exist.` };
  if (!Number.isInteger(segment) || segment < 0 || segment >= tile.sides) {
    return { error: `Segment ${segment} is invalid for tile ${tileIndex}.` };
  }
  if (tile.forested && !state.logistics.clearedForests.includes(tileIndex)) {
    return { error: 'Clear the forest before building a road on this tile.' };
  }
  if (isImpassableTerrain(tile.terrainType) && !state.logistics.bridges.includes(tileIndex)) {
    return { error: 'Build the bridge before building a road on this tile.' };
  }

  const key = encodeSeg(tileIndex, segment);
  const occupied =
    state.units.some(
      (unit) => unit.id !== excludeUnitId && unit.tileIndex === tileIndex && unit.segment === segment,
    ) ||
    state.buildings.some((building) => building.tileIndex === tileIndex && building.segment === segment) ||
    state.logistics.wells.some((well) => well.tileIndex === tileIndex && well.segment === segment) ||
    state.logistics.refineries.some(
      (refinery) => refinery.tileIndex === tileIndex && refinery.segments.includes(segment),
    ) ||
    state.logistics.hubs.some((hub) => hub.tileIndex === tileIndex && hub.segment === segment) ||
    state.logistics.tasks.some(
      (task) =>
        (task.kind === 'well' || task.kind === 'road') &&
        task.tileIndex === tileIndex &&
        task.segment === segment,
    ) ||
    state.logistics.routes.some((route) => route.segments.includes(key)) ||
    (state.logistics.standaloneRoadSegments ?? []).includes(key);
  if (occupied) return { error: 'This segment is already occupied by a unit, structure, task, or road.' };

  return { key };
}

/**
 * Pave the road segment an Engineer_Unit is standing on. Starts a timed `road`
 * EngineerTask (same countdown model as bridge/forest work); the segment becomes
 * a traversable road overlay when the task completes in `resolveLogisticsTurn`.
 *
 * Position comes from the engineer itself (like `buildOilWell`), so the engineer
 * paves under its own feet and the acting unit is excluded from the segment's
 * occupancy check. Roads never block movement, so a unit standing on one is
 * legal. Walking a path and paving each segment in turn is how a player connects
 * two structures well enough for a shuttle transport to run between them.
 */
export function applyBuildRoadSegmentIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildRoadSegment' }>,
  policy: LogisticsIntentPolicy = ENFORCE_LOGISTICS_POLICY,
): LogisticsApplyResult {
  const resolved = resolveEngineer(state, intent.unitId, activeFaction);
  if ('error' in resolved) return { error: resolved.error };
  if (!hasEngineer(resolved.ref)) {
    return { error: 'Only an engineer unit (engineer attribute 1–5) can build a road.' };
  }

  const { tileIndex, segment } = resolved.ref;
  const validated = validateRoadSegment(state, tiles, tileIndex, segment, resolved.ref.id);
  if ('error' in validated) return { error: validated.error };

  const chargedHome = chargeConstructionCost(
    getHome(state, activeFaction),
    CONSTRUCTION_COST.routeRoadPerSegment,
    policy,
  );
  if (!chargedHome) return { error: 'Insufficient Refined_Product to build a road segment.' };

  // ── Commit (reject-and-preserve: nothing above mutated state) ──
  state.logistics.home[activeFaction] = chargedHome;
  const task: EngineerTask = {
    id: genId('task-road'),
    kind: 'road',
    unitId: resolved.ref.id,
    tileIndex,
    segment,
    turnsRemaining: engineerTaskDuration(resolved.ref.attributes.engineer ?? 1),
    ownerId: activeFaction,
  };
  state.logistics.tasks.push(task);
  return {};
}

/**
 * Add one development-only road overlay to an otherwise empty segment, instantly
 * and without an engineer. This deliberately is not a `LogisticsRoute`: it has no
 * endpoints, capacity, transport, or path invariants, and cannot alter the
 * logistics economy.
 *
 * This is a temporary development affordance for in-game testing. The real
 * mechanic is `applyBuildRoadSegmentIntent` above (engineer-driven, timed).
 */
export function applyGodModeBuildRoadIntent(
  state: MatchState,
  tiles: Tile[],
  _activeFaction: string,
  intent: Extract<Intent, { kind: 'godModeBuildRoad' }>,
  policy: LogisticsIntentPolicy = ENFORCE_LOGISTICS_POLICY,
): LogisticsApplyResult {
  if (!policy.allowRemoteTerrainTasks || !policy.waiveRefinedProductCosts) {
    return { error: 'Standalone road construction is available only in development God Mode.' };
  }

  const validated = validateRoadSegment(state, tiles, intent.tileIndex, intent.segment);
  if ('error' in validated) return { error: validated.error };

  (state.logistics.standaloneRoadSegments ??= []).push(validated.key);
  return {};
}
