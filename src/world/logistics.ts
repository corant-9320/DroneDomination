/**
 * Pure Resolution Engine — Oil Logistics System.
 *
 * This module holds the I/O-free rules for the logistics subsystem: engineer task
 * lifecycle, placement validation, extraction/refining, routes, transports, hubs,
 * combat, and per-turn orchestration. It contains **no** Three.js, no network, and
 * no mutation of its inputs — every function returns new values so the same
 * `(state, tiles)` always resolves the same way (matches the engine's determinism
 * guarantee). The server persists the returned state; the client renders it.
 *
 * Layering note: this file lives in `src/`, so it may import the authoritative
 * `Tile` from `./types.js` when needed, but the engine functions accept the shared
 * types (`shared/logisticsTypes.ts`) wherever practical so the same shapes flow
 * across the wire without translation.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 *
 * ── Task 2.1 scope (this section): Engineer task lifecycle ──
 *   - engineerTaskDuration  Req 2.6, 9.3, 10.1
 *   - tickTask              Req 2.7, 9.4, 10.2
 *   - task completion       Req 2.8, 10.3 (well / cleared forest / bridged tile)
 *   - task interruption     Req 9.5, 10.7 (cancel, discard progress)
 */

import {
  CONVERSION_RATIO,
  ENGINEER_TASK_BASE,
  EXTRACTION_RATE,
  HOME_CITY_REFINED_PRODUCT_MAX,
  HUB_STORAGE_CAPACITY,
  MAX_TRANSPORTS_PER_ROUTE,
  REFINERY_THROUGHPUT_RATE,
  ROUTE_CAPACITY_MAX,
  ROUTE_CAPACITY_MIN,
  ROUTE_CAPACITY_STEP,
  TRANSPORT_CARGO_MAX,
  TRANSPORT_TIER_THRESHOLDS,
  WELL_STORAGE_CAPACITY,
} from '../../shared/logisticsConstants.js';
import type { TransportTier } from '../../shared/logisticsConstants.js';
import { isImpassableTerrain, MAX_STEEP_WHEELED } from '../../shared/movementConstants.js';
import { applyDamage } from './combat.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';
import type {
  DistributionHub,
  EngineerTask,
  EngineerUnitRef,
  HomeStock,
  LogisticsContext,
  LogisticsEvent,
  LogisticsRoute,
  LogisticsState,
  LogisticsTile,
  LogisticsValidation,
  OilWell,
  Refinery,
  Transport,
} from '../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Engineer task durations (Req 2.6, 9.3, 10.1)
// ---------------------------------------------------------------------------

/**
 * The required duration, in turns, of an engineer construction task (well drilling,
 * forest clearing, or bridge building) driven by an Engineer_Unit of the given
 * `engineer` attribute value.
 *
 * Duration = ENGINEER_TASK_BASE - engineer, yielding the inclusive range 1 turn
 * (engineer 5) to 5 turns (engineer 1). The `engineer === 0` case (which produces
 * ENGINEER_TASK_BASE) never reaches here in practice: an engineer value of 0 is
 * rejected up front by the placement validators (Req 2.2, 9.6, 10.6), not by this
 * pure duration helper.
 *
 * @param engineer The constructing unit's `engineer` attribute value.
 * @returns The whole-turn task duration.
 */
export function engineerTaskDuration(engineer: number): number {
  return ENGINEER_TASK_BASE - engineer;
}

// ---------------------------------------------------------------------------
// Task countdown (Req 2.7, 9.4, 10.2)
// ---------------------------------------------------------------------------

/**
 * Advance an in-progress engineer task by one turn: decrement its remaining
 * duration by one, clamped to a minimum of zero. Pure — returns a new task and
 * never mutates the input (Req 2.7, 9.4, 10.2/10.3).
 *
 * @param task The in-progress task.
 * @returns A new task with `turnsRemaining` decremented and clamped to `>= 0`.
 */
export function tickTask(task: EngineerTask): EngineerTask {
  return { ...task, turnsRemaining: Math.max(0, task.turnsRemaining - 1) };
}

/**
 * Whether a task has finished its countdown and is ready to complete
 * (`turnsRemaining === 0`).
 */
export function isTaskComplete(task: EngineerTask): boolean {
  return task.turnsRemaining <= 0;
}

// ---------------------------------------------------------------------------
// Task completion transitions (Req 2.8, 9.4, 10.3)
// ---------------------------------------------------------------------------

/**
 * The concrete effect produced when an engineer task reaches `turnsRemaining === 0`:
 *   - `well`        → an operational Oil_Well occupying exactly one segment (Req 2.8)
 *   - `clearForest` → the tile index reclassified as a traversable non-forest
 *                     tile (added to `LogisticsState.clearedForests`) (Req 9.4)
 *   - `bridge`      → the tile index now crossable by a Road (added to
 *                     `LogisticsState.bridges`) (Req 10.3)
 *
 * These are descriptions of the transition; the orchestrator applies them to
 * `LogisticsState`. Keeping them as data (rather than mutating state here) preserves
 * the engine's purity.
 */
export type TaskCompletion =
  | { kind: 'well'; well: OilWell }
  | { kind: 'clearForest'; tileIndex: number }
  | { kind: 'bridge'; tileIndex: number };

/**
 * Caller-supplied initialisation for a completed Oil_Well. The `id` and hit points
 * are provided by the caller (the orchestrator) rather than pinned in the pure
 * engine, so no balance value lives here. The completed well starts empty
 * (`storedOil === 0`) and full-health.
 */
export interface WellCompletionInit {
  id: string;
  maxHitPoints: number;
}

/**
 * Produce the operational Oil_Well described by a finished `well` task (Req 2.8).
 * Pure: reads only the task and the caller-supplied init; the well occupies exactly
 * the one segment the task targeted and belongs to the task's owner.
 *
 * @param task A `well` task at `turnsRemaining === 0`.
 * @param init The new well's id and hit-point pool (supplied by the caller).
 * @returns A new, operational Oil_Well.
 */
export function completeWellTask(task: EngineerTask, init: WellCompletionInit): OilWell {
  return {
    id: init.id,
    ownerId: task.ownerId,
    tileIndex: task.tileIndex,
    segment: task.segment ?? 0,
    storedOil: 0,
    hitPoints: init.maxHitPoints,
    maxHitPoints: init.maxHitPoints,
  };
}

/**
 * The tile index reclassified as a traversable non-forest tile by a finished
 * `clearForest` task (Req 9.4). The orchestrator adds this to
 * `LogisticsState.clearedForests`.
 */
export function completeClearForestTask(task: EngineerTask): number {
  return task.tileIndex;
}

/**
 * The tile index made crossable by a completed Bridge from a finished `bridge`
 * task (Req 10.3). The orchestrator adds this to `LogisticsState.bridges`.
 */
export function completeBridgeTask(task: EngineerTask): number {
  return task.tileIndex;
}

/**
 * Dispatch a finished task to its completion transition (Req 2.8, 9.4, 10.3). The
 * caller must supply `wellInit` for a `well` task (the new well's id + hit points,
 * kept out of the pure engine so no balance value is pinned).
 *
 * @param task A task at `turnsRemaining === 0`.
 * @param wellInit Required only when `task.kind === 'well'`.
 * @returns The completion transition to apply to `LogisticsState`.
 */
export function completeTask(task: EngineerTask, wellInit?: WellCompletionInit): TaskCompletion {
  switch (task.kind) {
    case 'well': {
      if (!wellInit) {
        throw new Error('completeTask: a well task requires wellInit (id + maxHitPoints)');
      }
      return { kind: 'well', well: completeWellTask(task, wellInit) };
    }
    case 'clearForest':
      return { kind: 'clearForest', tileIndex: completeClearForestTask(task) };
    case 'bridge':
      return { kind: 'bridge', tileIndex: completeBridgeTask(task) };
  }
}

// ---------------------------------------------------------------------------
// Task interruption (Req 9.5, 10.7)
// ---------------------------------------------------------------------------

/**
 * Cancel an in-progress engineer task and discard all accumulated progress
 * (Req 9.5, 10.7). Pure: returns a new task list with the identified task removed
 * and applies **no** partial effect — no forest is cleared, no bridge is completed,
 * no well is created. If the task id is not present, the list is returned unchanged
 * (a new array).
 *
 * @param tasks The current in-progress tasks.
 * @param taskId The id of the task to interrupt.
 * @returns A new task array with the task removed; progress is dropped.
 */
export function interruptTask(tasks: readonly EngineerTask[], taskId: string): EngineerTask[] {
  return tasks.filter((t) => t.id !== taskId);
}

// ---------------------------------------------------------------------------
// Placement validators (Req 2.1–2.5, 4.1, 4.8–4.12, 12.2, 12.3)
//
// Every validator below is PURE and runs BEFORE any mutation: it inspects the
// read-only LogisticsContext (regenerated tiles + current LogisticsState) and a
// proposed placement, and returns a LogisticsValidation describing whether the
// action may proceed and, if not, the discriminated reason. Inputs are never
// mutated (reject-and-preserve), so a rejection leaves the world untouched.
//
// Occupancy limitation: the pure engine only sees logistics entities held on
// LogisticsState (wells, refinery segments, hubs). The main-game building layer
// (`shared/buildings.ts`) is NOT part of LogisticsState/LogisticsContext, so a
// segment occupied by an ordinary building cannot be detected here. Occupancy is
// therefore based on wells + refinery segments + hubs; the server applier
// (task 13.2) is responsible for any additional building-collision check it can
// see. (Recorded in docs/architecture/known-issues.md.)
// ---------------------------------------------------------------------------

/** Stable "tileIndex:segment" key for segment-occupancy lookups. */
function segKey(tileIndex: number, segment: number): string {
  return `${tileIndex}:${segment}`;
}

/**
 * The number of HexSegments on a tile. Prefers the `segSteep` array length (one
 * entry per segment); falls back to the neighbour count (a hex has 6 neighbours
 * and 6 segments, a pentagon 5 and 5). Both are populated on the authoritative
 * tile; the fallback keeps legacy/test tiles workable.
 */
function tileSegmentCount(tile: LogisticsTile): number {
  if (tile.segSteep && tile.segSteep.length > 0) return tile.segSteep.length;
  return tile.neighbours.length;
}

/**
 * The set of segment keys currently occupied by a logistics structure that
 * blocks new placement: every Oil_Well segment, every Refinery_Segment, and
 * every Distribution_Hub segment held on `state`. See the occupancy limitation
 * note above regarding main-game buildings.
 */
function occupiedSegments(state: LogisticsState): Set<string> {
  const occupied = new Set<string>();
  for (const well of state.wells) occupied.add(segKey(well.tileIndex, well.segment));
  for (const refinery of state.refineries) {
    for (const seg of refinery.segments) occupied.add(segKey(refinery.tileIndex, seg));
  }
  for (const hub of state.hubs) occupied.add(segKey(hub.tileIndex, hub.segment));
  return occupied;
}

/** Per-segment steepness (radians) for a tile segment; 0 (flat) when absent. */
function segmentSteepnessAt(tile: LogisticsTile, segment: number): number {
  return tile.segSteep?.[segment] ?? 0;
}

/**
 * Whether a tile lies inside a city. `placeCities`/`foundCity` stamp `cityId` on
 * the capital and on every city-owned hex, so a truthy `cityId` marks any tile
 * within a city footprint. Oil_Wells and Refineries are barred from city tiles
 * (they belong on the open map); Distribution_Hubs are not — they may sit inside
 * or outside a city (at least one must be in the city to fuel Home_City upgrades).
 */
function isCityTile(tile: LogisticsTile): boolean {
  return typeof tile.cityId === 'string' && tile.cityId.length > 0;
}

