/**
 * Combat Math — pure damage formulas with no game-state dependencies.
 *
 * All functions here are stateless: given inputs, they return outputs.
 * They do not read or mutate any unit arrays or tile arrays.
 */

import { Unit } from './units.js';
import { Tile, ElevationType } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFENCE_SCALE = 0.75;
export const MAX_DAMAGE = 30;
export const MIN_DAMAGE = 1;
export const SPLASH_SCALE = 0.3;

/**
 * AttackPower is reduced by 10% for each unit of segment-distance beyond 1.
 * rangeEfficiency = 1 - RANGE_FALLOFF_PER_SEGMENT_UNIT × max(0, distance - 1)
 * Applies to declared attacks only (Direct Fire, Splash Fire, Anti-Air Fire).
 * Does NOT apply to Anti-Air Reaction Fire.
 */
export const RANGE_FALLOFF_PER_SEGMENT_UNIT = 0.10;

/**
 * Maximum possible damage contribution per point of AttackPower before the
 * global cap is applied. Ensures weak attacks cannot deal full damage against
 * undefended targets.
 */
export const DAMAGE_PER_ATTACK_POWER = 6;

// ---------------------------------------------------------------------------
// Segment-based range gate constants
// ---------------------------------------------------------------------------

import {
  SEGMENT_RANGE_PER_POINT as _SEGMENT_RANGE_PER_POINT,
  SEGMENT_RANGE_BASE as _SEGMENT_RANGE_BASE,
} from '../../shared/rangeCheck.js';

// Re-export for downstream consumers
export const SEGMENT_RANGE_PER_POINT = _SEGMENT_RANGE_PER_POINT;
export const SEGMENT_RANGE_BASE = _SEGMENT_RANGE_BASE;

// ---------------------------------------------------------------------------
// Chassis attack modifiers — outgoing weapon power multiplier by movement type
// ---------------------------------------------------------------------------

/**
 * Outgoing weapon power multiplier for wheeled (tank) units.
 * Tanks are the baseline — full attack power, lowest mobility.
 */
export const TANK_ATTACK_MODIFIER = 1.00;

/**
 * Outgoing weapon power multiplier for limb/spider units.
 * Spiders trade 25% attack power for superior terrain traversal.
 */
export const SPIDER_ATTACK_MODIFIER = 0.75;

/**
 * Outgoing weapon power multiplier for flight/drone units.
 * Drones trade 50% attack power for full mobility and reaction-fire immunity
 * (ground units). They are also vulnerable to anti-air weapons.
 */
export const DRONE_ATTACK_MODIFIER = 0.50;

// ---------------------------------------------------------------------------
// Drone incoming damage multipliers — per weapon mode
// ---------------------------------------------------------------------------

/**
 * Direct Fire damage multiplier when the target is a drone.
 * Drones are hard to hit with direct fire — small profile, fast movement.
 * Value: 0.33 (roughly 1/3 of normal damage).
 */
export const DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER = 0.33;

/**
 * Splash Fire damage multiplier when the affected unit is a drone.
 * Drones are somewhat harder to catch in a blast radius than ground units.
 * Value: 0.50 (half of normal splash damage).
 */
export const DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER = 0.50;

/**
 * Anti-Air damage multiplier when the target is a drone.
 * AA weapons are purpose-built for aerial targets — no penalty.
 * Value: 1.00 (full damage).
 */
export const DRONE_ANTI_AIR_DAMAGE_MULTIPLIER = 1.00;

// ---------------------------------------------------------------------------
// Unit classification helpers
// ---------------------------------------------------------------------------

/** Returns true if the unit has a flight chassis (drone). */
export function isDrone(unit: Unit): boolean {
  return (unit.attributes.flightMovement ?? 0) >= 1;
}

/**
 * Get the chassis attack modifier for a unit based on its movement type.
 * Drones (flightMovement > 0) → 0.50
 * Spiders (limbMovement > 0) → 0.75
 * Tanks (wheeledMovement > 0) → 1.00
 * Default → 1.00
 */
export function getChassisAttackModifier(unit: Unit): number {
  if ((unit.attributes.flightMovement ?? 0) > 0) return DRONE_ATTACK_MODIFIER;
  if ((unit.attributes.limbMovement ?? 0) > 0) return SPIDER_ATTACK_MODIFIER;
  if ((unit.attributes.wheeledMovement ?? 0) > 0) return TANK_ATTACK_MODIFIER;
  return TANK_ATTACK_MODIFIER;
}

// ---------------------------------------------------------------------------
// Range efficiency
// ---------------------------------------------------------------------------

/**
 * Calculate range efficiency for a declared attack.
 *
 * rangeEfficiency = 1 - RANGE_FALLOFF_PER_SEGMENT_UNIT × max(0, distance - 1)
 * Distance 1 → 1.00, distance 2 → 0.90, distance 3 → 0.80, etc.
 * Minimum 0 (clamped). Does NOT apply to Anti-Air Reaction Fire.
 */
export function calculateRangeEfficiency(distance: number): number {
  const d = Math.max(1, distance);
  return Math.max(0, 1 - RANGE_FALLOFF_PER_SEGMENT_UNIT * Math.max(0, d - 1));
}

// ---------------------------------------------------------------------------
// Attack power
// ---------------------------------------------------------------------------

/**
 * Calculate the modified attack power for a weapon, applying the chassis
 * modifier, range efficiency, and orientation bonus.
 *
 * AttackPower = (baseWeaponValue × chassisModifier × rangeEfficiency) + orientationBonus
 * Minimum 0.01 to avoid zero-division in the damage formula.
 *
 * @param distance - graph distance from attacker to target (for range falloff).
 *   Pass 1 for melee / reaction fire (no falloff).
 */
