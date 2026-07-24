import {
  clamp,
  computeDamage,
} from '../combatFormula.js';
import type { AttackArc } from '../combatFacing.js';
import {
  calculateOrientationArmourPenalty,
  classifyArcFromAngle,
  getAngularDifference,
} from '../combatFacing.js';
import type { Tile } from '../types.js';
import type { Unit } from '../units.js';
import {
  getChassisType,
  isDrone,
} from './context.js';
import type { CombatContext } from './types.js';

export const MAX_EW_RADIUS = 5;

/** BFS hop-distance map from a start tile out to maxRadius (inclusive). */
function bfsHopDistances(tiles: Tile[], start: number, maxRadius: number): Map<number, number> {
  const dist = new Map<number, number>();
  dist.set(start, 0);
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const d = dist.get(current)!;
    if (d >= maxRadius) continue;
    for (const n of tiles[current].neighbours) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}


/** Radius-based Electronic Warfare protection for a target unit. */
export function getEWProtection(target: Unit, ctx: CombatContext): number {
  const { units: allUnits, tiles, buildings } = ctx;
  const dist = bfsHopDistances(tiles, target.tileIndex, MAX_EW_RADIUS);

  const contribution = (ownerId: string, tileIndex: number, defence: number): number => {
    if (ownerId !== target.ownerId) return 0;
    if (defence <= 0) return 0;
    const d = tileIndex === target.tileIndex ? 0 : dist.get(tileIndex);
    if (d === undefined) return 0;
    return Math.max(0, defence - d);
  };

  let total = 0;
  for (const unit of allUnits) {
    if (unit.currentHealth <= 0) continue;
    total += contribution(unit.ownerId, unit.tileIndex, unit.attributes.defence ?? 0);
  }
  for (const building of buildings) {
    total += contribution(building.ownerId, building.tileIndex, building.attributes?.defence ?? 0);
  }
  return Math.min(total, 5);
}

/** Forest is the only terrain defence component; elevation affects range. */
export function getTerrainDefense(tile: Tile): number {
  if (tile.forested) return 1;
  return 0;
}

/** Calculate armour + applicable anti-drone EW + terrain defence. */
export function getDefencePower(
  target: Unit,
  ctx: CombatContext,
  attackerIsDrone: boolean = false,
): { armour: number; ew: number; ewRaw: number; ewMultiplier: number; defensiveFormation: number; terrain: number; total: number } {
  const { tiles } = ctx;
  const armour = clamp(target.attributes.armour ?? 0, 0, 5);
  const ewRaw = getEWProtection(target, ctx);
  const ewMultiplier = attackerIsDrone ? 1 : 0;
  const ew = ewRaw * ewMultiplier;
  const defensiveFormation = 0;
  const terrain = clamp(getTerrainDefense(tiles[target.tileIndex]), 0, 1);
  const total = armour + ew + terrain;

  return { armour, ew, ewRaw, ewMultiplier, defensiveFormation, terrain, total };
}

/** Calculate direct damage and its contextual defence/orientation data. */
export function calculateDirectDamage(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
  distance: number = 1,
): { damage: number; arc: AttackArc; orientationArmourPenalty: number; defencePower: ReturnType<typeof getDefencePower>; antiDronePenaltyApplied: boolean } {
  const { tiles } = ctx;
  const orientationArmourPenalty = calculateOrientationArmourPenalty(
    tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment,
  );
  const angleDiff = getAngularDifference(
    tiles, attacker.tileIndex, target.tileIndex, target.facing, attacker.segment, target.segment,
  );
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  const defencePower = getDefencePower(target, ctx, isDrone(attacker));
  const antiDronePenaltyApplied = isDrone(target);

  const { finalDamage } = computeDamage({
    mode: 'direct',
    attackerChassis: getChassisType(attacker),
    baseWeaponValue: attacker.attributes.kinetic ?? 0,
    orientationArmourPenalty,
    distance,
    armour: defencePower.armour,
    defenceOther: defencePower.ew + defencePower.terrain,
    targetIsDrone: antiDronePenaltyApplied,
  });

  return { damage: finalDamage, arc, orientationArmourPenalty, defencePower, antiDronePenaltyApplied };
}

/** Calculate splash damage for one enemy unit in the target hex. */
export function calculateSplashDamage(
  attacker: Unit,
  selectedTarget: Unit,
  victim: Unit,
  ctx: CombatContext,
  distance: number = 1,
): number {
  const { tiles } = ctx;
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0) return 0;

  const orientationArmourPenalty = victim.id === selectedTarget.id
    ? calculateOrientationArmourPenalty(
      tiles, attacker.tileIndex, victim.tileIndex, victim.facing, attacker.segment, victim.segment,
    )
    : 0;
  const defPower = getDefencePower(victim, ctx, isDrone(attacker));

  const { finalDamage } = computeDamage({
    mode: 'splash',
    attackerChassis: getChassisType(attacker),
    baseWeaponValue: splashPower,
    orientationArmourPenalty,
    distance,
    armour: defPower.armour,
    defenceOther: defPower.ew + defPower.terrain,
    targetIsDrone: isDrone(victim),
  });

  return finalDamage;
}