/**
 * Validate drilling an Oil_Well on `segment` of `tileIndex` by `unit`
 * (Req 2.1–2.5, 12.2, 12.3). Pure: reads only `ctx` and the proposed placement.
 *
 * The placement location is passed explicitly (rather than read off the unit) so
 * the server applier and property tests can drive it directly; at runtime the
 * applier passes the engineer's own `tileIndex`/`segment` (Req 2.1 — a well is
 * drilled on the Unit's current HexSegment).
 *
 * Rejection order / reasons:
 *   - `lacks-engineer`        engineer attribute not an integer in 1..5 (Req 2.2)
 *   - `ineligible-tile`       tile missing or segment index out of range
 *   - `owned-by-other-player` tile owned by a faction other than the unit's (Req 12.3)
 *   - `in-city`               tile lies inside a city (`cityId` set) — wells are map-only
 *   - `too-steep`             segment steepness exceeds MAX_STEEP_WHEELED (Req 2.3)
 *   - `no-deposit`            tile is not an Oil_Deposit (`resourceType !== 'oil'`) (Req 2.4)
 *   - `segment-occupied`      segment already holds a well/refinery-segment/hub (Req 2.5)
 *
 * @returns `{ legal: true }` when the well may be drilled, else a keyed rejection.
 */
export function validateWellPlacement(
  ctx: LogisticsContext,
  tileIndex: number,
  segment: number,
  unit: EngineerUnitRef,
): LogisticsValidation {
  // Req 2.1/2.2 — only an Engineer_Unit (engineer 1..5) may drill.
  const engineer = unit.attributes.engineer ?? 0;
  if (!Number.isInteger(engineer) || engineer < 1 || engineer > 5) {
    return {
      legal: false,
      reason: 'lacks-engineer',
      message: 'Only an engineer unit (engineer attribute 1–5) can drill an oil well.',
    };
  }

  const tile = ctx.tiles[tileIndex];
  if (!tile) {
    return {
      legal: false,
      reason: 'ineligible-tile',
      message: `Tile ${tileIndex} does not exist.`,
      offendingTiles: [tileIndex],
    };
  }

  const sides = tileSegmentCount(tile);
  if (!Number.isInteger(segment) || segment < 0 || segment >= sides) {
    return {
      legal: false,
      reason: 'ineligible-tile',
      message: `Segment ${segment} is out of range for tile ${tileIndex}.`,
      offendingTiles: [tileIndex],
    };
  }

  // Req 12.2/12.3 — build only on owned-by-self or unowned land; reject other-owned.
  if (tile.ownerId !== undefined && tile.ownerId !== unit.ownerId) {
    return {
      legal: false,
      reason: 'owned-by-other-player',
      message: 'That tile is owned by another player.',
      offendingTiles: [tileIndex],
    };
  }

  // Oil_Wells may not be drilled inside a city (city tiles carry a `cityId`).
  if (isCityTile(tile)) {
    return {
      legal: false,
      reason: 'in-city',
      message: 'An oil well cannot be built inside a city.',
      offendingTiles: [tileIndex],
    };
  }

  // Req 2.3 — steepness gate (identical threshold as the wheeled movement gate).
  if (segmentSteepnessAt(tile, segment) > MAX_STEEP_WHEELED) {
    return {
      legal: false,
      reason: 'too-steep',
      message: 'The terrain is too steep to drill an oil well here.',
      offendingTiles: [tileIndex],
    };
  }

  // Req 2.4 — a well may only be drilled on an Oil_Deposit.
  if (tile.resourceType !== 'oil') {
    return {
      legal: false,
      reason: 'no-deposit',
      message: 'There is no oil deposit on this segment.',
      offendingTiles: [tileIndex],
    };
  }

  // Req 2.5 — the segment must be free of any blocking logistics structure.
  if (occupiedSegments(ctx.state).has(segKey(tileIndex, segment))) {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'That segment is already occupied.',
      offendingTiles: [tileIndex],
    };
  }

  return { legal: true };
}

/**
 * Validate building a new Refinery covering the whole HexTile `tileIndex` for
 * `faction` (Req 4.1, 4.10, 4.11, 4.12, 12.3). Pure: reads only `ctx`.
 *
 * A tile is eligible only when it is land the requesting player may build on, has
 * no Refinery yet, every segment is at or below MAX_STEEP_WHEELED, and no segment
 * is occupied by a well/refinery-segment/hub. Ownership follows the general
 * construction rule (Req 12.2): owned-by-self or unowned land is allowed and only
 * a tile owned by another player is rejected.
 *
 * Rejection reasons:
 *   - `ineligible-tile`       missing tile, water, uncleared forest, or a
 *                             refinery already present (Req 4.10, 4.12)
 *   - `in-city`               tile lies inside a city (`cityId` set) — refineries are map-only
 *   - `owned-by-other-player` tile owned by another faction (Req 12.3)
 *   - `too-steep`             a segment exceeds MAX_STEEP_WHEELED (Req 4.11)
 *   - `segment-occupied`      a segment already holds a blocking structure (Req 4.11)
 */
export function validateRefineryPlacement(
  ctx: LogisticsContext,
  tileIndex: number,
  faction: string,
): LogisticsValidation {
  const tile = ctx.tiles[tileIndex];
  if (!tile) {
    return {
      legal: false,
      reason: 'ineligible-tile',
      message: `Tile ${tileIndex} does not exist.`,
      offendingTiles: [tileIndex],
    };
  }

  // Req 12.3 — reject a tile owned by another player.
  if (tile.ownerId !== undefined && tile.ownerId !== faction) {
    return {
      legal: false,
      reason: 'owned-by-other-player',
      message: 'That tile is owned by another player.',
      offendingTiles: [tileIndex],
    };
  }

  // Refineries may not be built inside a city (city tiles carry a `cityId`).
  if (isCityTile(tile)) {
    return {
      legal: false,
      reason: 'in-city',
      message: 'A refinery cannot be built inside a city.',
      offendingTiles: [tileIndex],
    };
  }

  // Req 4.12 — refineries cannot sit on water.
  if (tile.terrainType === 'ocean') {
    return {
      legal: false,
      reason: 'ineligible-tile',
      message: 'A refinery cannot be built on water.',
      offendingTiles: [tileIndex],
    };
  }

  // Req 4.12 — nor on a forest whose trees have not been cleared (a cleared
  // forest is recorded as an overlay in LogisticsState.clearedForests).
  if (tile.forested && !ctx.state.clearedForests.includes(tileIndex)) {
    return {
      legal: false,
      reason: 'ineligible-tile',
      message: 'Clear the forest before building a refinery here.',
      offendingTiles: [tileIndex],
    };
  }

  // Req 4.10 — a tile may host at most one refinery.
  if (ctx.state.refineries.some((r) => r.tileIndex === tileIndex)) {
    return {
      legal: false,
      reason: 'ineligible-tile',
      message: 'This tile already contains a refinery.',
      offendingTiles: [tileIndex],
    };
  }

  const sides = tileSegmentCount(tile);

  // Req 4.11 — every segment of the tile must be at or below the steepness gate.
  for (let s = 0; s < sides; s++) {
    if (segmentSteepnessAt(tile, s) > MAX_STEEP_WHEELED) {
      return {
        legal: false,
        reason: 'too-steep',
        message: 'The terrain is too steep to host a refinery.',
        offendingTiles: [tileIndex],
      };
    }
  }

  // Req 4.11 — no segment of the tile may already be occupied.
  const occupied = occupiedSegments(ctx.state);
  for (let s = 0; s < sides; s++) {
    if (occupied.has(segKey(tileIndex, s))) {
      return {
        legal: false,
        reason: 'segment-occupied',
        message: 'A segment of this tile is already occupied.',
        offendingTiles: [tileIndex],
      };
    }
  }

  return { legal: true };
}

/**
 * Validate adding one Refinery_Segment to an existing `refinery` on `segment`
 * (Req 4.8, 4.9). Pure: reads only `ctx` and the refinery.
 *
 * The refinery's tile is looked up in `ctx` to learn its segment count (a hex has
 * 6, a pentagon 5); a missing tile falls back to 6. Rejection reasons:
 *   - `outside-refinery-tile` segment index is out of range for the tile (Req 4.8)
 *   - `refinery-at-capacity`  every segment of the tile is already a
 *                             Refinery_Segment (Req 4.9)
 *   - `segment-occupied`      the target segment is already occupied by this
 *                             refinery (a segment hosts at most one Refinery_Segment)
 */
export function validateRefinerySegment(
  ctx: LogisticsContext,
  refinery: Refinery,
  segment: number,
): LogisticsValidation {
  const tile = ctx.tiles[refinery.tileIndex];
  // A hex has 6 segments, a pentagon 5; fall back to 6 when the tile is absent.
  const sides = tile ? tileSegmentCount(tile) : 6;

  // Req 4.8 — the segment must lie within the refinery's own tile.
  if (!Number.isInteger(segment) || segment < 0 || segment >= sides) {
    return {
      legal: false,
      reason: 'outside-refinery-tile',
      message: 'That segment is outside the refinery tile.',
      offendingTiles: [refinery.tileIndex],
    };
  }

  // Req 4.9 — reject once every segment of the tile is a Refinery_Segment.
  if (refinery.segments.length >= sides) {
    return {
      legal: false,
      reason: 'refinery-at-capacity',
      message: 'The refinery already occupies every segment of its tile.',
      offendingTiles: [refinery.tileIndex],
    };
  }

  // A segment hosts at most one Refinery_Segment (Req 4.3).
  if (refinery.segments.includes(segment)) {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'That segment already has a refinery segment.',
      offendingTiles: [refinery.tileIndex],
    };
  }

  return { legal: true };
}

// ---------------------------------------------------------------------------
// Extraction & storage (Req 3)
//
// Both functions are PURE: they never mutate their input well and always return
// a new object. Stored Oil is an integer >= 0, bounded above by the well's fixed
// WELL_STORAGE_CAPACITY (Req 3.2, 3.6).
// ---------------------------------------------------------------------------

/**
 * Run one turn of extraction for an operational Oil_Well (Req 3.1, 3.2, 3.3).
 *
 * Increases the well's stored Oil by EXTRACTION_RATE, clamping the result to the
 * fixed WELL_STORAGE_CAPACITY so it never overflows: once storage reaches the cap
 * the well holds at the cap and accrues nothing further until Oil is removed
 * (Req 3.3). Pure — returns a new well and never mutates the input (Req 3.6).
 *
 * @param well The operational well extracting this turn.
 * @returns A new well with `storedOil` increased by EXTRACTION_RATE, clamped to
 *          WELL_STORAGE_CAPACITY.
 */
export function extract(well: OilWell): OilWell {
  const storedOil = Math.min(well.storedOil + EXTRACTION_RATE, WELL_STORAGE_CAPACITY);
  return { ...well, storedOil };
}

/**
 * Remove Oil from an Oil_Well for transport (Req 3.4, 3.5).
 *
 * For a valid request — `0 < qty <= well.storedOil` — returns a success result:
 * a new well whose `storedOil` is decreased by `qty`, together with the `removed`
 * amount (Req 3.4).
 *
 * For an invalid request — `qty <= 0`, or `qty > well.storedOil` — returns an
 * `Error` (rather than throwing) so callers can branch, leaving the well's stored
 * Oil unchanged (Req 3.5). Returning an `Error` object matches the design's
 * declared `{ well: OilWell; removed: number } | Error` return type; callers use
 * `result instanceof Error` to detect the rejection.
 *
 * Pure — never mutates the input well.
 *
 * @param well The well to draw from.
 * @param qty The requested quantity to remove.
 * @returns `{ well, removed }` on success, or an `Error` on an invalid/insufficient
 *          request (well left unchanged).
 */
export function removeOil(
  well: OilWell,
  qty: number,
): { well: OilWell; removed: number } | Error {
  if (!Number.isFinite(qty) || qty <= 0) {
    return new Error(`Cannot remove a non-positive quantity of oil (requested ${qty}).`);
  }
  if (qty > well.storedOil) {
    return new Error(
      `Insufficient stored oil: requested ${qty} but only ${well.storedOil} available.`,
    );
  }
  return { well: { ...well, storedOil: well.storedOil - qty }, removed: qty };
}

