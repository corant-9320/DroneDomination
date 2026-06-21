/**
 * Combat Formula — the single, self-contained damage calculation.
 *
 * This is the authoritative place to tune combat balance and change the damage
 * formula. It is PURE and SELF-CONTAINED:
 *
 *   - No imports of `Unit`, `Tile`, or any game-state type.
 *   - Every function takes plain data (numbers / small param objects) and
 *     returns plain data. It never reaches out into the world to discover
 *     anything — the caller gathers world state and passes it in cleanly.
 *
 * The world-state gathering (EW sums, terrain, elevation levels, bearing-based
 * orientation, segment distance) lives in `combat.ts`, which builds the clean
 * input objects below and calls `computeDamage`.
 */

import {
  SEGMENT_RANGE_PER_POINT as _SEGMENT_RANGE_PER_POINT,
  SEGMENT_RANGE_BASE as _SEGMENT_RANGE_BASE,
} from '../../shared/rangeCheck.js';

// ---------------------------------------------------------------------------
// Core damage constants
// ---------------------------------------------------------------------------

export const DEFENCE_SCALE = 0.75;
export const MAX_DAMAGE = 30;
export const MIN_DAMAGE = 1;
export const SPLASH_SCALE = 0.3;

/**
 * AttackPower is reduced by 10% for each unit of segment-distance beyond 1.
 * rangeEfficiency = 1 - RANGE_FALLOFF_PER_SEGMENT_UNIT × max(0, distance - 1)
 */
export const RANGE_FALLOFF_PER_SEGMENT_UNIT = 0.10;

/**
 * Maximum possible damage contribution per point of AttackPower before the
 * global cap is applied.
 */
export const DAMAGE_PER_ATTACK_POWER = 6;

// Re-exported from the shared range-gate module (single source of truth).
export const SEGMENT_RANGE_PER_POINT = _SEGMENT_RANGE_PER_POINT;
export const SEGMENT_RANGE_BASE = _SEGMENT_RANGE_BASE;

// ---------------------------------------------------------------------------
// Chassis attack modifiers — outgoing weapon power multiplier by chassis
// ---------------------------------------------------------------------------

/** Outgoing weapon power multiplier for wheeled (tank) units — the baseline. */
export const TANK_ATTACK_MODIFIER = 1.00;
/** Outgoing weapon power multiplier for limb/spider units. */
export const SPIDER_ATTACK_MODIFIER = 0.75;
/** Outgoing weapon power multiplier for flight/drone units. */
export const DRONE_ATTACK_MODIFIER = 0.50;

/** Chassis movement classes. */
export type ChassisType = 'tank' | 'spider' | 'drone';

// ---------------------------------------------------------------------------
// Drone incoming damage multipliers — per weapon mode
// ---------------------------------------------------------------------------

/** Direct Fire damage multiplier when the target is a drone (hard to hit). */
export const DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER = 0.33;
/** Splash Fire damage multiplier when the affected unit is a drone. */
export const DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER = 0.50;
/** Anti-Air damage multiplier when the target is a drone — purpose-built, no penalty. */
export const DRONE_ANTI_AIR_DAMAGE_MULTIPLIER = 1.00;

// ---------------------------------------------------------------------------
// Electronic Warfare
// ---------------------------------------------------------------------------
//
// EW is now a radius-based anti-drone screen (see combat.ts getEWProtection):
// a unit's `defence` value is its coverage radius in hops, contributing
// max(0, defence − distance) to friendly units within range, additive across
// sources. It ONLY mitigates damage from drone attackers. The old per-mode
// effectiveness table (direct/splash/antiAir) has been removed.

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------
//
// Elevation no longer affects damage. It affects attack RANGE instead — a unit
// on higher ground shoots farther, lower ground shorter. That logic lives in
// shared/rangeCheck.ts (elevationRangeMultiplier) so the client and server
// range gates agree.

/** Weapon mode names used throughout the formula. */
type WeaponMode = 'direct' | 'splash' | 'antiAir';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Clamp a value to [min, max]. */
export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(value, maxValue));
}

/**
 * Apply damage to a unit's current health.
 * Returns the new health value, clamped to [0, 50]. Damage minimum is 1.
 */
export function applyDamage(currentHealth: number, damage: number): number {
  currentHealth = clamp(currentHealth, 0, 50);
  damage = Math.max(1, damage);
  return clamp(currentHealth - damage, 0, 50);
}

/** Outgoing weapon power multiplier for a chassis class. */
export function getChassisModifier(chassis: ChassisType): number {
  switch (chassis) {
    case 'drone':  return DRONE_ATTACK_MODIFIER;
    case 'spider': return SPIDER_ATTACK_MODIFIER;
    case 'tank':   return TANK_ATTACK_MODIFIER;
    default:       return TANK_ATTACK_MODIFIER;
  }
}

/**
 * Range efficiency for a declared attack.
 * Distance 1 → 1.00, distance 2 → 0.90, distance 3 → 0.80, … (clamped to ≥ 0).
 */
export function calculateRangeEfficiency(distance: number): number {
  const d = Math.max(1, distance);
  return Math.max(0, 1 - RANGE_FALLOFF_PER_SEGMENT_UNIT * Math.max(0, d - 1));
}

