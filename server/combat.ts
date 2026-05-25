/**
 * Combat resolution API handler.
 *
 * Accepts a world state + attack command, resolves the combat using
 * src/world/combat.ts, and returns a detailed step-by-step explanation
 * of every mechanic that contributed to the final result.
 *
 * Framework-agnostic — takes a plain object, returns one.
 */

import { Tile } from '../src/world/types.js';
import { Unit, HexSegment } from '../src/world/units.js';
import { graphDistance } from '../src/world/pathfinding.js';
import {
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  getOrientationBonus,
  getAdjacentFriendlySupport,
  getEWDefense,
  getTerrainDefense,
  getDefencePower,
  isEncircled,
  clamp,
  calculateDamage,
  applyDamage,
  calculateSplashDamage,
  calculateSplashBonusOnTarget,
  resolveAttack,
  DEFENCE_SCALE,
  SPLASH_SCALE,
  type AttackArc,
  type CombatResult,
} from '../src/world/combat.js';
import {
  calculateRepairAmount,
  applyRepair,
  validateRepair,
  resolveRepair,
} from '../src/world/repair.js';
import type {
  ExplanationStep,
  SplashExplanation,
  ExplainedCombat,
  ExplainedRepair,
  CombatResponse,
} from '../shared/combatTypes.js';

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
  attributes: {
    maxHealth?: number;
    attack?: number;
    armour?: number;
    defence?: number;
    splashAttack?: number;
    rangeAttack?: number;
    wheeledMovement?: number;
    limbMovement?: number;
    flightMovement?: number;
    repair?: number;
  };
  currentHealth: number;
}

/** Minimal tile data needed for combat resolution. */
interface WireTile {
  idx: number;
  s: 5 | 6;
  n: number[];
  /** Terrain type (needed for defence calculation). */
  t?: string;
  /** Whether tile has forest cover (needed for movement cost). */
  f?: boolean;
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
// Move handler (with reaction fire)
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