// ---------------------------------------------------------------------------
// Refining (Req 4.4–4.7)
//
// Both functions are PURE: `refine` never mutates its input refinery and always
// returns a new object. Raw heldOil and refinedProductAvailable are integers >= 0.
// ---------------------------------------------------------------------------

/**
 * The maximum raw Oil a Refinery can process in one turn (its throughput), scaling
 * linearly with the number of Refinery_Segments it occupies (Req 4.4).
 *
 * Throughput = segmentCount * REFINERY_THROUGHPUT_RATE, so a one-segment refinery
 * processes REFINERY_THROUGHPUT_RATE oil/turn and each added segment raises the cap
 * by the same amount.
 *
 * @param segmentCount The number of Refinery_Segments (`refinery.segments.length`).
 * @returns The per-turn oil-processing capacity.
 */
export function refineryThroughput(segmentCount: number): number {
  return segmentCount * REFINERY_THROUGHPUT_RATE;
}

/**
 * Run one turn of refining for a Refinery (Req 4.5, 4.6, 4.7).
 *
 * Consumes `min(throughput, heldOil)` raw Oil this turn — where `throughput =
 * refineryThroughput(refinery.segments.length)` — decrementing `heldOil` by the
 * consumed amount and adding `floor(consumed * CONVERSION_RATIO)` to
 * `refinedProductAvailable` (Req 4.5, 4.6). The `floor` keeps Refined_Product an
 * integer.
 *
 * When `heldOil === 0` the consumed amount is 0, so this is a no-op: `heldOil`
 * stays at 0 and zero product is produced (Req 4.7).
 *
 * Pure — returns a new Refinery and never mutates the input.
 *
 * @param refinery The refinery processing this turn.
 * @returns A new refinery with `heldOil` reduced and `refinedProductAvailable`
 *          increased by the floored conversion of the consumed oil.
 */
export function refine(refinery: Refinery): Refinery {
  const throughput = refineryThroughput(refinery.segments.length);
  const consumed = Math.min(throughput, refinery.heldOil);
  return {
    ...refinery,
    heldOil: refinery.heldOil - consumed,
    refinedProductAvailable:
      refinery.refinedProductAvailable + Math.floor(consumed * CONVERSION_RATIO),
  };
}

// ---------------------------------------------------------------------------
// Economy: construction charging & home accrual (Req 5, 6.9)
//
// All four helpers are PURE: they never mutate the input HomeStock and always
// return a new object. Refined_Product is the sole construction currency (Req 5.1)
// and is bounded to [0, HOME_CITY_REFINED_PRODUCT_MAX] (Req 5.5); delivered raw
// Oil accrues separately with no stated maximum (Req 6.9).
// ---------------------------------------------------------------------------

/**
 * Whether the Home_City holds enough Refined_Product to pay `cost` (Req 5.2, 5.3).
 *
 * Concrete Construction_Costs are integers >= 1 (Req 5.6); a cost of `0` is the
 * special no-charge case (clearing a Forest_Tile costs only turns, Req 5.9), which
 * is always affordable. Affordability is therefore `cost <= home.refinedProduct`,
 * which is trivially true for `cost === 0`.
 *
 * Pure — reads only the stock and the cost.
 *
 * @param home The paying faction's Home_City stock.
 * @param cost The item's Construction_Cost in Refined_Product units.
 * @returns `true` iff the cost can be paid from stored Refined_Product.
 */
export function canAfford(home: HomeStock, cost: number): boolean {
  return cost <= home.refinedProduct;
}

/**
 * Debit exactly `cost` Refined_Product from the Home_City to pay for a construction
 * or upgrade (Req 5.1, 5.2, 5.3). Only `refinedProduct` is charged — raw Oil is
 * never a construction currency (Req 5.1).
 *
 * Assumes the caller has already checked `canAfford`; as a defensive measure the
 * result is clamped to `>= 0` so an over-charge can never drive the stock negative
 * (Req 5.5 — stored Refined_Product is always an integer >= 0). Pure — returns a
 * new HomeStock and never mutates the input.
 *
 * @param home The paying faction's Home_City stock.
 * @param cost The Construction_Cost to debit.
 * @returns A new HomeStock with `refinedProduct` reduced by `cost`, clamped to `>= 0`.
 */
export function chargeConstruction(home: HomeStock, cost: number): HomeStock {
  return { ...home, refinedProduct: Math.max(0, home.refinedProduct - cost) };
}

/**
 * Accrue delivered Refined_Product at the Home_City (Req 5.4, 5.5, 5.7).
 *
 * Adds `qty` to stored Refined_Product, clamping the result to the
 * HOME_CITY_REFINED_PRODUCT_MAX ceiling and discarding any overflow — arriving
 * product that would raise the stock above the maximum is dropped, not retained
 * (Req 5.7). Pure — returns a new HomeStock and never mutates the input.
 *
 * @param home The receiving faction's Home_City stock.
 * @param qty The arriving quantity of Refined_Product (integer >= 0).
 * @returns A new HomeStock with `refinedProduct` increased by `qty`, clamped to
 *          HOME_CITY_REFINED_PRODUCT_MAX.
 */
export function accrueRefinedProduct(home: HomeStock, qty: number): HomeStock {
  const refinedProduct = Math.min(home.refinedProduct + qty, HOME_CITY_REFINED_PRODUCT_MAX);
  return { ...home, refinedProduct };
}

/**
 * Accrue delivered raw Oil at the Home_City (Req 6.9).
 *
 * Adds `qty` to stored Oil. Unlike Refined_Product there is no stated Home_City
 * maximum on raw Oil, so this is a simple non-negative add. Pure — returns a new
 * HomeStock and never mutates the input.
 *
 * @param home The receiving faction's Home_City stock.
 * @param qty The arriving quantity of raw Oil (integer >= 0).
 * @returns A new HomeStock with `oil` increased by `qty`.
 */
export function accrueOil(home: HomeStock, qty: number): HomeStock {
  return { ...home, oil: home.oil + qty };
}

// ---------------------------------------------------------------------------
// Route capacity & travel time (Req 7)
//
// A Logistics_Route follows a contiguous path of adjacent HexTiles (its
// Route_Segments). Its Route_Travel_Time is a pure function of the cumulative
// Segment_Steepness across those segments, so it is stable and monotone in
// steepness (Req 7.1, 7.2) and never mutates its inputs.
//
// Segment/face indexing (see `Tile.segSteep` in src/world/types.ts): a tile's
// `segSteep[i]` is the steepness (radians) of segment/side `i`, and its
// `neighbours[i]` is the tile reached across that same side. So the face a road
// crosses toward an adjacent tile `n` on tile `t` is `t.neighbours.indexOf(n)`,
// and that face's steepness is `t.segSteep[face]`.
// ---------------------------------------------------------------------------

/**
 * The Segment_Steepness of a single Route_Segment (one tile of a route).
 *
 * A road enters the tile across one triangular face and exits across another, so
 * the Route_Segment's steepness is defined as the **mean of the two crossed faces'
 * `segSteep` values** (entry face and exit face). For an endpoint tile, where the
 * road has only a single road face (it starts or ends on the tile), it is that one
 * face's `segSteep`. When neither face is known (e.g. a degenerate single-tile
 * route), the segment is treated as flat (steepness `0`).
 *
 * Face arguments are segment indices into `tile.segSteep` (i.e. the side the road
 * crosses). A missing/out-of-range face (`< 0`, `undefined`, or absent from
 * `segSteep`) is ignored, and an absent `segSteep` entry is read as `0` (flat) — the
 * same convention the placement gate uses. Pure: reads only its arguments.
 *
 * @param tile The Route_Segment tile.
 * @param entryFace Segment index of the face the road enters by, or `undefined`
 *   at the route's start endpoint.
 * @param exitFace Segment index of the face the road exits by, or `undefined` at
 *   the route's end endpoint.
 * @returns The Route_Segment's Segment_Steepness in radians (`>= 0`).
 */
export function routeSegmentSteepness(
  tile: LogisticsTile,
  entryFace?: number,
  exitFace?: number,
): number {
  const faces: number[] = [];
  for (const face of [entryFace, exitFace]) {
    if (face !== undefined && Number.isInteger(face) && face >= 0) {
      faces.push(segmentSteepnessAt(tile, face));
    }
  }
  if (faces.length === 0) return 0;
  return faces.reduce((acc, s) => acc + s, 0) / faces.length;
}

/**
 * Derive the per-Route_Segment Segment_Steepness profile for a route's tile path,
 * suitable for passing to {@link routeTravelTime}.
 *
 * `path` is the ordered list of Route_Segment tile indices (pairwise adjacent, as
 * stored on `LogisticsRoute.segments`). For each tile the road's entry face is the
 * side toward the previous tile in the path and its exit face is the side toward
 * the next tile; the two endpoint tiles have a single road face. Each tile's
 * steepness is computed by {@link routeSegmentSteepness}.
 *
 * Assumption (documented per the design): entry/exit faces are recovered from the
 * path via `tile.neighbours.indexOf(adjacentTileIndex)`. If a path tile is missing
 * from `tiles`, or an adjacent tile is not one of its neighbours (a non-contiguous
 * path), that face contributes nothing (treated as flat) rather than throwing —
 * route validation (task 5.3) is responsible for rejecting non-contiguous paths.
 * Pure: reads only its arguments; returns a new array.
 *
 * @param path Ordered Route_Segment tile indices.
 * @param tiles The authoritative tiles (indexable by tile index).
 * @returns One Segment_Steepness value (radians, `>= 0`) per Route_Segment.
 */
export function routeSteepnessProfile(
  path: readonly number[],
  tiles: readonly LogisticsTile[],
): number[] {
  return path.map((tileIndex, k) => {
    const tile = tiles[tileIndex];
    if (!tile) return 0;
    const prev = k > 0 ? path[k - 1] : undefined;
    const next = k < path.length - 1 ? path[k + 1] : undefined;
    const entryFace = prev !== undefined ? tile.neighbours.indexOf(prev) : undefined;
    const exitFace = next !== undefined ? tile.neighbours.indexOf(next) : undefined;
    // indexOf returns -1 when the adjacent tile is not a neighbour; routeSegmentSteepness
    // ignores negative faces, so a broken adjacency contributes 0 rather than throwing.
    return routeSegmentSteepness(
      tile,
      entryFace === -1 ? undefined : entryFace,
      exitFace === -1 ? undefined : exitFace,
    );
  });
}

/**
 * Compute a Logistics_Route's Route_Travel_Time from its per-Route_Segment
 * Segment_Steepness values (Req 7.1, 7.2, 7.3, 7.6).
 *
 * Exact specified formula (Req 7.6): the ceiling of the sum, over every
 * Route_Segment, of `(1 + steepness / MAX_STEEP_WHEELED)`, clamped to a minimum of
 * 1 turn. This yields a base of ~1 turn per flat segment and up to ~2 turns per
 * maximally-steep segment (steepness ≈ MAX_STEEP_WHEELED), is a whole number of
 * turns `>= 1` (Req 7.3), and is monotone non-decreasing in cumulative steepness
 * (Req 7.1, 7.2) — adding steepness never lowers the result. Pure: reads only its
 * argument.
 *
 * @param segmentSteepness One Segment_Steepness value (radians, `>= 0`) per
 *   Route_Segment (e.g. from {@link routeSteepnessProfile}).
 * @returns The Route_Travel_Time in whole turns (`>= 1`).
 */
export function routeTravelTime(segmentSteepness: number[]): number {
  const sum = segmentSteepness.reduce((acc, s) => acc + (1 + s / MAX_STEEP_WHEELED), 0);
  return Math.max(1, Math.ceil(sum));
}

