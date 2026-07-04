/**
 * Step-by-step explanation builders for combat and repair actions.
 *
 * Pure functions — no HTTP handling, no state mutation.
 * Imported by server/combatApi.ts to attach explanations to API responses.
 */

import { Unit } from '../src/world/units.js';
import { effectiveCombatDistance } from '../src/world/segmentGeometry.js';
import { elevationRangeMultiplier } from '../shared/rangeCheck.js';
import {
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  calculateOrientationArmourPenalty,
  classifyArcFromAngle,
  getAngularDifference,
  getDefencePower,
  isDrone,
  clamp,
  getChassisType,
  getChassisAttackModifier,
  getSegmentRangeThreshold,
  evaluateWeaponOptions,
  chooseWeaponOption,
  computeDamage,
  SPLASH_SCALE,
  SEGMENT_RANGE_PER_POINT,
  SEGMENT_RANGE_BASE,
  TANK_ATTACK_MODIFIER,
  SPIDER_ATTACK_MODIFIER,
  DRONE_ATTACK_MODIFIER,
  DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER,
  DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER,
  DRONE_ANTI_AIR_DAMAGE_MULTIPLIER,
  type AttackArc,
  type CombatResult,
  type CombatContext,
  type WeaponMode,
  type WeaponOption,
  type DamageBreakdown,
  type DamageInput,
} from '../src/world/combat.js';
import { calculateRepairAmount } from '../src/world/repair.js';
import { HP_PER_POINT } from '../src/world/units.js';
import type {
  ExplanationStep,
  SplashExplanation,
  ExplainedCombat,
  ExplainedRepair,
  CombatBreakdown,
} from '../shared/combatTypes.js';

// ---------------------------------------------------------------------------
// Private helpers
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

function formatArcShort(arc: AttackArc): string {
  switch (arc) {
    case 'front': return '🛡 Front';
    case 'side': return '→ Flank';
    case 'rear': return '🎯 Rear';
    case 'unknown': return '? Unknown';
    default: return '? Unknown';
  }
}

/**
 * Format arc with more granularity based on the angular difference.
 * 0-40° = Front, 40-80° = Front Flank, 80-100° = Flank,
 * 100-140° = Rear Flank, 140-180° = Rear
 */
function formatArcDetailed(angleDiffDeg: number): string {
  if (angleDiffDeg <= 40) return '🛡 Front';
  if (angleDiffDeg <= 80) return '🛡→ Front Flank';
  if (angleDiffDeg <= 100) return '→ Flank';
  if (angleDiffDeg <= 140) return '→🎯 Rear Flank';
  return '🎯 Rear';
}

// ---------------------------------------------------------------------------
// Item 2: Mapper — DamageBreakdown → CombatBreakdown
// ---------------------------------------------------------------------------

/**
 * Map a DamageBreakdown (from computeDamage) plus context into a CombatBreakdown
 * wire object for the client preview table.
 */
function damageBreakdownToCombatBreakdown(
  bd: DamageBreakdown,
  opts: {
    inRange: boolean;
    distance: number;
    attackRange: number;
    weaponMode: CombatBreakdown['weaponMode'];
    baseWeapon: number;
    orientationArmourPenalty: number;
    orientationLabel: string;
    defPower: ReturnType<typeof getDefencePower>;
    elevationMultiplier: number;
    droneEvasion: number;
    totalDamage: number;
    weaponSelectionLabel: string;
  },
): CombatBreakdown {
  const chassisLabel: CombatBreakdown['chassisLabel'] =
    bd.chassisModifier === DRONE_ATTACK_MODIFIER ? 'Drone'
    : bd.chassisModifier === SPIDER_ATTACK_MODIFIER ? 'Spider'
    : 'Tank';

  return {
    inRange: opts.inRange,
    distance: opts.distance,
    attackRange: Math.round(opts.attackRange * 100) / 100,
    weaponMode: opts.weaponMode,
    baseWeapon: opts.baseWeapon,
    chassisLabel,
    chassisModifier: bd.chassisModifier,
    rangeEfficiency: Math.round(bd.rangeEfficiency * 100) / 100,
    orientationArmourPenalty: opts.orientationArmourPenalty,
    orientationLabel: opts.orientationLabel,
    attackTotal: Math.round(bd.attackPower * 100) / 100,
    defArmour: opts.defPower.armour,
    defEW: opts.defPower.ew,
    defEWRaw: opts.defPower.ewRaw,
    defEWMultiplier: opts.defPower.ewMultiplier,
    defTerrain: opts.defPower.terrain,
    elevationMultiplier: Math.round(opts.elevationMultiplier * 100) / 100,
    droneEvasion: opts.droneEvasion,
    defTotal: Math.round(bd.effectiveDefence * 100) / 100,
    netDamage: opts.inRange ? opts.totalDamage : 0,
    weaponSelectionLabel: opts.weaponSelectionLabel,
  };
}