  // Walk the path — update position and facing.
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

function explainRepairAction(repairer: Unit, target: Unit): ExplainedRepair {
  const rp = repairer.attributes.repair ?? 0;
  const maxHealth = (target.attributes.maxHealth ?? 1) * 10; // HP_PER_POINT = 10
  const repairRate = 2 + (clamp(maxHealth, 10, 50) - 10) / 20;
  const repairAmount = Math.floor(clamp(rp, 1, 5) * repairRate + 0.5);

  const steps: ExplanationStep[] = [
    {
      title: '🔧 Repair Capability',
      description: `${repairer.label} has Repair ${rp}. Target ${target.label} has MaxHealth ${maxHealth}.`,
      result: `RP = ${rp}`,
      tone: 'neutral',
    },
    {
      title: '⚙ Repair Rate',
      description: `RepairRate = 2 + (${maxHealth} − 10) / 20 = ${repairRate.toFixed(2)} HP per RP.`,
      formula: `2 + (${maxHealth} − 10) / 20 = ${repairRate.toFixed(2)}`,
      result: `${repairRate.toFixed(2)} HP/RP`,
      tone: 'neutral',
    },
    {
      title: '💚 Repair Amount',
      description: `RepairAmount = round(${rp} × ${repairRate.toFixed(2)}) = ${repairAmount}.`,
      formula: `round(${rp} × ${repairRate.toFixed(2)}) = ${repairAmount}`,
      result: `+${repairAmount} HP`,
      tone: 'positive',
    },
    {
      title: '❤ Health Update',
      description: `${target.label}: ${target.currentHealth} → min(${maxHealth}, ${target.currentHealth} + ${repairAmount}) HP.`,
      formula: `min(${maxHealth}, ${target.currentHealth} + ${repairAmount})`,
      result: `${Math.min(maxHealth, target.currentHealth + repairAmount)} HP`,
      tone: 'positive',
    },
  ];

  return {
    repairerId: repairer.id,
    repairerLabel: repairer.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: true,
    steps,
    repairAmount,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: target.currentHealth, // updated after resolve
  };
}

function explainRepairInvalid(repairer: Unit, target: Unit, reason: string): ExplainedRepair {
  return {
    repairerId: repairer.id,
    repairerLabel: repairer.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: false,
    reasonInvalid: reason,
    steps: [{
      title: '❌ Invalid Repair',
      description: reason,
      result: 'Repair cannot proceed',
      tone: 'negative',
    }],
    repairAmount: 0,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: target.currentHealth,
  };
}

// ---------------------------------------------------------------------------
// Explanation builder
// ---------------------------------------------------------------------------

function explainAttack(
  attacker: Unit,
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): ExplainedCombat {
  const steps: ExplanationStep[] = [];

  // Validation
  if (attacker.currentHealth <= 0) {
    return invalidExplanation(attacker, target, 'Attacker is destroyed');
  }
  if (target.currentHealth <= 0) {
    return invalidExplanation(attacker, target, 'Target is already destroyed');
  }
  if (attacker.ownerId === target.ownerId) {
    return invalidExplanation(attacker, target, 'Cannot attack a friendly unit');
  }

  // Step 1: Range
  const rangeAttack = attacker.attributes.rangeAttack ?? 0;
  const meleeAttack = attacker.attributes.attack ?? 0;
  const attackRange = Math.max(rangeAttack, meleeAttack > 0 ? 1 : 0);
  const dist = graphDistance(tiles, attacker.tileIndex, target.tileIndex);

  steps.push({
    title: '📏 Range Check',
    description: `Graph distance from ${attacker.label} to ${target.label} is ${dist} hex${dist !== 1 ? 'es' : ''}. Attacker range: ${attackRange} (rangeAttack=${rangeAttack}${meleeAttack > 0 ? ', melee=1' : ''}).`,
    formula: `distance(${dist}) ≤ range(${attackRange})`,
    result: dist <= attackRange ? `✓ In range` : `✗ Out of range`,
    tone: dist <= attackRange ? 'positive' : 'negative',
  });

  if (dist < 0 || dist > attackRange) {
    return {
      attackerId: attacker.id,
      attackerLabel: attacker.label,
      targetId: target.id,
      targetLabel: target.label,
      wasValid: false,
      reasonInvalid: 'Out of range',
      steps,
      directDamage: 0,
      targetHealthBefore: target.currentHealth,
      targetHealthAfter: target.currentHealth,
      targetDestroyed: false,
      splash: [],
      destroyedUnitIds: [],
    };
  }

  // Step 2: Orientation
  const approachDir = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const arc = classifyAttackArc(target.facing, approachDir);
  const orientationBonus = getFacingModifier(arc);
  const attack = clamp(attacker.attributes.attack ?? 0, 1, 5);
  const attackPower = attack + orientationBonus;

  steps.push({
    title: '🧭 Orientation',
    description: `${target.label} faces direction ${target.facing}. ${attacker.label} approaches from direction ${approachDir}. Target orientation: ${arc}.`,
    formula: `AttackPower = attack(${attack}) + orientationBonus(${orientationBonus}) = ${attackPower}`,
    result: `${formatArcShort(arc)} → AttackPower ${attackPower}`,
    tone: orientationBonus > 0 ? 'positive' : 'neutral',
  });

  // Step 3: Defence breakdown
  const defPower = getDefencePower(target, allUnits, tiles);
  const effectiveDefence = defPower.total * DEFENCE_SCALE;

  steps.push({
    title: '🛡 Defence Power',
    description: `Armour(${defPower.armour}) + EW(${defPower.ew}) + Formation(${defPower.defensiveFormation}) + Terrain(${defPower.terrain}) = ${defPower.total}. EffectiveDefence = ${defPower.total} × ${DEFENCE_SCALE} = ${effectiveDefence.toFixed(2)}.`,
    formula: `DefencePower = ${defPower.armour} + ${defPower.ew} + ${defPower.defensiveFormation} + ${defPower.terrain} = ${defPower.total}`,
    result: `EffectiveDefence = ${effectiveDefence.toFixed(2)}`,
    tone: defPower.total > 0 ? 'negative' : 'neutral',
  });

  // Step 4: Damage calculation
  const damage = calculateDamage(
    attack,
    arc === 'unknown' ? 'front' : arc,
    defPower.armour,
    defPower.ew,
    defPower.defensiveFormation,
    defPower.terrain,
  );

  const apSq = attackPower * attackPower;
  const edSq = effectiveDefence * effectiveDefence;

  steps.push({
    title: '💥 Damage Formula',
    description: `Damage = round(1 + 29 × AP² / (AP² + ED²))`,
    formula: `round(1 + 29 × ${apSq} / (${apSq} + ${edSq.toFixed(2)})) = ${damage}`,
    result: `${damage} direct damage`,
    tone: damage >= 15 ? 'critical' : damage >= 5 ? 'positive' : 'neutral',
  });

  // Step 5: Splash bonus on primary target
  const splashAttack = attacker.attributes.splashAttack ?? 0;
  const splashBonus = splashAttack > 0
    ? calculateSplashBonusOnTarget(attacker, target, allUnits, tiles, arc === 'unknown' ? 'front' : arc)
    : 0;
  const totalDamage = damage + splashBonus;

  if (splashBonus > 0) {
    steps.push({
      title: '💣 Splash Bonus',
      description: `Splash attack ${splashAttack} adds ${Math.round(SPLASH_SCALE * 100)}% bonus damage to primary target.`,
      formula: `${damage} + ${splashBonus} = ${totalDamage} total`,
      result: `+${splashBonus} splash bonus (${totalDamage} total)`,
      tone: 'positive',
    });
  }

  // Step 6: Health outcome
  const healthAfter = Math.max(0, target.currentHealth - totalDamage);
  const destroyed = healthAfter <= 0;

  steps.push({
    title: destroyed ? '☠ Target Destroyed' : '❤ Health Update',
    description: `${target.label}: ${target.currentHealth} HP → ${healthAfter} HP.`,
    formula: `${target.currentHealth} − ${totalDamage} = ${healthAfter}`,
    result: destroyed ? `${target.label} is destroyed!` : `${healthAfter} HP remaining`,
    tone: destroyed ? 'critical' : (damage > 0 ? 'negative' : 'neutral'),
  });

  return {
    attackerId: attacker.id,
    attackerLabel: attacker.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: true,
    steps,
    directDamage: totalDamage,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: healthAfter,
    targetDestroyed: destroyed,
    splash: [],
    destroyedUnitIds: [],
  };
}

function explainSplash(
  attacker: Unit,
  primaryTarget: Unit,
  result: CombatResult,
  allUnits: Unit[],
  tiles: Tile[],
): SplashExplanation[] {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0 || result.splashEvents.length === 0) return [];

