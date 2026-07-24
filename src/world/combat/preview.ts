import { elevationRangeMultiplier } from '../../../shared/rangeCheck.js';
import {
  clamp,
  computeDamage,
  getChassisModifier,
} from '../combatFormula.js';
import type { AttackArc } from '../combatFacing.js';
import {
  calculateOrientationArmourPenalty,
  classifyArcFromAngle,
  getAngularDifference,
} from '../combatFacing.js';
import { effectiveCombatDistance } from '../segmentGeometry.js';
import { HP_PER_POINT } from '../units.js';
import type { Unit } from '../units.js';
import {
  getChassisType,
  getSegmentRangeThreshold,
  isDrone,
} from './context.js';
import { getDefencePower } from './defence.js';
import type { CombatContext, CombatPreview } from './types.js';
import { chooseWeaponOption, evaluateWeaponOptions } from './weaponOptions.js';

/** Evaluate an attack without mutating any state or drawing randomness. */
export function previewAttack(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
): CombatPreview {
  const { units: allUnits, tiles } = ctx;

  const base: Pick<CombatPreview, 'attackerId' | 'attackerLabel' | 'targetId' | 'targetLabel'> = {
    attackerId: attacker.id,
    attackerLabel: attacker.label,
    targetId: target.id,
    targetLabel: target.label,
  };

  if (attacker.currentHealth <= 0) {
    return { ...base, ...invalidPreview('Attacker is destroyed') };
  }
  if (target.currentHealth <= 0) {
    return { ...base, ...invalidPreview('Target is already destroyed') };
  }

  if (attacker.ownerId === target.ownerId) {
    return { ...base, ...invalidPreview('Cannot attack a friendly unit') };
  }

  const hasAttack = (attacker.attributes.kinetic ?? 0) > 0;
  const hasSplash = (attacker.attributes.splashAttack ?? 0) > 0;
  const hasAntiAir = (attacker.attributes.antiAir ?? 0) > 0;
  const hasRange = (attacker.attributes.rangeAttack ?? 0) > 0;
  if (!hasAttack && !hasRange && !hasSplash && hasAntiAir && !isDrone(target)) {
    return { ...base, ...invalidPreview('Anti-Air weapons can only target drones') };
  }

  const segDist = effectiveCombatDistance(tiles, attacker, target);
  const elevMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].height ?? 0,
    tiles[target.tileIndex].height ?? 0,
    isDrone(attacker) || isDrone(target),
  );
  const baseRangeThreshold = getSegmentRangeThreshold(attacker);
  const effectiveRangeThreshold = baseRangeThreshold * elevMult;
  const inRange = segDist <= effectiveRangeThreshold;

  const orientationArmourPenalty = calculateOrientationArmourPenalty(
    tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment,
  );
  const angleDiff = getAngularDifference(
    tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment,
  );
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  const angleDiffDeg = isNaN(angleDiff) ? 0 : Math.round((angleDiff * 180) / Math.PI);
  const orientationLabel = formatArcLabel(angleDiffDeg);

  const attackerIsDrone = isDrone(attacker);
  const defPower = getDefencePower(target, ctx, attackerIsDrone);
  const targetIsDrone = isDrone(target);

  const chassisType = getChassisType(attacker);
  const chassisModifier = getChassisModifier(chassisType);
  const chassisLabel: CombatPreview['chassisLabel'] =
    chassisType === 'drone' ? 'Drone' : chassisType === 'spider' ? 'Spider' : 'Tank';

  const weaponOptions = evaluateWeaponOptions(
    attacker, target, ctx, segDist, orientationArmourPenalty,
  );

  if (weaponOptions.length === 0) {
    return {
      ...base,
      wasValid: false,
      reasonInvalid: 'No valid weapon modes available',
      distance: segDist,
      baseRangeThreshold,
      elevationRangeMultiplier: elevMult,
      effectiveRangeThreshold,
      inRange,
      angleDiffDeg,
      arc,
      orientationArmourPenalty,
      orientationLabel,
      defArmour: defPower.armour,
      defEW: defPower.ew,
      defEWRaw: defPower.ewRaw,
      defEWMultiplier: defPower.ewMultiplier,
      defTerrain: defPower.terrain,
      defTotal: defPower.total,
      effectiveDefence: 0,
      chassisType,
      chassisLabel,
      chassisModifier,
      weaponOptions: [],
      chosenMode: 'none',
      baseWeapon: 0,
      rangeEfficiency: 0,
      attackTotal: 0,
      primaryTargetDamage: 0,
      totalDamage: 0,
      targetIsDrone,
      droneEvasion: 0,
      targetHealthBefore: target.currentHealth,
      targetHealthAfter: target.currentHealth,
      targetDestroyed: false,
      targetMaxHp: (target.attributes.size ?? 1) * HP_PER_POINT,
      splashVictims: [],
    };
  }

  const chosen = chooseWeaponOption(weaponOptions, target);

  let baseWeapon = 0;
  if (chosen.mode === 'direct') baseWeapon = clamp(attacker.attributes.kinetic ?? 0, 1, 5);
  else if (chosen.mode === 'splash') baseWeapon = clamp(attacker.attributes.splashAttack ?? 0, 1, 5);
  else if (chosen.mode === 'antiAir') baseWeapon = clamp(attacker.attributes.antiAir ?? 0, 1, 5);

  const bd = computeDamage({
    mode: chosen.mode,
    attackerChassis: chassisType,
    baseWeaponValue: baseWeapon,
    orientationArmourPenalty,
    distance: segDist,
    armour: defPower.armour,
    defenceOther: defPower.ew + defPower.terrain,
    targetIsDrone,
  });

  const totalDamage = chosen.score;
  const primaryTargetDamage = chosen.mode === 'splash'
    ? (chosen.damages.find((d) => d.unitId === target.id)?.damage ?? 0)
    : totalDamage;

  let droneEvasion = 0;
  if (targetIsDrone && chosen.mode !== 'antiAir') {
    droneEvasion = Math.max(0, bd.rawFormulaDamage - bd.finalDamage);
  }

  const targetMaxHp = (target.attributes.size ?? 1) * HP_PER_POINT;
  const healthAfter = inRange
    ? Math.max(0, target.currentHealth - primaryTargetDamage)
    : target.currentHealth;
  const destroyed = inRange && healthAfter <= 0;

  const splashVictims: CombatPreview['splashVictims'] = [];
  if (chosen.mode === 'splash') {
    for (const { unitId, damage } of chosen.damages) {
      if (unitId === target.id) continue;
      const victim = allUnits.find((u) => u.id === unitId);
      if (!victim) continue;
      const vMaxHp = (victim.attributes.size ?? 1) * HP_PER_POINT;
      splashVictims.push({
        unitId: victim.id,
        unitLabel: victim.label,
        damage,
        healthBefore: victim.currentHealth,
        healthAfter: Math.max(0, victim.currentHealth - damage),
        destroyed: victim.currentHealth - damage <= 0,
        maxHp: vMaxHp,
      });
    }
  }

  return {
    ...base,
    wasValid: !inRange ? true : true,
    reasonInvalid: undefined,
    distance: segDist,
    baseRangeThreshold,
    elevationRangeMultiplier: elevMult,
    effectiveRangeThreshold,
    inRange,
    angleDiffDeg,
    arc,
    orientationArmourPenalty,
    orientationLabel,
    defArmour: defPower.armour,
    defEW: defPower.ew,
    defEWRaw: defPower.ewRaw,
    defEWMultiplier: defPower.ewMultiplier,
    defTerrain: defPower.terrain,
    defTotal: defPower.total,
    effectiveDefence: bd.effectiveDefence,
    chassisType,
    chassisLabel,
    chassisModifier,
    weaponOptions,
    chosenMode: chosen.mode,
    baseWeapon,
    rangeEfficiency: bd.rangeEfficiency,
    attackTotal: bd.attackPower,
    primaryTargetDamage: inRange ? primaryTargetDamage : 0,
    totalDamage: inRange ? totalDamage : 0,
    targetIsDrone,
    droneEvasion,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: healthAfter,
    targetDestroyed: destroyed,
    targetMaxHp,
    splashVictims,
  };
}

