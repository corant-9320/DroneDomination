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
 */

import { Tile } from './types.js';
import { Unit, HexSegment } from './units.js';
import { graphDistance } from './pathfinding.js';


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFENCE_SCALE = 0.75;
export const MAX_DAMAGE = 30;
export const MIN_DAMAGE = 1;
export const SPLASH_SCALE = 0.3;

/**
 * AttackPower is reduced by 10% for each hex of attack distance beyond 1.
 * rangeEfficiency = 1 - RANGE_FALLOFF_PER_HEX × max(0, distance - 1)
 * Applies to declared attacks only (Direct Fire, Splash Fire, Anti-Air Fire).
 * Does NOT apply to Anti-Air Reaction Fire.
 */
export const RANGE_FALLOFF_PER_HEX = 0.10;

/**
 * Maximum possible damage contribution per point of AttackPower before the
 * global cap is applied. Ensures weak attacks cannot deal full damage against
 * undefended targets.
 */
export const DAMAGE_PER_ATTACK_POWER = 6;

// ---------------------------------------------------------------------------
// Chassis attack modifiers — outgoing weapon power multiplier by movement type
// ---------------------------------------------------------------------------

/** Outgoing weapon power multiplier for wheeled (tank) units. */
export const TANK_ATTACK_MODIFIER = 1.00;
/** Outgoing weapon power multiplier for limb/spider units. */
export const SPIDER_ATTACK_MODIFIER = 0.75;
/** Outgoing weapon power multiplier for flight/drone units. */
export const DRONE_ATTACK_MODIFIER = 0.50;

// ---------------------------------------------------------------------------
// Drone incoming damage multipliers — per weapon mode
// ---------------------------------------------------------------------------

/** Final Direct Fire damage multiplier when the target is a drone. */
export const DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER = 0.33;
/** Final Splash Fire damage multiplier when the affected unit is a drone. */
export const DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER = 0.50;
/** Final Anti-Air damage multiplier when the target is a drone (no penalty). */
export const DRONE_ANTI_AIR_DAMAGE_MULTIPLIER = 1.00;

// ---------------------------------------------------------------------------
// Orientation
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

/**
 * Calculate range efficiency for a declared attack.
 *
 * rangeEfficiency = 1 - RANGE_FALLOFF_PER_HEX × max(0, distance - 1)
 * Distance 1 → 1.00, distance 2 → 0.90, distance 3 → 0.80, etc.
 * Minimum 0 (clamped). Does NOT apply to Anti-Air Reaction Fire.
 */
export function calculateRangeEfficiency(distance: number): number {
  const d = Math.max(1, distance);
  return Math.max(0, 1 - RANGE_FALLOFF_PER_HEX * Math.max(0, d - 1));
}

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

/** Target orientation relative to the attacker. */
export type TargetOrientation = 'front' | 'side' | 'rear';

/** Legacy alias kept for API compatibility. */
export type AttackArc = 'front' | 'side' | 'rear' | 'unknown';

/**
 * Get the orientation bonus based on the target's facing relative to attacker.
 *
 * | Target Orientation | Bonus |
 * |--------------------|-------|
 * | Front-facing       |   0   |
 * | Side-on            |   1   |
 * | Rear / facing away |   2   |
 */
export function getOrientationBonus(targetOrientation: TargetOrientation | string): number {
  switch (targetOrientation) {
    case 'front': return 0;
    case 'side': return 1;
    case 'rear': return 2;
    default: return 0; // invalid defaults to front
  }
}

// ---------------------------------------------------------------------------
// Attack arc classification (hex geometry)
// ---------------------------------------------------------------------------

/**
 * Get the direction index from one adjacent tile to another using the
 * neighbour array. Returns the index in `fromTile.neighbours` where
 * `toIndex` appears, or -1 if not directly adjacent.
 */
export function getDirectionBetweenAdjacentHexes(
  tiles: Tile[],
  fromIndex: number,
  toIndex: number,
): number {
  return tiles[fromIndex].neighbours.indexOf(toIndex);
}

/**
 * Calculate the approach direction from the defender's perspective.
 * This is the direction from the defender's hex toward the attacker's hex.
 *
 * For non-adjacent hexes, uses BFS to find the first hop on the shortest
 * path from defender toward attacker, then returns that direction.
 * Returns -1 if no path or same hex.
 */
