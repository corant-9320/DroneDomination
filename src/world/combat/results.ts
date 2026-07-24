import type { CombatResult } from './types.js';

export function invalidResult(attackerId: string, targetId: string, reason: string): CombatResult {
  return {
    attackerId,
    targetId,
    wasValid: false,
    reasonInvalid: reason,
    attackArc: 'unknown',
    facingModifier: 0,
    targetArmour: 0,
    targetEffectiveDefense: 0,
    directDamage: 0,
    antiAirDamage: 0,
    splashEvents: [],
    destroyedUnitIds: [],
    reactionEvents: [],
    chosenWeaponMode: undefined,
    buildingDamage: [],
  };
}

/** A minimal valid Direct_Fire-on-building result skeleton. */
export function directFireBaseResult(attackerId: string, buildingId: string): CombatResult {
  return {
    attackerId,
    targetId: buildingId,
    wasValid: true,
    attackArc: 'unknown',
    facingModifier: 0,
    targetArmour: 0,
    targetEffectiveDefense: 0,
    directDamage: 0,
    antiAirDamage: 0,
    splashEvents: [],
    destroyedUnitIds: [],
    reactionEvents: [],
    chosenWeaponMode: 'direct',
    buildingDamage: [],
  };
}