// ---------------------------------------------------------------------------
// Route creation, path validation & capacity upgrade (Req 6, 9.2, 10.4, 10.5)
//
// A Logistics_Route is a physical Road laid along a contiguous path of adjacent,
// traversable HexTiles (its Route_Segments) between two distinct player-owned
// endpoints (each an Oil_Well, a Refinery, or the Home_City). All helpers here are
// PURE: they read only their arguments / the read-only LogisticsContext and never
// mutate inputs (reject-and-preserve), so a rejected build leaves the world
// untouched.
//
// Endpoint shape (design: `validateRoutePath(ctx, path, endpoints)`): rather than
// re-resolving structures inside the pure engine — the Home_City is a city flag,
// not a LogisticsState entity, so it cannot be looked up here — the caller passes a
// `RouteEndpoints` descriptor carrying each endpoint's structure id, kind, tile, and
// owning faction. The server applier (task 13.2) is responsible for resolving the
// real structures (well/refinery in state; Home_City via the `isPlayerHome` city
// flag) and populating this descriptor with the correct `kind`/`ownerId` before
// calling the validator — the same division of labour used by the occupancy note on
// the placement validators above. This validator then enforces the descriptor-level
// rules (distinct, valid kinds, single owner, endpoints seated at the path ends).
//
// Impassability classification (Req 10.4/10.5): a Road may not cross Impassable_
// Terrain (water or valley) unless a Bridge has been built there. Rivers/valleys are
// stored with `terrainType === 'ocean'` (see generate.ts — river tiles are reclassed
// to ocean so ground units are blocked and engineers can bridge them), so the
// existing movement gate `isImpassableTerrain(terrainType)` already recognises both
// water and valley. We reuse it verbatim so route laying mirrors ground movement.
// ---------------------------------------------------------------------------

/** The three structure kinds a Logistics_Route may connect (Req 6.1, 6.2). */
export type RouteEndpointKind = 'well' | 'refinery' | 'home-city';

/**
 * One endpoint of a proposed Logistics_Route (an Oil_Well, a Refinery, or the
 * Home_City). Supplied by the caller (see the module note above): the pure engine
 * trusts `kind`/`ownerId` and validates the descriptor rather than re-resolving the
 * structure, because the Home_City is not a LogisticsState entity.
 */
export interface RouteEndpoint {
  /** The endpoint structure's id (becomes `LogisticsRoute.fromStructureId`/`toStructureId`). */
  structureId: string;
  /** Whether the endpoint is a well, a refinery, or the Home_City. */
  kind: RouteEndpointKind;
  /** The tile the endpoint sits on; must coincide with the matching end of `path`. */
  tileIndex: number;
  /** Owning faction id (both endpoints must belong to the same player). */
  ownerId: string;
}

/** The ordered endpoint pair of a proposed route: `from` seats `path[0]`, `to` the last tile. */
export interface RouteEndpoints {
  from: RouteEndpoint;
  to: RouteEndpoint;
}

/** The endpoint kinds a route may connect (Req 6.1, 6.2). */
const VALID_ENDPOINT_KINDS: ReadonlySet<RouteEndpointKind> = new Set([
  'well',
  'refinery',
  'home-city',
]);

/** Whether `tile` is Impassable_Terrain (water or valley) for a Road — see module note. */
function isImpassableRouteTile(tile: LogisticsTile): boolean {
  return isImpassableTerrain(tile.terrainType);
}

/**
 * Validate a proposed Logistics_Route path between `endpoints`
 * (Req 6.1, 6.2, 6.3, 9.2, 10.4, 10.5). Pure: reads only `ctx`, `path`, and
 * `endpoints`; never mutates them, so a rejection leaves the world untouched.
 *
 * `path` is the ordered list of Route_Segment tile indices the Road would follow,
 * including both endpoint tiles. Checks, in order:
 *
 *   Endpoints (`invalid-endpoints`, Req 6.2, 10.4):
 *     - each endpoint's `kind` is a well / refinery / home-city;
 *     - the two endpoints are distinct structures (different `structureId`);
 *     - both endpoints belong to the same player (`from.ownerId === to.ownerId`) —
 *       a route connects two *player-owned* endpoints;
 *     - the endpoints are seated at the path ends (`{path[0], path[last]}` equals
 *       `{from.tileIndex, to.tileIndex}`), so the path actually joins them.
 *
 *   Path (`path-not-traversable`, Req 6.1, 6.3, 9.2, 10.5):
 *     - the path is non-empty and every tile index exists in `ctx.tiles`;
 *     - the path is contiguous: each tile is a neighbour of the previous one
 *       (`tiles[path[i]].neighbours` contains `path[i+1]`) (Req 6.1);
 *     - no tile is a Forest_Tile whose trees are uncleared — `forested` and its
 *       index is not in `ctx.state.clearedForests` (Req 6.3, 9.2);
 *     - no tile is unbridged Impassable_Terrain — impassable (water/valley) and its
 *       index is not in `ctx.state.bridges` (Req 6.3, 10.5). A bridged impassable
 *       tile and a cleared forest are both accepted (Req 10.4).
 *
 * @returns `{ legal: true }` when the route may be built, else a keyed rejection
 *   (`invalid-endpoints` or `path-not-traversable`) with the offending tile(s).
 */
export function validateRoutePath(
  ctx: LogisticsContext,
  path: readonly number[],
  endpoints: RouteEndpoints,
): LogisticsValidation {
  const { from, to } = endpoints;

  // Req 6.2 — both endpoints must be a well / refinery / home-city.
  if (!VALID_ENDPOINT_KINDS.has(from.kind) || !VALID_ENDPOINT_KINDS.has(to.kind)) {
    return {
      legal: false,
      reason: 'invalid-endpoints',
      message: 'A route must connect an oil well, a refinery, or the home city at each end.',
    };
  }

  // Req 6.2 — the two endpoints must be distinct structures.
  if (from.structureId === to.structureId) {
    return {
      legal: false,
      reason: 'invalid-endpoints',
      message: 'A route must connect two different structures.',
    };
  }

  // Req 6.1 — a route joins two endpoints owned by the same player.
  if (from.ownerId !== to.ownerId) {
    return {
      legal: false,
      reason: 'invalid-endpoints',
      message: 'Both route endpoints must belong to the same player.',
    };
  }

  // The path must actually run between the two endpoints (endpoints seated at ends).
  if (path.length === 0) {
    return {
      legal: false,
      reason: 'path-not-traversable',
      message: 'The route path is empty.',
    };
  }
  const first = path[0];
  const last = path[path.length - 1];
  const endsMatch =
    (first === from.tileIndex && last === to.tileIndex) ||
    (first === to.tileIndex && last === from.tileIndex);
  if (!endsMatch) {
    return {
      legal: false,
      reason: 'invalid-endpoints',
      message: 'The path does not start and end at the two endpoints.',
      offendingTiles: [first, last],
    };
  }

  // Req 6.1 — every tile must exist and the path must be contiguous (pairwise adjacent).
  for (let i = 0; i < path.length; i++) {
    const tile = ctx.tiles[path[i]];
    if (!tile) {
      return {
        legal: false,
        reason: 'path-not-traversable',
        message: `Route tile ${path[i]} does not exist.`,
        offendingTiles: [path[i]],
      };
    }
    if (i > 0 && !ctx.tiles[path[i - 1]].neighbours.includes(path[i])) {
      return {
        legal: false,
        reason: 'path-not-traversable',
        message: 'The route path is not a continuous line of adjacent tiles.',
        offendingTiles: [path[i - 1], path[i]],
      };
    }
  }

  // Req 6.3, 9.2, 10.5 — no uncleared forest and no unbridged impassable tile.
  for (const tileIndex of path) {
    const tile = ctx.tiles[tileIndex];

    // Req 6.3, 9.2 — a Road may not cross a Forest_Tile whose trees are uncleared.
    if (tile.forested && !ctx.state.clearedForests.includes(tileIndex)) {
      return {
        legal: false,
        reason: 'path-not-traversable',
        message: 'Clear the forest before laying a road across this tile.',
        offendingTiles: [tileIndex],
      };
    }

    // Req 6.3, 10.5 — a Road may only cross Impassable_Terrain that has a Bridge.
    if (isImpassableRouteTile(tile) && !ctx.state.bridges.includes(tileIndex)) {
      return {
        legal: false,
        reason: 'path-not-traversable',
        message: 'Build a bridge before laying a road across this water or valley tile.',
        offendingTiles: [tileIndex],
      };
    }
  }

  return { legal: true };
}

/**
 * Caller-supplied initialisation for a new Logistics_Route (Req 6.1, 6.4). The `id`,
 * owner, endpoint ids, and the Route_Segment `path` are provided by the caller; the
 * pure engine fills the derived fields (capacity, tier, travel time, operability).
 */
export interface RouteCreationInit {
  id: string;
  ownerId: string;
  fromStructureId: string;
  toStructureId: string;
  /** Ordered, pairwise-adjacent Route_Segment tile indices (validate first with {@link validateRoutePath}). */
  path: readonly number[];
}

/**
 * Create a new Logistics_Route as a Road along `init.path` (Req 6.1, 6.4, 7.6).
 *
 * The new Road starts at the base Route_Capacity (`ROUTE_CAPACITY_MIN`), is rendered
 * as a `'road'` (Req 6.7), is `operable`, and carries the ids/owner/endpoints the
 * caller supplied. Its Route_Travel_Time is computed from the path's steepness
 * profile via `routeTravelTime(routeSteepnessProfile(path, tiles))` (Req 7.6), so it
 * is a whole number of turns `>= 1`.
 *
 * The caller should have validated the path with {@link validateRoutePath} first;
 * `createRoute` itself does no validation and simply builds the entity. Pure: copies
 * `init.path` into a fresh `segments` array (no aliasing of the caller's array) and
 * mutates nothing.
 *
 * @param init The caller-supplied ids, owner, endpoints, and Route_Segment path.
 * @param tiles The authoritative tiles (indexable by tile index) for travel time.
 * @returns A new Road-tier `LogisticsRoute`.
 */
export function createRoute(
  init: RouteCreationInit,
  tiles: readonly LogisticsTile[],
): LogisticsRoute {
  const travelTime = routeTravelTime(routeSteepnessProfile(init.path, tiles));
  return {
    id: init.id,
    ownerId: init.ownerId,
    fromStructureId: init.fromStructureId,
    toStructureId: init.toStructureId,
    segments: [...init.path],
    capacity: ROUTE_CAPACITY_MIN,
    tier: 'road',
    travelTime,
    operable: true,
  };
}

/**
 * The next Route_Capacity after one upgrade step (Req 6.7, 6.8).
 *
 * Returns `min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP)` for a route below the
 * maximum. When `cap` is already at or above `ROUTE_CAPACITY_MAX`, returns an `Error`
 * (rather than throwing) so the caller can branch and leave the capacity unchanged
 * (Req 6.8 — reject at max). Returning an `Error` matches the design's declared
 * `number | Error` return type; callers use `result instanceof Error`. Pure.
 *
 * @param cap The route's current Route_Capacity.
 * @returns The upgraded capacity, or an `Error` when already at the maximum.
 */
export function upgradeRouteCapacity(cap: number): number | Error {
  if (cap >= ROUTE_CAPACITY_MAX) {
    return new Error(`Route is already at its maximum capacity (${ROUTE_CAPACITY_MAX}).`);
  }
  return Math.min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP);
}

/**
 * Upgrade a Logistics_Route one capacity step and render it as a Highway
 * (Req 6.7, 6.8).
 *
 * Applies {@link upgradeRouteCapacity} to the route's current capacity: on success
 * returns a new route with the bumped `capacity` and `tier: 'highway'`; when the
 * route is already at `ROUTE_CAPACITY_MAX` returns the `Error` from
 * `upgradeRouteCapacity` and the route is left unchanged (Req 6.8). Pure — returns a
 * new route and never mutates the input.
 *
 * @param route The route to upgrade.
 * @returns A new Highway-tier `LogisticsRoute` with increased capacity, or an
 *   `Error` when the route is already at the maximum capacity.
 */
export function upgradeRoute(route: LogisticsRoute): LogisticsRoute | Error {
  const next = upgradeRouteCapacity(route.capacity);
  if (next instanceof Error) return next;
  return { ...route, capacity: next, tier: 'highway' };
}

