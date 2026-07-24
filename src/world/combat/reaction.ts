import { applyDamage, computeDamage } from '../combatFormula.js';
import type { ChassisType } from '../combatFormula.js';
import type { Building } from '../types.js';
import type { Unit } from '../units.js';
import type { HexSegment } from '../units.js';
import { getChassisType, isDrone } from './context.js';
import { getDefencePower } from './defence.js';
import type { CombatContext, CombatResult } from './types.js';

/** Calculate Anti-Air Reaction Fire damage against a drone. */
export function calculateAntiAirReactionDamage(
  reactor: Unit | Building,
  drone: Unit,
  ctx: CombatContext,
): number {
  const reactorIsDrone = 'currentHealth' in reactor && isDrone(reactor as Unit);
  const defPower = getDefencePower(drone, ctx, reactorIsDrone);
  const attackerChassis: ChassisType =
    'currentHealth' in reactor ? getChassisType(reactor as Unit) : 'tank';
  const { finalDamage } = computeDamage({
    mode: 'antiAir',
    attackerChassis,
    baseWeaponValue: reactor.attributes?.antiAir ?? 0,
    orientationArmourPenalty: 0,
    distance: 1,
    armour: defPower.armour,
    defenceOther: defPower.ew,
    targetIsDrone: true,
    isReactionFire: true,
  });
  return finalDamage;
}

/** Resolve all eligible enemy unit and building AA reactors in one tile. */
export function resolveAntiAirReactionFireForTile(
  drone: Unit,
  tileIndex: number,
  ctx: CombatContext,
  reactedThisAction: Set<string>,
): CombatResult[] {
  const { units: allUnits, buildings: allBuildings } = ctx;
  const results: CombatResult[] = [];

  const reactors: Array<Unit | Building> = [

    ...allUnits.filter(
      (u) => u.ownerId !== drone.ownerId &&
             u.currentHealth > 0 &&
             (u.attributes.antiAir ?? 0) > 0 &&
             u.tileIndex === tileIndex &&
             !reactedThisAction.has(u.id),
    ),
    ...allBuildings.filter(
      (b) => b.ownerId !== drone.ownerId &&
             (b.attributes?.antiAir ?? 0) > 0 &&
             b.tileIndex === tileIndex &&
             !reactedThisAction.has(b.id),
    ),
  ];

  for (const reactor of reactors) {
    if (reactedThisAction.has(reactor.id)) continue;
    reactedThisAction.add(reactor.id);

    const damage = calculateAntiAirReactionDamage(reactor, drone, ctx);
    drone.currentHealth = applyDamage(drone.currentHealth, damage);
    const destroyed = drone.currentHealth <= 0;

    const reactorIsDrone = 'currentHealth' in reactor && isDrone(reactor as Unit);
    results.push({
      attackerId: reactor.id,
      targetId: drone.id,
      wasValid: true,
      attackArc: 'front',
      facingModifier: 0,
      targetArmour: drone.attributes.armour ?? 0,
      targetEffectiveDefense: getDefencePower(drone, ctx, reactorIsDrone).total,
      directDamage: damage,
      antiAirDamage: damage,
      splashEvents: [],
      destroyedUnitIds: destroyed ? [drone.id] : [],
      reactionEvents: [],
      chosenWeaponMode: 'antiAir',
      buildingDamage: [],
    });

    if (destroyed) break;
  }

  return results;
}

/** Resolve Anti-Air Reaction Fire as a drone moves along a path. */
export function resolveReactionFire(
  movingUnitId: string,
  path: number[],
  ctx: CombatContext,
): CombatResult[] {
  const { units: allUnits, tiles } = ctx;
  const movingUnit = allUnits.find((u) => u.id === movingUnitId);
  if (!movingUnit || movingUnit.currentHealth <= 0) return [];
  if (!isDrone(movingUnit)) return [];

  const results: CombatResult[] = [];
  const reactedThisAction = new Set<string>();

  for (let i = 1; i < path.length; i++) {
    const prevHex = path[i - 1];
    const currentHex = path[i];

    movingUnit.tileIndex = currentHex;
    const dir = tiles[prevHex].neighbours.indexOf(currentHex);
    if (dir !== -1) {
      movingUnit.facing = dir as HexSegment;
    }

    const tileResults = resolveAntiAirReactionFireForTile(
      movingUnit, currentHex, ctx, reactedThisAction,
    );
    results.push(...tileResults);

    if (movingUnit.currentHealth <= 0) {
      return results;
    }
  }

  return results;
}