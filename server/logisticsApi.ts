/**
 * Authoritative logistics intent appliers (Oil Logistics System — server side).
 *
 * One applier per logistics `Intent` variant (see `shared/matchTypes.ts`). Each
 * applier mirrors the convention established by `server/matchApi.ts`'s combat
 * appliers (`applyMoveIntent`/`applyAttackIntent`): it takes the authoritative
 * `MatchState`, the regenerated authoritative `Tile[]`, the acting faction id, and
 * the narrowed intent, then returns `{ error?: string }` — an `error` string means
 * the intent was rejected. `matchApi.ts::handleMatchIntent` (task 13.3) routes the
 * new intent kinds here and persists exactly as it does for combat intents.
 *
 * Each applier:
 *   - validates against the authoritative tiles + `MatchState.logistics` using the
 *     PURE engine validators from `src/world/logistics.ts`
 *     (`validateWellPlacement`/`validateRefineryPlacement`/`validateRefinerySegment`/
 *     `validateRoutePath`/`canAssignTransport`, …);
 *   - charges Refined_Product from the acting faction's `HomeStock` via
 *     `canAfford`/`chargeConstruction` with the correct `CONSTRUCTION_COST`;
 *   - mutates the logistics state (append well/refinery/route/hub/transport, start
 *     engineer tasks, upgrade capacity/tier/transport);
 *   - records `ownerId` (Structure_Owner, Req 12.1) on constructed structures;
 *   - is REJECT-AND-PRESERVE: every rejection returns before any mutation, so a
 *     rejected intent leaves `MatchState.logistics` byte-for-byte unchanged.
 *
 * Layering: `server/` may import from `src/` and `shared/` (only the client is
 * forbidden from importing `src/`/`server/`). Engine helpers come from
 * `../src/world/logistics.js`, matching how `matchApi.ts`/`combatApi.ts` import
 * `../src/world/combat.js` directly.
 *
 * Building-occupancy note (docs/architecture/known-issues.md): the pure engine
 * validators cannot see main-game buildings (they are not part of `LogisticsState`).
 * These appliers DO see `MatchState.buildings`, so they add a building-collision
 * check for well/refinery/hub segment placement that the engine cannot perform.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../src/world/types.js';
import { isImpassableTerrain } from '../shared/movementConstants.js';
import { CONSTRUCTION_COST } from '../shared/logisticsConstants.js';
import type { MatchState, Intent } from '../shared/matchTypes.js';
import type {
  DistributionHub,
  EngineerTask,
  EngineerUnitRef,
  HomeStock,
  LogisticsContext,
  LogisticsRoute,
  OilWell,
  Refinery,
  Transport,
} from '../shared/logisticsTypes.js';
import {
  canAfford,
  canAssignTransport,
  chargeConstruction,
  createHub,
  createRoute,
  engineerTaskDuration,
  transportTier,
  upgradeRoute,
  upgradeTransport,
  validateRefineryPlacement,
  validateRefinerySegment,
  validateRoutePath,
  validateWellPlacement,
  type RouteEndpoint,
  type RouteEndpointKind,
  type RouteEndpoints,
} from '../src/world/logistics.js';

// ---------------------------------------------------------------------------
// Structure/transport initialisation constants
//
// These are entity-init values (not Construction_Cost, and not balance-formula
// outputs), so they live here as named constants rather than pinned literals.
// ---------------------------------------------------------------------------

/**
 * Hit points every applier-built structure (well/refinery/hub) starts with. Kept
 * within the combat HP domain `[1, 50]` that `applyDamage` clamps into (see
 * docs/architecture/known-issues.md and `src/world/logisticsSeed.ts`), so a value
 * `> 50` would be silently clamped on the first hit. Matches `SEED_STRUCTURE_HP`.
 */
const STRUCTURE_MAX_HIT_POINTS = 40;