// ---------------------------------------------------------------------------
// Transport lifecycle (Req 6.6, 8.1–8.4, 8.7–8.13, 14.3, 14.5)
//
// A Transportation_Unit is an AI-driven vehicle assigned to one Logistics_Route
// that physically carries Oil or Refined_Product between the route's endpoints.
// Every helper here is PURE: it never mutates its inputs and always returns new
// values, so the same inputs always resolve the same way. Commodity quantities
// are non-negative integers; each helper clamps to `>= 0` defensively so a bad
// caller value can never drive a stored/carried amount negative.
//
// Division of labour (mirrors the placement/route notes above): these helpers
// implement the field-level rules (per-turn capacity limit, load/deliver clamps,
// upgrade, tier derivation, assignment cap, source retention). The orchestrator
// (`resolveLogisticsTurn`, task 9.1) and the server appliers (task 13.2) wire them
// into the turn loop — deciding *when* to load/dispatch/deliver and choosing the
// commodity type — while these functions decide *how much* moves and stays put.
// ---------------------------------------------------------------------------

/**
 * Limit the cargo moved along a Logistics_Route in a single turn to that route's
 * Route_Capacity (Req 6.6, 8.1).
 *
 * Returns `min(cargo, capacity)`, clamped to a minimum of `0`. Any excess above the
 * route capacity is *not* returned here — the caller retains it at the source
 * structure (see {@link retainAtSource}), so a route never carries more than its
 * capacity per turn. Pure: reads only its arguments.
 *
 * @param cargo The quantity the source would like to send this turn (`>= 0`).
 * @param capacity The route's current Route_Capacity.
 * @returns The permitted per-turn quantity: `max(0, min(cargo, capacity))`.
 */
export function clampTransport(cargo: number, capacity: number): number {
  return Math.max(0, Math.min(cargo, capacity));
}

/**
 * Load a Transportation_Unit from a source's available `supply` (Req 8.2, 8.3, 8.9).
 *
 * Accepts only what fits: the loaded amount is bounded by both the transport's
 * remaining free capacity (`cargoCapacity - cargo`) and the available `supply`, so
 * a load can never push `cargo` above `cargoCapacity` (Req 8.3 — reject/limit an
 * over-capacity load) and can never take more than the source holds. The returned
 * `loaded` is `max(0, min(remainingCapacity, supply))`.
 *
 * The optional `cargoType` lets the orchestrator record what commodity was loaded
 * (a raw `supply: number` alone cannot carry that). When a positive amount is
 * loaded and `cargoType` is supplied, the transport's `cargoType` is set to it;
 * otherwise the transport's existing `cargoType` is preserved. The design's
 * declared shape `loadTransport(t, supply)` is preserved — `cargoType` is an
 * optional third argument, so existing two-argument call sites are unaffected.
 *
 * Pure — returns a new transport and never mutates the input.
 *
 * @param t The transport being loaded.
 * @param supply The quantity available at the source this turn (`>= 0`).
 * @param cargoType Optional commodity to stamp on the transport when it takes on cargo.
 * @returns `{ t, loaded }` — the updated transport (cargo increased, cargoType set
 *   when supplied) and the amount actually loaded.
 */
export function loadTransport(
  t: Transport,
  supply: number,
  cargoType?: 'oil' | 'product',
): { t: Transport; loaded: number } {
  const remaining = Math.max(0, t.cargoCapacity - t.cargo);
  const loaded = Math.max(0, Math.min(remaining, supply));
  const nextCargoType = loaded > 0 && cargoType !== undefined ? cargoType : t.cargoType;
  return {
    t: { ...t, cargo: t.cargo + loaded, cargoType: nextCargoType },
    loaded,
  };
}

/**
 * A minimal storage destination for {@link deliver}: something that holds a bounded
 * `stored` quantity up to a `capacity`. Both the Home_City and a Distribution_Hub
 * (and a well/refinery acting as a delivery target) present this shape, so the
 * orchestrator (task 9.1) can deliver into any of them uniformly.
 */
export interface StorageLike {
  /** Currently stored quantity (`0 <= stored <= capacity`). */
  stored: number;
  /** The destination's Storage_Capacity. */
  capacity: number;
}

/**
 * Deliver `cargo` into a storage destination, clamping to its Storage_Capacity and
 * returning the undelivered remainder (Req 8.9, 8.10).
 *
 * Accepts `max(0, min(freeSpace, cargo))` where `freeSpace = capacity - stored`, so
 * the destination never overflows (Req 8.9). Any cargo that does not fit is returned
 * as `remainder` — the caller keeps it on the Transportation_Unit (Req 8.10) rather
 * than discarding it. Pure — returns a new `StorageLike` and never mutates the input.
 *
 * @param dest The destination store (`{ stored, capacity }`).
 * @param cargo The quantity the transport is trying to deliver (`>= 0`).
 * @returns `{ dest, remainder }` — the updated store (clamped to capacity) and the
 *   quantity that did not fit (retained on the transport).
 */
export function deliver(
  dest: StorageLike,
  cargo: number,
): { dest: StorageLike; remainder: number } {
  const wanted = Math.max(0, cargo);
  const freeSpace = Math.max(0, dest.capacity - dest.stored);
  const accepted = Math.min(freeSpace, wanted);
  const remainder = wanted - accepted;
  return { dest: { ...dest, stored: dest.stored + accepted }, remainder };
}

/**
 * Map a Transportation_Unit's cumulative upgrade count to its visual Transport_Tier
 * (Req 14.3, 14.5).
 *
 * Total and monotonic over `upgrades >= 0` using {@link TRANSPORT_TIER_THRESHOLDS}
 * as inclusive lower bounds: `>= 4` → `'juggernaut'`, `2..3` → `'truck'`, `0..1` →
 * `'van'`. Because the thresholds are checked from highest to lowest, every
 * non-negative upgrade count maps to exactly one tier, and increasing `upgrades`
 * never lowers the tier (monotonic). A negative/fractional count is treated by the
 * same inclusive comparisons (e.g. a negative value falls through to `'van'`). Pure.
 *
 * @param upgrades The transport's cumulative upgrade count (`>= 0`).
 * @returns The derived `TransportTier` (`'van' | 'truck' | 'juggernaut'`).
 */
export function transportTier(upgrades: number): TransportTier {
  if (upgrades >= TRANSPORT_TIER_THRESHOLDS.juggernaut) return 'juggernaut';
  if (upgrades >= TRANSPORT_TIER_THRESHOLDS.truck) return 'truck';
  return 'van';
}

/**
 * Positive per-upgrade increments for each upgradeable Transportation_Unit stat
 * (Req 8.4). These live in code (not pinned in tests): one upgrade strictly raises
 * the chosen stat by its increment. Cargo grows in larger commodity-unit steps;
 * speed and defence grow one point at a time. `cargo` is capped at
 * `TRANSPORT_CARGO_MAX` to respect the Req 8.3 capacity bound.
 */
export const TRANSPORT_UPGRADE_INCREMENT: {
  readonly cargo: number;
  readonly speed: number;
  readonly defence: number;
} = {
  cargo: 100,
  speed: 1,
  defence: 1,
};

/**
 * Apply one upgrade to a Transportation_Unit, strictly improving exactly one stat
 * (Req 8.4, 14.5).
 *
 * Increases the chosen `stat` — `cargo` → `cargoCapacity`, `speed`, or `defence` —
 * by its positive {@link TRANSPORT_UPGRADE_INCREMENT}, increments the cumulative
 * `upgrades` count, and recomputes `tier = transportTier(upgrades)` so the rendered
 * model swaps when the tier changes (Req 14.5). The other two stats and — crucially
 * — the assigned Logistics_Route's Route_Capacity are left untouched (Req 8.4): this
 * function only ever returns a new Transport and never touches any route. `cargo`
 * upgrades clamp to `TRANSPORT_CARGO_MAX` to keep `cargoCapacity` within its bound
 * (Req 8.3); below the cap the improvement is strictly positive.
 *
 * Pure — returns a new Transport and never mutates the input.
 *
 * @param t The transport to upgrade.
 * @param stat Which single stat to improve (`'cargo' | 'speed' | 'defence'`).
 * @returns A new Transport with one stat raised, `upgrades` incremented, and `tier`
 *   recomputed; route capacity unchanged.
 */
export function upgradeTransport(t: Transport, stat: 'cargo' | 'speed' | 'defence'): Transport {
  const upgrades = t.upgrades + 1;
  const next: Transport = { ...t, upgrades, tier: transportTier(upgrades) };
  switch (stat) {
    case 'cargo':
      next.cargoCapacity = Math.min(
        TRANSPORT_CARGO_MAX,
        t.cargoCapacity + TRANSPORT_UPGRADE_INCREMENT.cargo,
      );
      break;
    case 'speed':
      next.speed = t.speed + TRANSPORT_UPGRADE_INCREMENT.speed;
      break;
    case 'defence':
      next.defence = t.defence + TRANSPORT_UPGRADE_INCREMENT.defence;
      break;
  }
  return next;
}

/**
 * Whether another Transportation_Unit may be assigned to `route` without exceeding
 * the per-route cap (Req 8.11, 8.12, 8.13).
 *
 * Counts the transports in `transports` already assigned to the route
 * (`routeId === route.id`) and returns `true` iff that count is below
 * `MAX_TRANSPORTS_PER_ROUTE`. The caller rejects the assignment/purchase with the
 * `route-transport-full` reason when this returns `false` (Req 8.12). Pure: reads
 * only its arguments.
 *
 * @param route The target Logistics_Route.
 * @param transports All transports currently in play (any owner/route).
 * @returns `true` when the route has fewer than `MAX_TRANSPORTS_PER_ROUTE` assigned.
 */
export function canAssignTransport(
  route: LogisticsRoute,
  transports: readonly Transport[],
): boolean {
  let assigned = 0;
  for (const t of transports) {
    if (t.routeId === route.id) assigned++;
  }
  return assigned < MAX_TRANSPORTS_PER_ROUTE;
}

/**
 * Retain undelivered cargo at a source structure within its Storage_Capacity
 * (Req 8.7, 8.8).
 *
 * When a Logistics_Route has no operational Transportation_Unit to carry cargo (or
 * the route capacity clamps a load), the undelivered quantity stays at the source.
 * Returns `min(capacity, stored + undelivered)`, clamped to `>= 0`: the source holds
 * up to its Storage_Capacity and any excess beyond the capacity is discarded, not
 * accrued (Req 8.8). Pure: reads only its arguments.
 *
 * @param stored The source's currently stored quantity.
 * @param capacity The source's Storage_Capacity.
 * @param undelivered The quantity that could not be shipped this turn (`>= 0`).
 * @returns The new stored quantity: `max(0, min(capacity, stored + undelivered))`.
 */
export function retainAtSource(stored: number, capacity: number, undelivered: number): number {
  return Math.max(0, Math.min(capacity, stored + undelivered));
}

// ---------------------------------------------------------------------------
// Distribution hubs (Req 11.1, 11.3, 11.4, 11.5, 11.6, 11.7)
//
// A Distribution_Hub buffers Oil/Refined_Product and balances flow across the
// two-or-more outgoing Logistics_Routes it connects. Every helper here is PURE:
// it never mutates its inputs and always returns new values, so the same inputs
// always resolve the same way.
//
// Division of labour (mirrors the transport/route notes above): `distributeHub`
// decides *how much* moves onto each outgoing route, *how much* is buffered, and
// *how much* is left upstream this turn; the orchestrator (`resolveLogisticsTurn`,
// task 9.1) decides *which* commodity flows, sources the per-turn `inflow`, and
// applies the returned buffer/amounts back to state. All quantities are treated as
// combined Oil + Refined_Product units (a hub's buffer is a single combined pool,
// Req 11.3), and every helper clamps to `>= 0` defensively so a bad caller value
// can never drive a stored/distributed amount negative.
// ---------------------------------------------------------------------------

