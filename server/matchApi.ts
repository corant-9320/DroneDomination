/**
 * Authoritative match API (server-authority Phase 3).
 *
 * The server owns the match: it holds each unit's remaining MP / acted / rotated
 * state and whose turn it is, and validates every player intent against that
 * authoritative state before applying it. Unlike the stateless `/api/combat`
 * resolver, this enforces cumulative per-turn budgets and the once-per-turn
 * action gate, so a client cannot move twice, act twice, or overspend MP.
 *
 * Tiles are regenerated from the trusted seed (never accepted from the client),
 * so terrain can't be forged to legalise a move.
 *
 * State lives in the SessionStore (mocked DynamoDB locally — see sessionStore.ts).
 *
 * NOT YET DONE (next increments): wiring the client's TurnManager to this API,
 * and routing AI faction turns through the session (AI still uses /api/ai-turn).
 */

import { generateWorld } from '../src/world/generate.js';
import { Tile } from '../src/world/types.js';
import { HexSegment } from '../src/world/units.js';
import {
  isDrone,
  resolveAttack,
  resolveReactionFire,
  type CombatContext,
} from '../src/world/combat.js';
import { explainAttack, explainSplash, buildReactionExplanation, explainRepairAction, explainRepairInvalid } from './combatExplainer.js';
import { validateRepair, resolveRepair } from '../src/world/repair.js';
import {
  rebuildUnits,
  rebuildBuildings,
  toWireUnit,
  toWireBuilding,
  computeMovePath,
  handleBuildingAttack,
  type CombatRequest,
} from './combatApi.js';
import { getMaxMovement } from '../shared/movementConstants.js';
import { sanitizeCityDistributionHubs } from '../shared/logisticsSanitization.js';
import { resolveLogisticsTurn } from '../src/world/logistics/turn.js';
import { createEmptyLogisticsState } from '../src/world/logisticsSeed.js';
import { applyLogisticsIntent, isLogisticsIntent } from './logistics/dispatch.js';
import {
  getDevelopmentLogisticsPolicy,
  getDevelopmentMatchCapabilities,
} from './developmentMode.js';
import { getSessionStore, VersionConflictError } from './sessionStore.js';
import type {
  MatchState,
  UnitTurnState,
  Intent,
  CreateMatchRequest,
  CreateMatchResponse,
  MatchIntentRequest,
  MatchIntentResponse,
} from '../shared/matchTypes.js';
import type { ExplainedCombat, ExplainedRepair } from '../shared/combatTypes.js';
import type { LogisticsEvent } from '../shared/logisticsTypes.js';
import type { UnitAttributes } from '../shared/unitTypes.js';

// ---------------------------------------------------------------------------
// Authoritative tiles (regenerated from the trusted seed, cached per process)
// ---------------------------------------------------------------------------

const tileCache = new Map<number, Tile[]>();

function getAuthoritativeTiles(seed: number): Tile[] {
  let t = tileCache.get(seed);
  if (!t) {
    t = generateWorld(seed).tiles;
    tileCache.set(seed, t);
  }
  return t;
}

function newMatchId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Test hook: pre-seed the authoritative tile cache so tests can supply a small
 * synthetic world instead of paying the multi-second `generateWorld` cost.
 */
export function __setTilesForTest(seed: number, t: Tile[]): void {
  tileCache.set(seed, t);
}

// ---------------------------------------------------------------------------
// Create match
// ---------------------------------------------------------------------------

export async function handleCreateMatch(req: CreateMatchRequest): Promise<CreateMatchResponse> {
  if (typeof req.seed !== 'number' || !Array.isArray(req.factions) || !Array.isArray(req.units)) {
    return { success: false, error: 'seed, factions and units are required' };
  }
  if (req.factions.length === 0) {
    return { success: false, error: 'at least one faction is required' };
  }

  const tiles = getAuthoritativeTiles(req.seed);
  const cityTileIndices = new Set(tiles.filter((tile) => tile.cityId).map((tile) => tile.index));
  const unitTurn: Record<string, UnitTurnState> = {};
  for (const u of req.units) {
    unitTurn[u.id] = { mp: getMaxMovement(u.attributes), acted: false, rotated: false };
  }

  const state: MatchState = {
    matchId: newMatchId(),
    seed: req.seed,
    factions: req.factions,
    activeFactionIndex: 0,
    turn: 1,
    units: req.units,
    buildings: req.buildings ?? [],
    // The caller may supply a compact-save network, but legacy storage hubs
    // inside regenerated city footprints are removed before state is persisted.
    logistics: sanitizeCityDistributionHubs(
      req.logistics ?? createEmptyLogisticsState(),
      cityTileIndices,
    ),
    unitTurn,
    version: 0,
  };

  const created = await getSessionStore().create(state);
  console.log('[DD][match] created %s (%d units, %d factions)', created.matchId, created.units.length, created.factions.length);
  return {
    success: true,
    state: created,
    capabilities: getDevelopmentMatchCapabilities(),
  };
}

