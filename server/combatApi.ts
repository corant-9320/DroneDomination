/**
 * Combat resolution API handler.
 *
 * Accepts a world state + action command, resolves it using src/world/,
 * and returns a detailed step-by-step explanation via server/combatExplainer.ts.
 *
 * Framework-agnostic — takes a plain object, returns one.
 *
 * ── Responsibilities ─────────────────────────────────────────────────────────
 * - Deserialize WireUnit[] + WireTile[] from the HTTP request into server types
 * - Dispatch to handleAttack / handlePreview / handleMove / handleRepair
 * - Re-serialize the updated units back to WireUnit[] for the response
 *
 * ── Wire format ───────────────────────────────────────────────────────────────
 * WireUnit / WireTile are imported from shared/wireTypes.ts. The wire format
 * deliberately uses short field names (pos, n, s, terrain …) to keep JSON
 * compact for the client. The rebuildTiles / rebuildUnits helpers here convert
 * back to authoritative server types (position3d, neighbours, terrainType …).
 *
 * ── What this does NOT handle ─────────────────────────────────────────────────
 * - Reaction fire triggered by AI moves (handled client-side in aiTurn.ts)
 * - Turn/MP management (owned by client TurnManager)
 * - Combat explanation text (combatExplainer.ts)
 */

import { Tile, TerrainType, Building } from '../src/world/types.js';
import { Unit, HexSegment } from '../src/world/units.js';
import type { UnitAttributes } from '../shared/unitTypes.js';
import {
  isDrone,
  resolveAttack,
  resolveReactionFire,
  resolveBuildingDirectFire,
  resolveSplashHex,
  type CombatContext,
  type BuildingComponent,
  type BuildingDamageEvent,
  type WeaponMode,
} from '../src/world/combat.js';
import {
  validateRepair,
  resolveRepair,
} from '../src/world/repair.js';
import { getMovementMode, getMaxMovement, segmentCost } from '../shared/movementConstants.js';
import { realizeTilePathOverSegments, buildSegmentOccupancy, type SegNode } from '../shared/segmentGraph.js';
import type { CombatResponse } from '../shared/combatTypes.js';
import type { WireUnit, WireBuilding } from '../shared/wireTypes.js';
import {
  explainAttack,
  explainSplash,
  buildReactionExplanation,
  explainRepairAction,
  explainRepairInvalid,
} from './combatExplainer.js';

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

/**
 * Wire-format unit/building (matches CompactUnit + facing). Re-exported here
 * for backward-compatible imports (`./combatApi.js`); the authoritative
 * definition lives in `shared/wireTypes.ts`.
 */
export type { WireUnit, WireBuilding };

/** Minimal tile data needed for combat resolution. */
export interface WireTile {
  idx: number;
  s: 5 | 6;
  n: number[];
  /** Terrain type (needed for defence calculation). */
  t?: string;
  /** Elevation type (needed for elevation advantage multiplier — COMBAT_RULES §13). */
  elev?: string;
  /** Whether tile has forest cover (needed for movement cost). */
  f?: boolean;
  /** Discrete terrain height 0–11 (needed for movement steepness validation). Omitted when 0. */
  h?: number;
  /** 3D position on unit sphere [x, y, z] (needed for bearing-based orientation). */
  pos?: [number, number, number];
  /** Boundary polygon vertices [[x,y,z], ...] (needed for segment-distance range check). */
  b?: [number, number, number][];
  /** Per-segment steepness in radians (needed for steepness-gate movement validation). */
  ss?: number[];
}