/**
 * Caller-supplied initialisation for a newly-placed Distribution_Hub (Req 11.1).
 * The `id`, owner, location (`tileIndex`/`segment`), connected `routeIds`, and
 * hit-point pool are provided by the caller (the orchestrator/applier), kept out
 * of the pure engine so no balance value (max hit points) is pinned here. A newly
 * placed hub always starts with an empty buffer (`buffer === 0`, Req 11.1) and at
 * full health.
 */
export interface HubCreationInit {
  id: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  /** The connected outgoing Logistics_Route ids (Req 11.5). */
  routeIds: string[];
  maxHitPoints: number;
}

/**
 * Create a newly-placed Distribution_Hub with an initial buffered quantity of zero
 * (Req 11.1). Pure: reads only `init`, copies `routeIds` into a fresh array (no
 * aliasing of the caller's array), and mutates nothing.
 *
 * The caller is responsible for validating the placement first (task 8.x —
 * `invalid-placement`, Req 11.2); `createHub` itself does no validation and simply
 * builds the entity. The new hub starts empty (`buffer === 0`, Req 11.1) and at
 * full health (`hitPoints === maxHitPoints`).
 *
 * @param init The caller-supplied id, owner, location, connected routes, and
 *   hit-point pool.
 * @returns A new `DistributionHub` with `buffer === 0` and full hit points.
 */
export function createHub(init: HubCreationInit): DistributionHub {
  return {
    id: init.id,
    ownerId: init.ownerId,
    tileIndex: init.tileIndex,
    segment: init.segment,
    buffer: 0,
    routeIds: [...init.routeIds],
    hitPoints: init.maxHitPoints,
    maxHitPoints: init.maxHitPoints,
  };
}

/**
 * The outcome of resolving one turn of flow through a Distribution_Hub
 * (see {@link distributeHub}). Every quantity is a combined Oil + Refined_Product
 * amount (`>= 0`).
 */
export interface HubDistribution {
  /**
   * Per-outgoing-route quantity dispatched this turn, aligned index-for-index to
   * the `outgoingCaps` passed to {@link distributeHub}. Each entry is `<= its cap`
   * (Req 11.5) and the entries sum to {@link HubDistribution.distributedTotal}.
   */
  amounts: number[];
  /**
   * The total quantity dispatched across all outgoing routes this turn, equal to
   * `min(available, Σ outgoingCaps)` where `available = buffer + inflow`
   * (Req 11.4).
   */
  distributedTotal: number;
  /**
   * The hub's buffered quantity carried into the next turn, `0 <= newBuffer <=
   * HUB_STORAGE_CAPACITY` (Req 11.3, 11.6): the available quantity that exceeded
   * the combined outgoing capacity, held up to the Storage_Capacity.
   */
  newBuffer: number;
  /**
   * The quantity that could be neither distributed nor buffered (buffer full) and
   * is therefore left at the upstream source rather than discarded (Req 11.7).
   */
  leftUpstream: number;
}

/**
 * Resolve one turn of flow through a Distribution_Hub
 * (Req 11.3, 11.4, 11.5, 11.6, 11.7).
 *
 * The available quantity this turn is the hub's carried-over `buffer` plus the
 * `inflow` arriving from upstream (Req 11.4). It is disposed of by the following
 * policy, in order:
 *
 *   1. **Distribute across outgoing routes.** The total distributed is
 *      `min(available, Σ outgoingCaps)` (Req 11.4). That total is filled onto the
 *      outgoing routes **in order**, each route taking up to (but never more than)
 *      its own capacity (Req 11.5), until the distributed total is exhausted. The
 *      returned `amounts` are aligned index-for-index to `outgoingCaps`, each
 *      `<= its cap`, and sum to `distributedTotal`.
 *   2. **Buffer the remainder.** Whatever of `available` was not distributed
 *      (because combined capacity was the binding constraint) is held in the hub's
 *      buffer up to `HUB_STORAGE_CAPACITY`, so `newBuffer <= HUB_STORAGE_CAPACITY`
 *      (Req 11.3, 11.6).
 *   3. **Leave the rest upstream.** Anything that fits neither a route nor the
 *      buffer (the buffer is full) is left at the upstream source and is *not*
 *      discarded (Req 11.7).
 *
 * Conservation is exact — every unit of `buffer + inflow` is accounted for as
 * exactly one of distributed, buffered, or left upstream:
 *   `distributedTotal + newBuffer + leftUpstream === buffer + inflow` (Req 11.7).
 *
 * Defensive clamping: `inflow`, the carried `buffer`, and each entry of
 * `outgoingCaps` are floored at `0`, so a negative caller value cannot corrupt the
 * accounting (a negative cap contributes `0` capacity and receives `0`). Pure:
 * reads only its arguments and returns a fresh `amounts` array; mutates nothing.
 *
 * @param hub The hub being resolved (its `buffer` is the carried-over quantity).
 * @param inflow The quantity arriving from upstream this turn (`>= 0`).
 * @param outgoingCaps The current Route_Capacity of each connected outgoing route,
 *   in the order the caller wants them filled.
 * @returns A {@link HubDistribution}: per-route `amounts`, `distributedTotal`,
 *   `newBuffer`, and `leftUpstream`, satisfying the Req 11 constraints above.
 */
export function distributeHub(
  hub: DistributionHub,
  inflow: number,
  outgoingCaps: number[],
): HubDistribution {
  const caps = outgoingCaps.map((c) => Math.max(0, c));
  const available = Math.max(0, hub.buffer) + Math.max(0, inflow);
  const totalCapacity = caps.reduce((acc, c) => acc + c, 0);

  // Req 11.4 — distribute min(available, Σ caps) across the outgoing routes.
  const distributedTotal = Math.min(available, totalCapacity);

  // Fill routes in order, each up to its own capacity (Req 11.5).
  let remainingToDistribute = distributedTotal;
  const amounts = caps.map((cap) => {
    const amount = Math.min(cap, remainingToDistribute);
    remainingToDistribute -= amount;
    return amount;
  });

  // Req 11.6 — buffer whatever was not distributed, up to HUB_STORAGE_CAPACITY.
  const undistributed = available - distributedTotal;
  const newBuffer = Math.min(undistributed, HUB_STORAGE_CAPACITY);

  // Req 11.7 — leave anything that fits neither a route nor the buffer upstream.
  const leftUpstream = undistributed - newBuffer;

  return { amounts, distributedTotal, newBuffer, leftUpstream };
}

// ---------------------------------------------------------------------------
// Combat Integration — structures & transports gain hit points (Req 12.4–12.8)
//
// Logistics structures (Oil_Well, Refinery, Distribution_Hub, Road, Bridge) carry
// a Hit_Points pool and ARE destroyed at zero HP (Req 12.4, 12.6) — unlike main-game
// buildings, which take component damage and are never destroyed. The Req 12 glossary
// defines Hit_Points as "the integer amount of combat damage a destroyable structure
// can absorb before it is destroyed, tracked and reduced by the existing unit combat
// model", so a structure's HP shares the unit combat model's HP domain and is reduced
// with the very same `applyDamage` primitive that reduces a unit's health.
//
// Combat pipeline reuse (design §4): the attacker→structure damage magnitude is
// produced by the SAME `computeDamage` pipeline used for units — armour and
// EW/terrain read from the structure's `attributes` and its tile — before it reaches
// this module. That computation needs a full `CombatContext` (units/tiles/buildings)
// which is not available to a bare, pure structure attack, so the server combat
// resolver (the caller) runs `computeDamage(...)` with the structure's `attributes`
// and passes the resulting `damage` number here. `attackStructure` then applies that
// damage to the HP pool via the combat model's own `applyDamage`, so the numbers stay
// consistent with the unit combat rules and are never re-derived with pinned balance
// values (there are no balance numbers in this module).
//
// `applyDamage` (src/world/combat.ts → combatFormula.ts) enforces exactly the two
// combat-model HP invariants a structure needs: a minimum of 1 applied damage (a weak
// hit is never wasted) and HP never dropping below 0. It also clamps into the unit
// combat HP domain of [0, 50]; per the glossary a structure's Hit_Points live in that
// same domain, so a structure's `maxHitPoints` must be a positive integer within
// [1, 50] (see the enduring gotcha recorded in docs/architecture/known-issues.md).
//
// Every function here is PURE: it never mutates its inputs and always returns new
// values, matching the rest of this engine. Destruction *consequences* (Req 12.7,
// 12.8) are returned as data / applied by companion pure helpers, so the orchestrator
// (task 9.1) applies them to `LogisticsState` without this module touching global
// state.
// ---------------------------------------------------------------------------

/**
 * A destroyable logistics structure with a Hit_Points pool (design §4, verbatim):
 * an Oil_Well, a Refinery, a Distribution_Hub, a Road, or a Bridge (Req 12.4).
 *
 * `attributes` carries the optional armour/defence the damage formula reads; it is
 * consumed by the caller's `computeDamage` pass (which needs the full combat context)
 * rather than by `attackStructure`, which applies the already-computed damage to the
 * HP pool. `segment` identifies the occupied segment for wells/refinery-segments and
 * is absent for a whole-tile Road/Bridge.
 */
export interface HpStructure {           // Oil_Well, Refinery, Distribution_Hub, Road, Bridge
  id: string;
  kind: 'well' | 'refinery' | 'hub' | 'road' | 'bridge';
  ownerId: string;                        // Structure_Owner (Req 12.1)
  tileIndex: number;
  segment?: number;                       // wells/refinery-segments; absent for whole-tile road/bridge
  hitPoints: number;                      // current HP, integer > 0 while alive (Req 12.4)
  maxHitPoints: number;
  attributes?: UnitAttributes;            // optional armour/defence for the damage formula
}

/**
 * Apply combat damage to a structure using the existing unit combat model
 * (Req 12.5, 12.6).
 *
 * Reduces the structure's Hit_Points by the incoming `damage` using the combat
 * model's own `applyDamage` (re-exported from `src/world/combat.ts`, defined in
 * `combatFormula.ts`) — the SAME primitive that reduces a unit's health. This keeps
 * structure damage consistent with unit combat (minimum 1 applied damage, HP clamped
 * to `>= 0`) and re-derives no balance numbers: the `damage` argument is the output of
 * the caller's `computeDamage` pass (armour/EW/terrain from the structure's
 * `attributes` and tile — see the module note above). The structure is destroyed when
 * its Hit_Points reach zero (Req 12.6); the orchestrator then removes it from play and
 * applies the destruction consequence for its `kind` (Req 12.7/12.8 — see
 * {@link dropWellResources}/{@link dropRefineryResources}/{@link dropHubResources} and
 * {@link markRoutesInoperable}).
 *
 * Pure — returns a new structure and never mutates the input.
 *
 * @param struct The structure being attacked.
 * @param damage The already-computed incoming damage (from the unit combat pipeline).
 * @returns `{ struct, destroyed }` — a new structure with reduced Hit_Points and the
 *   destroyed flag (`true` iff Hit_Points reached zero).
 */
export function attackStructure(
  struct: HpStructure,
  damage: number,
): { struct: HpStructure; destroyed: boolean } {
  const hitPoints = applyDamage(struct.hitPoints, damage);
  return { struct: { ...struct, hitPoints }, destroyed: hitPoints <= 0 };
}

/**
 * The Oil and Refined_Product a destroyed structure removes from play (Req 12.7).
 * Every field is a non-negative integer; unused fields are `0` for a given structure
 * kind (e.g. a well drops only raw `oil`). The orchestrator uses these amounts for
 * `structure-destroyed` events; the commodities are discarded, delivered nowhere.
 */
export interface DestroyedResourceDrop {
  /** Raw Oil removed from play (an Oil_Well's stored oil, a Refinery's held oil). */
  oil: number;
  /** Refined_Product removed from play (a Refinery's available product). */
  product: number;
  /** Combined Oil + Refined_Product removed from play (a Distribution_Hub's buffer, a single pool). */
  combined: number;
}