// ---------------------------------------------------------------------------
// buildBreakdown — now delegates to computeDamage + mapper
// ---------------------------------------------------------------------------

/**
 * Build a structured CombatBreakdown for the preview table.
 * Called after all attack values are computed — both in-range and out-of-range.
 */
function buildBreakdown(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
  segDist: number,
  rangeThreshold: number,
  rangeAttack: number,
  meleeAttack: number,
  antiAirAttack: number,
  orientationArmourPenalty: number,
  defPower: ReturnType<typeof getDefencePower>,
  chosenMode: WeaponMode | 'none',
  totalDamage: number,
): CombatBreakdown {
  const { tiles } = ctx;
  // Elevation now extends/reduces RANGE (not damage). Higher ground shoots farther.
  const elevMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].height ?? 0,
    tiles[target.tileIndex].height ?? 0,
    isDrone(attacker) || isDrone(target),
  );
  const effectiveThreshold = rangeThreshold * elevMult;
  const inRange = segDist <= effectiveThreshold;
  const targetIsDrone = isDrone(target);

  // Orientation label from angular difference
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment);
  const angleDiffDeg = isNaN(angleDiff) ? 0 : Math.round((angleDiff * 180) / Math.PI);
  const orientationLabel = formatArcDetailed(angleDiffDeg);

  // Weapon selection label
  const weaponLabels: Record<string, string> = { direct: 'Direct Fire', splash: 'Splash Fire', antiAir: 'Anti-Air Fire', none: '—' };
  const weaponSelectionLabel = chosenMode !== 'none'
    ? `${weaponLabels[chosenMode]}: ${totalDamage}${targetIsDrone && chosenMode === 'direct' ? ' (×0.33 drone)' : ''}${targetIsDrone && chosenMode === 'splash' ? ' (×0.50 drone)' : ''}`
    : '—';

  // Base weapon value depends on chosen mode
  let baseWeapon = 0;
  let weaponMode: CombatBreakdown['weaponMode'] = 'none';
  if (chosenMode === 'direct') { baseWeapon = clamp(meleeAttack, 1, 5); weaponMode = 'kinetic'; }
  else if (chosenMode === 'splash') { baseWeapon = clamp(attacker.attributes.splashAttack ?? 0, 1, 5); weaponMode = 'splash'; }
  else if (chosenMode === 'antiAir') { baseWeapon = clamp(antiAirAttack, 1, 5); weaponMode = 'antiAir'; }
  else if (meleeAttack > 0) { baseWeapon = clamp(meleeAttack, 1, 5); weaponMode = 'kinetic'; }
  else if ((attacker.attributes.splashAttack ?? 0) > 0) { baseWeapon = clamp(attacker.attributes.splashAttack!, 1, 5); weaponMode = 'splash'; }
  else if (antiAirAttack > 0) { baseWeapon = clamp(antiAirAttack, 1, 5); weaponMode = 'antiAir'; }

  // Call computeDamage once — single source of truth for all numeric values
  const bd = computeDamage({
    mode: chosenMode === 'none' ? 'direct' : chosenMode,
    attackerChassis: getChassisType(attacker),
    baseWeaponValue: baseWeapon,
    orientationArmourPenalty,
    distance: segDist,
    armour: defPower.armour,
    defenceOther: defPower.ew + defPower.terrain,
    targetIsDrone,
  });

  // Drone evasion: difference between raw and final damage when target is a drone
  let droneEvasion = 0;
  if (targetIsDrone && chosenMode !== 'antiAir' && chosenMode !== 'none') {
    droneEvasion = Math.max(0, bd.rawFormulaDamage - totalDamage);
  }

  return damageBreakdownToCombatBreakdown(bd, {
    inRange,
    distance: segDist,
    attackRange: effectiveThreshold,
    weaponMode,
    baseWeapon,
    orientationArmourPenalty,
    orientationLabel,
    defPower,
    elevationMultiplier: elevMult,
    droneEvasion,
    totalDamage,
    weaponSelectionLabel,
  });
}


