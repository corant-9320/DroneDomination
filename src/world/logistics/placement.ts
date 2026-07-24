/**
 * Placement validators — Oil Logistics System (Req 2.1–2.5, 4.1, 4.8–4.12, 12.2, 12.3).
 *
 * Every validator below is PURE and runs BEFORE any mutation: it inspects the
 * read-only LogisticsContext (regenerated tiles + current LogisticsState) and a
 * proposed placement, and returns a LogisticsValidation describing whether the
 * action may proceed and, if not, the discriminated reason. Inputs are never
 * mutated (reject-and-preserve), so a rejection leaves the world untouched.
 *
 * Occupancy limitation: the pure engine only sees logistics entities held on
 * LogisticsState (wells, refinery segments, hubs). The main-game building layer
 * (`shared/buildings.ts`) is NOT part of LogisticsState/LogisticsContext, so a
 * segment occupied by an ordinary building cannot be detected here. Occupancy is
 * therefore based on wells + refinery segments + hubs; the server applier
 * (task 13.2) is responsible for any additional building-collision check it can
 * see. (Recorded in docs/architecture/known-issues.md.)
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { MAX_STEEP_WHEELED } from '../../../shared/movementConstants.js';
import type {
  EngineerUnitRef,
  LogisticsContext,
  LogisticsState,
  LogisticsTile,
  LogisticsValidation,
  Refinery,
} from '../../../shared/logisticsTypes.js';

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
 * The set of segment keys currently blocked by logistics structures, pending
 * well construction, or road. A well task reserves both its segment and tile
 * designation so it cannot complete into a conflicting refinery or consume the
 * road segment. Built road segments and pending `road` tasks are reserved too:
 * roads are engineer-built connectivity, so an oil structure must not be placed
 * on top of one (or on a segment a road is mid-construction on).
 * See the occupancy limitation note above regarding main-game buildings.
 */
function occupiedSegments(state: LogisticsState): Set<string> {
  const occupied = new Set<string>();
  for (const well of state.wells) occupied.add(segKey(well.tileIndex, well.segment));
  for (const refinery of state.refineries) {
    for (const seg of refinery.segments) occupied.add(segKey(refinery.tileIndex, seg));
  }
  for (const hub of state.hubs) occupied.add(segKey(hub.tileIndex, hub.segment));
  for (const task of state.tasks) {
    if ((task.kind === 'well' || task.kind === 'road') && task.segment !== undefined) {
      occupied.add(segKey(task.tileIndex, task.segment));
    }
  }
  for (const key of state.standaloneRoadSegments ?? []) {
    occupied.add(segKey(Math.floor(key / 6), key % 6));
  }
  return occupied;
}

/** A claimed oil tile may use every segment except one reserved road connection. */
function maxOilBuildingSegments(tile: LogisticsTile): number {
  return Math.max(0, tileSegmentCount(tile) - 1);
}

/** Oil wells, refineries, and storage hubs cannot mix on a tile; queued well construction reserves the same designation. */
function oilBuildingDesignation(
  state: LogisticsState,
  tileIndex: number,
): 'well' | 'refinery' | 'storage' | null {
  if (state.wells.some((well) => well.tileIndex === tileIndex)
    || state.tasks.some((task) => task.kind === 'well' && task.tileIndex === tileIndex)) return 'well';
  if (state.refineries.some((refinery) => refinery.tileIndex === tileIndex)) return 'refinery';
  if (state.hubs.some((hub) => hub.tileIndex === tileIndex)) return 'storage';
  return null;
}

/** Per-segment steepness (radians) for a tile segment; 0 (flat) when absent. */
function segmentSteepnessAt(tile: LogisticsTile, segment: number): number {
  return tile.segSteep?.[segment] ?? 0;
}

/**
 * Whether a tile lies inside a city. `placeCities`/`foundCity` stamp `cityId` on
 * the capital and on every city-owned hex, so a truthy `cityId` marks any tile
 * within a city footprint. Oil_Wells, Refineries, and Distribution_Hubs are
 * map-only structures; none may sit inside a city.
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

  // A well claims the whole tile for wells; every other oil-building type
  // requires a fully reset tile.
  const designation = oilBuildingDesignation(ctx.state, tileIndex);
  if (designation !== null && designation !== 'well') {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'This tile is designated for another oil building type; delete every footprint before drilling wells.',
      offendingTiles: [tileIndex],
    };
  }
  const wellCount = ctx.state.wells.filter((well) => well.tileIndex === tileIndex).length
    + ctx.state.tasks.filter((task) => task.kind === 'well' && task.tileIndex === tileIndex).length;
  if (wellCount >= maxOilBuildingSegments(tile)) {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'One segment must remain free for a road connection.',
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

  const designation = oilBuildingDesignation(ctx.state, refinery.tileIndex);
  if (designation !== null && designation !== 'refinery') {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'This tile is designated for another oil building type; delete every footprint before building refinery segments.',
      offendingTiles: [refinery.tileIndex],
    };
  }

  // Keep one segment free for a road connection on every hex or pentagon.
  const maxSegments = Math.max(0, sides - 1);
  if (refinery.segments.length >= maxSegments) {
    return {
      legal: false,
      reason: 'refinery-at-capacity',
      message: 'One segment must remain free for a road connection.',
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


/**
 * Validate one refinery footprint segment without requiring the rest of the tile
 * to be empty. This is used by development segment CRUD, where a refinery can
 * grow across its own selected segments while the final segment stays reserved
 * for a road connection.
 */
