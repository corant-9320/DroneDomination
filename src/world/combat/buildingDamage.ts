import type { BuildingComponent } from '../../../shared/buildingComponents.js';
import { BUILDING_COMPONENTS } from '../../../shared/buildingComponents.js';
import { elevationRangeMultiplier } from '../../../shared/rangeCheck.js';
import { applyDamage } from '../combatFormula.js';
import { effectiveCombatDistance, segmentDistance } from '../segmentGeometry.js';
import type { Building } from '../types.js';
import type { HexSegment } from '../units.js';
import { getSegmentRangeThreshold, isDrone } from './context.js';
import { calculateSplashDamage } from './defence.js';
import { directFireBaseResult, invalidResult } from './results.js';
import type {
  BuildingDamageEvent,
  CombatContext,
  CombatResult,
  RandomFn,
  SplashEvent,
} from './types.js';

export type { BuildingComponent };
export { BUILDING_COMPONENTS };

/** Components whose current value is at least 1. */
export function getEligibleBuildingComponents(building: Building): BuildingComponent[] {
  const a = building.attributes;
  if (!a) return [];
  return BUILDING_COMPONENTS.filter((c) => (a[c] ?? 0) >= 1);
}

/** Reduce one building component by one point, mutating in place. */
export function applyBuildingComponentDamage(
  building: Building,
  component: BuildingComponent,
): BuildingDamageEvent | null {
  const a = building.attributes;
  if (!a) return null;
  const current = a[component] ?? 0;
  if (current < 1) return null;
  const newValue = current - 1;
  a[component] = newValue;
  return { buildingId: building.id, component, newValue, destroyed: newValue === 0 };
}


/** Resolve Direct_Fire against one selected building component. */
export function resolveBuildingDirectFire(
  attackerId: string,
  building: Building,
  component: BuildingComponent | undefined,
  ctx: CombatContext,
): CombatResult {
  const { units: allUnits, tiles } = ctx;
  const attacker = allUnits.find((u) => u.id === attackerId);

  if (!attacker) return invalidResult(attackerId, building.id, 'Attacker not found');
  if (attacker.currentHealth <= 0) return invalidResult(attackerId, building.id, 'Attacker is destroyed');
  if (attacker.ownerId === building.ownerId) {
    return invalidResult(attackerId, building.id, 'Cannot attack a friendly building');
  }
  if ((attacker.attributes.kinetic ?? 0) <= 0) {
    return invalidResult(attackerId, building.id, 'Attacker has no Direct Fire weapon');
  }

  const segDist = effectiveCombatDistance(
    tiles, attacker, { tileIndex: building.tileIndex, segment: building.segment as HexSegment },
  );
  const elevRangeMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].height ?? 0,
    tiles[building.tileIndex].height ?? 0,
    isDrone(attacker),
  );
  const rangeThreshold = getSegmentRangeThreshold(attacker) * elevRangeMult;
  if (segDist > rangeThreshold) {
    return invalidResult(attackerId, building.id, 'Target out of range');
  }

  const eligible = getEligibleBuildingComponents(building);
  if (eligible.length === 0) {
    return { ...directFireBaseResult(attacker.id, building.id), buildingDamage: [] };
  }

  if (component === undefined) {
    return invalidResult(attackerId, building.id, 'A component selection is required');
  }
  if (!eligible.includes(component)) {
    return invalidResult(attackerId, building.id, 'Selected component cannot be targeted');
  }

  const event = applyBuildingComponentDamage(building, component);
  return {
    ...directFireBaseResult(attacker.id, building.id),
    buildingDamage: event ? [event] : [],
  };
}

/** Damage each eligible enemy building in array order, drawing once per building. */
export function resolveBuildingSplashInHex(
  attackerOwnerId: string,
  tileIndex: number,
  ctx: CombatContext,
  rng: RandomFn = Math.random,
): BuildingDamageEvent[] {
  const events: BuildingDamageEvent[] = [];
  for (const building of ctx.buildings) {
    if (building.tileIndex !== tileIndex) continue;
    if (building.ownerId === attackerOwnerId) continue;
    const eligible = getEligibleBuildingComponents(building);
    if (eligible.length === 0) continue;
    const pick = eligible[Math.floor(rng() * eligible.length)];
    const event = applyBuildingComponentDamage(building, pick);
    if (event) events.push(event);
  }
  return events;
}

/** Resolve Splash_Fire against all enemy units and buildings in a hex. */
export function resolveSplashHex(
  attackerId: string,
  tileIndex: number,
  ctx: CombatContext,
  rng: RandomFn = Math.random,
): CombatResult {
  const { units: allUnits, tiles } = ctx;
  const hexTargetId = `tile_${tileIndex}`;
  const attacker = allUnits.find((u) => u.id === attackerId);

  if (!attacker) return invalidResult(attackerId, hexTargetId, 'Attacker not found');
  if (attacker.currentHealth <= 0) return invalidResult(attackerId, hexTargetId, 'Attacker is destroyed');
  if ((attacker.attributes.splashAttack ?? 0) <= 0) {
    return invalidResult(attackerId, hexTargetId, 'Attacker has no Splash Fire weapon');
  }

  const segDist = segmentDistance(
    tiles, attacker.tileIndex, attacker.segment, tileIndex, 0 as HexSegment,
  );
  const elevRangeMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].height ?? 0,
    tiles[tileIndex].height ?? 0,
    isDrone(attacker),
  );
  if (segDist > getSegmentRangeThreshold(attacker) * elevRangeMult) {
    return invalidResult(attackerId, hexTargetId, 'Target out of range');
  }

  const splashEvents: SplashEvent[] = [];
  const destroyedIds: string[] = [];
  const enemyUnits = allUnits.filter(
    (u) => u.ownerId !== attacker.ownerId && u.currentHealth > 0 && u.tileIndex === tileIndex,
  );
  for (const victim of enemyUnits) {
    const dmg = calculateSplashDamage(attacker, attacker, victim, ctx, segDist);
    victim.currentHealth = applyDamage(victim.currentHealth, dmg);
    const destroyed = victim.currentHealth <= 0;
    if (destroyed) destroyedIds.push(victim.id);
    splashEvents.push({ victimId: victim.id, damage: dmg, victimDestroyed: destroyed });
  }

  const buildingDamage = resolveBuildingSplashInHex(attacker.ownerId, tileIndex, ctx, rng);

  return {
    attackerId,
    targetId: hexTargetId,
    wasValid: true,
    attackArc: 'front',
    facingModifier: 0,
    targetArmour: 0,
    targetEffectiveDefense: 0,
    directDamage: splashEvents.reduce((sum, e) => sum + e.damage, 0),
    antiAirDamage: 0,
    splashEvents,
    destroyedUnitIds: destroyedIds,
    reactionEvents: [],
    chosenWeaponMode: 'splash',
    buildingDamage,
  };
}