/** A freshly purchased Transportation_Unit's cargo capacity (`TRANSPORT_CARGO_MIN..MAX`). */
const INITIAL_TRANSPORT_CARGO_CAPACITY = 100;
/** A freshly purchased Transportation_Unit's movement speed (upgradeable, Req 8.4). */
const INITIAL_TRANSPORT_SPEED = 1;
/** A freshly purchased Transportation_Unit's defensive strength (upgradeable, Req 8.4). */
const INITIAL_TRANSPORT_DEFENCE = 1;

// ---------------------------------------------------------------------------
// Applier result + id generation
// ---------------------------------------------------------------------------

/**
 * The uniform applier return shape (mirrors `matchApi.ts`'s appliers): an `error`
 * string means the intent was rejected and no state was changed.
 */
export interface LogisticsApplyResult {
  error?: string;
}

let idCounter = 0;

/** Generate a process-unique id for a new logistics entity/task. */
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the read-only engine context from authoritative tiles + logistics state. */
function makeCtx(state: MatchState, tiles: Tile[]): LogisticsContext {
  return { tiles, state: state.logistics };
}

/**
 * The acting faction's Home_City stock, or a fresh zero-stock when it has none yet.
 * Non-mutating: never writes into `state.logistics.home`, so calling it during a
 * rejection path leaves state untouched. Callers store the charged result back
 * explicitly on the success path.
 */
function getHome(state: MatchState, faction: string): HomeStock {
  return state.logistics.home[faction] ?? { factionId: faction, refinedProduct: 0, oil: 0 };
}

/** Whether an ordinary main-game building occupies `tileIndex:segment`. */
function buildingOccupies(state: MatchState, tileIndex: number, segment: number): boolean {
  return state.buildings.some((b) => b.tileIndex === tileIndex && b.segment === segment);
}

/** Whether any main-game building sits on `tileIndex` (any segment). */
function buildingOnTile(state: MatchState, tileIndex: number): boolean {
  return state.buildings.some((b) => b.tileIndex === tileIndex);
}

/** Resolve the acting engineer unit and adapt it to the engine's `EngineerUnitRef`. */
function resolveEngineer(
  state: MatchState,
  unitId: string,
  activeFaction: string,
): { ref: EngineerUnitRef } | { error: string } {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { error: 'Acting unit not found' };
  if (unit.ownerId !== activeFaction) return { error: "Not this faction's unit" };
  return {
    ref: {
      id: unit.id,
      ownerId: unit.ownerId,
      tileIndex: unit.tileIndex,
      segment: unit.segment,
      attributes: unit.attributes,
    },
  };
}

/** Whether a unit's attributes make it an Engineer_Unit (engineer 1..5). Req 2.2/9.6/10.6. */
function hasEngineer(ref: EngineerUnitRef): boolean {
  const engineer = ref.attributes.engineer ?? 0;
  return Number.isInteger(engineer) && engineer >= 1 && engineer <= 5;
}

