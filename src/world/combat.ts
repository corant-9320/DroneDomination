/**
 * Combat System — deterministic drone combat on a hex grid.
 *
 * Damage formula (attack-scaled ratio curve):
 *   MaxFormulaDamage = min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER * AttackPower)
 *   Damage = round(MIN_DAMAGE + (MaxFormulaDamage - MIN_DAMAGE) * AttackPower² / (AttackPower² + EffectiveDefence²))
 *   Damage = clamp(Damage, MIN_DAMAGE, MAX_DAMAGE)
 *
 * Key properties:
 * - Minimum damage is always 1 (weak attacks are never useless)
 * - Maximum damage is 30
 * - Weak attacks can no longer deal 30 damage against undefended targets
 * - Strong attacks (AttackPower ≥ 5) can still reach 30 against undefended targets
 * - Defence uses a 0.75 scale factor to stay meaningful without being overwhelming
 * - Orientation is additive: front +0, side +1, rear +2
 *
 * The pure, self-contained damage formula lives in combatFormula.ts.
 * Arc/facing geometry lives in combatFacing.ts.
 *
 * This file is the GATHERING/ADAPTER layer: it reads game state (units, tiles,
 * EW, terrain, elevation, bearing) and packs clean inputs for combatFormula's
 * computeDamage(). The Unit/Tile-taking helpers below are thin adapters over
 * the pure formula functions, kept for backward compatibility.
 */

import { Tile, ElevationType, Building } from './types.js';
import { Unit, HexSegment } from './units.js';
import { effectiveCombatDistance, segmentDistance } from './segmentGeometry.js';
import { elevationRangeMultiplier } from '../../shared/rangeCheck.js';

// ---------------------------------------------------------------------------
// Re-export the pure formula surface so existing importers stay compatible
// ---------------------------------------------------------------------------

export {
  // Constants
  DEFENCE_SCALE,
  MAX_DAMAGE,
  MIN_DAMAGE,
  SPLASH_SCALE,
  RANGE_FALLOFF_PER_SEGMENT_UNIT as RANGE_FALLOFF_PER_HEX,
  DAMAGE_PER_ATTACK_POWER,
  SEGMENT_RANGE_PER_POINT,
  SEGMENT_RANGE_BASE,
  TANK_ATTACK_MODIFIER,
  SPIDER_ATTACK_MODIFIER,
  DRONE_ATTACK_MODIFIER,
  DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER,
  DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER,
  DRONE_ANTI_AIR_DAMAGE_MULTIPLIER,
  // Pure functions
  calculateRangeEfficiency,
  clamp,
  applyDamage,
  calculateFormulaDamage,
  computeDamage,
  // Types
  type ChassisType,
  type DamageInput,
  type DamageBreakdown,
} from './combatFormula.js';

export {
  // Types
  type TargetOrientation,
  type AttackArc,
  // Functions
  getOrientationBonus,
  getDirectionBetweenAdjacentHexes,
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  getCrossfireBonus,
  calculateOrientationBonus,
  classifyArcFromAngle,
  getAngularDifference,
  getBearingBetweenTiles,
  getFacingAngle,
} from './combatFacing.js';

// ---------------------------------------------------------------------------
// Local imports (for use within this file)
// ---------------------------------------------------------------------------

import {
  DEFENCE_SCALE,
  SEGMENT_RANGE_BASE,
  type ChassisType,
  getChassisModifier,
  calculateRangeEfficiency,
  modifiedAttackPower,
  droneIncomingDamageModifier,
  segmentRangeThreshold,
  clamp,
  applyDamage,
  computeDamage,
} from './combatFormula.js';

import {
  type AttackArc,
  getOrientationBonus,
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  calculateOrientationBonus,
  classifyArcFromAngle,
  getAngularDifference,
} from './combatFacing.js';

// ---------------------------------------------------------------------------
// Combat context — the shared world state every combat calculation reads
// ---------------------------------------------------------------------------

/**
 * Bundles the world state combat functions need. Passing this single object
 * (instead of threading `units`/`tiles`/`buildings` positionally through every
 * function) means adding a new state source later only touches the functions
 * that actually read it — not every signature in the call chain.
 *
 * `units` is mutated in place by the `resolve*` functions (health changes).
 */
