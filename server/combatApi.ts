/**
 * Combat resolution API handler.
 *
 * Accepts a world state + action command, resolves it using src/world/,
 * and returns a detailed step-by-step explanation via server/combatExplainer.ts.
 *
 * Framework-agnostic — takes a plain object, returns one.
 */

import { Tile, ElevationType } from '../src/world/types.js';
import { Unit, HexSegment } from '../src/world/units.js';
import type { UnitAttributes } from '../shared/unitTypes.js';
import {
  isDrone,
  resolveAttack,
  resolveReactionFire,
} from '../src/world/combat.js';
import {
  validateRepair,
  resolveRepair,
} from '../src/world/repair.js';
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
interface WireUnit {
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  facing: number;
  attributes: UnitAttributes;
  currentHealth: number;
}

/** Minimal tile data needed for combat resolution. */
interface WireTile {
  idx: number;
  s: 5 | 6;
  n: number[];
  /** Terrain type (needed for defence calculation). */
  t?: string;
  /** Elevation type (needed for elevation advantage multiplier — COMBAT_RULES §13). */
  elev?: string;
  /** Whether tile has forest cover (needed for movement cost). */
  f?: boolean;
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
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleCombat(req: CombatRequest): CombatResponse<WireUnit> {
  console.log('[DD][combat] handleCombat action=%s', req.action);

  // Rebuild minimal Tile[] for pathfinding/adjacency
  const tiles = rebuildTiles(req.tiles);
  const units = rebuildUnits(req.units);

  if (req.action === 'attack') {
    return handleAttack(req, tiles, units);
  } else if (req.action === 'preview') {
    return handlePreview(req, tiles, units);
  } else if (req.action === 'move') {
    return handleMove(req, tiles, units);
  } else if (req.action === 'repair') {
    return handleRepair(req, tiles, units);
  }

  return { success: false, error: 'Unknown action', combats: [], reactions: [], updatedUnits: [] };
}

// ---------------------------------------------------------------------------
// Attack handler
// ---------------------------------------------------------------------------

function handleAttack(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
  const { attackerId, targetId, activeFaction } = req;
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
  const explained = explainAttack(attacker, target, units, tiles);

  // Actually resolve the attack (mutates units)
  const result = resolveAttack(attackerId, targetId, units, tiles);

  // Update explanation with post-combat health
  explained.targetHealthAfter = target.currentHealth;
  explained.targetDestroyed = target.currentHealth <= 0;
  explained.destroyedUnitIds = result.destroyedUnitIds;

  // Build splash explanations
  explained.splash = explainSplash(attacker, target, result, units, tiles);

  // Remove destroyed units completely so they never appear again
  const survivingUnits = units.filter((u) => u.currentHealth > 0);

  return {
    success: true,
    combats: [explained],
    reactions: [],
    updatedUnits: survivingUnits.map(toWireUnit),
  };
}

// ---------------------------------------------------------------------------
// Preview handler (explanation only, no state mutation)
// ---------------------------------------------------------------------------

function handlePreview(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
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
  const explained = explainAttack(attacker, target, units, tiles);

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

function handleMove(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
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

  // Drones trigger Anti-Air Reaction Fire along their path (§16).
  // Ground units do not trigger reaction fire.
  if (isDrone(mover)) {
    const reactionResults = resolveReactionFire(unitId, path, units, tiles);
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

function handleRepair(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
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

function rebuildTiles(wireTiles: WireTile[]): Tile[] {
  const maxIdx = wireTiles.reduce((m, t) => Math.max(m, t.idx), 0);
  const tiles: Tile[] = new Array(maxIdx + 1);

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
      terrainType: (wt.t as any) ?? 'plains',
      elevationType: (wt.elev as ElevationType) ?? 'flat',
      forested: wt.f || undefined,
    };
  }

  return tiles;
}

function rebuildUnits(wireUnits: WireUnit[]): Unit[] {
  return wireUnits.map((wu) => ({
    id: wu.id,
    label: wu.label,
    ownerId: wu.ownerId,
    tileIndex: wu.tileIndex,
    segment: wu.segment as HexSegment,
    facing: wu.facing as HexSegment,
    attributes: {
      maxHealth: wu.attributes.maxHealth,
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

function toWireUnit(u: Unit): WireUnit {
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
