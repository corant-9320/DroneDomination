import { applyDamage } from '../combatFormula.js';
import { resolveAttack } from './resolution.js';
import type { CombatContext, CombatResult } from './types.js';

/** Resolve two attacks from snapshots, then apply both damages simultaneously. */
export function resolveSimultaneousAttacks(
  unitAId: string,
  unitBId: string,
  ctx: CombatContext,
): CombatResult[] {
  const { units: allUnits } = ctx;
  const unitA = allUnits.find((u) => u.id === unitAId);
  const unitB = allUnits.find((u) => u.id === unitBId);

  if (!unitA || !unitB) return [];

  const healthA = unitA.currentHealth;
  const healthB = unitB.currentHealth;

  const resultA = resolveAttack(unitAId, unitBId, ctx);

  unitA.currentHealth = healthA;
  unitB.currentHealth = healthB;

  const resultB = resolveAttack(unitBId, unitAId, ctx);

  unitA.currentHealth = applyDamage(healthA, resultB.directDamage);
  unitB.currentHealth = applyDamage(healthB, resultA.directDamage);

  return [resultA, resultB];
}