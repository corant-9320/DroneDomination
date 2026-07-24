import type { ChassisType } from '../combatFormula.js';
import {
  SEGMENT_RANGE_BASE,
  droneIncomingDamageModifier,
  getChassisModifier,
  segmentRangeThreshold,
} from '../combatFormula.js';
import type { Unit } from '../units.js';

/** Returns true if the unit has a flight chassis (drone). */
export function isDrone(unit: Unit): boolean {
  return (unit.attributes.flightMovement ?? 0) >= 1;
}

/** Classify a unit's chassis from its movement attributes. */
export function getChassisType(unit: Unit): ChassisType {
  if ((unit.attributes.flightMovement ?? 0) > 0) return 'drone';
  if ((unit.attributes.limbMovement ?? 0) > 0) return 'spider';
  return 'tank';
}

/** Outgoing weapon power multiplier for a unit (by chassis). */
export function getChassisAttackModifier(unit: Unit): number {
  return getChassisModifier(getChassisType(unit));
}

/** Apply the drone incoming damage modifier (adapter — resolves isDrone). */
export function applyDroneIncomingDamageModifier(
  weaponMode: 'direct' | 'splash' | 'antiAir',
  targetUnit: Unit,
  damage: number,
): number {
  return droneIncomingDamageModifier(weaponMode, isDrone(targetUnit), damage);
}

/** Segment-distance range threshold for a unit (adapter).
 * Drones are hard-locked to adjacent reach (range 1) — they drop bombs / collide,
 * so they have no rangeAttack and ignore any that might be present. */
export function getSegmentRangeThreshold(unit: Unit): number {
  if (isDrone(unit)) return SEGMENT_RANGE_BASE;
  return segmentRangeThreshold(unit.attributes.rangeAttack ?? 0);
}