/** Resolve a route endpoint descriptor from a structure id (well/refinery/home-city). */
function resolveEndpoint(
  state: MatchState,
  tiles: Tile[],
  structureId: string,
): RouteEndpoint | null {
  const well = state.logistics.wells.find((w) => w.id === structureId);
  if (well) {
    return { structureId, kind: 'well', tileIndex: well.tileIndex, ownerId: well.ownerId };
  }
  const refinery = state.logistics.refineries.find((r) => r.id === structureId);
  if (refinery) {
    return {
      structureId,
      kind: 'refinery',
      tileIndex: refinery.tileIndex,
      ownerId: refinery.ownerId,
    };
  }
  // Home_City: the tile carrying this city id (set by placeCities). Its owner is
  // the tile's ownerId, defaulting to the structure id (a city id == faction id).
  const cityTileIndex = tiles.findIndex((t) => t && t.cityId === structureId);
  if (cityTileIndex >= 0) {
    const kind: RouteEndpointKind = 'home-city';
    return {
      structureId,
      kind,
      tileIndex: cityTileIndex,
      ownerId: tiles[cityTileIndex].ownerId ?? structureId,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engineer-driven intents: buildOilWell, buildBridge, clearForest
//
// These start an EngineerTask (duration = engineerTaskDuration(engineer)); the
// actual structure/effect completes later in resolveLogisticsTurn (task 9.1).
// ---------------------------------------------------------------------------

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
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to drill an oil well.' };

  // ── Commit (reject-and-preserve: nothing above mutated state) ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
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
): LogisticsApplyResult {
  const resolved = resolveEngineer(state, intent.unitId, activeFaction);
  if ('error' in resolved) return { error: resolved.error };
  if (!hasEngineer(resolved.ref)) {
    return { error: 'Only an engineer unit (engineer attribute 1–5) can build a bridge.' };
  }

  const tile = tiles[intent.tileIndex];
  if (!tile) return { error: `Tile ${intent.tileIndex} does not exist.` };
  // A bridge is only meaningful across Impassable_Terrain (water/valley) (Req 10).
  if (!isImpassableTerrain(tile.terrainType)) {
    return { error: 'A bridge can only be built across impassable water or valley terrain.' };
  }
  if (state.logistics.bridges.includes(intent.tileIndex)) {
    return { error: 'This tile already has a bridge.' };
  }

  const cost = CONSTRUCTION_COST.bridge;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to build a bridge.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
  const task: EngineerTask = {
    id: genId('task-bridge'),
    kind: 'bridge',
    unitId: resolved.ref.id,
    tileIndex: intent.tileIndex,
    turnsRemaining: engineerTaskDuration(resolved.ref.attributes.engineer ?? 0),
    ownerId: activeFaction,
  };
  state.logistics.tasks.push(task);
  return {};
}

/**
 * Begin clearing a Forest_Tile on the acting engineer's current HexTile
 * (Req 9.1, 9.6, 5.9, 12.1). Costs 0 Refined_Product (turns only, Req 5.9). Starts
 * a `clearForest` EngineerTask; the tile is reclassified when the task completes.
 */
export function applyClearForestIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'clearForest' }>,
): LogisticsApplyResult {
  const resolved = resolveEngineer(state, intent.unitId, activeFaction);
  if ('error' in resolved) return { error: resolved.error };
  const ref = resolved.ref;
  if (!hasEngineer(ref)) {
    return { error: 'Only an engineer unit (engineer attribute 1–5) can clear a forest.' };
  }

  const tile = tiles[ref.tileIndex];
  if (!tile) return { error: `Tile ${ref.tileIndex} does not exist.` };
  if (!tile.forested || state.logistics.clearedForests.includes(ref.tileIndex)) {
    return { error: 'There is no uncleared forest on this tile.' };
  }

  // Req 5.9 — clearing a forest costs 0 Refined_Product (always affordable).
  const cost = CONSTRUCTION_COST.forestClear;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to clear a forest.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
  const task: EngineerTask = {
    id: genId('task-clear'),
    kind: 'clearForest',
    unitId: ref.id,
    tileIndex: ref.tileIndex,
    turnsRemaining: engineerTaskDuration(ref.attributes.engineer ?? 0),
    ownerId: activeFaction,
  };
  state.logistics.tasks.push(task);
  return {};
}

// ---------------------------------------------------------------------------
// Refinery intents: buildRefinery, addRefinerySegment
// ---------------------------------------------------------------------------

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
): LogisticsApplyResult {
  const ctx = makeCtx(state, tiles);
  const validation = validateRefineryPlacement(ctx, intent.tileIndex, activeFaction);
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  // Building-collision check the pure engine cannot perform (any segment of the tile).
  if (buildingOnTile(state, intent.tileIndex)) {
    return { error: 'A building already occupies this tile.' };
  }

  const cost = CONSTRUCTION_COST.refineryFirstSegment;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to build a refinery.' };

  // ── Commit ── one Refinery_Segment on the first HexSegment (Req 4.2).
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
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
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) {
    return { error: 'Insufficient Refined_Product to add a refinery segment.' };
  }

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
  refinery.segments.push(intent.segment);
  return {};
}