/**
 * Modified attack power.
 * AttackPower = (baseWeaponValue × chassisModifier × rangeEfficiency) + orientationBonus,
 * floored at 0.01 to avoid zero-division in the damage formula.
 */
export function modifiedAttackPower(
  chassisModifier: number,
  baseWeaponValue: number,
  orientationBonus: number,
  rangeEfficiency: number,
): number {
  return Math.max(0.01, baseWeaponValue * chassisModifier * rangeEfficiency + orientationBonus);
}

/**
 * Core ratio-curve damage.
 * MaxFormulaDamage = min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER × attackPower)
 * Damage = round(MIN + (MaxFormulaDamage - MIN) × AP² / (AP² + ED²)), clamped.
 */
export function calculateFormulaDamage(attackPower: number, effectiveDefence: number): number {
  const maxFormulaDamage = Math.min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER * attackPower);
  const apSq = attackPower * attackPower;
  const edSq = effectiveDefence * effectiveDefence;
  const rawDamage = MIN_DAMAGE + (maxFormulaDamage - MIN_DAMAGE) * apSq / (apSq + edSq);
  return clamp(Math.round(rawDamage), MIN_DAMAGE, MAX_DAMAGE);
}

/**
 * Apply the drone incoming damage modifier based on weapon mode.
 * Only reduces damage when the target is a drone.
 */
export function droneIncomingDamageModifier(
  mode: WeaponMode,
  targetIsDrone: boolean,
  damage: number,
): number {
  if (!targetIsDrone) return damage;
  switch (mode) {
    case 'direct':  return Math.max(MIN_DAMAGE, Math.round(damage * DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER));
    case 'splash':  return Math.max(MIN_DAMAGE, Math.round(damage * DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER));
    case 'antiAir': return damage;
    default:        return damage;
  }
}

/**
 * Maximum segment-distance a unit can attack at.
 * threshold = rangeAttack × SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE.
 */
export function segmentRangeThreshold(rangeAttack: number): number {
  return rangeAttack * SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE;
}

// ---------------------------------------------------------------------------
// computeDamage — the single damage entry point
// ---------------------------------------------------------------------------

/**
 * Clean, plain-data description of a single damage calculation. The caller
 * (combat.ts) gathers all of this from the world and passes it in; the formula
 * never reads game state itself.
 */
export interface DamageInput {
  /** Weapon mode being resolved. */
  mode: WeaponMode;
  /** Attacker chassis class (sets the outgoing power multiplier). */
  attackerChassis: ChassisType;
  /** Raw weapon attribute value (kinetic / splashAttack / antiAir). Clamped to [1,5] internally. */
  baseWeaponValue: number;
  /** Bearing-based orientation bonus (0–2). Pass 0 for non-primary splash victims. */
  orientationBonus: number;
  /** Segment distance attacker→target, for range falloff. */
  distance: number;
  /** Defender's effective defence (DefencePower × DEFENCE_SCALE), already composed by the caller. */
  effectiveDefence: number;
  /** Whether the target is a drone (drives incoming-damage modifier). */
  targetIsDrone: boolean;
  /** Anti-air reaction fire: no range falloff, no orientation bonus (snap shot). */
  isReactionFire?: boolean;
}

/** Full breakdown of a damage calculation — every intermediate value. */
export interface DamageBreakdown {
  chassisModifier: number;
  rangeEfficiency: number;
  attackPower: number;
  effectiveDefence: number;
  rawFormulaDamage: number;
  finalDamage: number;
}

/**
 * Compute damage for a single attack from fully-gathered, plain inputs.
 *
 * Order of operations (matches the documented combat rules):
 *   1. AttackPower = (clamp(base,1,5) × chassisMod × rangeEff) + orientation
 *   2. rawFormulaDamage = ratio curve vs effectiveDefence
 *   3. × SPLASH_SCALE (splash mode only)
 *   4. × drone incoming-damage modifier (drone targets only)
 *
 * Elevation no longer affects damage (it affects range — see rangeCheck.ts).
 */
export function computeDamage(input: DamageInput): DamageBreakdown {
  const chassisModifier = getChassisModifier(input.attackerChassis);
  const rangeEfficiency = input.isReactionFire ? 1 : calculateRangeEfficiency(input.distance);
  const orientation = input.isReactionFire ? 0 : input.orientationBonus;
  const base = clamp(input.baseWeaponValue, 1, 5);
  const attackPower = modifiedAttackPower(chassisModifier, base, orientation, rangeEfficiency);

  const rawFormulaDamage = calculateFormulaDamage(attackPower, input.effectiveDefence);

  let damage = rawFormulaDamage;

  if (input.mode === 'splash') {
    damage = Math.max(MIN_DAMAGE, Math.round(damage * SPLASH_SCALE));
  }

  damage = droneIncomingDamageModifier(input.mode, input.targetIsDrone, damage);

  return {
    chassisModifier,
    rangeEfficiency,
    attackPower,
    effectiveDefence: input.effectiveDefence,
    rawFormulaDamage,
    finalDamage: damage,
  };
}