// ---------------------------------------------------------------------------
// Apply intent
// ---------------------------------------------------------------------------

export async function handleMatchIntent(req: MatchIntentRequest): Promise<MatchIntentResponse> {
  const store = getSessionStore();
  const state = await store.get(req.matchId);
  if (!state) return { success: false, error: 'Match not found' };

  if (req.expectedVersion != null && req.expectedVersion !== state.version) {
    return { success: false, conflict: true, error: 'Stale match version', version: state.version };
  }

  const activeFaction = state.factions[state.activeFactionIndex];
  const tiles = getAuthoritativeTiles(state.seed);
  state.logistics = sanitizeCityDistributionHubs(
    state.logistics,
    new Set(tiles.filter((tile) => tile.cityId).map((tile) => tile.index)),
  );
  const ctx: CombatContext = {
    units: rebuildUnits(state.units),
    tiles,
    buildings: rebuildBuildings(state.buildings),
  };

  let combats: ExplainedCombat[] | undefined;
  let reactions: ExplainedCombat[] | undefined;
  let repair: ExplainedRepair | undefined;
  let events: LogisticsEvent[] | undefined;

  const intent = req.intent;
  switch (intent.kind) {
    case 'endTurn':
      events = advanceTurn(state, tiles);
      break;
    case 'move': {
      const r = applyMoveIntent(state, ctx, tiles, activeFaction, intent);
      if (r.error) return { success: false, error: r.error };
      reactions = r.reactions;
      break;
    }
    case 'attack': {
      const r = applyAttackIntent(state, ctx, activeFaction, intent);
      if (r.error) return { success: false, error: r.error };
      combats = r.combats;
      break;
    }
    case 'attackBuilding': {
      const r = applyBuildingAttackIntent(state, ctx, activeFaction, intent);
      if (r.error) return { success: false, error: r.error };
      combats = r.combats;
      break;
    }
    case 'buildingAttackUnit': {
      const r = applyBuildingAttackUnitIntent(state, ctx, activeFaction, intent);
      if (r.error) return { success: false, error: r.error };
      combats = r.combats;
      break;
    }
    case 'repair': {
      const r = applyRepairIntent(state, ctx, activeFaction, intent);
      if (r.error) return { success: false, error: r.error };
      repair = r.repair;
      break;
    }
    case 'godModeEditUnit': {
      const r = applyGodModeEditUnit(ctx, intent);
      if (r.error) return { success: false, error: r.error };
      break;
    }
    case 'godModeDeleteUnit': {
      const r = applyGodModeDeleteUnit(state, ctx, intent);
      if (r.error) return { success: false, error: r.error };
      break;
    }
    case 'godModeEditBuilding': {
      const r = applyGodModeEditBuilding(ctx, intent);
      if (r.error) return { success: false, error: r.error };
      break;
    }
    case 'godModeDeleteBuilding': {
      const r = applyGodModeDeleteBuilding(state, ctx, intent);
      if (r.error) return { success: false, error: r.error };
      break;
    }
    default: {
      // Logistics intents mutate state.logistics in place (they don't use ctx),
      // so the ctx.units/ctx.buildings sync-back below does not touch them.
      if (isLogisticsIntent(intent)) {
        const r = applyLogisticsIntent(
          state,
          tiles,
          activeFaction,
          intent,
          getDevelopmentLogisticsPolicy(),
        );
        if (r.error) return { success: false, error: r.error };
        break;
      }
      return { success: false, error: 'Unknown intent' };
    }
  }

  // Sync authoritative entity state back from the combat context.
  state.units = ctx.units.filter((u) => u.currentHealth > 0).map(toWireUnit);
  state.buildings = ctx.buildings.map(toWireBuilding);
  // Drop turn state for any unit that died.
  for (const id of Object.keys(state.unitTurn)) {
    if (!state.units.some((u) => u.id === id)) delete state.unitTurn[id];
  }

  let saved: MatchState;
  try {
    saved = await store.update(state);
  } catch (e) {
    if (e instanceof VersionConflictError) {
      return { success: false, conflict: true, error: 'Concurrent match update — retry' };
    }
    throw e;
  }

  return {
    success: true,
    matchId: saved.matchId,
    version: saved.version,
    turn: saved.turn,
    activeFaction: saved.factions[saved.activeFactionIndex],
    units: saved.units,
    buildings: saved.buildings,
    unitTurn: saved.unitTurn,
    combats,
    reactions,
    repair,
    logistics: saved.logistics,
    capabilities: getDevelopmentMatchCapabilities(),
    events,
  };
}