// ---------------------------------------------------------------------------
// Route intents: buildRoute, upgradeRoute
// ---------------------------------------------------------------------------

/**
 * Build a Logistics_Route as a Road along a contiguous path between two player-owned
 * endpoints (Req 6.1, 6.2, 6.3, 5.2, 5.3, 12.1). Cost is `routeRoadPerSegment` per
 * Route_Segment.
 */
export function applyBuildRouteIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildRoute' }>,
): LogisticsApplyResult {
  const from = resolveEndpoint(state, tiles, intent.fromStructureId);
  const to = resolveEndpoint(state, tiles, intent.toStructureId);
  if (!from || !to) {
    return { error: 'A route must connect an oil well, a refinery, or the home city at each end.' };
  }
  const endpoints: RouteEndpoints = { from, to };

  const ctx = makeCtx(state, tiles);
  const validation = validateRoutePath(ctx, intent.path, endpoints);
  if (!validation.legal) return { error: validation.message ?? validation.reason };

  // A route connects player-owned endpoints (Req 6.2).
  if (from.ownerId !== activeFaction || to.ownerId !== activeFaction) {
    return { error: 'Both route endpoints must belong to you.' };
  }

  const cost = CONSTRUCTION_COST.routeRoadPerSegment * intent.path.length;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to build this road.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
  const route: LogisticsRoute = createRoute(
    {
      id: genId('route'),
      ownerId: activeFaction,
      fromStructureId: intent.fromStructureId,
      toStructureId: intent.toStructureId,
      path: intent.path,
    },
    tiles,
  );
  state.logistics.routes.push(route);
  return {};
}

/**
 * Upgrade a Logistics_Route one capacity step and render it as a Highway
 * (Req 6.7, 6.8, 5.2, 5.3, 12.3). Rejects at maximum capacity. Cost is
 * `routeUpgradePerSegment` per Route_Segment.
 */
export function applyUpgradeRouteIntent(
  state: MatchState,
  _tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'upgradeRoute' }>,
): LogisticsApplyResult {
  const idx = state.logistics.routes.findIndex((r) => r.id === intent.routeId);
  if (idx < 0) return { error: 'Route not found' };
  const route = state.logistics.routes[idx];
  if (route.ownerId !== activeFaction) return { error: 'That route is owned by another player.' };

  const upgraded = upgradeRoute(route);
  if (upgraded instanceof Error) return { error: 'The route is already at maximum capacity.' };

  const cost = CONSTRUCTION_COST.routeUpgradePerSegment * route.segments.length;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to upgrade this route.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
  state.logistics.routes[idx] = upgraded;
  return {};
}

// ---------------------------------------------------------------------------
// Distribution hub intent: buildDistributionHub
// ---------------------------------------------------------------------------

/**
 * Build a Distribution_Hub on a HexSegment, connecting two-or-more Logistics_Routes
 * (Req 11.1, 11.2, 5.2, 5.3, 12.1). There is no dedicated engine hub validator, so
 * a minimal ownership/occupancy placement check is performed (reason
 * `invalid-placement`, Req 11.2).
 */
