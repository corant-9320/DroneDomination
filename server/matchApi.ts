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
import { resolveLogisticsTurn } from '../src/world/logistics.js';
import { createEmptyLogisticsState } from '../src/world/logisticsSeed.js';
import { applyLogisticsIntent, isLogisticsIntent } from './logisticsApi.js';
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
    // Adopt the caller-supplied network (e.g. the compact save's seeded Oil
    // Logistics System example for DEFAULT_SEED) so the server is the single
    // authoritative source; non-default seeds omit it and start empty.
    logistics: req.logistics ?? createEmptyLogisticsState(),
    unitTurn,
    version: 0,
  };

  const created = await getSessionStore().create(state);
  // Warm the authoritative tile cache now (regenerating from seed is ~seconds)
  // so the first gameplay intent isn't stalled by world generation.
  getAuthoritativeTiles(created.seed);
  console.log('[DD][match] created %s (%d units, %d factions)', created.matchId, created.units.length, created.factions.length);
  return { success: true, state: created };
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
    default: {
      // Logistics intents mutate state.logistics in place (they don't use ctx),
      // so the ctx.units/ctx.buildings sync-back below does not touch them.
      if (isLogisticsIntent(intent)) {
        const r = applyLogisticsIntent(state, tiles, activeFaction, intent);
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
  if (!intent.path || intent.path.length < 2) return { error: 'Move path (2+ tiles) required' };

  const mover = ctx.units.find((u) => u.id === intent.unitId);
  if (!mover) return { error: 'Moving unit not found' };
  if (mover.ownerId !== activeFaction) return { error: 'Not this faction\'s turn, or not your unit' };

  const ts = state.unitTurn[mover.id];
  if (!ts) return { error: 'No turn state for unit' };

  // Occupancy-gated (B2-B4): every other unit's segment blocks the path;
  // buildings additionally block ground chassis (drones fly over them).
  const isDroneMover = isDrone(mover);
  const occupants = ctx.units
    .filter((u) => u.id !== mover.id)
    .map((u) => ({ tileIndex: u.tileIndex, segment: u.segment }));
  if (!isDroneMover) {
    occupants.push(...ctx.buildings.map((b) => ({ tileIndex: b.tileIndex, segment: b.segment })));
  }

  const finalSegment = typeof intent.segment === 'number' && intent.segment >= 0 && intent.segment <= 5
    ? intent.segment
    : undefined;
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