function invalidPreview(
  reason: string,
): Omit<CombatPreview, 'attackerId' | 'attackerLabel' | 'targetId' | 'targetLabel'> {
  return {
    wasValid: false,
    reasonInvalid: reason,
    distance: 0,
    baseRangeThreshold: 0,
    elevationRangeMultiplier: 1,
    effectiveRangeThreshold: 0,
    inRange: false,
    angleDiffDeg: 0,
    arc: 'unknown',
    orientationArmourPenalty: 0,
    orientationLabel: '—',
    defArmour: 0,
    defEW: 0,
    defEWRaw: 0,
    defEWMultiplier: 0,
    defTerrain: 0,
    defTotal: 0,
    effectiveDefence: 0,
    chassisType: 'tank',
    chassisLabel: 'Tank',
    chassisModifier: 1,
    weaponOptions: [],
    chosenMode: 'none',
    baseWeapon: 0,
    rangeEfficiency: 0,
    attackTotal: 0,
    primaryTargetDamage: 0,
    totalDamage: 0,
    targetIsDrone: false,
    droneEvasion: 0,
    targetHealthBefore: 0,
    targetHealthAfter: 0,
    targetDestroyed: false,
    targetMaxHp: 0,
    splashVictims: [],
  };
}

function formatArcLabel(angleDiffDeg: number): string {
  if (angleDiffDeg <= 40) return 'Front';
  if (angleDiffDeg <= 80) return 'Front Flank';
  if (angleDiffDeg <= 100) return 'Flank';
  if (angleDiffDeg <= 140) return 'Rear Flank';
  return 'Rear';
}