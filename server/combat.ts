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
  isDrone,
  clamp,
  calculateDamage,
  calculateFormulaDamage,
  calculateSplashDamage,
  calculateModifiedAttackPower,
  calculateRangeEfficiency,
  getChassisAttackModifier,
  applyDroneIncomingDamageModifier,
  applyDamage,
  resolveAttack,
  resolveReactionFire,
  resolveAntiAirReactionFireForTile,
  calculateAntiAirReactionDamage,
  DEFENCE_SCALE,
  SPLASH_SCALE,
  TANK_ATTACK_MODIFIER,
  SPIDER_ATTACK_MODIFIER,
  DRONE_ATTACK_MODIFIER,
  DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER,
  DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER,
  DRONE_ANTI_AIR_DAMAGE_MULTIPLIER,
  RANGE_FALLOFF_PER_HEX,
  type AttackArc,
  type CombatResult,
  type WeaponMode,
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
    antiAir?: number;
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

function buildReactionExplanation(
  result: CombatResult,
  reactor: Unit | undefined,
  drone: Unit | undefined,
): ExplainedCombat {
  if (!reactor || !drone) {
    return {
      attackerId: result.attackerId,
      attackerLabel: result.attackerId,
      targetId: result.targetId,
      targetLabel: result.targetId,
      wasValid: result.wasValid,
      steps: [],
      directDamage: result.directDamage,
      targetHealthBefore: 0,
      targetHealthAfter: 0,
      targetDestroyed: result.destroyedUnitIds.includes(result.targetId),
      splash: [],
      destroyedUnitIds: result.destroyedUnitIds,
    };
  }

  const aaLevel = clamp(reactor.attributes.antiAir ?? 0, 1, 5);
  const chassisModifier = getChassisAttackModifier(reactor);
  const attackPower = Math.max(0.01, aaLevel * chassisModifier);
  const healthAfter = drone.currentHealth;
  const healthBefore = healthAfter + result.directDamage;
  const destroyed = result.destroyedUnitIds.includes(drone.id);

  const steps: ExplanationStep[] = [
    {
      title: '🚀 Anti-Air Reaction Fire',
      description: `${reactor.label} fires at drone ${drone.label} as it enters the tile. Orientation bonus is 0 (snap shot). Drone terrain defence is 0 (airborne).`,
      formula: `AntiAirReactionAttackPower = ${aaLevel} × ${chassisModifier} = ${attackPower.toFixed(2)}`,
      result: `AttackPower = ${attackPower.toFixed(2)}`,
      tone: 'neutral',
    },
    {
      title: destroyed ? '☠ Drone Destroyed' : '❤ Drone Health Update',
      description: `${drone.label}: ${healthBefore} HP → ${healthAfter} HP.`,
      formula: `${healthBefore} − ${result.directDamage} = ${healthAfter}`,
      result: destroyed ? `${drone.label} is destroyed!` : `${healthAfter} HP remaining`,
      tone: destroyed ? 'critical' : 'negative',
    },
  ];

  return {
    attackerId: reactor.id,
    attackerLabel: reactor.label,
    targetId: drone.id,
    targetLabel: drone.label,
    wasValid: true,
    steps,
    directDamage: result.directDamage,
    targetHealthBefore: healthBefore,
    targetHealthAfter: healthAfter,
    targetDestroyed: destroyed,
    splash: [],
    destroyedUnitIds: result.destroyedUnitIds,
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
  const antiAirAttack = attacker.attributes.antiAir ?? 0;
  const attackRange = Math.max(rangeAttack, meleeAttack > 0 ? 1 : 0, antiAirAttack > 0 ? 1 : 0);
  const dist = graphDistance(tiles, attacker.tileIndex, target.tileIndex);

  steps.push({
    title: '📏 Range Check',
    description: `Graph distance from ${attacker.label} to ${target.label} is ${dist} hex${dist !== 1 ? 'es' : ''}. Attacker range: ${attackRange} (rangeAttack=${rangeAttack}${meleeAttack > 0 ? ', melee=1' : ''}${antiAirAttack > 0 ? ', antiAir=1' : ''}).`,
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

  steps.push({
    title: '🧭 Orientation',
    description: `${target.label} faces direction ${target.facing}. ${attacker.label} approaches from direction ${approachDir}. Target orientation: ${arc}.`,
    result: `${formatArcShort(arc)} → orientation bonus +${orientationBonus}`,
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

  // Step 4: Evaluate all valid weapon modes
  const targetIsDrone = isDrone(target);
  const chassisModifier = getChassisAttackModifier(attacker);
  const chassisLabel = chassisModifier === DRONE_ATTACK_MODIFIER
    ? `drone (×${DRONE_ATTACK_MODIFIER})`
    : chassisModifier === SPIDER_ATTACK_MODIFIER
      ? `spider (×${SPIDER_ATTACK_MODIFIER})`
      : `tank (×${TANK_ATTACK_MODIFIER})`;
  const weaponOptions: Array<{ mode: WeaponMode; score: number; label: string }> = [];

  // Direct Fire
  if (meleeAttack > 0) {
    const baseAttack = clamp(meleeAttack, 1, 5);
    const attackPower = calculateModifiedAttackPower(attacker, baseAttack, orientationBonus, dist);
    let directDmg = calculateFormulaDamage(attackPower, effectiveDefence);
    directDmg = applyDroneIncomingDamageModifier('direct', target, directDmg);
    weaponOptions.push({
      mode: 'direct',
      score: directDmg,
      label: `Direct Fire: ${directDmg}${targetIsDrone ? ` (×${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER} drone)` : ''}`,
    });
  }

  // Splash Fire
  const splashAttack = attacker.attributes.splashAttack ?? 0;
  if (splashAttack > 0) {
    const affectedEnemies = allUnits.filter((u) => {
      if (u.ownerId === attacker.ownerId) return false;
      if (u.currentHealth <= 0) return false;
      return u.tileIndex === target.tileIndex;
    });
    let splashScore = 0;
    for (const victim of affectedEnemies) {
      splashScore += calculateSplashDamage(attacker, target, victim, allUnits, tiles, dist);
    }
    weaponOptions.push({ mode: 'splash', score: splashScore, label: `Splash Fire: ${splashScore} total (${affectedEnemies.length} unit${affectedEnemies.length !== 1 ? 's' : ''} in hex)` });
  }

  // Anti-Air Fire
  if (antiAirAttack > 0 && targetIsDrone) {
    const aaLevel = clamp(antiAirAttack, 1, 5);
    const aaAttackPower = calculateModifiedAttackPower(attacker, aaLevel, orientationBonus, dist);
    const antiAirDmg = calculateFormulaDamage(aaAttackPower, effectiveDefence);
    // Anti-Air has no drone penalty (multiplier = 1.0)
    weaponOptions.push({ mode: 'antiAir', score: antiAirDmg, label: `Anti-Air Fire: ${antiAirDmg} (no drone penalty)` });
  }

  steps.push({
    title: '⚙ Chassis Modifier',
    description: `${attacker.label} is a ${chassisLabel} chassis. Outgoing weapon power is multiplied by ${chassisModifier}.`,
    formula: `chassisModifier = ${chassisModifier}`,
    result: `×${chassisModifier}`,
    tone: chassisModifier < 1 ? 'negative' : 'neutral',
  });

  steps.push({
    title: '🎯 Weapon Selection',
    description: `Valid weapon modes evaluated: ${weaponOptions.map((o) => o.label).join('; ')}.`,
    result: weaponOptions.length > 0
      ? `Best: ${weaponOptions.reduce((a, b) => b.score > a.score ? b : a).label}`
      : 'No valid weapon modes',
    tone: 'neutral',
  });

  // Determine chosen mode (mirrors resolveAttack logic)
  const chosenOption = weaponOptions.length > 0
    ? weaponOptions.reduce((best, current) => current.score > best.score ? current : best)
    : null;

  if (!chosenOption) {
    return invalidExplanation(attacker, target, 'No valid weapon modes available');
  }

  const totalDamage = chosenOption.score;

  // Step 5: Chosen weapon detail
  if (chosenOption.mode === 'direct') {
    const baseAttack = clamp(meleeAttack, 1, 5);
    const rangeEff = calculateRangeEfficiency(dist);
    const attackPower = calculateModifiedAttackPower(attacker, baseAttack, orientationBonus, dist);
    const apSq = attackPower * attackPower;
    const edSq = effectiveDefence * effectiveDefence;
    const chassisModifier = getChassisAttackModifier(attacker);
    steps.push({
      title: '💥 Direct Fire',
      description: `rangeEfficiency = ${rangeEff.toFixed(2)} (distance ${dist}). AttackPower = (${baseAttack} × ${chassisModifier} × ${rangeEff.toFixed(2)}) + ${orientationBonus} = ${attackPower.toFixed(2)}. Damage formula applied.${targetIsDrone ? ` Drone incoming modifier ×${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER} applied.` : ''}`,
      formula: `round(1 + 29 × ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)}))${targetIsDrone ? ` × ${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER}` : ''} = ${totalDamage}`,
      result: `${totalDamage} direct damage`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  } else if (chosenOption.mode === 'splash') {
    const affectedCount = allUnits.filter((u) => u.ownerId !== attacker.ownerId && u.currentHealth > 0 && u.tileIndex === target.tileIndex).length;
    const rangeEff = calculateRangeEfficiency(dist);
    steps.push({
      title: '💣 Splash Fire',
      description: `splashAttack=${splashAttack}. rangeEfficiency = ${rangeEff.toFixed(2)} (distance ${dist}). Affects ${affectedCount} enemy unit${affectedCount !== 1 ? 's' : ''} in target hex. Each takes ${Math.round(SPLASH_SCALE * 100)}% of formula damage.`,
      formula: `Total splash score = ${totalDamage}`,
      result: `${totalDamage} total splash damage across ${affectedCount} unit${affectedCount !== 1 ? 's' : ''}`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  } else if (chosenOption.mode === 'antiAir') {
    const aaLevel = clamp(antiAirAttack, 1, 5);
    const chassisModifier = getChassisAttackModifier(attacker);
    const rangeEff = calculateRangeEfficiency(dist);
    const aaAttackPower = calculateModifiedAttackPower(attacker, aaLevel, orientationBonus, dist);
    const apSq = aaAttackPower * aaAttackPower;
    const edSq = effectiveDefence * effectiveDefence;
    steps.push({
      title: '🚀 Anti-Air Fire',
      description: `antiAir=${antiAirAttack}. rangeEfficiency = ${rangeEff.toFixed(2)} (distance ${dist}). AttackPower = (${aaLevel} × ${chassisModifier} × ${rangeEff.toFixed(2)}) + ${orientationBonus} = ${aaAttackPower.toFixed(2)}. Fires at drone target. Full damage formula, no drone penalty.`,
      formula: `round(1 + 29 × ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)})) = ${totalDamage}`,
      result: `${totalDamage} anti-air damage`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
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
    tone: destroyed ? 'critical' : (totalDamage > 0 ? 'negative' : 'neutral'),
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
  if (splashPower <= 0 || result.chosenWeaponMode !== 'splash') return [];

  const dist = graphDistance(tiles, attacker.tileIndex, primaryTarget.tileIndex);
  const rangeEff = calculateRangeEfficiency(dist);
  const explanations: SplashExplanation[] = [];

  for (const event of result.splashEvents) {
    const victim = allUnits.find((u) => u.id === event.victimId);
    if (!victim) continue;

    const defPower = getDefencePower(victim, allUnits, tiles);
    const effectiveDefence = defPower.total * DEFENCE_SCALE;
    const healthBefore = victim.currentHealth + event.damage;

    // Orientation bonus only for the primary target
    const isSelectedTarget = victim.id === primaryTarget.id;
    const approachDir = isSelectedTarget
      ? getApproachDirection(tiles, victim.tileIndex, attacker.tileIndex)
      : -1;
    const arc = isSelectedTarget ? classifyAttackArc(victim.facing, approachDir) : 'front';
    const orientationBonus = isSelectedTarget ? getFacingModifier(arc as AttackArc) : 0;
    const baseSplash = clamp(splashPower, 1, 5);
    const splashAttackPower = calculateModifiedAttackPower(attacker, baseSplash, orientationBonus, dist);
    const chassisModifier = getChassisAttackModifier(attacker);

    const apSq = splashAttackPower * splashAttackPower;
    const edSq = effectiveDefence * effectiveDefence;
    const fullDamage = calculateFormulaDamage(splashAttackPower, effectiveDefence);
    const scaledDamage = event.damage;
    const victimIsDrone = isDrone(victim);

    const steps: ExplanationStep[] = [
      {
        title: '💣 Splash Fire',
        description: `${attacker.label} uses Splash Fire (splashAttack=${splashPower}, chassis ×${chassisModifier}, rangeEfficiency=${rangeEff.toFixed(2)} at distance ${dist}). ${victim.label} is in target hex. Deals ${Math.round(SPLASH_SCALE * 100)}% of formula damage.${isSelectedTarget ? ` Orientation: ${arc} (+${orientationBonus}).` : ' Orientation: front (no bonus for non-primary).'}`,
        formula: `SplashAttackPower = (${splashPower} × ${chassisModifier} × ${rangeEff.toFixed(2)})${orientationBonus > 0 ? ` + ${orientationBonus}` : ''} = ${splashAttackPower.toFixed(2)}`,
        result: `SplashAttackPower: ${splashAttackPower.toFixed(2)}`,
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
        description: `Full formula = ${fullDamage}, × ${SPLASH_SCALE} = ${Math.round(fullDamage * SPLASH_SCALE)}${victimIsDrone ? `, × ${DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER} drone modifier` : ''} = ${scaledDamage} splash damage.`,
        formula: `max(1, round(${fullDamage} × ${SPLASH_SCALE}))${victimIsDrone ? ` × ${DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER}` : ''} = ${scaledDamage}`,
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

function formatArcShort(arc: AttackArc): string {
  switch (arc) {
    case 'front': return '🛡 Front';
    case 'side': return '→ Side';
    case 'rear': return '🎯 Rear';
    default: return '? Unknown';
  }
}