export interface CombatContext {
  /** All units on the board. */
  units: Unit[];
  /** Tile adjacency / terrain data. */
  tiles: Tile[];
  /** Buildings on the board — EW-bearing buildings project anti-drone screens. */
  buildings: Building[];
}

// ---------------------------------------------------------------------------
// Unit/Tile adapters — gather state from game objects, delegate to combatFormula
// ---------------------------------------------------------------------------

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

/**
 * Modified attack power for a unit's weapon (adapter over combatFormula).
 * @param distance graph distance for range falloff (1 = no falloff).
 */
export function calculateModifiedAttackPower(
  unit: Unit,
  baseWeaponValue: number,
  orientationBonus: number,
  distance: number = 1,
): number {
  return modifiedAttackPower(
    getChassisAttackModifier(unit),
    baseWeaponValue,
    orientationBonus,
    calculateRangeEfficiency(distance),
  );
}

/** Map elevation type to a numeric level for comparison. */
export function getElevationLevel(elevationType: ElevationType): number {
  switch (elevationType) {
    case 'flat':     return 0;
    case 'rolling':  return 1;
    case 'hills':    return 2;
    case 'mountain': return 3;
    default:         return 0;
  }
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

// ---------------------------------------------------------------------------
// Formation support — DEPRECATED (2026-06-21)
// ---------------------------------------------------------------------------
//
// The defensive-formation bonus (defence for having adjacent friendly units)
// has been removed. It is not realistic in modern missile warfare and it
// complicated the defence calculation. DefencePower no longer includes a
// formation term; the `defensiveFormation` field is retained as a constant 0
// for wire/UI compatibility and will be removed in the combat-formula refactor.

// ---------------------------------------------------------------------------
// Electronic Warfare (EW) — radius-based anti-drone screen
// ---------------------------------------------------------------------------

/**
 * Maximum EW coverage radius in hops (a unit's `defence` value is its radius,
 * 0–5, so 5 is the largest possible).
 */
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

/**
 * Radius-based Electronic Warfare protection for a target unit.
 *
 * Each friendly EW source — units AND buildings (including the target itself) —
 * with a `defence` value E projects an anti-drone screen of radius E hops,
 * contributing max(0, E − d) to a unit d hops away. Contributions are additive
 * across all sources, with no explicit cap — geometry limits it naturally (e.g.
 * three EW-5 screens one hop away give 3 × (5 − 1) = 12). Destroyed units and
 * enemies do not contribute; buildings are indestructible (building-damage
 * feature) and contribute while their `defence` component is ≥ 1.
 *
 * This value only mitigates damage from DRONE attackers (see getDefencePower).
 */
export function getEWProtection(target: Unit, ctx: CombatContext): number {
  const { units: allUnits, tiles, buildings } = ctx;
  const dist = bfsHopDistances(tiles, target.tileIndex, MAX_EW_RADIUS);

  const contribution = (ownerId: string, tileIndex: number, defence: number): number => {
    if (ownerId !== target.ownerId) return 0;
    if (defence <= 0) return 0;
    const d = tileIndex === target.tileIndex ? 0 : dist.get(tileIndex);
    if (d === undefined) return 0; // beyond max radius
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
  return total;
}

// ---------------------------------------------------------------------------
// Terrain defence value
// ---------------------------------------------------------------------------

/**
 * Get the terrain defence value for a tile.
 * Based on forest cover only — elevation is now handled by the
 * elevation advantage multiplier (offensive modifier).
 *
 * Forest: +1
 * Max 1.
 */
export function getTerrainDefense(tile: Tile): number {
  if (tile.forested) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Defence Power calculation
// ---------------------------------------------------------------------------

/**
 * EW effectiveness is no longer per-weapon-mode. EW is a radius-based
 * anti-drone screen that only mitigates damage from drone attackers.
 */

/**
 * Calculate the full DefencePower for a target unit.
 * DefencePower = armour + EW + terrain
 *
 * EW is the radius-based anti-drone screen (getEWProtection) and ONLY applies
 * when the attacker is a drone; against ground (tank/spider) attackers EW
 * contributes 0. (The defensive-formation term was deprecated 2026-06-21 and is always 0.)
 *
 * @param ctx - combat context (units, tiles, buildings) — buildings and units
 *   both act as EW sources via getEWProtection.
 * @param attackerIsDrone - whether the attacking unit is a drone (enables EW).
 */
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
  // Defensive formation bonus deprecated (2026-06-21).
  const defensiveFormation = 0;
  const terrain = clamp(getTerrainDefense(tiles[target.tileIndex]), 0, 1);
  const total = armour + ew + terrain;

  return { armour, ew, ewRaw, ewMultiplier, defensiveFormation, terrain, total };
}

// ---------------------------------------------------------------------------
// Direct and splash damage calculations (contextual — uses game state)
// ---------------------------------------------------------------------------

/**
 * Calculate direct damage from attacker to target using full game state.
 * Returns the damage amount along with breakdown info.
 *
 * AttackPower = (attack × chassisModifier × rangeEfficiency) + orientationBonus
 * If the target is a drone, Direct Fire damage is multiplied by
 * DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER (0.33).
 *
 * @param distance - graph distance from attacker to target (for range falloff).
 */
export function calculateDirectDamage(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
  distance: number = 1,
): { damage: number; arc: AttackArc; orientationBonus: number; defencePower: ReturnType<typeof getDefencePower>; antiDronePenaltyApplied: boolean } {
  const { tiles } = ctx;
  // New bearing-based orientation bonus (continuous 0–2)
  const orientationBonus = calculateOrientationBonus(tiles, attacker.tileIndex, target.tileIndex, target.facing);

  // Classify arc for UI/wire display from the angular difference
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);

  // EW (radius anti-drone screen) only applies when the attacker is a drone.
  const defencePower = getDefencePower(target, ctx, isDrone(attacker));
  const antiDronePenaltyApplied = isDrone(target);

  const { finalDamage } = computeDamage({
    mode: 'direct',
    attackerChassis: getChassisType(attacker),
    baseWeaponValue: attacker.attributes.kinetic ?? 0,
    orientationBonus,
    distance,
    effectiveDefence: defencePower.total * DEFENCE_SCALE,
    targetIsDrone: antiDronePenaltyApplied,
  });

  return { damage: finalDamage, arc, orientationBonus, defencePower, antiDronePenaltyApplied };
}

/**
 * Calculate splash damage for one enemy unit in the target hex.
 *
 * Orientation bonus applies only to the originally selected target.
 * All other units in the hex use front orientation (orientationBonus = 0).
 *
 * AttackPower = (splashAttack × chassisModifier × rangeEfficiency) + orientationBonus
 * If the victim is a drone, splash damage is multiplied by
 * DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER (0.50) after splash scaling.
 *
 * @param distance - graph distance from attacker to target hex (for range falloff).
 */
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

  // Orientation bonus only for the originally selected target (bearing-based)
  const orientationBonus = victim.id === selectedTarget.id
    ? calculateOrientationBonus(tiles, attacker.tileIndex, victim.tileIndex, victim.facing)
    : 0;

  // EW (radius anti-drone screen) only applies when the attacker is a drone.
  const defPower = getDefencePower(victim, ctx, isDrone(attacker));

  const { finalDamage } = computeDamage({
    mode: 'splash',
    attackerChassis: getChassisType(attacker),
    baseWeaponValue: splashPower,
    orientationBonus,
    distance,
    effectiveDefence: defPower.total * DEFENCE_SCALE,
    targetIsDrone: isDrone(victim),
  });

  return finalDamage;
}

