import { computeDamage } from '../combatFormula.js';
import type { Unit } from '../units.js';
import { getChassisType, isDrone } from './context.js';
import { calculateDirectDamage, calculateSplashDamage, getDefencePower } from './defence.js';
import type { CombatContext, WeaponOption } from './types.js';

/** Evaluate all valid weapon modes without mutating state. */
export function evaluateWeaponOptions(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
  dist: number,
  orientationArmourPenalty: number,
): WeaponOption[] {
  const { units: allUnits } = ctx;
  const options: WeaponOption[] = [];

  if ((attacker.attributes.kinetic ?? 0) > 0) {
    const { damage } = calculateDirectDamage(attacker, target, ctx, dist);
    options.push({
      mode: 'direct',
      score: damage,
      damages: [{ unitId: target.id, damage }],
    });
  }

  if ((attacker.attributes.splashAttack ?? 0) > 0) {
    const affectedEnemies = allUnits.filter((u) => {
      if (u.ownerId === attacker.ownerId) return false;
      if (u.currentHealth <= 0) return false;
      return u.tileIndex === target.tileIndex;
    });

    const splashDamages: Array<{ unitId: string; damage: number }> = [];
    for (const victim of affectedEnemies) {
      const dmg = calculateSplashDamage(attacker, target, victim, ctx, dist);
      splashDamages.push({ unitId: victim.id, damage: dmg });
    }

    const splashScore = splashDamages.reduce((sum, d) => sum + d.damage, 0);

    options.push({
      mode: 'splash',
      score: splashScore,
      damages: splashDamages,
    });
  }

  if ((attacker.attributes.antiAir ?? 0) > 0 && isDrone(target)) {
    const defencePower = getDefencePower(target, ctx, isDrone(attacker));
    const { finalDamage } = computeDamage({
      mode: 'antiAir',
      attackerChassis: getChassisType(attacker),
      baseWeaponValue: attacker.attributes.antiAir!,
      orientationArmourPenalty,
      distance: dist,
      armour: defencePower.armour,
      defenceOther: defencePower.ew + defencePower.terrain,
      targetIsDrone: true,
    });
    options.push({
      mode: 'antiAir',
      score: finalDamage,
      damages: [{ unitId: target.id, damage: finalDamage }],
    });
  }

  return options;
}

/** Choose the highest score using the established tie-break order. */
export function chooseWeaponOption(options: WeaponOption[], target: Unit): WeaponOption {
  const targetIsDrone = isDrone(target);

  return options.reduce((best, current) => {
    if (current.score > best.score) return current;
    if (current.score < best.score) return best;

    if (targetIsDrone) {
      if (current.mode === 'antiAir' && best.mode !== 'antiAir') return current;
      if (best.mode === 'antiAir' && current.mode !== 'antiAir') return best;
    }

    const currentSplashCount = current.mode === 'splash' ? current.damages.length : 0;
    const bestSplashCount = best.mode === 'splash' ? best.damages.length : 0;
    if (current.mode === 'splash' && currentSplashCount > 1 && bestSplashCount <= 1) return current;
    if (best.mode === 'splash' && bestSplashCount > 1 && currentSplashCount <= 1) return best;

    if (current.mode === 'direct' && best.mode === 'splash') return current;
    if (best.mode === 'direct' && current.mode === 'splash') return best;

    const currentTargetDmg = current.damages.find((d) => d.unitId === target.id)?.damage ?? 0;
    const bestTargetDmg = best.damages.find((d) => d.unitId === target.id)?.damage ?? 0;
    return currentTargetDmg >= bestTargetDmg ? current : best;
  });
}