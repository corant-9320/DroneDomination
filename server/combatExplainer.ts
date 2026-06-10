/**
 * Step-by-step explanation builders for combat and repair actions.
 *
 * Pure functions — no HTTP handling, no state mutation.
 * Imported by server/combat.ts to attach explanations to API responses.
 */

import { Tile } from '../src/world/types.js';
import { Unit } from '../src/world/units.js';
import { effectiveCombatDistance } from '../src/world/segmentGeometry.js';
import {
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  calculateOrientationBonus,
  classifyArcFromAngle,
  getAngularDifference,
  getDefencePower,
  isDrone,
  clamp,
  calculateFormulaDamage,
  calculateSplashDamage,
  calculateModifiedAttackPower,
  calculateRangeEfficiency,
  getChassisAttackModifier,
  getSegmentRangeThreshold,
  applyDroneIncomingDamageModifier,
  evaluateWeaponOptions,
  chooseWeaponOption,
  calculateElevationMultiplier,
  EW_EFFECTIVENESS_DIRECT,
  EW_EFFECTIVENESS_SPLASH,
  EW_EFFECTIVENESS_ANTIAIR,
  DEFENCE_SCALE,
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
  type WeaponMode,
  type WeaponOption,
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
// Attack explanation
// ---------------------------------------------------------------------------

/**
 * Build a structured CombatBreakdown for the preview table.
 * Called after all attack values are computed — both in-range and out-of-range.
 */
function buildBreakdown(
  attacker: Unit,
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
  segDist: number,
  rangeThreshold: number,
  rangeAttack: number,
  meleeAttack: number,
  antiAirAttack: number,
  orientationBonus: number,
  defPower: ReturnType<typeof getDefencePower>,
  chosenMode: WeaponMode | 'none',
  totalDamage: number,
): CombatBreakdown {
  const inRange = segDist <= rangeThreshold;
  const chassisModifier = getChassisAttackModifier(attacker);
  const rangeEfficiency = calculateRangeEfficiency(segDist);
  const targetIsDrone = isDrone(target);
  const effectiveDefence = defPower.total * DEFENCE_SCALE;

  // Orientation label from angular difference
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing);
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

  const attackPower = calculateModifiedAttackPower(attacker, baseWeapon, orientationBonus, segDist);
  const rawDamage = calculateFormulaDamage(attackPower, effectiveDefence);

  // Elevation multiplier
  const elevMult = calculateElevationMultiplier(tiles[attacker.tileIndex], tiles[target.tileIndex], attacker, target);

  // Drone evasion: difference between raw and final damage when target is a drone
  let droneEvasion = 0;
  if (targetIsDrone && chosenMode !== 'antiAir') {
    const multiplier = chosenMode === 'splash'
      ? (1 - (attacker.attributes.splashAttack ?? 0 > 0 ? 0.50 : 0.33))
      : 0.67; // direct: 1 - 0.33
    droneEvasion = Math.max(0, rawDamage - totalDamage);
  }

  return {
    inRange,
    distance: segDist,
    attackRange: rangeThreshold,
    weaponMode,
    baseWeapon,
    chassisLabel: chassisModifier === DRONE_ATTACK_MODIFIER ? 'Drone'
      : chassisModifier === SPIDER_ATTACK_MODIFIER ? 'Spider'
      : 'Tank',
    chassisModifier,
    rangeEfficiency: Math.round(rangeEfficiency * 100) / 100,
    orientationBonus,
    orientationLabel,
    droneAttackPenalty: 0, // deprecated — chassis modifier is shown via chassisLabel row
    attackTotal: Math.round(attackPower * 100) / 100,
    defArmour: defPower.armour,
    defEW: defPower.ew,
    defEWRaw: defPower.ewRaw,
    defEWMultiplier: defPower.ewMultiplier,
    defFormation: defPower.defensiveFormation,
    defTerrain: defPower.terrain,
    elevationMultiplier: Math.round(elevMult * 100) / 100,
    droneEvasion,
    defTotal: Math.round(effectiveDefence * 100) / 100,
    netDamage: inRange ? totalDamage : 0,
    weaponSelectionLabel,
  };
}