export interface CombatRequest {
  /** The attack to resolve. */
  action: 'attack' | 'move' | 'preview' | 'repair';
  /** For 'attack'/'preview': attacker unit ID. */
  attackerId?: string;
  /** For 'attack'/'preview': target unit ID. */
  targetId?: string;
  /**
   * For 'attack'/'preview' against a building (building-damage feature): the
   * target building's ID. Mutually exclusive with targeting a unit. When set,
   * the attack degrades the building's components instead of dealing HP damage.
   */
  targetBuildingId?: string;
  /**
   * For Direct_Fire against a building: which component the attacking player
   * chose to degrade. Required for Direct_Fire when the building has at least
   * one eligible component (Requirement 4). Ignored for Splash_Fire.
   */
  component?: BuildingComponent;
  /**
   * Optional explicit weapon mode for a building attack ('direct' | 'splash').
   * When omitted, the server auto-selects, defaulting to Splash_Fire when both
   * are available (Requirement 2.6). 'antiAir' against a building is rejected.
   */
  weaponMode?: WeaponMode;
  /** For 'repair': repairer unit ID. */
  repairerId?: string;
  /** For 'repair': target unit ID to heal. */
  repairTargetId?: string;
  /** For 'move': unit ID that is moving. */
  unitId?: string;
  /** For 'move': path as tile indices (one tile for an intra-hex move). */
  path?: number[];
  /** For 'move': requested destination segment. Required for an intra-hex move. */
  segment?: number;
  /** The faction (ownerId) whose turn it currently is. Only this faction may attack. */
  activeFaction: string;
  /** All units currently on the board. */
  units: WireUnit[];
  /** Tile adjacency data (only idx, sides, neighbours needed). */
  tiles: WireTile[];
  /** Buildings on the board — EW-bearing buildings project anti-drone screens. */
  buildings?: WireBuilding[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleCombat(req: CombatRequest): CombatResponse<WireUnit> {
  console.log('[DD][combat] handleCombat action=%s', req.action);

  // Rebuild the combat context (units, tiles, buildings) once for all handlers.
  const ctx: CombatContext = {
    units: rebuildUnits(req.units),
    tiles: rebuildTiles(req.tiles),
    buildings: rebuildBuildings(req.buildings ?? []),
  };

  if (req.action === 'attack') {
    return handleAttack(req, ctx);
  } else if (req.action === 'preview') {
    return handlePreview(req, ctx);
  } else if (req.action === 'move') {
    return handleMove(req, ctx);
  } else if (req.action === 'repair') {
    return handleRepair(req, ctx);
  }

  return { success: false, error: 'Unknown action', combats: [], reactions: [], updatedUnits: [] };
}

// ---------------------------------------------------------------------------
// Building attack handler (building-damage feature)
// ---------------------------------------------------------------------------

/**
 * Resolve an attack declared against an enemy building. Direct_Fire degrades
 * the single attacker-chosen component; Splash_Fire degrades one random
 * component of every enemy building in the hex (and applies HP splash to enemy
 * units there). Anti_Air_Fire against a building is rejected.
 */
export function handleBuildingAttack(req: CombatRequest, ctx: CombatContext): CombatResponse<WireUnit> {
  const { units, buildings } = ctx;
  const { attackerId, targetBuildingId, activeFaction, component } = req;
  if (!attackerId || !targetBuildingId) {
    return { success: false, error: 'attackerId and targetBuildingId required', combats: [], reactions: [], updatedUnits: [] };
  }

  const attacker = units.find((u) => u.id === attackerId);
  const building = buildings.find((b) => b.id === targetBuildingId);
  if (!attacker || !building) {
    return { success: false, error: 'Attacker or target building not found', combats: [], reactions: [], updatedUnits: [] };
  }
  if (attacker.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn to attack', combats: [], reactions: [], updatedUnits: [] };
  }
  if (attacker.ownerId === building.ownerId) {
    return { success: false, error: 'Cannot attack a friendly building', combats: [], reactions: [], updatedUnits: [] };
  }

  // Weapon-mode selection. Anti-Air can never target a building (Requirement 2.5).
  const hasDirect = (attacker.attributes.kinetic ?? 0) > 0;
  const hasSplash = (attacker.attributes.splashAttack ?? 0) > 0;
  let mode = req.weaponMode;
  if (mode === 'antiAir') {
    return { success: false, error: 'Buildings cannot be targeted by Anti-Air Fire', combats: [], reactions: [], updatedUnits: [] };
  }
  if (!mode) {
    // Auto-select: default to Splash_Fire when both are available (Req 2.6).
    mode = hasSplash ? 'splash' : hasDirect ? 'direct' : undefined;
  }
  if (!mode) {
    return { success: false, error: 'Attacker has no building-damaging weapon', combats: [], reactions: [], updatedUnits: [] };
  }

  const result = mode === 'splash'
    ? resolveSplashHex(attackerId, building.tileIndex, ctx)
    : resolveBuildingDirectFire(attackerId, building, component, ctx);

  if (!result.wasValid) {
    return {
      success: true,
      combats: [buildBuildingCombat(req, ctx, result, false)],
      reactions: [],
      updatedUnits: units.filter((u) => u.currentHealth > 0).map(toWireUnit),
      updatedBuildings: buildings.map(toWireBuilding),
    };
  }

  return {
    success: true,
    combats: [buildBuildingCombat(req, ctx, result, true)],
    reactions: [],
    updatedUnits: units.filter((u) => u.currentHealth > 0).map(toWireUnit),
    updatedBuildings: buildings.map(toWireBuilding),
  };
}

/** Build an ExplainedCombat for a building attack result. */
function buildBuildingCombat(
  req: CombatRequest,
  ctx: CombatContext,
  result: ReturnType<typeof resolveBuildingDirectFire>,
  valid: boolean,
): import('../shared/combatTypes.js').ExplainedCombat {
  const attacker = ctx.units.find((u) => u.id === result.attackerId);
  const building = ctx.buildings.find((b) => b.id === req.targetBuildingId);
  const buildingDamage = result.buildingDamage.map(toBuildingReport);
  const steps = valid
    ? buildBuildingSteps(result)
    : [{ title: '❌ Invalid Attack', description: result.reasonInvalid ?? 'Invalid', result: 'Attack cannot proceed', tone: 'negative' as const }];

  // Translate any HP splash on co-located enemy units into splash explanations
  // (Splash_Fire on a building's hex also damages enemy units — decision O1).
  const splash: import('../shared/combatTypes.js').SplashExplanation[] = result.splashEvents.map((ev) => {
    const victim = ctx.units.find((u) => u.id === ev.victimId);
    const healthAfter = victim ? victim.currentHealth : 0;
    const healthBefore = healthAfter + ev.damage;
    const label = victim?.label ?? ev.victimId;
    return {
      victimId: ev.victimId,
      victimLabel: label,
      steps: [{
        title: '💣 Splash Fire',
        description: `${label} caught in the splash for ${ev.damage} damage.`,
        result: ev.victimDestroyed ? `${label} destroyed!` : `${healthAfter} HP remaining`,
        tone: ev.victimDestroyed ? 'critical' : 'negative',
      }],
      damage: ev.damage,
      victimDestroyed: ev.victimDestroyed,
      victimHealthBefore: healthBefore,
      victimHealthAfter: healthAfter,
    };
  });

  return {
    attackerId: result.attackerId,
    attackerLabel: attacker?.label ?? result.attackerId,
    targetId: req.targetBuildingId ?? result.targetId,
    targetLabel: building ? `Building ${building.id}` : result.targetId,
    wasValid: valid,
    reasonInvalid: valid ? undefined : result.reasonInvalid,
    steps,
    directDamage: 0,
    targetHealthBefore: 0,
    targetHealthAfter: 0,
    targetDestroyed: false,
    splash,
    destroyedUnitIds: result.destroyedUnitIds,
    buildingDamage,
  };
}

function buildBuildingSteps(result: ReturnType<typeof resolveBuildingDirectFire>): import('../shared/combatTypes.js').ExplanationStep[] {
  if (result.buildingDamage.length === 0) {
    return [{
      title: '🏛 No Component Damage',
      description: 'The targeted building has no component left to degrade.',
      result: 'No damage applied',
      tone: 'neutral',
    }];
  }
  return result.buildingDamage.map((ev) => ({
    title: ev.destroyed ? '🏚 Component Destroyed' : '🏛 Component Damaged',
    description: `${ev.component} reduced to ${ev.newValue}.`,
    result: ev.destroyed ? `${ev.component} disabled` : `${ev.component} → ${ev.newValue}`,
    tone: ev.destroyed ? 'critical' : 'negative',
  }));
}

function toBuildingReport(ev: BuildingDamageEvent): import('../shared/combatTypes.js').BuildingDamageReport {
  return { buildingId: ev.buildingId, component: ev.component, newValue: ev.newValue, destroyed: ev.destroyed };
}

// ---------------------------------------------------------------------------
// Attack handler
// ---------------------------------------------------------------------------

function handleAttack(req: CombatRequest, ctx: CombatContext): CombatResponse<WireUnit> {
  const { units } = ctx;
  const { attackerId, targetId, activeFaction } = req;

  // Building target → dedicated handler (building-damage feature).
  if (req.targetBuildingId) {
    return handleBuildingAttack(req, ctx);
  }

  if (!attackerId || !targetId) {
    return { success: false, error: 'attackerId and targetId required', combats: [], reactions: [], updatedUnits: [] };
  }

  const attacker = units.find((u) => u.id === attackerId);
  const target = units.find((u) => u.id === targetId);
  if (!attacker || !target) {
    return { success: false, error: 'Attacker or target not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Turn-based enforcement: only the active faction may attack
  if (attacker.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn to attack', combats: [], reactions: [], updatedUnits: [] };
  }

  // Build explanation BEFORE resolving (so we capture "before" state)
  const explained = explainAttack(attacker, target, ctx);

  // Actually resolve the attack (mutates units)
  const result = resolveAttack(attackerId, targetId, ctx);

  // Update explanation with post-combat health
  explained.targetHealthAfter = target.currentHealth;
  explained.targetDestroyed = target.currentHealth <= 0;
  explained.destroyedUnitIds = result.destroyedUnitIds;

  // Build splash explanations
  explained.splash = explainSplash(attacker, target, result, ctx);

  // Surface any building component damage caused by Splash_Fire that landed in
  // the same hex (building-damage feature, Resolved decision O1).
  explained.buildingDamage = result.buildingDamage.map((ev) => ({
    buildingId: ev.buildingId,
    component: ev.component,
    newValue: ev.newValue,
    destroyed: ev.destroyed,
  }));

  // Remove destroyed units completely so they never appear again
  const survivingUnits = units.filter((u) => u.currentHealth > 0);

  return {
    success: true,
    combats: [explained],
    reactions: [],
    updatedUnits: survivingUnits.map(toWireUnit),
    updatedBuildings: result.buildingDamage.length > 0 ? ctx.buildings.map(toWireBuilding) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Preview handler (explanation only, no state mutation)
// ---------------------------------------------------------------------------

function handlePreview(req: CombatRequest, ctx: CombatContext): CombatResponse<WireUnit> {
  const { units } = ctx;
  const { attackerId, targetId } = req;
  if (!attackerId || !targetId) {
    return { success: false, error: 'attackerId and targetId required', combats: [], reactions: [], updatedUnits: [] };
  }

  const attacker = units.find((u) => u.id === attackerId);
  const target = units.find((u) => u.id === targetId);
  if (!attacker || !target) {
    return { success: false, error: 'Attacker or target not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Build explanation WITHOUT resolving (read-only)
  const explained = explainAttack(attacker, target, ctx);

  return {
    success: true,
    combats: [explained],
    reactions: [],
    updatedUnits: [], // no mutation for preview
  };
}

// ---------------------------------------------------------------------------
// Move handler (with Anti-Air reaction fire for drones, §16)
// ---------------------------------------------------------------------------

/**
 * Compute the occupancy-gated segment-step cost of a requested move path
 * (server-authority Phase 2/3, reworked for Segment-Based Movement). Returns
 * `{ cost, segmentPath }` when the path is legal — contiguous, every step
 * lands on an empty segment with finite terrain cost — or `{ error }`
 * otherwise. Does NOT check any movement budget — callers compare `cost`
 * against the relevant budget (max MP for the stateless endpoint, remaining
 * MP for a match session).
 *
 * `occupants` are every OTHER unit/building segment on the board (the mover's
 * own current segment must already be excluded by the caller, since a unit
 * must be allowed to step off its own segment).
 */
/**
 * Build the occupant list a mover's segment path must avoid: every other
 * living unit and every building. A segment must be empty for every chassis,
 * including flight-capable units (Requirements B2/B5).
 */
function movementOccupants(
  units: ReadonlyArray<{ id: string; tileIndex: number; segment: number }>,
  buildings: ReadonlyArray<{ tileIndex: number; segment: number }>,
  moverId: string,
): { tileIndex: number; segment: number }[] {
  return [
    ...units
      .filter((u) => u.id !== moverId)
      .map((u) => ({ tileIndex: u.tileIndex, segment: u.segment })),
    ...buildings.map((b) => ({ tileIndex: b.tileIndex, segment: b.segment })),
  ];
}

export function computeMovePath(
  mover: Unit,
  path: number[],
  tiles: Tile[],
  occupants: ReadonlyArray<{ tileIndex: number; segment: number }> = [],
  finalSegment?: number,
): { error: string } | { cost: number; segmentPath: SegNode[] } {
  if (path.length === 0) {
    return { error: 'Move path is required' };
  }
  if (path[0] !== mover.tileIndex) {
    return { error: 'Move path does not start at the unit\'s current tile' };
  }
  for (let i = 1; i < path.length; i++) {
    const prevTile = tiles[path[i - 1]];
    if (!prevTile) return { error: 'Move path references an unknown tile' };
    if (prevTile.neighbours.indexOf(path[i]) < 0) return { error: 'Move path is not contiguous' };
  }
  const finalTile = tiles[path[path.length - 1]];
  if (!finalTile) return { error: 'Move path references an unknown tile' };
  if (finalSegment !== undefined && (
    !Number.isInteger(finalSegment) || finalSegment < 0 || finalSegment >= finalTile.sides
  )) {
    return { error: 'Move destination segment is invalid' };
  }
  if (path.length === 1 && finalSegment === undefined) {
    return { error: 'Destination segment required for an intra-hex move' };
  }

  const mode = getMovementMode(mover.attributes);
  const isOccupied = buildSegmentOccupancy(occupants);
  const r = realizeTilePathOverSegments(
    tiles,
    { tileIndex: mover.tileIndex, segment: mover.segment },
    path,
    (tile, segment) => segmentCost(tile, segment, mode),
    isOccupied,
    finalSegment,
  );
  if (!r) return { error: 'Move path crosses impassable or occupied terrain' };
  return { cost: r.cost, segmentPath: r.path };
}

/**
 * Server-side legality check for a requested move path (server-authority
 * Phase 2). Validates everything derivable from the world snapshot + the
 * unit's attributes, so a client can no longer fabricate teleports, paths
 * through impassable/occupied terrain, or moves longer than the unit's
 * movement budget.
 *
 * NOTE: this enforces a SINGLE action's cost against the unit's *maximum*
 * movement. Cumulative per-turn MP and "already acted this turn" enforcement
 * needs server-held turn state and is handled by the match-session path
 * (server/matchApi.ts).
 *
 * Returns null when the path is legal, or a human-readable reason when not.
 */
export function validateMovePath(
  mover: Unit,
  path: number[],
  tiles: Tile[],
  occupants: ReadonlyArray<{ tileIndex: number; segment: number }> = [],
): string | null {
  const r = computeMovePath(mover, path, tiles, occupants);
  if ('error' in r) return r.error;
  // Small epsilon for floating-point segment-cost accumulation.
  if (r.cost > getMaxMovement(mover.attributes) + 1e-9) {
    return 'Move exceeds the unit\'s movement budget';
  }
  return null;
}

function handleMove(req: CombatRequest, ctx: CombatContext): CombatResponse<WireUnit> {
  const { units, tiles } = ctx;
  const { unitId, path, segment, activeFaction } = req;
  if (!unitId || !path || path.length < 1) {
    return { success: false, error: 'unitId and path required', combats: [], reactions: [], updatedUnits: [] };
  }

  const mover = units.find((u) => u.id === unitId);
  if (!mover) {
    return { success: false, error: 'Moving unit not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Turn-based enforcement: only the active faction may move
  if (mover.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn to move', combats: [], reactions: [], updatedUnits: [] };
  }

  // Legality enforcement (Phase 2/B2-B4): reject teleports, impassable or
  // occupied segments, and overlong paths. The mover's own segment is omitted.
  const isDroneMover = isDrone(mover);
  const occupants = movementOccupants(units, ctx.buildings, mover.id);

  const moveResult = computeMovePath(mover, path, tiles, occupants, segment);
  if ('error' in moveResult) {
    return { success: false, error: moveResult.error, combats: [], reactions: [], updatedUnits: [] };
  }
  if (moveResult.cost > getMaxMovement(mover.attributes) + 1e-9) {
    return { success: false, error: 'Move exceeds the unit\'s movement budget', combats: [], reactions: [], updatedUnits: [] };
  }

  // Drones trigger Anti-Air Reaction Fire along their path (§16).
  // Ground units do not trigger reaction fire.
  if (isDroneMover) {
    const reactionResults = resolveReactionFire(unitId, path, ctx);
    const reactionExplained = reactionResults.map((r) => {
      const reactor = units.find((u) => u.id === r.attackerId)
        ?? ctx.buildings.find((b) => b.id === r.attackerId);
      const drone = units.find((u) => u.id === r.targetId);
      return buildReactionExplanation(r, reactor, drone);
    });

    applySegmentPath(mover, moveResult.segmentPath, tiles);

    // If drone was destroyed, remove it and return
    const survivingUnits = units.filter((u) => u.currentHealth > 0);
    return {
      success: true,
      combats: [],
      reactions: reactionExplained,
      updatedUnits: survivingUnits.map(toWireUnit),
    };
  }

  // Ground unit: walk the resolved segment path — updates position, segment,
  // and facing to match the occupancy-gated route actually taken.
  applySegmentPath(mover, moveResult.segmentPath, tiles);

  return {
    success: true,
    combats: [],
    reactions: [],
    updatedUnits: units.map(toWireUnit),
  };
}

/**
 * Apply a resolved segment path to a unit: sets its final tileIndex/segment
 * and derives facing from the last inter-hex crossing (matching the previous
 * tile-path-walking behaviour). No-op beyond position/segment/facing.
 */
function applySegmentPath(mover: Unit, segmentPath: SegNode[], tiles: Tile[]): void {
  if (segmentPath.length === 0) return;
  let lastTile = mover.tileIndex;
  for (let i = 1; i < segmentPath.length; i++) {
    const node = segmentPath[i];
    if (node.tileIndex !== lastTile) {
      const dir = tiles[lastTile].neighbours.indexOf(node.tileIndex);
      if (dir !== -1) mover.facing = dir as HexSegment;
      lastTile = node.tileIndex;
    }
  }
  const final = segmentPath[segmentPath.length - 1];
  mover.tileIndex = final.tileIndex;
  mover.segment = final.segment as HexSegment;
}

// ---------------------------------------------------------------------------
// Repair handler
// ---------------------------------------------------------------------------

function handleRepair(req: CombatRequest, ctx: CombatContext): CombatResponse<WireUnit> {
  const { units } = ctx;
  const { repairerId, repairTargetId, activeFaction } = req;
  if (!repairerId || !repairTargetId) {
    return { success: false, error: 'repairerId and repairTargetId required', combats: [], reactions: [], updatedUnits: [] };
  }

  const repairer = units.find((u) => u.id === repairerId);
  const target = units.find((u) => u.id === repairTargetId);
  if (!repairer || !target) {
    return { success: false, error: 'Repairer or target not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Turn-based enforcement: only the active faction may repair
  if (repairer.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn', combats: [], reactions: [], updatedUnits: [] };
  }

  // Validate and resolve
  const validation = validateRepair(repairer, target);
  if (!validation.valid) {
    const explained = explainRepairInvalid(repairer, target, validation.reason!);
    return { success: true, combats: [], reactions: [], updatedUnits: units.map(toWireUnit), repair: explained };
  }

  // Build explanation before resolving
  const explained = explainRepairAction(repairer, target);

  // Resolve (mutates target health)
  resolveRepair(repairerId, repairTargetId, units);

  // Update explanation with post-repair health
  explained.targetHealthAfter = target.currentHealth;
  explained.repairAmount = target.currentHealth - explained.targetHealthBefore;

  return {
    success: true,
    combats: [],
    reactions: [],
    updatedUnits: units.map(toWireUnit),
    repair: explained,
  };
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

export function rebuildTiles(wireTiles: WireTile[]): Tile[] {
  const maxIdx = wireTiles.reduce((m, t) => Math.max(m, t.idx), 0);
  const tiles: Tile[] = new Array<Tile>(maxIdx + 1);

  for (const wt of wireTiles) {
    const pos = wt.pos
      ? { x: wt.pos[0], y: wt.pos[1], z: wt.pos[2] }
      : { x: 0, y: 0, z: 0 };
    const boundary = wt.b
      ? wt.b.map((v) => ({ x: v[0], y: v[1], z: v[2] }))
      : [];
    tiles[wt.idx] = {
      id: `t${wt.idx}`,
      index: wt.idx,
      sides: wt.s,
      neighbours: wt.n,
      position3d: pos,
      boundary,
      terrainType: (wt.t as TerrainType) ?? 'plains',
      height: wt.h ?? 0,
      forested: wt.f ?? false,
      segSteep: wt.ss,
    };
  }

  return tiles;
}

export function rebuildUnits(wireUnits: WireUnit[]): Unit[] {
  return wireUnits.map((wu) => ({
    id: wu.id,
    label: wu.label,
    ownerId: wu.ownerId,
    tileIndex: wu.tileIndex,
    segment: wu.segment as HexSegment,
    facing: wu.facing as HexSegment,
    attributes: {
      size: wu.attributes.size,
      kinetic: wu.attributes.kinetic,
      armour: wu.attributes.armour,
      defence: wu.attributes.defence,
      splashAttack: wu.attributes.splashAttack,
      rangeAttack: wu.attributes.rangeAttack,
      wheeledMovement: wu.attributes.wheeledMovement,
      limbMovement: wu.attributes.limbMovement,
      flightMovement: wu.attributes.flightMovement,
      repair: wu.attributes.repair,
      antiAir: wu.attributes.antiAir,
    },
    currentHealth: wu.currentHealth,
  }));
}

export function rebuildBuildings(wireBuildings: WireBuilding[]): Building[] {
  return wireBuildings.map((wb) => ({
    id: wb.id,
    ownerId: wb.ownerId,
    tileIndex: wb.tileIndex,
    segment: wb.segment,
    attributes: wb.attributes,
  }));
}

export function toWireUnit(u: Unit): WireUnit {
  return {
    id: u.id,
    label: u.label,
    ownerId: u.ownerId,
    tileIndex: u.tileIndex,
    segment: u.segment,
    facing: u.facing,
    attributes: u.attributes,
    currentHealth: u.currentHealth,
  };
}

export function toWireBuilding(b: Building): WireBuilding {
  return {
    id: b.id,
    ownerId: b.ownerId,
    tileIndex: b.tileIndex,
    segment: b.segment as HexSegment,
    attributes: b.attributes,
  };
}