export function getApproachDirection(
  tiles: Tile[],
  defenderIndex: number,
  attackerIndex: number,
): number {
  if (defenderIndex === attackerIndex) return -1;

  // If adjacent, direct lookup
  const direct = tiles[defenderIndex].neighbours.indexOf(attackerIndex);
  if (direct !== -1) return direct;

  // BFS from defender toward attacker, find first step
  const visited = new Uint8Array(tiles.length);
  const parent = new Int32Array(tiles.length).fill(-1);
  const queue: number[] = [defenderIndex];
  visited[defenderIndex] = 1;
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    for (const neighbour of tiles[current].neighbours) {
      if (!visited[neighbour]) {
        visited[neighbour] = 1;
        parent[neighbour] = current;
        if (neighbour === attackerIndex) {
          // Trace back to find first step from defender
          let step = attackerIndex;
          while (parent[step] !== defenderIndex) {
            step = parent[step];
          }
          return tiles[defenderIndex].neighbours.indexOf(step);
        }
        queue.push(neighbour);
      }
    }
  }

  return -1; // unreachable
}

/**
 * Classify the target orientation based on the defender's facing and the
 * approach direction (direction from defender toward attacker).
 *
 * Simplified 3-arc system:
 * - diff 0, 1, 5 → front
 * - diff 2, 4 → side
 * - diff 3 → rear
 */
export function classifyAttackArc(
  defenderFacing: number,
  approachDirection: number,
): AttackArc {
  if (approachDirection < 0) return 'unknown';

  // Normalize the difference (mod 6)
  const diff = ((approachDirection - defenderFacing) % 6 + 6) % 6;

  switch (diff) {
    case 0: return 'front';
    case 1: return 'front'; // front-right
    case 5: return 'front'; // front-left
    case 2: return 'side';  // side-right
    case 4: return 'side';  // side-left
    case 3: return 'rear';
    default: return 'unknown';
  }
}

/** Get the orientation bonus for a classified attack arc. */
export function getFacingModifier(arc: AttackArc): number {
  return getOrientationBonus(arc === 'unknown' ? 'front' : arc);
}

// ---------------------------------------------------------------------------
// Formation support (defensiveFormation)
// ---------------------------------------------------------------------------

/**
 * Count adjacent friendly units that provide formation support.
 * Adjacent = neighbouring hex or same hex (different segment).
 * Destroyed units (currentHealth <= 0) do not provide support.
 * Capped at 2.
 */
export function getAdjacentFriendlySupport(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  let support = 0;
  const targetTile = tiles[target.tileIndex];

  for (const unit of allUnits) {
    if (unit.id === target.id) continue;
    if (unit.ownerId !== target.ownerId) continue;
    if (unit.currentHealth <= 0) continue;

    // Same hex, different segment
    if (unit.tileIndex === target.tileIndex) {
      support++;
    } else if (targetTile.neighbours.includes(unit.tileIndex)) {
      support++;
    }

    if (support >= 2) return 2;
  }

  return support;
}

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
 * Based on elevation type and forest cover.
 *
 * Elevation mapping:
 *   flat     → 0
 *   rolling  → 0
 *   hills    → 1
 *   mountain → 3
 * Forest: +1
 * Max 4.
 */
export function getTerrainDefense(tile: Tile): number {
  let value = 0;

  switch (tile.elevationType) {
    case 'hills':    value += 1; break;
    case 'mountain': value += 3; break;
  }

  if (tile.forested) value += 1;

  return Math.min(4, value);
}

// ---------------------------------------------------------------------------
// Defence Power calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the full DefencePower for a target unit.
 * DefencePower = armour + EW + defensiveFormation + terrain
 *
 * Each component is clamped to its valid range before summing.
 */
export function getDefencePower(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): { armour: number; ew: number; defensiveFormation: number; terrain: number; total: number } {
  const armour = clamp(target.attributes.armour ?? 0, 0, 5);
  const ew = clamp(getEWDefense(target, allUnits), 0, 5);
  const defensiveFormation = clamp(getAdjacentFriendlySupport(target, allUnits, tiles), 0, 2);
  const terrain = clamp(getTerrainDefense(tiles[target.tileIndex]), 0, 4);
  const total = armour + ew + defensiveFormation + terrain;

  return { armour, ew, defensiveFormation, terrain, total };
}

// ---------------------------------------------------------------------------
// Legacy compatibility: getEffectiveDefense (used by server/combat.ts)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use getDefencePower instead. Kept for server compatibility.
 * Returns the DefencePower total (not scaled).
 */
export function getEffectiveDefense(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  return getDefencePower(target, allUnits, tiles).total;
}

// ---------------------------------------------------------------------------
// Legacy compatibility: getBestNearbyDefense
// ---------------------------------------------------------------------------

