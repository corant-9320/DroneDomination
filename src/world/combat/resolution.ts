import { elevationRangeMultiplier } from '../../../shared/rangeCheck.js';
import { calculateOrientationArmourPenalty, classifyArcFromAngle, getAngularDifference } from '../combatFacing.js';
import type { AttackArc } from '../combatFacing.js';
import { effectiveCombatDistance } from '../segmentGeometry.js';
import { resolveBuildingSplashInHex } from './buildingDamage.js';
import { getSegmentRangeThreshold, isDrone } from './context.js';
import { getDefencePower } from './defence.js';
import { invalidResult } from './results.js';
import type { CombatContext, CombatResult, RandomFn } from './types.js';
import { applySelectedWeaponDamage } from './unitDamage.js';
import { chooseWeaponOption, evaluateWeaponOptions } from './weaponOptions.js';

export function resolveAttack(
  attackerId: string,
  targetId: string,
  ctx: CombatContext,
  rng: RandomFn = Math.random,
): CombatResult {
  const { units: allUnits, tiles } = ctx;
  const attacker = allUnits.find((u) => u.id === attackerId);
  const target = allUnits.find((u) => u.id === targetId);

  if (!attacker) return invalidResult(attackerId, targetId, 'Attacker not found');
  if (!target) return invalidResult(attackerId, targetId, 'Target not found');
  if (attacker.currentHealth <= 0) return invalidResult(attackerId, targetId, 'Attacker is destroyed');
  if (target.currentHealth <= 0) return invalidResult(attackerId, targetId, 'Target is destroyed');
  if (attacker.ownerId === target.ownerId) return invalidResult(attackerId, targetId, 'Cannot attack friendly unit');

  const hasAttack = (attacker.attributes.kinetic ?? 0) > 0;
  const hasRange = (attacker.attributes.rangeAttack ?? 0) > 0;
  const hasSplash = (attacker.attributes.splashAttack ?? 0) > 0;
  const hasAntiAir = (attacker.attributes.antiAir ?? 0) > 0;

  if (!hasAttack && !hasRange && !hasSplash && hasAntiAir && !isDrone(target)) {
    return invalidResult(attackerId, targetId, 'Anti-Air weapons can only target drones');
  }

  const segDist = effectiveCombatDistance(tiles, attacker, target);
  const elevRangeMult = elevationRangeMultiplier(

    tiles[attacker.tileIndex].height ?? 0,
    tiles[target.tileIndex].height ?? 0,
    isDrone(attacker) || isDrone(target),
  );
  const rangeThreshold = getSegmentRangeThreshold(attacker) * elevRangeMult;
  if (segDist > rangeThreshold) {
    return invalidResult(attackerId, targetId, 'Target out of range');
  }

  const orientationArmourPenalty = calculateOrientationArmourPenalty(
    tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment,
  );
  const angleDiff = getAngularDifference(
    tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment,
  );
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  const defencePower = getDefencePower(target, ctx, isDrone(attacker));

  const validOptions = evaluateWeaponOptions(
    attacker, target, ctx, segDist, orientationArmourPenalty,
  );

  if (validOptions.length === 0) {
    return invalidResult(attackerId, targetId, 'No valid weapon modes available');
  }

  const chosen = chooseWeaponOption(validOptions, target);
  const { destroyedIds, splashEvents } = applySelectedWeaponDamage(chosen, target.id, allUnits);
  const totalDamage = chosen.damages.reduce((sum, d) => sum + d.damage, 0);
  const antiAirDamage = chosen.mode === 'antiAir' ? totalDamage : 0;

  const buildingDamage = chosen.mode === 'splash'
    ? resolveBuildingSplashInHex(attacker.ownerId, target.tileIndex, ctx, rng)
    : [];

  return {
    attackerId,
    targetId,
    wasValid: true,
    attackArc: arc,
    facingModifier: orientationArmourPenalty,
    targetArmour: defencePower.armour,
    targetEffectiveDefense: defencePower.total,
    directDamage: totalDamage,
    antiAirDamage,
    splashEvents: chosen.mode === 'splash' ? splashEvents : [],
    destroyedUnitIds: destroyedIds,
    reactionEvents: [],
    chosenWeaponMode: chosen.mode,
    buildingDamage,
  };
}