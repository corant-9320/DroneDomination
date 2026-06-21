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
 * Pure math lives in combatMath.ts.
 * Arc/facing geometry lives in combatFacing.ts.
 */

import { Tile } from './types.js';
import { Unit, HexSegment } from './units.js';
import { effectiveCombatDistance } from './segmentGeometry.js';

// ---------------------------------------------------------------------------
// Re-export everything from sub-modules so existing importers stay compatible
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
  ELEVATION_MULTIPLIER_PER_LEVEL,
  // Functions
  isDrone,
  getChassisAttackModifier,
  calculateRangeEfficiency,
  calculateModifiedAttackPower,
  applyDroneIncomingDamageModifier,
  clamp,
  applyDamage,
  calculateFormulaDamage,
  getSegmentRangeThreshold,
  getElevationLevel,
  calculateElevationMultiplier,
} from './combatMath.js';

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
// Local imports from sub-modules (for use within this file)
// ---------------------------------------------------------------------------

import {
  DEFENCE_SCALE,
  MAX_DAMAGE,
  MIN_DAMAGE,
  SPLASH_SCALE,
  isDrone,
  getChassisAttackModifier,
  calculateModifiedAttackPower,
  applyDroneIncomingDamageModifier,
  clamp,
  applyDamage,
  calculateFormulaDamage,
  getSegmentRangeThreshold,
  calculateElevationMultiplier,
} from './combatMath.js';

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
// Formation support — DEPRECATED (2026-06-21)
// ---------------------------------------------------------------------------
//
// The defensive-formation bonus (defence for having adjacent friendly units)
// has been removed. It is not realistic in modern missile warfare and it
// complicated the defence calculation. DefencePower no longer includes a
// formation term; the `defensiveFormation` field is retained as a constant 0
// for wire/UI compatibility and will be removed in the combat-formula refactor.

// ---------------------------------------------------------------------------
// Electronic Warfare (EW) — sum of defence in same hex, capped at 5
// ---------------------------------------------------------------------------

/**
 * Get the total EW defence from friendly units in the same hex as the target.
 * Sum all defence values (including the target itself), capped at 5.
 * Excludes destroyed units.
 */