export function applyBuildDistributionHubIntent(
  state: MatchState,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildDistributionHub' }>,
): LogisticsApplyResult {
  const tile = tiles[intent.tileIndex];
  if (!tile) return { error: 'The chosen tile does not exist.' };

  // Req 12.3 — reject a tile owned by another player.
  if (tile.ownerId !== undefined && tile.ownerId !== activeFaction) {
    return { error: 'That tile is owned by another player.' };
  }
  // Segment must be in range and free of any logistics structure or building.
  const segCount = tile.segSteep?.length ?? tile.neighbours.length;
  if (!Number.isInteger(intent.segment) || intent.segment < 0 || intent.segment >= segCount) {
    return { error: 'Invalid hub placement: segment out of range.' };
  }
  const segTaken =
    state.logistics.wells.some((w) => w.tileIndex === intent.tileIndex && w.segment === intent.segment) ||
    state.logistics.refineries.some(
      (r) => r.tileIndex === intent.tileIndex && r.segments.includes(intent.segment),
    ) ||
    state.logistics.hubs.some((h) => h.tileIndex === intent.tileIndex && h.segment === intent.segment) ||
    buildingOccupies(state, intent.tileIndex, intent.segment);
  if (segTaken) return { error: 'Invalid hub placement: that segment is already occupied.' };

  const cost = CONSTRUCTION_COST.distributionHub;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) {
    return { error: 'Insufficient Refined_Product to build a distribution hub.' };
  }

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
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

// ---------------------------------------------------------------------------
// Transport intents: purchaseTransport, upgradeTransport
// ---------------------------------------------------------------------------

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
): LogisticsApplyResult {
  const route = state.logistics.routes.find((r) => r.id === intent.routeId);
  if (!route) return { error: 'Route not found' };
  if (route.ownerId !== activeFaction) return { error: 'That route is owned by another player.' };

  // Req 8.12 — reject once the route is full.
  if (!canAssignTransport(route, state.logistics.transports)) {
    return { error: 'This route already has the maximum number of transports.' };
  }

  const cost = CONSTRUCTION_COST.transportUnit;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to purchase a transport.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
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
): LogisticsApplyResult {
  const idx = state.logistics.transports.findIndex((t) => t.id === intent.transportId);
  if (idx < 0) return { error: 'Transport not found' };
  const transport = state.logistics.transports[idx];
  if (transport.ownerId !== activeFaction) {
    return { error: 'That transport is owned by another player.' };
  }

  const cost = CONSTRUCTION_COST.transportUpgrade;
  const home = getHome(state, activeFaction);
  if (!canAfford(home, cost)) return { error: 'Insufficient Refined_Product to upgrade a transport.' };

  // ── Commit ──
  state.logistics.home[activeFaction] = chargeConstruction(home, cost);
  state.logistics.transports[idx] = upgradeTransport(transport, intent.stat);
  return {};
}

// ---------------------------------------------------------------------------
// Uniform dispatcher (used by matchApi.ts routing in task 13.3)
// ---------------------------------------------------------------------------

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
  | 'purchaseTransport'
  | 'upgradeTransport';

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
    case 'purchaseTransport':
    case 'upgradeTransport':
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
): LogisticsApplyResult {
  switch (intent.kind) {
    case 'buildOilWell':
      return applyBuildOilWellIntent(state, tiles, activeFaction, intent);
    case 'buildRefinery':
      return applyBuildRefineryIntent(state, tiles, activeFaction, intent);
    case 'addRefinerySegment':
      return applyAddRefinerySegmentIntent(state, tiles, activeFaction, intent);
    case 'buildRoute':
      return applyBuildRouteIntent(state, tiles, activeFaction, intent);
    case 'upgradeRoute':
      return applyUpgradeRouteIntent(state, tiles, activeFaction, intent);
    case 'buildDistributionHub':
      return applyBuildDistributionHubIntent(state, tiles, activeFaction, intent);
    case 'buildBridge':
      return applyBuildBridgeIntent(state, tiles, activeFaction, intent);
    case 'clearForest':
      return applyClearForestIntent(state, tiles, activeFaction, intent);
    case 'purchaseTransport':
      return applyPurchaseTransportIntent(state, tiles, activeFaction, intent);
    case 'upgradeTransport':
      return applyUpgradeTransportIntent(state, tiles, activeFaction, intent);
  }
}