// ---------------------------------------------------------------------------
// Combat result structures
// ---------------------------------------------------------------------------

export interface SplashEvent {
  victimId: string;
  damage: number;
  victimDestroyed: boolean;
}

export interface CombatResult {
  attackerId: string;
  targetId: string;
  wasValid: boolean;
  reasonInvalid?: string;
  attackArc: AttackArc;
  facingModifier: number;
  targetArmour: number;
  targetEffectiveDefense: number;
  directDamage: number;
  /** Anti-air damage dealt to the target (only if antiAir mode was chosen). */
  antiAirDamage: number;
  splashEvents: SplashEvent[];
  destroyedUnitIds: string[];
  reactionEvents: CombatResult[];
  /** The weapon mode that was selected and resolved. */
  chosenWeaponMode?: WeaponMode;
  /**
   * Building component reductions applied by this attack (building-damage
   * feature). Empty unless the attack reached one or more enemy buildings.
   */
  buildingDamage: BuildingDamageEvent[];
}

// ---------------------------------------------------------------------------
// Attack validation
// ---------------------------------------------------------------------------

function invalidResult(attackerId: string, targetId: string, reason: string): CombatResult {
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

// ---------------------------------------------------------------------------
// Building component damage (building-damage feature)
// ---------------------------------------------------------------------------

/**
 * The seven equipment components a building may carry. A building is never
 * destroyed; attacks strip points from these components. A component with
 * value 0 is "absent" and cannot be targeted. (Movement/engineering attributes
 * never apply to buildings.) The identifiers live in shared/buildingComponents
 * so the client UI can reference them without importing from src/.
 */
import type { BuildingComponent } from '../../shared/buildingComponents.js';
import { BUILDING_COMPONENTS } from '../../shared/buildingComponents.js';
export type { BuildingComponent };
export { BUILDING_COMPONENTS };

/**
 * A deterministic random source returning a float in [0, 1). Defaults to
 * Math.random. The server passes its own generator so Splash_Fire's random
 * component selection is authoritative and reproducible (Requirement 5.6).
 */
export type RandomFn = () => number;

/** One building component reduction produced by a successful attack. */
export interface BuildingDamageEvent {
  buildingId: string;
  component: BuildingComponent;
  /** Component value AFTER the reduction (always clamped to ≥ 0). */
  newValue: number;
  /** True when the component reached 0 (capability fully disabled). */
  destroyed: boolean;
}

/**
 * Components of a building whose current value is at least 1 — i.e. those
 * eligible to receive a point of damage. Returns [] for a Plain_Building.
 */
export function getEligibleBuildingComponents(building: Building): BuildingComponent[] {
  const a = building.attributes;
  if (!a) return [];
  return BUILDING_COMPONENTS.filter((c) => (a[c] ?? 0) >= 1);
}

/**
 * Reduce a single building component by exactly one point (clamped at 0),
 * mutating the building's attributes in place. Buildings have no health pool,
 * no armour mitigation, and no min-damage formula — this is a flat one-point
 * loss (Requirements 1, 3).
 *
 * Returns the resulting event, or null when the component is already 0/absent
 * (no change applied — Requirements 3.4, 6.1).
 */
export function applyBuildingComponentDamage(
  building: Building,
  component: BuildingComponent,
): BuildingDamageEvent | null {
  const a = building.attributes;
  if (!a) return null;
  const current = a[component] ?? 0;
  if (current < 1) return null;
  const newValue = current - 1; // current ≥ 1 ⇒ newValue ≥ 0 (clamped by construction)
  a[component] = newValue;
  return { buildingId: building.id, component, newValue, destroyed: newValue === 0 };
}

/**
 * Resolve Direct_Fire against a single targeted building: the attacking player
 * chooses which component to degrade (Requirement 4).
 *
 * Returns a CombatResult. On success the chosen component is reduced by one and
 * reported in `buildingDamage`. Invalid declarations (friendly building, out of
 * range, missing/invalid component, no targetable component) are rejected with
 * `wasValid = false` and leave every component unchanged.
 */
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

  // Range gate — same segment-distance + elevation rules as unit Direct Fire.
  const segDist = effectiveCombatDistance(tiles, attacker, { tileIndex: building.tileIndex, segment: building.segment as HexSegment });
  const elevRangeMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].elevationType,
    tiles[building.tileIndex].elevationType,
    isDrone(attacker),
  );
  const rangeThreshold = getSegmentRangeThreshold(attacker) * elevRangeMult;
  if (segDist > rangeThreshold) {
    return invalidResult(attackerId, building.id, 'Target out of range');
  }

  const eligible = getEligibleBuildingComponents(building);

  // A Plain_Building (or fully stripped building) is a valid target but takes
  // no damage (Requirements 2.3, 6.3).
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