/**
 * Remove a destroyed Oil_Well's stored Oil from play (Req 12.7).
 *
 * Returns a new well with `storedOil === 0` and the dropped `oil` amount (the well's
 * former stored oil), so none of it is delivered anywhere. Pure — never mutates the
 * input well. The orchestrator calls this when {@link attackStructure} reports a
 * destroyed `well` before removing the well from state.
 */
export function dropWellResources(well: OilWell): { well: OilWell; dropped: DestroyedResourceDrop } {
  return {
    well: { ...well, storedOil: 0 },
    dropped: { oil: well.storedOil, product: 0, combined: well.storedOil },
  };
}

/**
 * Remove a destroyed Refinery's held raw Oil and available Refined_Product from play
 * (Req 12.7).
 *
 * Returns a new refinery with both `heldOil` and `refinedProductAvailable` zeroed and
 * the dropped amounts (`oil` = former held oil, `product` = former available product).
 * Pure — never mutates the input refinery.
 */
export function dropRefineryResources(
  refinery: Refinery,
): { refinery: Refinery; dropped: DestroyedResourceDrop } {
  return {
    refinery: { ...refinery, heldOil: 0, refinedProductAvailable: 0 },
    dropped: {
      oil: refinery.heldOil,
      product: refinery.refinedProductAvailable,
      combined: refinery.heldOil + refinery.refinedProductAvailable,
    },
  };
}

/**
 * Remove a destroyed Distribution_Hub's buffered commodities from play (Req 12.7).
 *
 * A hub's buffer is a single combined Oil + Refined_Product pool (Req 11.3), so the
 * dropped quantity is reported in `combined`; the `oil`/`product` split is not tracked
 * on the buffer and is therefore `0`. Returns a new hub with `buffer === 0`. Pure —
 * never mutates the input hub.
 */
export function dropHubResources(
  hub: DistributionHub,
): { hub: DistributionHub; dropped: DestroyedResourceDrop } {
  return {
    hub: { ...hub, buffer: 0 },
    dropped: { oil: 0, product: 0, combined: hub.buffer },
  };
}

/**
 * Mark every Logistics_Route that uses a destroyed Road/Bridge Route_Segment as
 * inoperable (Req 12.8).
 *
 * When a Road or Bridge on tile `destroyedTileIndex` is destroyed, every route whose
 * `segments` include that tile can no longer carry cargo until the segment is repaired
 * or the route is rerouted along an intact path. Returns a new routes array with those
 * routes' `operable` set to `false` (routes not using the tile, and already-inoperable
 * routes, are returned unchanged by reference) plus the ids of the routes that use the
 * destroyed segment (for `route-inoperable` events). Pure — never mutates the input
 * array or its routes.
 *
 * @param routes All Logistics_Routes in play.
 * @param destroyedTileIndex The tile index of the destroyed Road/Bridge Route_Segment.
 * @returns `{ routes, affectedRouteIds }` — the updated routes and the ids of every
 *   route that used the destroyed Route_Segment.
 */
export function markRoutesInoperable(
  routes: readonly LogisticsRoute[],
  destroyedTileIndex: number,
): { routes: LogisticsRoute[]; affectedRouteIds: string[] } {
  const affectedRouteIds: string[] = [];
  const next = routes.map((route) => {
    if (!route.segments.includes(destroyedTileIndex)) return route;
    affectedRouteIds.push(route.id);
    return route.operable ? { ...route, operable: false } : route;
  });
  return { routes: next, affectedRouteIds };
}

// ---------------------------------------------------------------------------
// Per-turn orchestration — resolveLogisticsTurn (Req 3.1, 4.5, 5.4, 6.6, 6.9,
// 7.4, 7.5, 8.1, 8.6, 8.9, 11.4, 12.8)
//
// This is the integration glue that runs a single faction's logistics economy for
// one turn. It composes the pure helpers above into seven ordered stages and is
// itself PURE: it never mutates the input `state` or `tiles`, building and returning
// a brand-new LogisticsState plus the LogisticsEvents to forward to the client. The
// same `(state, tiles, faction)` always resolves the same way.
//
// Scope: only the acting `faction`'s entities are resolved; every other faction's
// wells, refineries, routes, transports, hubs, home stock, and tasks are carried
// through unchanged (by identity where possible).
//
// Ordered stages (design "Per-turn orchestration"):
//   1. Tick tasks       — tickTask each in-progress EngineerTask; apply completions
//                         (well / cleared-forest / bridge). (Req 2.7, 2.8, 9.4, 10.3)
//   2. Refine           — refine() each faction refinery. (Req 4.5)
//   3. Dispatch         — load idle transports on operable routes from their source
//                         (well→oil, refinery→product), clamped to route capacity,
//                         and send them in transit for `route.travelTime` turns.
//                         Inoperable routes (operable === false) are skipped.
//                         (Req 6.6, 8.1, 12.8)
//   4. Advance+deliver  — advance ONLY the transports that were already in transit at
//                         the START of the turn; deliver exactly when turnsRemaining
//                         hits 0 (so a transport travels its full travelTime turns —
//                         Req 7.4). Cargo of a destroyed transport is never delivered
//                         (Req 7.5, 8.6 — destroyed transports are removed from state
//                         by the combat path before this runs, so their cargo leaves
//                         play with them). Deliveries clamp to the destination's
//                         capacity (Req 8.9, 8.10).
//   5. Hub distribute   — distributeHub each faction hub with its accumulated inflow
//                         and its operable outgoing route capacities; apply newBuffer
//                         and push the distributed amounts toward each route's far
//                         endpoint. (Req 11.4)
//   6. Home accrual     — accrue the turn's delivered Oil / Refined_Product to the
//                         faction's HomeStock, clamped (Req 5.4, 6.9).
//   7. Extract          — extract() each operational faction well at end of turn
//                         (including wells that became operational in stage 1).
//                         (Req 3.1)
//
// Under-specified inter-stage data flow (documented deterministic policy):
//   • Route source/destination — a route connects two endpoints (well / refinery /
//     home-city, and in practice a hub). A route's SOURCE is its well endpoint if it
//     has one (a well ships raw Oil), else its refinery endpoint (a refinery ships
//     Refined_Product); the DESTINATION is the other endpoint. This makes well→
//     refinery carry Oil, refinery→home carry Product, well→home carry Oil, all
//     deterministically. A route with no well/refinery endpoint (e.g. hub→home) has
//     no dispatch source and is fed by the hub stage instead.
//   • Hub inflow — transports delivering INTO a hub accumulate as that hub's `inflow`
//     for stage 5 (they do not write the buffer directly), so distributeHub sees a
//     real inflow. A hub's buffer is a single COMBINED Oil+Product pool (Req 11.3);
//     when the hub pushes toward a Home_City endpoint the combined units accrue to the
//     Home_City's raw-Oil stock (documented simplification — the buffer does not
//     retain the split).
// ---------------------------------------------------------------------------

/**
 * Default Hit_Points pool assigned to an Oil_Well that an engineer task completes
 * (stage 1). Kept in code (not pinned in tests) and within the unit-combat HP domain
 * of [1, 50] that structures share (see the combat-integration note above). The
 * server applier may override this when it constructs wells directly; the orchestrator
 * only needs *a* sensible in-domain default so a task-completed well is combat-valid.
 */
const WELL_DEFAULT_MAX_HIT_POINTS = 30;

/** Which kind of endpoint a structure id resolves to within a route. */
type EndpointKind = 'well' | 'refinery' | 'hub' | 'home-city';

/**
 * Resolve one faction's logistics economy for a single turn (see the module note
 * above for the seven ordered stages and the documented inter-stage policy).
 *
 * Pure: neither `state` nor `tiles` is mutated; a fresh `LogisticsState` is returned
 * along with the `LogisticsEvent`s to forward to the client. Only `faction`'s entities
 * are resolved — all other factions' entities are carried through unchanged.
 *
 * @param state The current authoritative logistics state.
 * @param tiles The seed-regenerated authoritative tiles (as client-safe LogisticsTile).
 * @param faction The acting faction whose economy is resolved this turn.
 * @returns `{ logistics, events }` — the next state and the per-turn events.
 */