// ---------------------------------------------------------------------------
// Intent appliers (mutate ctx + state.unitTurn)
// ---------------------------------------------------------------------------

function applyMoveIntent(
  state: MatchState,
  ctx: CombatContext,
  tiles: Tile[],
  activeFaction: string,
  intent: Extract<Intent, { kind: 'move' }>,
): { error?: string; reactions?: ExplainedCombat[] } {
  if (!intent.path || intent.path.length < 1) return { error: 'Move path required' };

  const mover = ctx.units.find((u) => u.id === intent.unitId);
  if (!mover) return { error: 'Moving unit not found' };
  if (mover.ownerId !== activeFaction) return { error: 'Not this faction\'s turn, or not your unit' };

  const ts = state.unitTurn[mover.id];
  if (!ts) return { error: 'No turn state for unit' };

  // Occupancy-gated (B2-B5): every other unit and every building blocks every
  // chassis. The mover's own segment is excluded so it may step away.
  const isDroneMover = isDrone(mover);
  const occupants = [
    ...ctx.units
      .filter((u) => u.id !== mover.id)
      .map((u) => ({ tileIndex: u.tileIndex, segment: u.segment })),
    ...ctx.buildings.map((b) => ({ tileIndex: b.tileIndex, segment: b.segment })),
  ];

  const finalTile = tiles[intent.path[intent.path.length - 1]];
  const finalSegment = typeof intent.segment === 'number'
    && Number.isInteger(intent.segment)
    && finalTile
    && intent.segment >= 0
    && intent.segment < finalTile.sides
    ? intent.segment
    : undefined;
  if (intent.segment !== undefined && finalSegment === undefined) {
    return { error: 'Move destination segment is invalid' };
  }
  if (intent.path.length === 1 && finalSegment === undefined) {
    return { error: 'Destination segment required for an intra-hex move' };
  }
  const r = computeMovePath(mover, intent.path, tiles, occupants, finalSegment);
  if ('error' in r) return { error: r.error };
  if (r.cost > ts.mp + 1e-9) return { error: 'Insufficient movement points for this move' };

  let reactions: ExplainedCombat[] = [];
  if (isDroneMover) {
    const results = resolveReactionFire(mover.id, intent.path, ctx);
    reactions = results.map((res) =>
      buildReactionExplanation(
        res,
        ctx.units.find((u) => u.id === res.attackerId)
          ?? ctx.buildings.find((b) => b.id === res.attackerId),
        ctx.units.find((u) => u.id === res.targetId),
      ),
    );
  }

  // Apply the resolved segment path — final position/segment, and facing
  // derived from the last inter-hex crossing actually taken.
  let lastTile = mover.tileIndex;
  for (let i = 1; i < r.segmentPath.length; i++) {
    const node = r.segmentPath[i];
    if (node.tileIndex !== lastTile) {
      const dir = tiles[lastTile].neighbours.indexOf(node.tileIndex);
      if (dir !== -1) mover.facing = dir as HexSegment;
      lastTile = node.tileIndex;
    }
  }
  const final = r.segmentPath[r.segmentPath.length - 1];
  mover.tileIndex = final.tileIndex;
  mover.segment = final.segment as HexSegment;

  ts.mp -= r.cost;
  return { reactions };
}

