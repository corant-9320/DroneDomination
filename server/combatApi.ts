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

import { Tile, ElevationType, TerrainType, Building } from '../src/world/types.js';
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
import type { CombatResponse } from '../shared/combatTypes.js';
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

/** Wire-format unit (matches CompactUnit + facing). */
export interface WireUnit {
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  facing: number;
  attributes: UnitAttributes;
  currentHealth: number;
}

/** Wire-format building (immobile EW/combat source on a city hex). */
export interface WireBuilding {
  id: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  attributes?: UnitAttributes;
}

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
  /** For 'move': path as tile indices. */
  path?: number[];
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
 * Compute the segment-cost of a requested move path and validate its geometry
 * (server-authority Phase 2/3). Returns `{ cost }` when the path is legal
 * (contiguous, no impassable steps), or `{ error }` otherwise. Does NOT check
 * any movement budget — callers compare `cost` against the relevant budget
 * (max MP for the stateless endpoint, remaining MP for a match session).
 */
export function computeMovePath(
  mover: Unit,
  path: number[],
  tiles: Tile[],
): { error: string } | { cost: number } {
  if (path[0] !== mover.tileIndex) {
    return { error: 'Move path does not start at the unit\'s current tile' };
  }
  const mode = getMovementMode(mover.attributes);

  let spent = 0;
  let currentSegment = mover.segment as number;

  for (let i = 1; i < path.length; i++) {
    const prevHex = path[i - 1];
    const currentHex = path[i];
    const prevTile = tiles[prevHex];
    const destTile = tiles[currentHex];
    if (!prevTile || !destTile) return { error: 'Move path references an unknown tile' };

    // Contiguity: each step must cross to an actual neighbour.
    const departureSeg = prevTile.neighbours.indexOf(currentHex);
    if (departureSeg < 0) return { error: 'Move path is not contiguous' };

    // Intra-hex pivot to the departure segment.
    const diff = Math.abs(currentSegment - departureSeg);
    const pivotSteps = Math.min(diff, 6 - diff);
    const pivotStepCost = segmentCost(prevTile, mode);
    if (!Number.isFinite(pivotStepCost)) return { error: 'Move path crosses impassable terrain' };
    spent += pivotSteps * pivotStepCost;

    // Cross the border into the destination tile.
    const crossCost = segmentCost(destTile, mode, prevTile);
    if (!Number.isFinite(crossCost)) return { error: 'Move path crosses impassable terrain' };
    spent += crossCost;

    const arrivalSeg = destTile.neighbours.indexOf(prevHex);
    currentSegment = arrivalSeg >= 0 ? arrivalSeg : 0;
  }

  return { cost: spent };
}

/**
 * Server-side legality check for a requested move path (server-authority
 * Phase 2). Validates everything derivable from the world snapshot + the
 * unit's attributes, so a client can no longer fabricate teleports, paths
 * through impassable terrain, or moves longer than the unit's movement budget.
 *
 * NOTE: this enforces a SINGLE action's cost against the unit's *maximum*
 * movement. Cumulative per-turn MP and "already acted this turn" enforcement
 * needs server-held turn state and is handled by the match-session path
 * (server/matchApi.ts).
 *
 * Returns null when the path is legal, or a human-readable reason when not.
 */
export function validateMovePath(mover: Unit, path: number[], tiles: Tile[]): string | null {
  const r = computeMovePath(mover, path, tiles);
  if ('error' in r) return r.error;
  // Small epsilon for floating-point segment-cost accumulation.
  if (r.cost > getMaxMovement(mover.attributes) + 1e-9) {
    return 'Move exceeds the unit\'s movement budget';
  }
  return null;
}

function handleMove(req: CombatRequest, ctx: CombatContext): CombatResponse<WireUnit> {
  const { units, tiles } = ctx;
  const { unitId, path, activeFaction } = req;
  if (!unitId || !path || path.length < 2) {
    return { success: false, error: 'unitId and path (2+ tiles) required', combats: [], reactions: [], updatedUnits: [] };
  }

  const mover = units.find((u) => u.id === unitId);
  if (!mover) {
    return { success: false, error: 'Moving unit not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Turn-based enforcement: only the active faction may move
  if (mover.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn to move', combats: [], reactions: [], updatedUnits: [] };
  }

  // Legality enforcement (Phase 2): reject teleports / impassable / overlong paths.
  const moveError = validateMovePath(mover, path, tiles);
  if (moveError) {
    return { success: false, error: moveError, combats: [], reactions: [], updatedUnits: [] };
  }

  // Drones trigger Anti-Air Reaction Fire along their path (§16).
  // Ground units do not trigger reaction fire.
  if (isDrone(mover)) {
    const reactionResults = resolveReactionFire(unitId, path, ctx);
    const reactionExplained = reactionResults.map((r) => {
      const reactor = units.find((u) => u.id === r.attackerId);
      const drone = units.find((u) => u.id === r.targetId);
      return buildReactionExplanation(r, reactor, drone);
    });

    // If drone was destroyed, remove it and return
    const survivingUnits = units.filter((u) => u.currentHealth > 0);
    return {
      success: true,
      combats: [],
      reactions: reactionExplained,
      updatedUnits: survivingUnits.map(toWireUnit),
    };
  }

  // Ground unit: walk the path — update position and facing, no reaction fire.
  for (let i = 1; i < path.length; i++) {
    const prevHex = path[i - 1];
    const currentHex = path[i];

    mover.tileIndex = currentHex;
    const dir = tiles[prevHex].neighbours.indexOf(currentHex);
    if (dir !== -1) {
      mover.facing = dir as HexSegment;
    }
  }

  return {
    success: true,
    combats: [],
    reactions: [],
    updatedUnits: units.map(toWireUnit),
  };
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
      elevationType: (wt.elev as ElevationType) ?? 'flat',
      height: wt.h,
      forested: wt.f || undefined,
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
    segment: b.segment,
    attributes: b.attributes,
  };
}