/** A minimal valid Direct_Fire-on-building result skeleton. */
function directFireBaseResult(attackerId: string, buildingId: string): CombatResult {
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

/**
 * Resolve Splash_Fire's building damage in a hex: every enemy building in the
 * tile loses one uniformly-random eligible component (Requirement 5). Buildings
 * with no eligible component are left unchanged. Each building's random choice
 * is independent.
 *
 * Pure with respect to the RNG: pass a deterministic `rng` on the server so all
 * clients observe the same outcome (Requirement 5.6).
 */
export function resolveBuildingSplashInHex(
  attackerOwnerId: string,
  tileIndex: number,
  ctx: CombatContext,
  rng: RandomFn = Math.random,
): BuildingDamageEvent[] {
  const events: BuildingDamageEvent[] = [];
  for (const building of ctx.buildings) {
    if (building.tileIndex !== tileIndex) continue;
    if (building.ownerId === attackerOwnerId) continue; // only enemy buildings
    const eligible = getEligibleBuildingComponents(building);
    if (eligible.length === 0) continue; // Requirement 5.3
    const pick = eligible[Math.floor(rng() * eligible.length)];
    const event = applyBuildingComponentDamage(building, pick);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Resolve Splash_Fire against a whole hex (used when the player targets a
 * building with Splash_Fire). Applies HP damage to every enemy unit in the hex
 * (front orientation — no selected unit) AND one random component of damage to
 * every enemy building in the hex (Requirement 5, Resolved decision O1).
 *
 * Mutates unit health and building attributes in place.
 */
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

  // Range gate to the target hex (representative segment 0), with elevation.
  const segDist = segmentDistance(tiles, attacker.tileIndex, attacker.segment, tileIndex, 0 as HexSegment);
  const elevRangeMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].elevationType,
    tiles[tileIndex].elevationType,
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
    // Passing `attacker` as the selected target forces front orientation for
    // every victim (no victim's id equals the attacker's id).
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

// ---------------------------------------------------------------------------
// Weapon mode types
// ---------------------------------------------------------------------------

export type WeaponMode = 'direct' | 'splash' | 'antiAir';

export interface WeaponOption {
  mode: WeaponMode;
  score: number;
  damages: Array<{ unitId: string; damage: number }>;
}

// ---------------------------------------------------------------------------
// Weapon evaluation — shared single source of truth
// ---------------------------------------------------------------------------

/**
 * Evaluate all valid weapon modes for an attacker targeting a specific unit.
 *
 * This is a pure read-only function — it does NOT mutate any state.
 * Used by both `resolveAttack` (to pick the best mode) and the combat
 * explainer (to show the player all options and their damage).
 *
 * Returns an empty array if no weapon modes are applicable (e.g. no weapons,
 * target is ground and attacker only has antiAir).
 */
export function evaluateWeaponOptions(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
  dist: number,
  orientationBonus: number,
): WeaponOption[] {
  const { units: allUnits } = ctx;
  const options: WeaponOption[] = [];

  // --- Direct Fire ---
  if ((attacker.attributes.kinetic ?? 0) > 0) {
    const { damage } = calculateDirectDamage(attacker, target, ctx, dist);
    options.push({
      mode: 'direct',
      score: damage,
      damages: [{ unitId: target.id, damage }],
    });
  }

  // --- Splash Fire ---
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

  // --- Anti-Air Fire ---
  if ((attacker.attributes.antiAir ?? 0) > 0 && isDrone(target)) {
    const defencePower = getDefencePower(target, ctx, isDrone(attacker));
    const { finalDamage } = computeDamage({
      mode: 'antiAir',
      attackerChassis: getChassisType(attacker),
      baseWeaponValue: attacker.attributes.antiAir!,
      orientationBonus,
      distance: dist,
      effectiveDefence: defencePower.total * DEFENCE_SCALE,
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

// ---------------------------------------------------------------------------
// Attack resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single attack from attacker to target (immediate mode).
 * Automatically selects the best weapon mode (direct, splash, or anti-air).
 * Only one weapon mode is applied — damage is not additive across modes.
 * Mutates unit health in the allUnits array.
 */
export function resolveAttack(
  attackerId: string,
  targetId: string,
  ctx: CombatContext,
  rng: RandomFn = Math.random,
): CombatResult {
  const { units: allUnits, tiles } = ctx;
  const attacker = allUnits.find((u) => u.id === attackerId);
  const target = allUnits.find((u) => u.id === targetId);

  if (!attacker) return invalidResult(attackerId, targetId, 'Attacker not found');
  if (!target) return invalidResult(attackerId, targetId, 'Target not found');
  if (attacker.currentHealth <= 0) return invalidResult(attackerId, targetId, 'Attacker is destroyed');
  if (target.currentHealth <= 0) return invalidResult(attackerId, targetId, 'Target is destroyed');
  if (attacker.ownerId === target.ownerId) return invalidResult(attackerId, targetId, 'Cannot attack friendly unit');

  // Anti-Air validation: if attacker ONLY has antiAir (no kinetic, no rangeAttack, no splashAttack),
  // it can only target drones.
  const hasAttack = (attacker.attributes.kinetic ?? 0) > 0;
  const hasRange = (attacker.attributes.rangeAttack ?? 0) > 0;
  const hasSplash = (attacker.attributes.splashAttack ?? 0) > 0;
  const hasAntiAir = (attacker.attributes.antiAir ?? 0) > 0;

  if (!hasAttack && !hasRange && !hasSplash && hasAntiAir && !isDrone(target)) {
    return invalidResult(attackerId, targetId, 'Anti-Air weapons can only target drones');
  }

  // Range check — segment-based gate, extended by elevation (higher ground
  // shoots farther; lower ground shorter). No elevation effect for drones.
  const segDist = effectiveCombatDistance(tiles, attacker, target);
  const elevRangeMult = elevationRangeMultiplier(
    tiles[attacker.tileIndex].elevationType,
    tiles[target.tileIndex].elevationType,
    isDrone(attacker) || isDrone(target),
  );
  const rangeThreshold = getSegmentRangeThreshold(attacker) * elevRangeMult;
  if (segDist > rangeThreshold) {
    return invalidResult(attackerId, targetId, 'Target out of range');
  }

  // Orientation info (shared across weapon modes) — bearing-based
  const orientationBonus = calculateOrientationBonus(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  // EW (radius anti-drone screen) only applies when the attacker is a drone.
  const defencePower = getDefencePower(target, ctx, isDrone(attacker));

  // Evaluate all valid weapon options (shared with explainer)
  const validOptions = evaluateWeaponOptions(attacker, target, ctx, segDist, orientationBonus);

  if (validOptions.length === 0) {
    return invalidResult(attackerId, targetId, 'No valid weapon modes available');
  }

  // Choose highest-scoring weapon mode with tie-break rules
  const chosen = chooseWeaponOption(validOptions, target);

  // Apply damage from chosen mode only
  const destroyedIds: string[] = [];
  const splashEvents: SplashEvent[] = [];

  for (const { unitId, damage } of chosen.damages) {
    const victim = allUnits.find((u) => u.id === unitId);
    if (!victim) continue;

    victim.currentHealth = applyDamage(victim.currentHealth, damage);
    const destroyed = victim.currentHealth <= 0;
    if (destroyed) destroyedIds.push(victim.id);

    if (chosen.mode === 'splash' && unitId !== target.id) {
      splashEvents.push({ victimId: unitId, damage, victimDestroyed: destroyed });
    } else if (chosen.mode === 'splash' && unitId === target.id) {
      // Primary target in splash mode — record as splash event too
      splashEvents.push({ victimId: unitId, damage, victimDestroyed: destroyed });
    }
  }

  // directDamage field: total damage dealt by the chosen mode
  const totalDamage = chosen.damages.reduce((sum, d) => sum + d.damage, 0);

  // antiAirDamage field: only set when antiAir mode was chosen
  const antiAirDamage = chosen.mode === 'antiAir' ? totalDamage : 0;

  // Splash Fire also degrades every enemy building sharing the target hex —
  // one uniformly-random component each (Requirement 5, Resolved decision O1).
  const buildingDamage = chosen.mode === 'splash'
    ? resolveBuildingSplashInHex(attacker.ownerId, target.tileIndex, ctx, rng)
    : [];

  return {
    attackerId,
    targetId,
    wasValid: true,
    attackArc: arc,
    facingModifier: orientationBonus,
    targetArmour: defencePower.armour,
    targetEffectiveDefense: defencePower.total,
    directDamage: totalDamage,
    antiAirDamage,
    splashEvents: chosen.mode === 'splash' ? splashEvents : [],
    destroyedUnitIds: destroyedIds,
    reactionEvents: [],
    chosenWeaponMode: chosen.mode,
    buildingDamage,
  };
}

/**
 * Choose the highest-scoring weapon option.
 * Tie-break order:
 * 1. Highest score
 * 2. Anti-Air preferred if target is a drone
 * 3. Splash preferred if it damages more than one enemy unit
 * 4. Direct preferred
 * 5. Highest damage to the originally selected target
 */
export function chooseWeaponOption(options: WeaponOption[], target: Unit): WeaponOption {
  const targetIsDrone = isDrone(target);

  return options.reduce((best, current) => {
    if (current.score > best.score) return current;
    if (current.score < best.score) return best;

    // Tie-break: anti-air preferred for drones
    if (targetIsDrone) {
      if (current.mode === 'antiAir' && best.mode !== 'antiAir') return current;
      if (best.mode === 'antiAir' && current.mode !== 'antiAir') return best;
    }

    // Tie-break: splash preferred if it hits more than one unit
    const currentSplashCount = current.mode === 'splash' ? current.damages.length : 0;
    const bestSplashCount = best.mode === 'splash' ? best.damages.length : 0;
    if (current.mode === 'splash' && currentSplashCount > 1 && bestSplashCount <= 1) return current;
    if (best.mode === 'splash' && bestSplashCount > 1 && currentSplashCount <= 1) return best;

    // Tie-break: direct preferred over splash (single target)
    if (current.mode === 'direct' && best.mode === 'splash') return current;
    if (best.mode === 'direct' && current.mode === 'splash') return best;

    // Tie-break: highest damage to the originally selected target
    const currentTargetDmg = current.damages.find((d) => d.unitId === target.id)?.damage ?? 0;
    const bestTargetDmg = best.damages.find((d) => d.unitId === target.id)?.damage ?? 0;
    return currentTargetDmg >= bestTargetDmg ? current : best;
  });
}

// ---------------------------------------------------------------------------
// Anti-Air Reaction Fire (§16)
// ---------------------------------------------------------------------------

/**
 * Calculate Anti-Air Reaction Fire damage from a reacting unit against a drone.
 *
 * Orientation bonus is 0 — snap shot against an airborne target.
 * No drone incoming damage modifier is applied (AA reaction is not penalised).
 *
 * AntiAirReactionAttackPower = antiAir × ChassisAttackModifier
 */
export function calculateAntiAirReactionDamage(
  reactingUnit: Unit,
  drone: Unit,
  ctx: CombatContext,
): number {
  // Anti-air reaction: EW only applies if the reacting attacker is itself a drone.
  const defPower = getDefencePower(drone, ctx, isDrone(reactingUnit));
  // Terrain is 0 for airborne drones (formation bonus deprecated — see getDefencePower)
  const airborneDefence = (defPower.armour + defPower.ew) * DEFENCE_SCALE;

  const { finalDamage } = computeDamage({
    mode: 'antiAir',
    attackerChassis: getChassisType(reactingUnit),
    baseWeaponValue: reactingUnit.attributes.antiAir ?? 0,
    orientationBonus: 0,
    distance: 1,
    effectiveDefence: airborneDefence,
    targetIsDrone: true,
    isReactionFire: true,
  });
  return finalDamage;
}

/**
 * Resolve Anti-Air Reaction Fire for all eligible enemy units in a single tile.
 *
 * Eligible reactors must:
 * - Be an enemy of the drone
 * - Be alive (currentHealth > 0)
 * - Have antiAir > 0
 * - Not have already reacted during this drone action
 *
 * Mutates drone health. Returns all reaction CombatResults.
 * Stops early if the drone is destroyed.
 */
export function resolveAntiAirReactionFireForTile(
  drone: Unit,
  tileIndex: number,
  ctx: CombatContext,
  reactedThisAction: Set<string>,
): CombatResult[] {
  const { units: allUnits } = ctx;
  const results: CombatResult[] = [];

  for (const unit of allUnits) {
    if (unit.ownerId === drone.ownerId) continue;
    if (unit.currentHealth <= 0) continue;
    if ((unit.attributes.antiAir ?? 0) <= 0) continue;
    if (unit.tileIndex !== tileIndex) continue;
    if (reactedThisAction.has(unit.id)) continue;

    reactedThisAction.add(unit.id);

    const damage = calculateAntiAirReactionDamage(unit, drone, ctx);
    drone.currentHealth = applyDamage(drone.currentHealth, damage);
    const destroyed = drone.currentHealth <= 0;

    results.push({
      attackerId: unit.id,
      targetId: drone.id,
      wasValid: true,
      attackArc: 'front', // snap shot — no arc
      facingModifier: 0,
      targetArmour: drone.attributes.armour ?? 0,
      targetEffectiveDefense: getDefencePower(drone, ctx, isDrone(unit)).total,
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

/**
 * Resolve Anti-Air Reaction Fire as a drone moves along a path (§16).
 *
 * Rules:
 * - Only drones trigger reaction fire.
 * - Only enemy units with antiAir > 0 may react.
 * - Each reacting unit may fire at most once per drone action.
 * - Reaction fire uses Anti-Air Fire only (no weapon selection).
 * - Orientation bonus is 0 (snap shot).
 * - Drone terrain defence is 0 (airborne).
 * - If the drone is destroyed, movement stops immediately.
 *
 * Mutates unit health. Returns all reaction CombatResults.
 */
export function resolveReactionFire(
  movingUnitId: string,
  path: number[],
  ctx: CombatContext,
): CombatResult[] {
  const { units: allUnits, tiles } = ctx;
  const movingUnit = allUnits.find((u) => u.id === movingUnitId);
  if (!movingUnit || movingUnit.currentHealth <= 0) return [];

  // Ground units (tanks/spiders) never trigger reaction fire (§16)
  if (!isDrone(movingUnit)) return [];

  const results: CombatResult[] = [];
  const reactedThisAction = new Set<string>();

  for (let i = 1; i < path.length; i++) {
    const prevHex = path[i - 1];
    const currentHex = path[i];

    // Update drone position and facing
    movingUnit.tileIndex = currentHex;
    const dir = tiles[prevHex].neighbours.indexOf(currentHex);
    if (dir !== -1) {
      movingUnit.facing = dir as HexSegment;
    }

    // Resolve AA reaction fire from enemies in this tile
    const tileResults = resolveAntiAirReactionFireForTile(
      movingUnit, currentHex, ctx, reactedThisAction,
    );
    results.push(...tileResults);

    // Stop if drone is destroyed
    if (movingUnit.currentHealth <= 0) {
      return results;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Movement with facing update (re-exported from movement.ts)
// ---------------------------------------------------------------------------

export { moveUnit, pivotUnit } from './movement.js';

// Re-export segment geometry for external consumers
export {
  getSegmentCentroid3D,
  getLocalHexSpacing,
  segmentDistance,
  effectiveCombatDistance,
  segmentMovementDistance,
} from './segmentGeometry.js';

// ---------------------------------------------------------------------------
// Simultaneous resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve two units attacking each other simultaneously.
 * Both attacks are resolved at the same time — neither gets priority.
 * Returns both results.
 */
export function resolveSimultaneousAttacks(
  unitAId: string,
  unitBId: string,
  ctx: CombatContext,
): CombatResult[] {
  const { units: allUnits } = ctx;
  const unitA = allUnits.find((u) => u.id === unitAId);
  const unitB = allUnits.find((u) => u.id === unitBId);

  if (!unitA || !unitB) return [];

  // Simultaneous: snapshot health, resolve both independently, apply both
  const healthA = unitA.currentHealth;
  const healthB = unitB.currentHealth;

  // Resolve A attacking B
  const resultA = resolveAttack(unitAId, unitBId, ctx);

  // Restore both to pre-combat state for B's attack
  unitA.currentHealth = healthA;
  unitB.currentHealth = healthB;

  // Resolve B attacking A
  const resultB = resolveAttack(unitBId, unitAId, ctx);

  // Restore and apply both damages simultaneously
  unitA.currentHealth = applyDamage(healthA, resultB.directDamage);
  unitB.currentHealth = applyDamage(healthB, resultA.directDamage);

  return [resultA, resultB];
}