  const explanations: SplashExplanation[] = [];

  for (const event of result.splashEvents) {
    const victim = allUnits.find((u) => u.id === event.victimId);
    if (!victim) continue;

    const defPower = getDefencePower(victim, allUnits, tiles);
    const effectiveDefence = defPower.total * DEFENCE_SCALE;
    const healthBefore = victim.currentHealth + event.damage;

    const apSq = splashPower * splashPower;
    const edSq = effectiveDefence * effectiveDefence;

    const fullDamage = Math.round(1 + 29 * apSq / (apSq + edSq));
    const scaledDamage = event.damage;

    const steps: ExplanationStep[] = [
      {
        title: '💥 Splash Source',
        description: `${attacker.label} has splash attack ${splashPower}. ${victim.label} is adjacent to primary target ${primaryTarget.label}. Splash deals ${Math.round(SPLASH_SCALE * 100)}% of formula damage.`,
        result: `Splash AttackPower: ${splashPower}`,
        tone: 'neutral',
      },
      {
        title: '🛡 Victim Defence',
        description: `Armour(${defPower.armour}) + EW(${defPower.ew}) + Formation(${defPower.defensiveFormation}) + Terrain(${defPower.terrain}) = ${defPower.total}. EffectiveDefence = ${effectiveDefence.toFixed(2)}.`,
        formula: `DefencePower = ${defPower.total}, ED = ${effectiveDefence.toFixed(2)}`,
        result: `EffectiveDefence = ${effectiveDefence.toFixed(2)}`,
        tone: defPower.total > 0 ? 'negative' : 'neutral',
      },
      {
        title: '💥 Splash Result',
        description: `Full formula = ${fullDamage}, × ${SPLASH_SCALE} = ${scaledDamage} splash damage.`,
        formula: `round(${fullDamage} × ${SPLASH_SCALE}) = ${scaledDamage}`,
        result: event.victimDestroyed
          ? `${scaledDamage} damage — ${victim.label} destroyed!`
          : `${scaledDamage} damage to ${victim.label}`,
        tone: event.damage > 0 ? 'critical' : 'neutral',
      },
    ];

    explanations.push({
      victimId: victim.id,
      victimLabel: victim.label,
      steps,
      damage: event.damage,
      victimDestroyed: event.victimDestroyed,
      victimHealthBefore: healthBefore,
      victimHealthAfter: victim.currentHealth,
    });
  }

  return explanations;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalidExplanation(attacker: Unit, target: Unit, reason: string): ExplainedCombat {
  return {
    attackerId: attacker.id,
    attackerLabel: attacker.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: false,
    reasonInvalid: reason,
    steps: [{
      title: '❌ Invalid Attack',
      description: reason,
      result: 'Attack cannot proceed',
      tone: 'negative',
    }],
    directDamage: 0,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: target.currentHealth,
    targetDestroyed: false,
    splash: [],
    destroyedUnitIds: [],
  };
}

function rebuildTiles(wireTiles: WireTile[]): Tile[] {
  const maxIdx = wireTiles.reduce((m, t) => Math.max(m, t.idx), 0);
  const tiles: Tile[] = new Array(maxIdx + 1);

  for (const wt of wireTiles) {
    tiles[wt.idx] = {
      id: `t${wt.idx}`,
      index: wt.idx,
      sides: wt.s,
      neighbours: wt.n,
      position3d: { x: 0, y: 0, z: 0 },
      boundary: [],
      terrainType: (wt.t as any) ?? 'plains',
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
      attack: wu.attributes.attack,
      armour: wu.attributes.armour,
      defence: wu.attributes.defence,
      splashAttack: wu.attributes.splashAttack,
      rangeAttack: wu.attributes.rangeAttack,
      wheeledMovement: wu.attributes.wheeledMovement,
      limbMovement: wu.attributes.limbMovement,
      flightMovement: wu.attributes.flightMovement,
      repair: wu.attributes.repair,
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

function formatArcShort(arc: AttackArc): string {
  switch (arc) {
    case 'front': return '🛡 Front';
    case 'side': return '→ Side';
    case 'rear': return '🎯 Rear';
    default: return '? Unknown';
  }
}