/**
 * @deprecated Legacy function. In the new model, EW is summed from same-hex
 * units (not best-nearby). Kept for API compatibility.
 */
export function getBestNearbyDefense(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  return getEWDefense(target, allUnits);
}

// ---------------------------------------------------------------------------
// Encirclement (legacy — no longer affects damage formula)
// ---------------------------------------------------------------------------

/**
 * A unit is encircled if enemy units occupy 3 or more distinct adjacent
 * directions around it. Kept for informational purposes.
 */
export function isEncircled(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): boolean {
  const targetTile = tiles[target.tileIndex];
  const occupiedDirections = new Set<number>();

  for (const unit of allUnits) {
    if (unit.ownerId === target.ownerId) continue;
    if (unit.currentHealth <= 0) continue;

    const dirIndex = targetTile.neighbours.indexOf(unit.tileIndex);
    if (dirIndex !== -1) {
      occupiedDirections.add(dirIndex);
    }
  }

  return occupiedDirections.size >= 3;
}

// ---------------------------------------------------------------------------
// Damage formula
// ---------------------------------------------------------------------------

/** Clamp a value to [min, max]. */
export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(value, maxValue));
}

/**
 * Calculate damage using the attack-scaled ratio curve formula.
 *
 * MaxFormulaDamage = min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER * AttackPower)
 * Damage = round(MIN_DAMAGE + (MaxFormulaDamage - MIN_DAMAGE) * AttackPower² / (AttackPower² + EffectiveDefence²))
 * Clamped to [MIN_DAMAGE, MAX_DAMAGE].
 *
 * Weak attacks can no longer deal 30 damage just because the target has zero
 * defence. Strong attacks (AttackPower ≥ 5) can still reach 30.
 */