export function calculateModifiedAttackPower(
  unit: Unit,
  baseWeaponValue: number,
  orientationBonus: number,
  distance: number = 1,
): number {
  const chassisModifier = getChassisAttackModifier(unit);
  const rangeEfficiency = calculateRangeEfficiency(distance);
  const attackPower = baseWeaponValue * chassisModifier * rangeEfficiency + orientationBonus;
  return Math.max(0.01, attackPower);
}

// ---------------------------------------------------------------------------
// Drone incoming damage modifier
// ---------------------------------------------------------------------------

/**
 * Apply the drone incoming damage modifier based on weapon mode.
 * Only reduces damage when the target is a drone (flightMovement >= 1).
 */
export function applyDroneIncomingDamageModifier(
  weaponMode: 'direct' | 'splash' | 'antiAir',
  targetUnit: Unit,
  damage: number,
): number {
  if (!isDrone(targetUnit)) return damage;
  switch (weaponMode) {
    case 'direct':  return Math.max(MIN_DAMAGE, Math.round(damage * DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER));
    case 'splash':  return Math.max(MIN_DAMAGE, Math.round(damage * DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER));
    case 'antiAir': return damage; // no penalty
    default:        return damage;
  }
}

// ---------------------------------------------------------------------------
// Core damage formula
// ---------------------------------------------------------------------------

/** Clamp a value to [min, max]. */
export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(value, maxValue));
}

/**
 * Apply damage to a unit's current health.
 * Returns the new health value, clamped to [0, 50].
 * Damage minimum is 1 (no upper clamp — combined direct+splash can exceed 30).
 */
export function applyDamage(currentHealth: number, damage: number): number {
  currentHealth = clamp(currentHealth, 0, 50);
  damage = Math.max(1, damage);
  const newHealth = currentHealth - damage;
  return clamp(newHealth, 0, 50);
}

/**
 * Core formula damage helper — calculates full formula damage given
 * an attack power and effective defence (already scaled).
 *
 * MaxFormulaDamage = min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER * attackPower)
 * Damage = round(MIN_DAMAGE + (MaxFormulaDamage - MIN_DAMAGE) * AP² / (AP² + ED²))
 * Clamped to [MIN_DAMAGE, MAX_DAMAGE].
 */
export function calculateFormulaDamage(attackPower: number, effectiveDefence: number): number {
  const maxFormulaDamage = Math.min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER * attackPower);
  const apSq = attackPower * attackPower;
  const edSq = effectiveDefence * effectiveDefence;
  const rawDamage =
    MIN_DAMAGE +
    (maxFormulaDamage - MIN_DAMAGE) * apSq / (apSq + edSq);
  return clamp(Math.round(rawDamage), MIN_DAMAGE, MAX_DAMAGE);
}

// ---------------------------------------------------------------------------
// Elevation advantage
// ---------------------------------------------------------------------------

/** Map elevation type to numeric level for comparison. */
export function getElevationLevel(elevationType: ElevationType): number {
  switch (elevationType) {
    case 'flat':     return 0;
    case 'rolling':  return 1;
    case 'hills':    return 2;
    case 'mountain': return 3;
    default:         return 0;
  }
}

/**
 * Elevation advantage multiplier per level difference.
 * +10% per elevation level the attacker is above the defender.
 * -10% per elevation level the attacker is below the defender.
 */
export const ELEVATION_MULTIPLIER_PER_LEVEL = 0.10;

/**
 * Calculate the elevation damage multiplier.
 *
 * elevationDelta = attackerLevel - defenderLevel
 * multiplier = 1 + (delta × 0.10), clamped to [0.70, 1.30]
 *
 * Returns 1.0 (no effect) when either unit is a drone (airborne).
 */
export function calculateElevationMultiplier(
  attackerTile: Tile,
  defenderTile: Tile,
  attackerUnit: Unit,
  targetUnit: Unit,
): number {
  // Drones are airborne — elevation advantage does not apply
  if (isDrone(attackerUnit) || isDrone(targetUnit)) return 1.0;

  const attackerLevel = getElevationLevel(attackerTile.elevationType);
  const defenderLevel = getElevationLevel(defenderTile.elevationType);
  const delta = attackerLevel - defenderLevel;
  const multiplier = 1 + delta * ELEVATION_MULTIPLIER_PER_LEVEL;
  return clamp(multiplier, 0.70, 1.30);
}

// ---------------------------------------------------------------------------
// Segment-based range gate
// ---------------------------------------------------------------------------

/**
 * Get the maximum segment-distance a unit can attack at.
 *
 * threshold = rangeAttack * SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE
 *
 * A unit must have at least one weapon (kinetic, splashAttack, or antiAir)
 * to attack at all — rangeAttack alone doesn't grant attack capability.
 * However any weapon-bearing unit gets at least the base reach (0.5).
 *
 * Examples:
 *   rangeAttack 0 → threshold 0.5  (adjacent segment)
 *   rangeAttack 1 → threshold 1.5  (1 hex + segment)
 *   rangeAttack 2 → threshold 2.5  (2 hexes + segment)
 *   rangeAttack 5 → threshold 5.5  (5 hexes + segment)
 */
export function getSegmentRangeThreshold(unit: Unit): number {
  const range = unit.attributes.rangeAttack ?? 0;
  return range * SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE;
}