export function getEWDefense(
  target: Unit,
  allUnits: Unit[],
): number {
  let total = 0;

  for (const unit of allUnits) {
    if (unit.ownerId !== target.ownerId) continue;
    if (unit.currentHealth <= 0) continue;
    if (unit.tileIndex !== target.tileIndex) continue;

    total += unit.attributes.defence ?? 0;
  }

  return Math.min(5, total);
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
 * EW effectiveness multipliers by weapon mode.
 *
 * Electronic Warfare is less effective against physical projectiles (kinetic)
 * and somewhat effective against area fire (splash), but fully effective
 * against dedicated electronic targeting systems (antiAir / reaction).
 *
 * - direct (kinetic):  50% — bullets/shells bypass most ECM
 * - splash:            75% — area weapons are partially jammed
 * - antiAir / reaction: 100% — AA targeting is fully countered by EW
 */
export const EW_EFFECTIVENESS_DIRECT = 0.50;
export const EW_EFFECTIVENESS_SPLASH = 0.75;
export const EW_EFFECTIVENESS_ANTIAIR = 1.00;

/**
 * Calculate the full DefencePower for a target unit.
 * DefencePower = armour + (EW × ewMultiplier) + terrain
 *
 * Each component is clamped to its valid range before summing.
 * (The defensive-formation term was deprecated 2026-06-21 and is always 0.)
 *
 * @param weaponMode - The attacking weapon mode, which determines EW effectiveness.
 *   'direct'  → EW at 50%
 *   'splash'  → EW at 75%
 *   'antiAir' → EW at 100% (default when omitted)
 */
export function getDefencePower(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
  weaponMode: 'direct' | 'splash' | 'antiAir' = 'antiAir',
): { armour: number; ew: number; ewRaw: number; ewMultiplier: number; defensiveFormation: number; terrain: number; total: number } {
  const armour = clamp(target.attributes.armour ?? 0, 0, 5);
  const ewRaw = clamp(getEWDefense(target, allUnits), 0, 5);
  const ewMultiplier = weaponMode === 'direct' ? EW_EFFECTIVENESS_DIRECT
    : weaponMode === 'splash' ? EW_EFFECTIVENESS_SPLASH
    : EW_EFFECTIVENESS_ANTIAIR;
  const ew = ewRaw * ewMultiplier;
  // Defensive formation bonus deprecated (2026-06-21) — adjacency confers no
  // defence in modern missile warfare. Retained as 0 for wire/UI compatibility.
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
  allUnits: Unit[],
  tiles: Tile[],
  distance: number = 1,
): { damage: number; arc: AttackArc; orientationBonus: number; defencePower: ReturnType<typeof getDefencePower>; antiDronePenaltyApplied: boolean } {
  // New bearing-based orientation bonus (continuous 0–2)
  const orientationBonus = calculateOrientationBonus(tiles, attacker.tileIndex, target.tileIndex, target.facing);

  // Classify arc for UI/wire display from the angular difference
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);

  // EW is 50% effective against kinetic (direct) fire
  const defencePower = getDefencePower(target, allUnits, tiles, 'direct');
  const baseAttack = clamp(attacker.attributes.kinetic ?? 0, 1, 5);
  const attackPower = calculateModifiedAttackPower(attacker, baseAttack, orientationBonus, distance);
  const effectiveDefence = defencePower.total * DEFENCE_SCALE;

  let damage = calculateFormulaDamage(attackPower, effectiveDefence);

  // Apply elevation advantage multiplier (before drone modifier)
  const elevMult = calculateElevationMultiplier(tiles[attacker.tileIndex], tiles[target.tileIndex], attacker, target);
  damage = clamp(Math.round(damage * elevMult), MIN_DAMAGE, MAX_DAMAGE);

  // Apply drone incoming damage modifier
  const antiDronePenaltyApplied = isDrone(target);
  damage = applyDroneIncomingDamageModifier('direct', target, damage);

  return { damage, arc, orientationBonus, defencePower, antiDronePenaltyApplied };
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
  allUnits: Unit[],
  tiles: Tile[],
  distance: number = 1,
): number {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0) return 0;

  // Orientation bonus only for the originally selected target (bearing-based)
  let orientationBonus = 0;
  if (victim.id === selectedTarget.id) {
    orientationBonus = calculateOrientationBonus(tiles, attacker.tileIndex, victim.tileIndex, victim.facing);
  }

  const baseSplash = clamp(splashPower, 1, 5);
  const splashAttackPower = calculateModifiedAttackPower(attacker, baseSplash, orientationBonus, distance);
  // EW is 75% effective against splash fire
  const defPower = getDefencePower(victim, allUnits, tiles, 'splash');
  const effectiveDefence = defPower.total * DEFENCE_SCALE;

  const fullFormulaDamage = calculateFormulaDamage(splashAttackPower, effectiveDefence);

  // Apply elevation advantage multiplier (before splash scaling and drone modifier)
  const elevMult = calculateElevationMultiplier(tiles[attacker.tileIndex], tiles[victim.tileIndex], attacker, victim);
  const elevAdjustedDamage = clamp(Math.round(fullFormulaDamage * elevMult), MIN_DAMAGE, MAX_DAMAGE);

  // Splash scaling applied before drone modifier
  let result = Math.max(MIN_DAMAGE, Math.round(elevAdjustedDamage * SPLASH_SCALE));

  // Drone incoming damage modifier applied after splash scaling
  result = applyDroneIncomingDamageModifier('splash', victim, result);

  return result;
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
  allUnits: Unit[],
  tiles: Tile[],
  dist: number,
  orientationBonus: number,
): WeaponOption[] {
  const options: WeaponOption[] = [];

  // --- Direct Fire ---
  if ((attacker.attributes.kinetic ?? 0) > 0) {
    const { damage } = calculateDirectDamage(attacker, target, allUnits, tiles, dist);
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
      const dmg = calculateSplashDamage(attacker, target, victim, allUnits, tiles, dist);
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
    const aaLevel = clamp(attacker.attributes.antiAir!, 1, 5);
    const aaAttackPower = calculateModifiedAttackPower(attacker, aaLevel, orientationBonus, dist);
    const defencePower = getDefencePower(target, allUnits, tiles, 'antiAir');
    const effectiveDefence = defencePower.total * DEFENCE_SCALE;
    let antiAirDamage = calculateFormulaDamage(aaAttackPower, effectiveDefence);
    // Elevation multiplier does not apply to drones (calculateElevationMultiplier returns 1.0)
    options.push({
      mode: 'antiAir',
      score: antiAirDamage,
      damages: [{ unitId: target.id, damage: antiAirDamage }],
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
  allUnits: Unit[],
  tiles: Tile[],
): CombatResult {
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

  // Range check — segment-based gate (0.25 per segment, continuous)
  const segDist = effectiveCombatDistance(tiles, attacker, target);
  const rangeThreshold = getSegmentRangeThreshold(attacker);
  if (segDist > rangeThreshold) {
    return invalidResult(attackerId, targetId, 'Target out of range');
  }

  // Orientation info (shared across weapon modes) — bearing-based
  const orientationBonus = calculateOrientationBonus(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const angleDiff = getAngularDifference(tiles, attacker.tileIndex, target.tileIndex, target.facing);
  const arc: AttackArc = isNaN(angleDiff) ? 'unknown' : classifyArcFromAngle(angleDiff);
  // Anti-air uses full EW (100% effectiveness); direct/splash use mode-specific values via their own calls
  const defencePower = getDefencePower(target, allUnits, tiles, 'antiAir');

  // Evaluate all valid weapon options (shared with explainer)
  const validOptions = evaluateWeaponOptions(attacker, target, allUnits, tiles, segDist, orientationBonus);

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
  allUnits: Unit[],
  tiles: Tile[],
): number {
  const aaLevel = clamp(reactingUnit.attributes.antiAir ?? 0, 1, 5);
  const chassisModifier = getChassisAttackModifier(reactingUnit);
  // No orientation bonus for reaction fire (snap shot)
  const attackPower = Math.max(0.01, aaLevel * chassisModifier);
  // Anti-air / reaction fire uses full EW effectiveness (100%)
  const defPower = getDefencePower(drone, allUnits, tiles, 'antiAir');
  // Terrain is 0 for airborne drones (formation bonus deprecated — see getDefencePower)
  const airborneDefence = (defPower.armour + defPower.ew) * DEFENCE_SCALE;
  return calculateFormulaDamage(attackPower, airborneDefence);
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
  allUnits: Unit[],
  tiles: Tile[],
  reactedThisAction: Set<string>,
): CombatResult[] {
  const results: CombatResult[] = [];

  for (const unit of allUnits) {
    if (unit.ownerId === drone.ownerId) continue;
    if (unit.currentHealth <= 0) continue;
    if ((unit.attributes.antiAir ?? 0) <= 0) continue;
    if (unit.tileIndex !== tileIndex) continue;
    if (reactedThisAction.has(unit.id)) continue;

    reactedThisAction.add(unit.id);

    const damage = calculateAntiAirReactionDamage(unit, drone, allUnits, tiles);
    drone.currentHealth = applyDamage(drone.currentHealth, damage);
    const destroyed = drone.currentHealth <= 0;

    results.push({
      attackerId: unit.id,
      targetId: drone.id,
      wasValid: true,
      attackArc: 'front', // snap shot — no arc
      facingModifier: 0,
      targetArmour: drone.attributes.armour ?? 0,
      targetEffectiveDefense: getDefencePower(drone, allUnits, tiles).total,
      directDamage: damage,
      antiAirDamage: damage,
      splashEvents: [],
      destroyedUnitIds: destroyed ? [drone.id] : [],
      reactionEvents: [],
      chosenWeaponMode: 'antiAir',
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
  allUnits: Unit[],
  tiles: Tile[],
): CombatResult[] {
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
      movingUnit, currentHex, allUnits, tiles, reactedThisAction,
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
  allUnits: Unit[],
  tiles: Tile[],
): CombatResult[] {
  const unitA = allUnits.find((u) => u.id === unitAId);
  const unitB = allUnits.find((u) => u.id === unitBId);

  if (!unitA || !unitB) return [];

  // Simultaneous: snapshot health, resolve both independently, apply both
  const healthA = unitA.currentHealth;
  const healthB = unitB.currentHealth;

  // Resolve A attacking B
  const resultA = resolveAttack(unitAId, unitBId, allUnits, tiles);

  // Restore both to pre-combat state for B's attack
  unitA.currentHealth = healthA;
  unitB.currentHealth = healthB;

  // Resolve B attacking A
  const resultB = resolveAttack(unitBId, unitAId, allUnits, tiles);

  // Restore and apply both damages simultaneously
  unitA.currentHealth = applyDamage(healthA, resultB.directDamage);
  unitB.currentHealth = applyDamage(healthB, resultA.directDamage);

  return [resultA, resultB];
}