export function resolveLogisticsTurn(
  state: LogisticsState,
  tiles: LogisticsTile[],
  faction: string,
): { logistics: LogisticsState; events: LogisticsEvent[] } {
  void tiles; // travel times are precomputed on routes; tiles are accepted for signature/purity parity.
  const events: LogisticsEvent[] = [];

  // ── Working copies (clones), keyed by id, so we never mutate the inputs. ──
  const wellsById = new Map<string, OilWell>(state.wells.map((w) => [w.id, { ...w }]));
  const refineriesById = new Map<string, Refinery>(state.refineries.map((r) => [r.id, { ...r }]));
  const hubsById = new Map<string, DistributionHub>(state.hubs.map((h) => [h.id, { ...h }]));
  const transportsById = new Map<string, Transport>(state.transports.map((t) => [t.id, { ...t }]));
  const routesById = new Map<string, LogisticsRoute>(state.routes.map((r) => [r.id, r]));
  const home: Record<string, HomeStock> = { ...state.home };
  const clearedForests = [...state.clearedForests];
  const bridges = [...state.bridges];

  // Oil / Refined_Product delivered toward the Home_City this turn, applied in stage 6.
  const homeDelta = { oil: 0, product: 0 };
  // Combined Oil+Product arriving into each hub this turn (fed to distributeHub in stage 5).
  const hubInflow = new Map<string, number>();

  const owned = (ownerId: string): boolean => ownerId === faction;

  /** Classify a route endpoint id (a well / refinery / hub, else the Home_City). */
  const classify = (id: string): EndpointKind => {
    if (wellsById.has(id)) return 'well';
    if (refineriesById.has(id)) return 'refinery';
    if (hubsById.has(id)) return 'hub';
    return 'home-city';
  };

  /**
   * The route's source endpoint (where a transport loads): its well endpoint if it
   * has one (ships Oil), else its refinery endpoint (ships Product), else null.
   */
  const routeSource = (
    route: LogisticsRoute,
  ): { kind: 'well' | 'refinery'; id: string } | null => {
    const ends = [route.fromStructureId, route.toStructureId];
    const wellEnd = ends.find((id) => wellsById.has(id));
    if (wellEnd !== undefined) return { kind: 'well', id: wellEnd };
    const refEnd = ends.find((id) => refineriesById.has(id));
    if (refEnd !== undefined) return { kind: 'refinery', id: refEnd };
    return null;
  };

  /** The endpoint of `route` that is not `structureId` (its far end). */
  const otherEndpoint = (route: LogisticsRoute, structureId: string): string =>
    route.fromStructureId === structureId ? route.toStructureId : route.fromStructureId;

  /** The tile a structure id sits on, when resolvable (for event annotation). */
  const tileOf = (id: string): number | undefined =>
    wellsById.get(id)?.tileIndex ??
    refineriesById.get(id)?.tileIndex ??
    hubsById.get(id)?.tileIndex;

  /**
   * Deliver a transport's `cargo` of `cargoType` into `destId`, returning the
   * undelivered remainder (retained on the transport, Req 8.10). Home_City product is
   * clamped/discarded in stage 6; hub deliveries become the hub's inflow.
   */
  const deliverToEndpoint = (
    destId: string,
    cargoType: 'oil' | 'product',
    cargo: number,
  ): number => {
    switch (classify(destId)) {
      case 'home-city':
        // Accrue in stage 6 (clamped); the whole cargo is "delivered" here (Req 5.4, 6.9).
        if (cargoType === 'oil') homeDelta.oil += cargo;
        else homeDelta.product += cargo;
        return 0;
      case 'hub':
        // Becomes the hub's inflow for stage 5 (Req 11.4); no per-arrival clamp here.
        hubInflow.set(destId, (hubInflow.get(destId) ?? 0) + cargo);
        return 0;
      case 'well': {
        const w = wellsById.get(destId)!;
        if (cargoType !== 'oil') return cargo; // a well stores only raw Oil; retain the rest.
        const { dest, remainder } = deliver({ stored: w.storedOil, capacity: WELL_STORAGE_CAPACITY }, cargo);
        wellsById.set(destId, { ...w, storedOil: dest.stored });
        return remainder;
      }
      case 'refinery': {
        const r = refineriesById.get(destId)!;
        // A refinery has no stated storage cap, so it accepts the full cargo (Req 8.9).
        if (cargoType === 'oil') refineriesById.set(destId, { ...r, heldOil: r.heldOil + cargo });
        else
          refineriesById.set(destId, {
            ...r,
            refinedProductAvailable: r.refinedProductAvailable + cargo,
          });
        return 0;
      }
    }
  };

  /**
   * Push a hub's distributed COMBINED amount toward `destId`, returning what could not
   * be placed (retained in the hub buffer). Home_City accrues as raw Oil (documented
   * combined-pool simplification, Req 11.3).
   */
  const depositCombinedToEndpoint = (destId: string, amount: number): number => {
    switch (classify(destId)) {
      case 'home-city':
        homeDelta.oil += amount;
        return 0;
      case 'well': {
        const w = wellsById.get(destId)!;
        const { dest, remainder } = deliver({ stored: w.storedOil, capacity: WELL_STORAGE_CAPACITY }, amount);
        wellsById.set(destId, { ...w, storedOil: dest.stored });
        return remainder;
      }
      case 'refinery': {
        const r = refineriesById.get(destId)!;
        refineriesById.set(destId, { ...r, heldOil: r.heldOil + amount });
        return 0;
      }
      case 'hub': {
        const h = hubsById.get(destId)!;
        const { dest, remainder } = deliver({ stored: h.buffer, capacity: HUB_STORAGE_CAPACITY }, amount);
        hubsById.set(destId, { ...h, buffer: dest.stored });
        return remainder;
      }
    }
  };

  // ── Stage 1: tick engineer tasks and apply completions (Req 2.7, 2.8, 9.4, 10.3) ──
  const remainingTasks: EngineerTask[] = [];
  const newWellIds: string[] = [];
  for (const task of state.tasks) {
    if (!owned(task.ownerId)) {
      remainingTasks.push(task); // other factions' tasks are untouched.
      continue;
    }
    const ticked = tickTask(task);
    if (!isTaskComplete(ticked)) {
      remainingTasks.push(ticked);
      continue;
    }
    // turnsRemaining hit 0 this turn → apply the completion transition.
    switch (task.kind) {
      case 'well': {
        const completion = completeTask(ticked, {
          id: `well-${task.id}`,
          maxHitPoints: WELL_DEFAULT_MAX_HIT_POINTS,
        });
        // completion.kind === 'well' by construction.
        const well = (completion as { kind: 'well'; well: OilWell }).well;
        wellsById.set(well.id, well);
        newWellIds.push(well.id);
        events.push({
          kind: 'well-completed',
          factionId: faction,
          entityId: well.id,
          tileIndex: well.tileIndex,
        });
        break;
      }
      case 'clearForest': {
        const idx = completeClearForestTask(ticked);
        if (!clearedForests.includes(idx)) clearedForests.push(idx);
        break;
      }
      case 'bridge': {
        const idx = completeBridgeTask(ticked);
        if (!bridges.includes(idx)) bridges.push(idx);
        break;
      }
    }
    // A completed task is not retained (its progress is consumed by the transition).
  }

  // ── Stage 2: refine each faction refinery (Req 4.5) ──
  for (const r of state.refineries) {
    if (!owned(r.ownerId)) continue;
    const work = refineriesById.get(r.id)!;
    const before = work.refinedProductAvailable;
    const refined = refine(work);
    refineriesById.set(r.id, refined);
    const produced = refined.refinedProductAvailable - before;
    if (produced > 0) {
      events.push({
        kind: 'refined',
        factionId: faction,
        entityId: r.id,
        amount: produced,
        cargoType: 'product',
      });
    }
  }

  // Capture transports already in transit at the START of the turn: only these advance
  // in stage 4, so a transport dispatched this turn travels its FULL travelTime (Req 7.4).
  const inTransitAtStart = new Set<string>();
  for (const t of state.transports) {
    if (owned(t.ownerId) && t.inTransit) inTransitAtStart.add(t.id);
  }

  // ── Stage 3: dispatch idle transports on operable routes (Req 6.6, 8.1, 12.8) ──
  for (const route of state.routes) {
    if (!owned(route.ownerId)) continue;
    if (route.operable === false) continue; // inoperable route: skip dispatch (Req 12.8, 8.1).
    const src = routeSource(route);
    if (!src) continue; // no well/refinery source (e.g. hub→home): fed by the hub stage.

    let remainingCap = route.capacity; // per-turn Route_Capacity budget (Req 6.6).
    for (const t of state.transports) {
      if (!owned(t.ownerId) || t.routeId !== route.id || t.inTransit) continue;
      if (remainingCap <= 0) break;
      const work = transportsById.get(t.id)!;
      if (work.cargo >= work.cargoCapacity) continue; // no free capacity.

      // Determine source supply + commodity.
      const cargoType: 'oil' | 'product' = src.kind === 'well' ? 'oil' : 'product';
      const supply =
        src.kind === 'well'
          ? wellsById.get(src.id)!.storedOil
          : refineriesById.get(src.id)!.refinedProductAvailable;
      if (supply <= 0) continue;

      // Load up to the per-turn route budget (clampTransport) and the transport's free
      // capacity (loadTransport); the undelivered surplus stays put at the source.
      const allowed = clampTransport(supply, remainingCap);
      const { t: loaded, loaded: amt } = loadTransport(work, allowed, cargoType);
      if (amt <= 0) continue;

      // Remove the loaded quantity from the source (retainAtSource leaves the surplus).
      if (src.kind === 'well') {
        const w = wellsById.get(src.id)!;
        wellsById.set(src.id, {
          ...w,
          storedOil: retainAtSource(0, WELL_STORAGE_CAPACITY, w.storedOil - amt),
        });
      } else {
        const r = refineriesById.get(src.id)!;
        refineriesById.set(src.id, {
          ...r,
          refinedProductAvailable: Math.max(0, r.refinedProductAvailable - amt),
        });
      }

      // Send it in transit for the route's travel time (Req 7.4).
      transportsById.set(t.id, { ...loaded, inTransit: true, turnsRemaining: route.travelTime });
      remainingCap -= amt;
      events.push({
        kind: 'dispatched',
        factionId: faction,
        entityId: t.id,
        routeId: route.id,
        amount: amt,
        cargoType,
      });
    }
  }

  // ── Stage 4: advance in-transit transports and deliver on arrival (Req 7.4, 7.5, 8.9) ──
  for (const t of state.transports) {
    if (!owned(t.ownerId) || !inTransitAtStart.has(t.id)) continue;
    const work = transportsById.get(t.id)!;
    const nextRemaining = Math.max(0, work.turnsRemaining - 1);
    if (nextRemaining > 0) {
      transportsById.set(t.id, { ...work, turnsRemaining: nextRemaining }); // still travelling.
      continue;
    }

    // Arrived this turn. The transport is intact (destroyed transports and their cargo
    // were removed from `state.transports` by the combat path before this runs, so no
    // destroyed cargo is ever delivered — Req 7.5, 8.6).
    const route = routesById.get(work.routeId);
    const cargo = work.cargo;
    const cargoType = work.cargoType;
    if (!route || cargo <= 0 || cargoType == null) {
      transportsById.set(t.id, { ...work, inTransit: false, turnsRemaining: 0 });
      continue;
    }
    const src = routeSource(route);
    const destId = src ? otherEndpoint(route, src.id) : route.toStructureId;
    const remainder = deliverToEndpoint(destId, cargoType, cargo);
    const delivered = cargo - remainder;
    transportsById.set(t.id, {
      ...work,
      cargo: remainder,
      cargoType: remainder > 0 ? cargoType : null,
      inTransit: false,
      turnsRemaining: 0,
    });
    if (delivered > 0) {
      events.push({
        kind: 'delivered',
        factionId: faction,
        entityId: t.id,
        routeId: route.id,
        amount: delivered,
        cargoType,
        tileIndex: tileOf(destId),
      });
    }
  }

  // ── Stage 5: distribute each faction hub's buffered + inflow across outgoing routes (Req 11.4) ──
  for (const h of state.hubs) {
    if (!owned(h.ownerId)) continue;
    const hub = hubsById.get(h.id)!;
    const inflowAmt = hubInflow.get(h.id) ?? 0;

    // Operable outgoing routes and their capacities, in the hub's connection order.
    const outgoing = hub.routeIds
      .map((rid) => routesById.get(rid))
      .filter((r): r is LogisticsRoute => r !== undefined && r.operable !== false);
    const caps = outgoing.map((r) => r.capacity);

    const dist = distributeHub(hub, inflowAmt, caps);
    let buffer = dist.newBuffer;

    // Push each route's distributed amount toward its far endpoint; anything that will
    // not fit is retained back in the hub buffer (clamped) so nothing is silently lost.
    outgoing.forEach((route, i) => {
      const amt = dist.amounts[i];
      if (amt <= 0) return;
      const destId = otherEndpoint(route, h.id);
      const leftover = depositCombinedToEndpoint(destId, amt);
      const placed = amt - leftover;
      if (leftover > 0) buffer = Math.min(HUB_STORAGE_CAPACITY, buffer + leftover);
      if (placed > 0) {
        events.push({
          kind: 'delivered',
          factionId: faction,
          entityId: h.id,
          routeId: route.id,
          amount: placed,
          tileIndex: tileOf(destId),
        });
      }
    });

    hubsById.set(h.id, { ...hub, buffer });

    // Anything that fit neither an outgoing route nor the buffer is surfaced as spill.
    if (dist.leftUpstream > 0) {
      events.push({
        kind: 'storage-full',
        factionId: faction,
        entityId: h.id,
        amount: dist.leftUpstream,
      });
    }
  }

  // ── Stage 6: accrue this turn's Home_City deliveries, clamped (Req 5.4, 6.9) ──
  if (homeDelta.oil > 0 || homeDelta.product > 0) {
    const existing: HomeStock = home[faction] ?? { factionId: faction, refinedProduct: 0, oil: 0 };
    let stock: HomeStock = { ...existing };
    if (homeDelta.oil > 0) stock = accrueOil(stock, homeDelta.oil);
    if (homeDelta.product > 0) {
      const before = stock.refinedProduct;
      stock = accrueRefinedProduct(stock, homeDelta.product);
      const discarded = before + homeDelta.product - stock.refinedProduct;
      if (discarded > 0) {
        events.push({
          kind: 'storage-full',
          factionId: faction,
          amount: discarded,
          cargoType: 'product',
        });
      }
    }
    home[faction] = stock;
  }

  // ── Stage 7: extract at end of turn for every operational faction well (Req 3.1) ──
  const factionWellIds = [
    ...state.wells.filter((w) => owned(w.ownerId)).map((w) => w.id),
    ...newWellIds,
  ];
  for (const id of factionWellIds) {
    const w = wellsById.get(id)!;
    const before = w.storedOil;
    const extracted = extract(w);
    wellsById.set(id, extracted);
    const added = extracted.storedOil - before;
    if (added > 0) {
      events.push({
        kind: 'extracted',
        factionId: faction,
        entityId: id,
        amount: added,
        cargoType: 'oil',
      });
    }
  }

  // ── Rebuild the next state, preserving original order and non-faction entities. ──
  const logistics: LogisticsState = {
    wells: [
      ...state.wells.map((w) => wellsById.get(w.id)!),
      ...newWellIds.map((id) => wellsById.get(id)!),
    ],
    refineries: state.refineries.map((r) => refineriesById.get(r.id)!),
    routes: state.routes.map((r) => routesById.get(r.id)!),
    transports: state.transports.map((t) => transportsById.get(t.id)!),
    hubs: state.hubs.map((h) => hubsById.get(h.id)!),
    home,
    tasks: remainingTasks,
    clearedForests,
    bridges,
  };

  return { logistics, events };
}