// ---------------------------------------------------------------------------
// Attack explanation
// ---------------------------------------------------------------------------

export function explainAttack(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
): ExplainedCombat {
  const { units: allUnits, tiles } = ctx;
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

  // Step 1: Range (segment-based gate)
  const rangeAttack = attacker.attributes.rangeAttack ?? 0;
  const meleeAttack = attacker.attributes.kinetic ?? 0;
  const antiAirAttack = attacker.attributes.antiAir ?? 0;
  const baseRangeThreshold = getSegmentRangeThreshold(attacker);
  const segDist = effectiveCombatDistance(tiles, attacker, target);
  // Elevation extends/reduces range (higher ground shoots farther). No effect for drones.
  const rangeElevMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].height ?? 0,
    tiles[target.tileIndex].height ?? 0,
    isDrone(attacker) || isDrone(target),
  );
  const rangeThreshold = baseRangeThreshold * rangeElevMult;
  const elevPct = Math.round((rangeElevMult - 1) * 100);
  const elevNote = rangeElevMult !== 1
    ? ` Elevation ${elevPct > 0 ? '+' : ''}${elevPct}% range (h${tiles[attacker.tileIndex].height ?? 0} vs h${tiles[target.tileIndex].height ?? 0}) → ${rangeThreshold.toFixed(2)}.`
    : '';

  steps.push({
    title: '📏 Range Check',
    description: `Segment distance from ${attacker.label} to ${target.label} is ${segDist.toFixed(2)} hex-units. Base range threshold: ${baseRangeThreshold.toFixed(2)} (rangeAttack=${rangeAttack} × ${SEGMENT_RANGE_PER_POINT} + ${SEGMENT_RANGE_BASE}).${elevNote}`,
    formula: `segDist(${segDist.toFixed(2)}) ≤ threshold(${rangeThreshold.toFixed(2)})`,
    result: segDist <= rangeThreshold ? `✓ In range` : `✗ Out of range`,
    tone: segDist <= rangeThreshold ? 'positive' : 'negative',
  });

  const outOfRange = segDist > rangeThreshold;

  // Step 2: Orientation (bearing-based continuous armour penalty)
  const orientationArmourPenalty = calculateOrientationArmourPenalty(tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment);
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment);
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  const angleDiffDeg = isNaN(angleDiff) ? 0 : Math.round((angleDiff * 180) / Math.PI);

  steps.push({
    title: '🧭 Orientation',
    description: `${target.label} facing direction ${target.facing}. Bearing from target to ${attacker.label} differs by ${angleDiffDeg}°. Target orientation: ${arc}.`,
    result: `${formatArcDetailed(angleDiffDeg)} → armour penalty −${orientationArmourPenalty.toFixed(1)}`,
    tone: orientationArmourPenalty > 0.3 ? 'positive' : 'neutral',
  });

  // Step 3: Defence breakdown. EW is now a radius-based anti-drone screen —
  // it only applies when the ATTACKER is a drone (independent of weapon mode).
  // Orientation degrades the armour component before scaling.
  const attackerIsDrone = isDrone(attacker);
  const defPower = getDefencePower(target, ctx, attackerIsDrone);
  const effectiveArmour = Math.max(0, defPower.armour - orientationArmourPenalty);

  // Call computeDamage once for step 3's effectiveDefence display
  // (we'll call it again per-weapon in buildBreakdown, but this gives us the defence value for narration)
  const defInput: DamageInput = {
    mode: 'direct',
    attackerChassis: getChassisType(attacker),
    baseWeaponValue: clamp(meleeAttack || (attacker.attributes.splashAttack ?? 0) || antiAirAttack, 1, 5),
    orientationArmourPenalty,
    distance: segDist,
    armour: defPower.armour,
    defenceOther: defPower.ew + defPower.terrain,
    targetIsDrone: isDrone(target),
  };
  const defBd = computeDamage(defInput);
  const effectiveDefence = defBd.effectiveDefence;

  steps.push({
    title: '🛡 Defence Power',
    description: `Armour(${defPower.armour}) − orientation(${orientationArmourPenalty.toFixed(1)}) = ${effectiveArmour.toFixed(1)}. + EW(${defPower.ewRaw.toFixed(2)} radius screen, ${attackerIsDrone ? 'applies vs drone attacker' : '0 vs ground attacker'}) + Terrain(${defPower.terrain}).`,
    formula: `EffectiveDefence = (${effectiveArmour.toFixed(1)} + ${defPower.ew.toFixed(2)} + ${defPower.terrain}) × ${0.75} = ${effectiveDefence.toFixed(2)}`,
    result: `EffectiveDefence = ${effectiveDefence.toFixed(2)}`,
    tone: effectiveDefence > 0 ? 'negative' : 'neutral',
  });

  // Step 4: Evaluate all valid weapon modes (using shared function)
  const targetIsDrone = isDrone(target);
  const chassisModifier = getChassisAttackModifier(attacker);
  const chassisLabel = chassisModifier === DRONE_ATTACK_MODIFIER
    ? `drone (×${DRONE_ATTACK_MODIFIER})`
    : chassisModifier === SPIDER_ATTACK_MODIFIER
      ? `spider (×${SPIDER_ATTACK_MODIFIER})`
      : `tank (×${TANK_ATTACK_MODIFIER})`;

  // Single source of truth: same function used by resolveAttack
  // Use segment-aware distance for range efficiency (same as resolveAttack)
  const weaponOptions: WeaponOption[] = evaluateWeaponOptions(attacker, target, ctx, segDist, orientationArmourPenalty);

  // Build display labels for each evaluated option (formatting only)
  const weaponLabelsForDisplay: Array<{ mode: WeaponMode; score: number; label: string }> = weaponOptions.map((opt) => {
    if (opt.mode === 'direct') {
      return { mode: opt.mode, score: opt.score, label: `Direct Fire: ${opt.score}${targetIsDrone ? ` (×${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER} drone)` : ''}` };
    } else if (opt.mode === 'splash') {
      const affectedCount = opt.damages.length;
      return { mode: opt.mode, score: opt.score, label: `Splash Fire: ${opt.score} total (${affectedCount} unit${affectedCount !== 1 ? 's' : ''} in hex)` };
    } else {
      return { mode: opt.mode, score: opt.score, label: `Anti-Air Fire: ${opt.score} (no drone penalty)` };
    }
  });

  steps.push({
    title: '⚙ Chassis Modifier',
    description: `${attacker.label} is a ${chassisLabel} chassis. Outgoing weapon power is multiplied by ${chassisModifier}.`,
    formula: `chassisModifier = ${chassisModifier}`,
    result: `×${chassisModifier}`,
    tone: chassisModifier < 1 ? 'negative' : 'neutral',
  });

  steps.push({
    title: '🎯 Weapon Selection',
    description: `Valid weapon modes evaluated: ${weaponLabelsForDisplay.map((o) => o.label).join('; ')}.`,
    result: weaponOptions.length > 0
      ? `Best: ${weaponLabelsForDisplay.reduce((a, b) => b.score > a.score ? b : a).label}`
      : 'No valid weapon modes',
    tone: 'neutral',
  });

  // Determine chosen mode (same tie-break logic as resolveAttack)
  const chosenOption = weaponOptions.length > 0
    ? chooseWeaponOption(weaponOptions, target)
    : null;

  if (!chosenOption) {
    return invalidExplanation(attacker, target, 'No valid weapon modes available');
  }

  const totalDamage = chosenOption.score;

  // Step 5: Chosen weapon detail — format from DamageBreakdown (Item 1)
  if (chosenOption.mode === 'direct') {
    const baseAttack = clamp(meleeAttack, 1, 5);
    const bd = computeDamage({
      mode: 'direct',
      attackerChassis: getChassisType(attacker),
      baseWeaponValue: baseAttack,
      orientationArmourPenalty,
      distance: segDist,
      armour: defPower.armour,
      defenceOther: defPower.ew + defPower.terrain,
      targetIsDrone,
    });
    const apSq = bd.attackPower * bd.attackPower;
    const edSq = bd.effectiveDefence * bd.effectiveDefence;
    steps.push({
      title: '💥 Kinetic Fire',
      description: `rangeEfficiency = ${bd.rangeEfficiency.toFixed(2)} (segDist ${segDist.toFixed(2)}). AttackPower = ${baseAttack} × ${bd.chassisModifier} × ${bd.rangeEfficiency.toFixed(2)} = ${bd.attackPower.toFixed(2)}. Orientation strips ${orientationArmourPenalty.toFixed(1)} armour → ED = ${bd.effectiveDefence.toFixed(2)}.${targetIsDrone ? ` Drone incoming modifier ×${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER} applied.` : ''}`,
      formula: `round(1 + 49 × ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)}))${targetIsDrone ? ` × ${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER}` : ''} = ${totalDamage}`,
      result: `${totalDamage} direct damage`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  } else if (chosenOption.mode === 'splash') {
    const affectedCount = allUnits.filter((u) => u.ownerId !== attacker.ownerId && u.currentHealth > 0 && u.tileIndex === target.tileIndex).length;
    const splashAttack = attacker.attributes.splashAttack ?? 0;
    const baseSplash = clamp(splashAttack, 1, 5);
    const bd = computeDamage({
      mode: 'splash',
      attackerChassis: getChassisType(attacker),
      baseWeaponValue: baseSplash,
      orientationArmourPenalty,
      distance: segDist,
      armour: defPower.armour,
      defenceOther: defPower.ew + defPower.terrain,
      targetIsDrone,
    });
    steps.push({
      title: '💣 Splash Fire',
      description: `splashAttack=${splashAttack}. rangeEfficiency = ${bd.rangeEfficiency.toFixed(2)} (segDist ${segDist.toFixed(2)}). AttackPower = ${baseSplash} × ${bd.chassisModifier} × ${bd.rangeEfficiency.toFixed(2)} = ${bd.attackPower.toFixed(2)}. Orientation strips ${orientationArmourPenalty.toFixed(1)} armour (primary only) → ED = ${bd.effectiveDefence.toFixed(2)}. Affects ${affectedCount} enemy unit${affectedCount !== 1 ? 's' : ''} in target hex. Each takes ${Math.round(SPLASH_SCALE * 100)}% of formula damage.`,
      formula: `Total splash score = ${totalDamage}`,
      result: `${totalDamage} total splash damage across ${affectedCount} unit${affectedCount !== 1 ? 's' : ''}`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  } else if (chosenOption.mode === 'antiAir') {
    const aaLevel = clamp(antiAirAttack, 1, 5);
    const bd = computeDamage({
      mode: 'antiAir',
      attackerChassis: getChassisType(attacker),
      baseWeaponValue: aaLevel,
      orientationArmourPenalty,
      distance: segDist,
      armour: defPower.armour,
      defenceOther: defPower.ew + defPower.terrain,
      targetIsDrone: true,
    });
    const apSq = bd.attackPower * bd.attackPower;
    const edSq = bd.effectiveDefence * bd.effectiveDefence;
    steps.push({
      title: '🚀 Anti-Air Fire',
      description: `antiAir=${antiAirAttack}. rangeEfficiency = ${bd.rangeEfficiency.toFixed(2)} (segDist ${segDist.toFixed(2)}). AttackPower = ${aaLevel} × ${bd.chassisModifier} × ${bd.rangeEfficiency.toFixed(2)} = ${bd.attackPower.toFixed(2)}. Orientation strips ${orientationArmourPenalty.toFixed(1)} armour → ED = ${bd.effectiveDefence.toFixed(2)}. Fires at drone target. Full damage formula, no drone penalty.`,
      formula: `round(1 + 49 × ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)})) = ${totalDamage}`,
      result: `${totalDamage} anti-air damage`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  }

  // (Elevation now affects range, shown in the Range Check step above — not damage.)

  // Step 7: Health outcome
  // For splash, totalDamage is the aggregate score across all victims.
  // The primary target only takes its individual share from chosenOption.damages.
  const primaryTargetDamage = chosenOption.mode === 'splash'
    ? (chosenOption.damages.find((d) => d.unitId === target.id)?.damage ?? 0)
    : totalDamage;
  const maxHp = (target.attributes.size ?? 1) * HP_PER_POINT;
  const healthAfter = Math.max(0, target.currentHealth - primaryTargetDamage);
  const destroyed = healthAfter <= 0;

  steps.push({
    title: destroyed ? '☠ Target Destroyed' : '❤ Health Update',
    description: `${target.label}: ${target.currentHealth}/${maxHp} HP → ${healthAfter}/${maxHp} HP.`,
    formula: `${target.currentHealth} − ${primaryTargetDamage} = ${healthAfter}`,
    result: destroyed ? `${target.label} is destroyed!` : `${healthAfter}/${maxHp} HP remaining`,
    tone: destroyed ? 'critical' : (primaryTargetDamage > 0 ? 'negative' : 'neutral'),
  });

  return {
    attackerId: attacker.id,
    attackerLabel: attacker.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: !outOfRange,
    reasonInvalid: outOfRange ? 'Out of range' : undefined,
    steps,
    directDamage: outOfRange ? 0 : totalDamage,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: outOfRange ? target.currentHealth : healthAfter,
    targetDestroyed: outOfRange ? false : destroyed,    splash: [],
    destroyedUnitIds: [],
    breakdown: buildBreakdown(
      attacker, target, ctx,
      segDist, baseRangeThreshold,
      rangeAttack, meleeAttack, antiAirAttack,
      orientationArmourPenalty,
      defPower,
      chosenOption.mode,
      outOfRange ? 0 : totalDamage,
    ),
  };
}


// ---------------------------------------------------------------------------
// Splash explanation
// ---------------------------------------------------------------------------

export function explainSplash(
  attacker: Unit,
  primaryTarget: Unit,
  result: CombatResult,
  ctx: CombatContext,
): SplashExplanation[] {
  const { units: allUnits, tiles } = ctx;
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0 || result.chosenWeaponMode !== 'splash') return [];

  const segDist = effectiveCombatDistance(tiles, attacker, primaryTarget);
  const explanations: SplashExplanation[] = [];

  for (const event of result.splashEvents) {
    const victim = allUnits.find((u) => u.id === event.victimId);
    if (!victim) continue;

    // Orientation armour penalty only for the primary target (bearing-based)
    const isSelectedTarget = victim.id === primaryTarget.id;
    const orientationArmourPenalty = isSelectedTarget
      ? calculateOrientationArmourPenalty(tiles, attacker.tileIndex, victim.tileIndex, victim.facing, attacker.segment, victim.segment)
      : 0;
    const defPower = getDefencePower(victim, ctx, isDrone(attacker));
    const healthBefore = victim.currentHealth + event.damage;
    const victimIsDrone = isDrone(victim);

    const angleDiff = isSelectedTarget
      ? getAngularDifference(tiles, attacker.tileIndex, victim.tileIndex, victim.facing, attacker.segment, victim.segment)
      : 0;
    const arc: AttackArc = isSelectedTarget
      ? (isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff))
      : 'front';

    // Call computeDamage once per victim — single source of truth (Item 1)
    const baseSplash = clamp(splashPower, 1, 5);
    const bd = computeDamage({
      mode: 'splash',
      attackerChassis: getChassisType(attacker),
      baseWeaponValue: baseSplash,
      orientationArmourPenalty,
      distance: segDist,
      armour: defPower.armour,
      defenceOther: defPower.ew + defPower.terrain,
      targetIsDrone: victimIsDrone,
    });

    const scaledDamage = event.damage;
    const maxHpVictim = (victim.attributes.size ?? 1) * HP_PER_POINT;

    const steps: ExplanationStep[] = [
      {
        title: '💣 Splash Fire',
        description: `${attacker.label} uses Splash Fire (splashAttack=${splashPower}, chassis ×${bd.chassisModifier}, rangeEfficiency=${bd.rangeEfficiency.toFixed(2)} at segDist ${segDist.toFixed(2)}). ${victim.label} is in target hex. Deals ${Math.round(SPLASH_SCALE * 100)}% of formula damage.${isSelectedTarget ? ` Orientation: ${arc} (armour −${orientationArmourPenalty}).` : ' Orientation: front (no penalty for non-primary).'}`,
        formula: `SplashAttackPower = ${splashPower} × ${bd.chassisModifier} × ${bd.rangeEfficiency.toFixed(2)} = ${bd.attackPower.toFixed(2)}`,
        result: `SplashAttackPower: ${bd.attackPower.toFixed(2)}`,
        tone: 'neutral',
      },
      {
        title: '🛡 Victim Defence',
        description: `Armour(${defPower.armour}) − orientation(${orientationArmourPenalty.toFixed(1)}) + EW(${defPower.ew.toFixed(2)} anti-drone screen) + Terrain(${defPower.terrain}). EffectiveDefence = ${bd.effectiveDefence.toFixed(2)}.`,
        formula: `ED = (max(0, ${defPower.armour} − ${orientationArmourPenalty.toFixed(1)}) + ${defPower.ew.toFixed(2)} + ${defPower.terrain}) × ${0.75} = ${bd.effectiveDefence.toFixed(2)}`,
        result: `EffectiveDefence = ${bd.effectiveDefence.toFixed(2)}`,
        tone: bd.effectiveDefence > 0 ? 'negative' : 'neutral',
      },
      {
        title: '💥 Splash Result',
        description: `Full formula = ${bd.rawFormulaDamage}, × ${SPLASH_SCALE} = ${Math.round(bd.rawFormulaDamage * SPLASH_SCALE)}${victimIsDrone ? `, × ${DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER} drone modifier` : ''} = ${scaledDamage} splash damage.`,
        formula: `max(1, round(${bd.rawFormulaDamage} × ${SPLASH_SCALE}))${victimIsDrone ? ` × ${DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER}` : ''} = ${scaledDamage}`,
        result: event.victimDestroyed
          ? `${scaledDamage} damage — ${victim.label} destroyed!`
          : `${scaledDamage} damage → ${victim.currentHealth}/${maxHpVictim} HP remaining`,
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
// Reaction fire explanation
// ---------------------------------------------------------------------------

export function buildReactionExplanation(
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
  const maxHpDrone = (drone.attributes.size ?? 1) * HP_PER_POINT;

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
      description: `${drone.label}: ${healthBefore}/${maxHpDrone} HP → ${healthAfter}/${maxHpDrone} HP.`,
      formula: `${healthBefore} − ${result.directDamage} = ${healthAfter}`,
      result: destroyed ? `${drone.label} is destroyed!` : `${healthAfter}/${maxHpDrone} HP remaining`,
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
// Repair explanations
// ---------------------------------------------------------------------------

export function explainRepairAction(repairer: Unit, target: Unit): ExplainedRepair {
  const rp = repairer.attributes.repair ?? 0;
  const maxHealth = (target.attributes.size ?? 1) * HP_PER_POINT;

  // Use the shared formula from src/world/repair.ts — no duplication
  const repairAmount = calculateRepairAmount(rp, maxHealth);

  // Derive repairRate for display only (matches the formula in repair.ts)
  const repairRate = 2 + (clamp(maxHealth, 10, 50) - 10) / 20;

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
      description: `${target.label}: ${target.currentHealth}/${maxHealth} → min(${maxHealth}, ${target.currentHealth} + ${repairAmount})/${maxHealth} HP.`,
      formula: `min(${maxHealth}, ${target.currentHealth} + ${repairAmount})`,
      result: `${Math.min(maxHealth, target.currentHealth + repairAmount)}/${maxHealth} HP`,
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

export function explainRepairInvalid(repairer: Unit, target: Unit, reason: string): ExplainedRepair {
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