function applyAttackIntent(
  state: MatchState,
  ctx: CombatContext,
  activeFaction: string,
  intent: Extract<Intent, { kind: 'attack' }>,
): { error?: string; combats?: ExplainedCombat[] } {
  const attacker = ctx.units.find((u) => u.id === intent.attackerId);
  const target = ctx.units.find((u) => u.id === intent.targetId);
  if (!attacker || !target) return { error: 'Attacker or target not found' };
  if (attacker.ownerId !== activeFaction) return { error: 'Not this faction\'s turn, or not your unit' };

  const ts = state.unitTurn[attacker.id];
  if (!ts) return { error: 'No turn state for unit' };
  if (ts.acted) return { error: 'Unit has already acted this turn' };
  if (ts.mp < 1) return { error: 'Insufficient movement points to attack' };

  const explained = explainAttack(attacker, target, ctx);
  if (!explained.wasValid) return { error: explained.reasonInvalid ?? 'Invalid attack' };

  const result = resolveAttack(attacker.id, target.id, ctx);
  explained.targetHealthAfter = target.currentHealth;
  explained.targetDestroyed = target.currentHealth <= 0;
  explained.destroyedUnitIds = result.destroyedUnitIds;
  explained.splash = explainSplash(attacker, target, result, ctx);
  explained.buildingDamage = result.buildingDamage.map((ev) => ({
    buildingId: ev.buildingId,
    component: ev.component,
    newValue: ev.newValue,
    destroyed: ev.destroyed,
  }));

  ts.acted = true;
  ts.mp -= 1;
  return { combats: [explained] };
}

/**
 * Building fires offensively at an enemy unit. The building is treated as a
 * stationary "unit" with its weapon attributes, size=1, and full health.
 * Buildings can fire once per turn (tracked via a synthetic turn-state key).
 */
function applyBuildingAttackUnitIntent(
  state: MatchState,
  ctx: CombatContext,
  activeFaction: string,
  intent: Extract<Intent, { kind: 'buildingAttackUnit' }>,
): { error?: string; combats?: ExplainedCombat[] } {
  const building = ctx.buildings.find((b) => b.id === intent.buildingId);
  const target = ctx.units.find((u) => u.id === intent.targetId);
  if (!building || !target) return { error: 'Building or target not found' };
  if (building.ownerId !== activeFaction) return { error: 'Not this faction\'s building' };

  // Check building hasn't already fired this turn (use building.id as turn-state key)
  if (!state.unitTurn[building.id]) {
    state.unitTurn[building.id] = { mp: 1, acted: false, rotated: false };
  }
  const bts = state.unitTurn[building.id];
  if (bts.acted) return { error: 'Building has already fired this turn' };

  // Create a synthetic attacker unit from the building
  const attrs = building.attributes ?? {};
  const syntheticAttacker = {
    id: building.id,
    label: `Building #${building.id.replace(/^building_/, '')}`,
    ownerId: building.ownerId,
    tileIndex: building.tileIndex,
    segment: building.segment as HexSegment,
    facing: building.segment as HexSegment,
    attributes: { ...attrs, size: (attrs.size ?? 1) },
    currentHealth: ((attrs.size ?? 1) as number) * 10,
  };

  // Inject the synthetic attacker into the combat context so resolveAttack can find it
  ctx.units.push(syntheticAttacker);

  const explained = explainAttack(syntheticAttacker, target, ctx);
  if (!explained.wasValid) {
    // Remove synthetic unit
    ctx.units.pop();
    return { error: explained.reasonInvalid ?? 'Invalid building attack' };
  }

  const result = resolveAttack(syntheticAttacker.id, target.id, ctx);
  explained.targetHealthAfter = target.currentHealth;
  explained.targetDestroyed = target.currentHealth <= 0;
  explained.destroyedUnitIds = result.destroyedUnitIds;
  explained.splash = explainSplash(syntheticAttacker, target, result, ctx);
  explained.buildingDamage = result.buildingDamage.map((ev) => ({
    buildingId: ev.buildingId,
    component: ev.component,
    newValue: ev.newValue,
    destroyed: ev.destroyed,
  }));

  // Remove synthetic unit from context (it's not a real unit)
  ctx.units = ctx.units.filter((u) => u.id !== building.id);

  bts.acted = true;
  return { combats: [explained] };
}

