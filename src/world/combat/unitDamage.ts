import { applyDamage } from '../combatFormula.js';
import type { Unit } from '../units.js';
import type { SplashEvent, WeaponOption } from './types.js';

/** Apply the chosen normal-attack option in its existing damage-entry order. */
export function applySelectedWeaponDamage(
  chosen: WeaponOption,
  targetId: string,
  allUnits: Unit[],
): { destroyedIds: string[]; splashEvents: SplashEvent[] } {
  const destroyedIds: string[] = [];
  const splashEvents: SplashEvent[] = [];

  for (const { unitId, damage } of chosen.damages) {
    const victim = allUnits.find((u) => u.id === unitId);
    if (!victim) continue;

    victim.currentHealth = applyDamage(victim.currentHealth, damage);
    const destroyed = victim.currentHealth <= 0;
    if (destroyed) destroyedIds.push(victim.id);

    if (chosen.mode === 'splash' && unitId !== targetId) {
      splashEvents.push({ victimId: unitId, damage, victimDestroyed: destroyed });
    } else if (chosen.mode === 'splash' && unitId === targetId) {
      splashEvents.push({ victimId: unitId, damage, victimDestroyed: destroyed });
    }
  }

  return { destroyedIds, splashEvents };
}