export function calculateDamage(
  attack: number,
  targetOrientation: TargetOrientation | string,
  armour: number,
  ew: number,
  defensiveFormation: number,
  terrain: number,
): number {
  // Clamp inputs
  attack = clamp(attack, 1, 5);
  armour = clamp(armour, 0, 5);
  ew = clamp(ew, 0, 5);
  defensiveFormation = clamp(defensiveFormation, 0, 2);
  terrain = clamp(terrain, 0, 4);

  const orientationBonus = getOrientationBonus(targetOrientation);
  const attackPower = Math.max(1, attack + orientationBonus);

  const defencePower = armour + ew + defensiveFormation + terrain;
  const effectiveDefence = defencePower * DEFENCE_SCALE;

  const maxFormulaDamage = Math.min(MAX_DAMAGE, DAMAGE_PER_ATTACK_POWER * attackPower);

  const attackPowerSquared = attackPower * attackPower;
  const effectiveDefenceSquared = effectiveDefence * effectiveDefence;

  const rawDamage =
    MIN_DAMAGE +
    (maxFormulaDamage - MIN_DAMAGE) *
      attackPowerSquared /
      (attackPowerSquared + effectiveDefenceSquared);
  const damage = Math.round(rawDamage);

  return clamp(damage, MIN_DAMAGE, MAX_DAMAGE);
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

// ---------------------------------------------------------------------------
// Direct damage calculation (contextual — uses game state)
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
  const approachDir = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const arc = classifyAttackArc(target.facing, approachDir);
  const orientationBonus = getFacingModifier(arc);

  const defencePower = getDefencePower(target, allUnits, tiles);
  const baseAttack = clamp(attacker.attributes.attack ?? 0, 1, 5);
  const attackPower = calculateModifiedAttackPower(attacker, baseAttack, orientationBonus, distance);
  const effectiveDefence = defencePower.total * DEFENCE_SCALE;

  let damage = calculateFormulaDamage(attackPower, effectiveDefence);

  // Apply drone incoming damage modifier
  const antiDronePenaltyApplied = isDrone(target);
  damage = applyDroneIncomingDamageModifier('direct', target, damage);

  return { damage, arc, orientationBonus, defencePower, antiDronePenaltyApplied };
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

  // Orientation bonus only for the originally selected target
  let orientationBonus = 0;
  if (victim.id === selectedTarget.id) {
    const approachDir = getApproachDirection(tiles, victim.tileIndex, attacker.tileIndex);
    const arc = classifyAttackArc(victim.facing, approachDir);
    orientationBonus = getFacingModifier(arc);
  }

  const baseSplash = clamp(splashPower, 1, 5);
  const splashAttackPower = calculateModifiedAttackPower(attacker, baseSplash, orientationBonus, distance);
  const defPower = getDefencePower(victim, allUnits, tiles);
  const effectiveDefence = defPower.total * DEFENCE_SCALE;

  const fullFormulaDamage = calculateFormulaDamage(splashAttackPower, effectiveDefence);

  // Splash scaling applied before drone modifier
  let result = Math.max(MIN_DAMAGE, Math.round(fullFormulaDamage * SPLASH_SCALE));

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

  // Anti-Air validation: if attacker ONLY has antiAir (no attack, no rangeAttack, no splashAttack),
  // it can only target drones.
  const hasAttack = (attacker.attributes.attack ?? 0) > 0;
  const hasRange = (attacker.attributes.rangeAttack ?? 0) > 0;
  const hasSplash = (attacker.attributes.splashAttack ?? 0) > 0;
  const hasAntiAir = (attacker.attributes.antiAir ?? 0) > 0;

  if (!hasAttack && !hasRange && !hasSplash && hasAntiAir && !isDrone(target)) {
    return invalidResult(attackerId, targetId, 'Anti-Air weapons can only target drones');
  }

  // Range check
  const range = attacker.attributes.rangeAttack ?? 0;
  const attackRange = Math.max(range, (attacker.attributes.attack ?? 0) > 0 ? 1 : 0, hasAntiAir ? 1 : 0);
  const dist = graphDistance(tiles, attacker.tileIndex, target.tileIndex);
  if (dist < 0 || dist > attackRange) {
    return invalidResult(attackerId, targetId, 'Target out of range');
  }

  // Orientation info (shared across weapon modes)
  const approachDir = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const arc = classifyAttackArc(target.facing, approachDir);
  const orientationBonus = getFacingModifier(arc);
  const defencePower = getDefencePower(target, allUnits, tiles);

  // Build valid weapon options
  const validOptions: WeaponOption[] = [];

  // --- Direct Fire ---
  if ((attacker.attributes.attack ?? 0) > 0) {
    const { damage } = calculateDirectDamage(attacker, target, allUnits, tiles, dist);
    validOptions.push({
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
    validOptions.push({
      mode: 'splash',
      score: splashScore,
      damages: splashDamages,
    });
  }

  // --- Anti-Air Fire ---
  if ((attacker.attributes.antiAir ?? 0) > 0 && isDrone(target)) {
    const aaLevel = clamp(attacker.attributes.antiAir!, 1, 5);
    const aaAttackPower = calculateModifiedAttackPower(attacker, aaLevel, orientationBonus, dist);
    const effectiveDefence = defencePower.total * DEFENCE_SCALE;
    const antiAirDamage = calculateFormulaDamage(aaAttackPower, effectiveDefence);
    // applyDroneIncomingDamageModifier('antiAir') returns damage unchanged (multiplier = 1.0)
    validOptions.push({
      mode: 'antiAir',
      score: antiAirDamage,
      damages: [{ unitId: target.id, damage: antiAirDamage }],
    });
  }

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
function chooseWeaponOption(options: WeaponOption[], target: Unit): WeaponOption {
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
  const defPower = getDefencePower(drone, allUnits, tiles);
  // Terrain is 0 for airborne drones
  const airborneDefence = (defPower.armour + defPower.ew + defPower.defensiveFormation) * DEFENCE_SCALE;
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
    const healthBefore = drone.currentHealth;
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

// ---------------------------------------------------------------------------
// Crossfire bonus (optional)
// ---------------------------------------------------------------------------

/**
 * Check if a crossfire bonus applies for an attacker against a target.
 * Crossfire: 2+ friendly units attacking same target from side/rear arcs
 * in the same resolution window grants +1 damage each.
 *
 * This function checks if the given attacker qualifies for the crossfire bonus
 * given a list of other attackers targeting the same unit this turn.
 */
export function getCrossfireBonus(
  attacker: Unit,
  target: Unit,
  otherAttackers: Unit[],
  tiles: Tile[],
): number {
  // Check if this attacker is hitting from side or rear
  const myApproach = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const myArc = classifyAttackArc(target.facing, myApproach);
  if (myArc !== 'side' && myArc !== 'rear') return 0;

  // Count other attackers also hitting from side/rear
  let qualifyingOthers = 0;
  for (const other of otherAttackers) {
    if (other.id === attacker.id) continue;
    if (other.currentHealth <= 0) continue;
    const approach = getApproachDirection(tiles, target.tileIndex, other.tileIndex);
    const arc = classifyAttackArc(target.facing, approach);
    if (arc === 'side' || arc === 'rear') {
      qualifyingOthers++;
    }
  }

  return qualifyingOthers >= 1 ? 1 : 0;
}