function applyBuildingAttackIntent(
  state: MatchState,
  ctx: CombatContext,
  activeFaction: string,
  intent: Extract<Intent, { kind: 'attackBuilding' }>,
): { error?: string; combats?: ExplainedCombat[] } {
  const attacker = ctx.units.find((u) => u.id === intent.attackerId);
  if (!attacker) return { error: 'Attacker not found' };
  if (attacker.ownerId !== activeFaction) return { error: 'Not this faction\'s turn, or not your unit' };

  const ts = state.unitTurn[attacker.id];
  if (!ts) return { error: 'No turn state for unit' };
  if (ts.acted) return { error: 'Unit has already acted this turn' };
  if (ts.mp < 1) return { error: 'Insufficient movement points to attack' };

  // Reuse the stateless building-attack resolver (reads units/buildings from ctx).
  const req: CombatRequest = {
    action: 'attack',
    attackerId: intent.attackerId,
    targetBuildingId: intent.buildingId,
    weaponMode: intent.weaponMode,
    component: intent.component,
    activeFaction,
    units: [],
    tiles: [],
  };
  const result = handleBuildingAttack(req, ctx);
  if (!result.success) return { error: result.error ?? 'Invalid building attack' };

  ts.acted = true;
  ts.mp -= 1;
  return { combats: result.combats };
}

function applyRepairIntent(
  state: MatchState,
  ctx: CombatContext,
  activeFaction: string,
  intent: Extract<Intent, { kind: 'repair' }>,
): { error?: string; repair?: ExplainedRepair } {
  const repairer = ctx.units.find((u) => u.id === intent.repairerId);
  const target = ctx.units.find((u) => u.id === intent.targetId);
  if (!repairer || !target) return { error: 'Repairer or target not found' };
  if (repairer.ownerId !== activeFaction) return { error: 'Not this faction\'s turn, or not your unit' };

  const ts = state.unitTurn[repairer.id];
  if (!ts) return { error: 'No turn state for unit' };
  if (ts.acted) return { error: 'Unit has already acted this turn' };
  if (ts.mp < 1) return { error: 'Insufficient movement points to repair' };

  const validation = validateRepair(repairer, target);
  if (!validation.valid) {
    return { error: validation.reason ?? 'Invalid repair', repair: explainRepairInvalid(repairer, target, validation.reason!) };
  }

  const explained = explainRepairAction(repairer, target);
  resolveRepair(repairer.id, target.id, ctx.units);
  explained.targetHealthAfter = target.currentHealth;
  explained.repairAmount = target.currentHealth - explained.targetHealthBefore;

  ts.acted = true;
  ts.mp -= 1;
  return { repair: explained };
}

const GOD_MODE_UNIT_ATTRIBUTES: readonly (keyof UnitAttributes)[] = [
  'size',
  'kinetic',
  'armour',
  'defence',
  'splashAttack',
  'rangeAttack',
  'wheeledMovement',
  'limbMovement',
  'flightMovement',
  'repair',
  'antiAir',
  'engineer',
];

const GOD_MODE_BUILDING_ATTRIBUTES: readonly (keyof UnitAttributes)[] = [
  'kinetic',
  'armour',
  'defence',
  'splashAttack',
  'rangeAttack',
  'repair',
  'antiAir',
];

function canEditEntitiesInGodMode(): boolean {
  return getDevelopmentMatchCapabilities().entityEditing;
}

function validateGodModeAttributes(
  attributes: UnitAttributes,
  allowed: readonly (keyof UnitAttributes)[],
  requireUnitMobility: boolean,
): UnitAttributes | { error: string } {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return { error: 'Attributes must be an object.' };
  }

  const normalized: UnitAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowed.includes(key as keyof UnitAttributes)) {
      return { error: `Attribute ${key} cannot be edited in God Mode.` };
    }
    if (typeof value !== 'number'
      || !Number.isInteger(value)
      || value < 0
      || value > 5
      || (key === 'size' && value < 1)) {
      return { error: `Attribute ${key} must be an integer in its allowed range.` };
    }
    normalized[key as keyof UnitAttributes] = value;
  }

  if (requireUnitMobility) {
    if (normalized.size === undefined) {
      return { error: 'A unit edit must include size.' };
    }
    const movement = (normalized.wheeledMovement ?? 0)
      + (normalized.limbMovement ?? 0)
      + (normalized.flightMovement ?? 0);
    if (movement < 1) {
      return { error: 'A unit must retain at least one movement attribute.' };
    }
  }

  return normalized;
}