export function explainAttack(
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

  // Step 1: Range (segment-based gate)
  const rangeAttack = attacker.attributes.rangeAttack ?? 0;
  const meleeAttack = attacker.attributes.kinetic ?? 0;
  const antiAirAttack = attacker.attributes.antiAir ?? 0;
  const rangeThreshold = getSegmentRangeThreshold(attacker);
  const segDist = effectiveCombatDistance(tiles, attacker, target);

  steps.push({
    title: '📏 Range Check',
    description: `Segment distance from ${attacker.label} to ${target.label} is ${segDist.toFixed(2)} hex-units. Range threshold: ${rangeThreshold.toFixed(2)} (rangeAttack=${rangeAttack} × ${SEGMENT_RANGE_PER_POINT} + ${SEGMENT_RANGE_BASE}).`,
    formula: `segDist(${segDist.toFixed(2)}) ≤ threshold(${rangeThreshold.toFixed(2)})`,
    result: segDist <= rangeThreshold ? `✓ In range` : `✗ Out of range`,
    tone: segDist <= rangeThreshold ? 'positive' : 'negative',
  });

  const outOfRange = segDist > rangeThreshold;

  // Step 2: Orientation (bearing-based continuous bonus)
  const orientationBonus = calculateOrientationBonus(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  const angleDiffDeg = isNaN(angleDiff) ? 0 : Math.round((angleDiff * 180) / Math.PI);

  steps.push({
    title: '🧭 Orientation',
    description: `${target.label} facing direction ${target.facing}. Bearing from target to ${attacker.label} differs by ${angleDiffDeg}°. Target orientation: ${arc}.`,
    result: `${formatArcDetailed(angleDiffDeg)} → orientation bonus +${orientationBonus.toFixed(1)}`,
    tone: orientationBonus > 0.3 ? 'positive' : 'neutral',
  });

  // Step 3: Defence breakdown — EW effectiveness depends on weapon mode.
  // We compute per-mode defence powers; shown after weapon selection is known.
  // For display we show the direct-fire defence (conservative, most likely mode).
  // The actual per-mode values are shown in the chosen weapon detail step.
  const defPowerDirect = getDefencePower(target, allUnits, tiles, 'direct');
  const defPowerSplash = getDefencePower(target, allUnits, tiles, 'splash');
  const defPowerAntiAir = getDefencePower(target, allUnits, tiles, 'antiAir');
  const defPower = defPowerDirect; // default for initial display
  const effectiveDefence = defPower.total * DEFENCE_SCALE;

  steps.push({
    title: '🛡 Defence Power',
    description: `Armour(${defPower.armour}) + EW(${defPower.ewRaw}×${EW_EFFECTIVENESS_DIRECT} kinetic / ×${EW_EFFECTIVENESS_SPLASH} splash / ×${EW_EFFECTIVENESS_ANTIAIR} AA) + Formation(${defPower.defensiveFormation}) + Terrain(${defPower.terrain}).`,
    formula: `DefencePower(kinetic) = ${defPower.armour} + ${defPower.ew.toFixed(2)} + ${defPower.defensiveFormation} + ${defPower.terrain} = ${defPower.total.toFixed(2)}`,
    result: `EffectiveDefence(kinetic) = ${effectiveDefence.toFixed(2)}`,
    tone: defPower.total > 0 ? 'negative' : 'neutral',
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
  const weaponOptions: WeaponOption[] = evaluateWeaponOptions(attacker, target, allUnits, tiles, segDist, orientationBonus);

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

  // Step 5: Chosen weapon detail
  if (chosenOption.mode === 'direct') {
    const baseAttack = clamp(meleeAttack, 1, 5);
    const rangeEff = calculateRangeEfficiency(segDist);
    const attackPower = calculateModifiedAttackPower(attacker, baseAttack, orientationBonus, segDist);
    const apSq = attackPower * attackPower;
    const edDirect = defPowerDirect.total * DEFENCE_SCALE;
    const edSq = edDirect * edDirect;
    const cm = getChassisAttackModifier(attacker);
    steps.push({
      title: '💥 Kinetic Fire',
      description: `rangeEfficiency = ${rangeEff.toFixed(2)} (segDist ${segDist.toFixed(2)}). AttackPower = (${baseAttack} × ${cm} × ${rangeEff.toFixed(2)}) + ${orientationBonus} = ${attackPower.toFixed(2)}. EW at ${EW_EFFECTIVENESS_DIRECT * 100}% vs kinetic → ED = ${edDirect.toFixed(2)}.${targetIsDrone ? ` Drone incoming modifier ×${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER} applied.` : ''}`,
      formula: `round(1 + 29 × ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)}))${targetIsDrone ? ` × ${DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER}` : ''} = ${totalDamage}`,
      result: `${totalDamage} direct damage`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  } else if (chosenOption.mode === 'splash') {
    const affectedCount = allUnits.filter((u) => u.ownerId !== attacker.ownerId && u.currentHealth > 0 && u.tileIndex === target.tileIndex).length;
    const rangeEff = calculateRangeEfficiency(segDist);
    const edSplash = defPowerSplash.total * DEFENCE_SCALE;
    const splashAttack = attacker.attributes.splashAttack ?? 0;
    steps.push({
      title: '💣 Splash Fire',
      description: `splashAttack=${splashAttack}. rangeEfficiency = ${rangeEff.toFixed(2)} (segDist ${segDist.toFixed(2)}). EW at ${EW_EFFECTIVENESS_SPLASH * 100}% vs splash → ED = ${edSplash.toFixed(2)}. Affects ${affectedCount} enemy unit${affectedCount !== 1 ? 's' : ''} in target hex. Each takes ${Math.round(SPLASH_SCALE * 100)}% of formula damage.`,
      formula: `Total splash score = ${totalDamage}`,
      result: `${totalDamage} total splash damage across ${affectedCount} unit${affectedCount !== 1 ? 's' : ''}`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  } else if (chosenOption.mode === 'antiAir') {
    const aaLevel = clamp(antiAirAttack, 1, 5);
    const cm = getChassisAttackModifier(attacker);
    const rangeEff = calculateRangeEfficiency(segDist);
    const aaAttackPower = calculateModifiedAttackPower(attacker, aaLevel, orientationBonus, segDist);
    const apSq = aaAttackPower * aaAttackPower;
    const edAntiAir = defPowerAntiAir.total * DEFENCE_SCALE;
    const edSq = edAntiAir * edAntiAir;
    steps.push({
      title: '🚀 Anti-Air Fire',
      description: `antiAir=${antiAirAttack}. rangeEfficiency = ${rangeEff.toFixed(2)} (segDist ${segDist.toFixed(2)}). AttackPower = (${aaLevel} × ${cm} × ${rangeEff.toFixed(2)}) + ${orientationBonus} = ${aaAttackPower.toFixed(2)}. EW at ${EW_EFFECTIVENESS_ANTIAIR * 100}% vs AA → ED = ${edAntiAir.toFixed(2)}. Fires at drone target. Full damage formula, no drone penalty.`,
      formula: `round(1 + 29 × ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)})) = ${totalDamage}`,
      result: `${totalDamage} anti-air damage`,
      tone: totalDamage >= 15 ? 'critical' : totalDamage >= 5 ? 'positive' : 'neutral',
    });
  }

  // Step 6: Elevation advantage (only shown when multiplier ≠ 1.0)
  const elevMult = calculateElevationMultiplier(tiles[attacker.tileIndex], tiles[target.tileIndex], attacker, target);
  if (elevMult !== 1.0) {
    const elevPercent = Math.round((elevMult - 1) * 100);
    const sign = elevPercent > 0 ? '+' : '';
    steps.push({
      title: '⛰ Elevation',
      description: `Attacker elevation: ${tiles[attacker.tileIndex].elevationType}. Defender elevation: ${tiles[target.tileIndex].elevationType}. Damage multiplier: ×${elevMult.toFixed(2)} (${sign}${elevPercent}%).`,
      formula: `elevationMultiplier = clamp(1 + delta × 0.10, 0.70, 1.30) = ${elevMult.toFixed(2)}`,
      result: `${sign}${elevPercent}% damage`,
      tone: elevPercent > 0 ? 'positive' : 'negative',
    });
  }

  // Step 7: Health outcome
  const maxHp = (target.attributes.maxHealth ?? 1) * HP_PER_POINT;
  const healthAfter = Math.max(0, target.currentHealth - totalDamage);
  const destroyed = healthAfter <= 0;

  steps.push({
    title: destroyed ? '☠ Target Destroyed' : '❤ Health Update',
    description: `${target.label}: ${target.currentHealth}/${maxHp} HP → ${healthAfter}/${maxHp} HP.`,
    formula: `${target.currentHealth} − ${totalDamage} = ${healthAfter}`,
    result: destroyed ? `${target.label} is destroyed!` : `${healthAfter}/${maxHp} HP remaining`,
    tone: destroyed ? 'critical' : (totalDamage > 0 ? 'negative' : 'neutral'),
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
    targetDestroyed: outOfRange ? false : destroyed,
    splash: [],
    destroyedUnitIds: [],
    breakdown: buildBreakdown(
      attacker, target, allUnits, tiles,
      segDist, rangeThreshold,
      rangeAttack, meleeAttack, antiAirAttack,
      orientationBonus,
      chosenOption.mode === 'direct' ? defPowerDirect
        : chosenOption.mode === 'splash' ? defPowerSplash
        : defPowerAntiAir,
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
  allUnits: Unit[],
  tiles: Tile[],
): SplashExplanation[] {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0 || result.chosenWeaponMode !== 'splash') return [];

  const segDist = effectiveCombatDistance(tiles, attacker, primaryTarget);
  const rangeEff = calculateRangeEfficiency(segDist);
  const explanations: SplashExplanation[] = [];

  for (const event of result.splashEvents) {
    const victim = allUnits.find((u) => u.id === event.victimId);
    if (!victim) continue;

    const defPower = getDefencePower(victim, allUnits, tiles, 'splash');
    const effectiveDefence = defPower.total * DEFENCE_SCALE;
    const healthBefore = victim.currentHealth + event.damage;

    // Orientation bonus only for the primary target (bearing-based)
    const isSelectedTarget = victim.id === primaryTarget.id;
    const orientationBonus = isSelectedTarget
      ? calculateOrientationBonus(tiles, attacker.tileIndex, victim.tileIndex, victim.facing)
      : 0;
    const angleDiff = isSelectedTarget
      ? getAngularDifference(tiles, attacker.tileIndex, victim.tileIndex, victim.facing)
      : 0;
    const arc: AttackArc = isSelectedTarget
      ? (isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff))
      : 'front';
    const baseSplash = clamp(splashPower, 1, 5);
    const splashAttackPower = calculateModifiedAttackPower(attacker, baseSplash, orientationBonus, segDist);
    const chassisModifier = getChassisAttackModifier(attacker);

    const apSq = splashAttackPower * splashAttackPower;
    const edSq = effectiveDefence * effectiveDefence;
    const fullDamage = calculateFormulaDamage(splashAttackPower, effectiveDefence);
    const scaledDamage = event.damage;
    const victimIsDrone = isDrone(victim);

    const maxHpVictim = (victim.attributes.maxHealth ?? 1) * HP_PER_POINT;

    const steps: ExplanationStep[] = [
      {
        title: '💣 Splash Fire',
        description: `${attacker.label} uses Splash Fire (splashAttack=${splashPower}, chassis ×${chassisModifier}, rangeEfficiency=${rangeEff.toFixed(2)} at segDist ${segDist.toFixed(2)}). ${victim.label} is in target hex. Deals ${Math.round(SPLASH_SCALE * 100)}% of formula damage.${isSelectedTarget ? ` Orientation: ${arc} (+${orientationBonus}).` : ' Orientation: front (no bonus for non-primary).'}`,
        formula: `SplashAttackPower = (${splashPower} × ${chassisModifier} × ${rangeEff.toFixed(2)})${orientationBonus > 0 ? ` + ${orientationBonus}` : ''} = ${splashAttackPower.toFixed(2)}`,
        result: `SplashAttackPower: ${splashAttackPower.toFixed(2)}`,
        tone: 'neutral',
      },
      {
        title: '🛡 Victim Defence',
        description: `Armour(${defPower.armour}) + EW(${defPower.ewRaw}×${EW_EFFECTIVENESS_SPLASH}) + Formation(${defPower.defensiveFormation}) + Terrain(${defPower.terrain}) = ${defPower.total.toFixed(2)}. EffectiveDefence = ${effectiveDefence.toFixed(2)}.`,
        formula: `DefencePower = ${defPower.armour} + ${defPower.ew.toFixed(2)} + ${defPower.defensiveFormation} + ${defPower.terrain} = ${defPower.total.toFixed(2)}, ED = ${effectiveDefence.toFixed(2)}`,
        result: `EffectiveDefence = ${effectiveDefence.toFixed(2)}`,
        tone: defPower.total > 0 ? 'negative' : 'neutral',
      },
      {
        title: '💥 Splash Result',
        description: `Full formula = ${fullDamage}, × ${SPLASH_SCALE} = ${Math.round(fullDamage * SPLASH_SCALE)}${victimIsDrone ? `, × ${DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER} drone modifier` : ''} = ${scaledDamage} splash damage.`,
        formula: `max(1, round(${fullDamage} × ${SPLASH_SCALE}))${victimIsDrone ? ` × ${DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER}` : ''} = ${scaledDamage}`,
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
  const maxHpDrone = (drone.attributes.maxHealth ?? 1) * HP_PER_POINT;

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
  const maxHealth = (target.attributes.maxHealth ?? 1) * HP_PER_POINT;

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