export function validateRefinerySegmentPlacement(
  ctx: LogisticsContext,
  tileIndex: number,
  faction: string,
  segment: number,
): LogisticsValidation {
  const tile = ctx.tiles[tileIndex];
  if (!tile) {
    return { legal: false, reason: 'ineligible-tile', message: `Tile ${tileIndex} does not exist.`, offendingTiles: [tileIndex] };
  }
  if (tile.ownerId !== undefined && tile.ownerId !== faction) {
    return { legal: false, reason: 'owned-by-other-player', message: 'That tile is owned by another player.', offendingTiles: [tileIndex] };
  }
  if (isCityTile(tile)) {
    return { legal: false, reason: 'in-city', message: 'A refinery cannot be built inside a city.', offendingTiles: [tileIndex] };
  }
  if (tile.terrainType === 'ocean' || (tile.forested && !ctx.state.clearedForests.includes(tileIndex))) {
    return { legal: false, reason: 'ineligible-tile', message: 'That segment cannot host a refinery.', offendingTiles: [tileIndex] };
  }

  const sides = tileSegmentCount(tile);
  if (!Number.isInteger(segment) || segment < 0 || segment >= sides) {
    return { legal: false, reason: 'outside-refinery-tile', message: 'That segment is outside the refinery tile.', offendingTiles: [tileIndex] };
  }
  const designation = oilBuildingDesignation(ctx.state, tileIndex);
  if (designation !== null && designation !== 'refinery') {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'This tile is designated for another oil building type; delete every footprint before building a refinery.',
      offendingTiles: [tileIndex],
    };
  }
  if (segmentSteepnessAt(tile, segment) > MAX_STEEP_WHEELED) {
    return { legal: false, reason: 'too-steep', message: 'The terrain is too steep to host a refinery.', offendingTiles: [tileIndex] };
  }
  if (occupiedSegments(ctx.state).has(segKey(tileIndex, segment))) {
    return { legal: false, reason: 'segment-occupied', message: 'That segment is already occupied.', offendingTiles: [tileIndex] };
  }
  return { legal: true };
}

/**
 * Validate an Oil_Storage building (Distribution_Hub) on one segment. Storage
 * follows the same map-only tile designation and road-reservation policy as
 * wells and refineries: it cannot mix with another oil-building type and no
 * more than `segments - 1` storage footprints may claim a tile.
 */
export function validateDistributionHubPlacement(
  ctx: LogisticsContext,
  tileIndex: number,
  faction: string,
  segment: number,
): LogisticsValidation {
  const tile = ctx.tiles[tileIndex];
  if (!tile) {
    return { legal: false, reason: 'ineligible-tile', message: `Tile ${tileIndex} does not exist.`, offendingTiles: [tileIndex] };
  }
  if (tile.ownerId !== undefined && tile.ownerId !== faction) {
    return { legal: false, reason: 'owned-by-other-player', message: 'That tile is owned by another player.', offendingTiles: [tileIndex] };
  }
  if (isCityTile(tile)) {
    return { legal: false, reason: 'in-city', message: 'Oil storage cannot be built inside a city.', offendingTiles: [tileIndex] };
  }
  if (tile.terrainType === 'ocean' || (tile.forested && !ctx.state.clearedForests.includes(tileIndex))) {
    return { legal: false, reason: 'ineligible-tile', message: 'That segment cannot host oil storage.', offendingTiles: [tileIndex] };
  }

  const sides = tileSegmentCount(tile);
  if (!Number.isInteger(segment) || segment < 0 || segment >= sides) {
    return { legal: false, reason: 'invalid-placement', message: 'Invalid oil-storage segment.', offendingTiles: [tileIndex] };
  }
  const designation = oilBuildingDesignation(ctx.state, tileIndex);
  if (designation !== null && designation !== 'storage') {
    return {
      legal: false,
      reason: 'segment-occupied',
      message: 'This tile is designated for another oil building type; delete every footprint before building oil storage.',
      offendingTiles: [tileIndex],
    };
  }
  const storageCount = ctx.state.hubs.filter((hub) => hub.tileIndex === tileIndex).length;
  if (storageCount >= maxOilBuildingSegments(tile)) {
    return {
      legal: false,
      reason: 'invalid-placement',
      message: 'One segment must remain free for a road connection.',
      offendingTiles: [tileIndex],
    };
  }
  if (segmentSteepnessAt(tile, segment) > MAX_STEEP_WHEELED) {
    return { legal: false, reason: 'too-steep', message: 'The terrain is too steep to host oil storage.', offendingTiles: [tileIndex] };
  }
  if (occupiedSegments(ctx.state).has(segKey(tileIndex, segment))) {
    return { legal: false, reason: 'segment-occupied', message: 'That segment is already occupied.', offendingTiles: [tileIndex] };
  }
  return { legal: true };
}