function applyGodModeEditUnit(
  ctx: CombatContext,
  intent: Extract<Intent, { kind: 'godModeEditUnit' }>,
): { error?: string } {
  if (!canEditEntitiesInGodMode()) return { error: 'God Mode entity editing is disabled.' };
  const unit = ctx.units.find((candidate) => candidate.id === intent.unitId);
  if (!unit) return { error: 'Unit not found.' };

  const attributes = validateGodModeAttributes(intent.attributes, GOD_MODE_UNIT_ATTRIBUTES, true);
  if ('error' in attributes) return attributes;
  unit.attributes = attributes;
  unit.currentHealth = attributes.size! * 10;
  return {};
}

function applyGodModeDeleteUnit(
  state: MatchState,
  ctx: CombatContext,
  intent: Extract<Intent, { kind: 'godModeDeleteUnit' }>,
): { error?: string } {
  if (!canEditEntitiesInGodMode()) return { error: 'God Mode entity editing is disabled.' };
  if (!ctx.units.some((candidate) => candidate.id === intent.unitId)) {
    return { error: 'Unit not found.' };
  }

  ctx.units = ctx.units.filter((candidate) => candidate.id !== intent.unitId);
  delete state.unitTurn[intent.unitId];
  return {};
}

function applyGodModeEditBuilding(
  ctx: CombatContext,
  intent: Extract<Intent, { kind: 'godModeEditBuilding' }>,
): { error?: string } {
  if (!canEditEntitiesInGodMode()) return { error: 'God Mode entity editing is disabled.' };
  const building = ctx.buildings.find((candidate) => candidate.id === intent.buildingId);
  if (!building) return { error: 'Building not found.' };

  const attributes = validateGodModeAttributes(intent.attributes, GOD_MODE_BUILDING_ATTRIBUTES, false);
  if ('error' in attributes) return attributes;
  building.attributes = attributes;
  return {};
}

function applyGodModeDeleteBuilding(
  state: MatchState,
  ctx: CombatContext,
  intent: Extract<Intent, { kind: 'godModeDeleteBuilding' }>,
): { error?: string } {
  if (!canEditEntitiesInGodMode()) return { error: 'God Mode entity editing is disabled.' };
  if (!ctx.buildings.some((candidate) => candidate.id === intent.buildingId)) {
    return { error: 'Building not found.' };
  }

  ctx.buildings = ctx.buildings.filter((candidate) => candidate.id !== intent.buildingId);
  delete state.unitTurn[intent.buildingId];
  return {};
}

// ---------------------------------------------------------------------------
// Turn advance
// ---------------------------------------------------------------------------

/**
 * Advance to the next faction in the turn order, resetting the incoming
 * faction's units to a fresh budget (full MP, not acted, not rotated). The turn
 * counter increments when the order wraps back to faction 0.
 *
 * Before rotating, the per-turn logistics pipeline resolves for the OUTGOING
 * (currently-active) faction — the one whose turn is ending — updating
 * `state.logistics` and returning the events it produced so the caller can
 * surface them in the intent response.
 */
function advanceTurn(state: MatchState, tiles: Tile[]): LogisticsEvent[] {
  // Resolve the ending faction's economy before turn rotation.
  const outgoingFaction = state.factions[state.activeFactionIndex];
  const resolved = resolveLogisticsTurn(state.logistics, tiles, outgoingFaction);
  state.logistics = resolved.logistics;

  state.activeFactionIndex = (state.activeFactionIndex + 1) % state.factions.length;
  if (state.activeFactionIndex === 0) state.turn += 1;

  const newActive = state.factions[state.activeFactionIndex];
  for (const u of state.units) {
    if (u.ownerId === newActive) {
      state.unitTurn[u.id] = { mp: getMaxMovement(u.attributes), acted: false, rotated: false };
    }
  }

  return resolved.events;
}
