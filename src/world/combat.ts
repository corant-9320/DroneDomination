/**
 * Combat System — deterministic drone combat on a hex grid.
 *
 * Damage formula (ratio-based curve):
 *   Damage = round(1 + 29 * AttackPower² / (AttackPower² + EffectiveDefence²))
 *
 * Key properties:
 * - Minimum damage is always 1 (weak attacks are never useless)
 * - Maximum damage is 30
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
export const SPLASH_SCALE = 0.2;

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

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
 * Sum all defence values, capped at 5.
 * Excludes the target itself and destroyed units.
 */
export function getEWDefense(
  target: Unit,
  allUnits: Unit[],
): number {
  let total = 0;

  for (const unit of allUnits) {
    if (unit.id === target.id) continue;
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
 * Calculate damage using the ratio-based curve formula.
 *
 * Damage = round(1 + 29 * AttackPower² / (AttackPower² + EffectiveDefence²))
 * Clamped to [1, 30].
 *
 * When EffectiveDefence is 0, the denominator equals AttackPower² and damage = 30.
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
  const attackPower = attack + orientationBonus;

  const defencePower = armour + ew + defensiveFormation + terrain;
  const effectiveDefence = defencePower * DEFENCE_SCALE;

  const attackPowerSquared = attackPower * attackPower;
  const effectiveDefenceSquared = effectiveDefence * effectiveDefence;

  const rawDamage = 1 + 29 * attackPowerSquared / (attackPowerSquared + effectiveDefenceSquared);
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
 */
export function calculateDirectDamage(
  attacker: Unit,
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): { damage: number; arc: AttackArc; orientationBonus: number; defencePower: ReturnType<typeof getDefencePower> } {
  const approachDir = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const arc = classifyAttackArc(target.facing, approachDir);
  const orientationBonus = getFacingModifier(arc);

  const defencePower = getDefencePower(target, allUnits, tiles);
  const attack = clamp(attacker.attributes.attack ?? 0, 1, 5);

  const damage = calculateDamage(
    attack,
    arc === 'unknown' ? 'front' : arc,
    defencePower.armour,
    defencePower.ew,
    defencePower.defensiveFormation,
    defencePower.terrain,
  );

  return { damage, arc, orientationBonus, defencePower };
}

/**
 * Calculate splash damage against a specific victim.
 *
 * Splash is 20% of the formula result using splashAttack as the attack input.
 * Orientation is always "front" (no flanking bonus for splash on adjacents).
 * Result is rounded, with minimum 1 damage.
 */
export function calculateSplashDamage(
  attacker: Unit,
  victim: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0) return 0;

  const defPower = getDefencePower(victim, allUnits, tiles);

  const fullDamage = calculateDamage(
    clamp(splashPower, 1, 5),
    'front',
    defPower.armour,
    defPower.ew,
    defPower.defensiveFormation,
    defPower.terrain,
  );

  // Splash is 20% of the formula result, minimum 1
  return Math.max(1, Math.round(fullDamage * SPLASH_SCALE));
}

/**
 * Calculate the splash bonus damage added to the primary target.
 *
 * Same formula as splash on adjacents: 20% of damage using splashAttack,
 * but uses the primary target's orientation and defence.
 */
export function calculateSplashBonusOnTarget(
  attacker: Unit,
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
  targetOrientation: TargetOrientation | string,
): number {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0) return 0;

  const defPower = getDefencePower(target, allUnits, tiles);

  const fullDamage = calculateDamage(
    clamp(splashPower, 1, 5),
    targetOrientation,
    defPower.armour,
    defPower.ew,
    defPower.defensiveFormation,
    defPower.terrain,
  );

  // 20% of formula result, minimum 1
  return Math.max(1, Math.round(fullDamage * SPLASH_SCALE));
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
  splashEvents: SplashEvent[];
  destroyedUnitIds: string[];
  reactionEvents: CombatResult[];
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
    splashEvents: [],
    destroyedUnitIds: [],
    reactionEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Attack resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single attack from attacker to target (immediate mode).
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

  // Range check
  const range = attacker.attributes.rangeAttack ?? 0;
  const attackRange = Math.max(range, (attacker.attributes.attack ?? 0) > 0 ? 1 : 0);
  const dist = graphDistance(tiles, attacker.tileIndex, target.tileIndex);
  if (dist < 0 || dist > attackRange) {
    return invalidResult(attackerId, targetId, 'Target out of range');
  }

  // Calculate direct damage
  const { damage, arc, orientationBonus, defencePower } = calculateDirectDamage(attacker, target, allUnits, tiles);

  // Calculate splash bonus on primary target (additive)
  const splashPower = attacker.attributes.splashAttack ?? 0;
  const splashBonusOnTarget = splashPower > 0
    ? calculateSplashBonusOnTarget(attacker, target, allUnits, tiles, arc === 'unknown' ? 'front' : arc)
    : 0;
  const totalDirectDamage = damage + splashBonusOnTarget;

  // Apply total damage to primary target
  target.currentHealth = applyDamage(target.currentHealth, totalDirectDamage);
  const destroyedIds: string[] = [];
  if (target.currentHealth <= 0) {
    destroyedIds.push(target.id);
  }

  // Splash damage on adjacent units (20% of formula using splashAttack)
  const splashEvents: SplashEvent[] = [];
  if (splashPower > 0) {
    const targetTile = tiles[target.tileIndex];
    const splashCandidates = allUnits.filter((u) => {
      if (u.id === target.id) return false;
      if (u.id === attacker.id) return false;
      if (u.currentHealth <= 0) return false;
      // Adjacent to primary target or same hex
      return (
        u.tileIndex === target.tileIndex ||
        targetTile.neighbours.includes(u.tileIndex)
      );
    });

    for (const victim of splashCandidates) {
      const splashDmg = calculateSplashDamage(attacker, victim, allUnits, tiles);
      if (splashDmg > 0) {
        victim.currentHealth = applyDamage(victim.currentHealth, splashDmg);
        const destroyed = victim.currentHealth <= 0;
        if (destroyed) {
          destroyedIds.push(victim.id);
        }
        splashEvents.push({ victimId: victim.id, damage: splashDmg, victimDestroyed: destroyed });
      }
    }
  }

  return {
    attackerId,
    targetId,
    wasValid: true,
    attackArc: arc,
    facingModifier: orientationBonus,
    targetArmour: defencePower.armour,
    targetEffectiveDefense: defencePower.total,
    directDamage: totalDirectDamage,
    splashEvents,
    destroyedUnitIds: destroyedIds,
    reactionEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Reaction fire
// ---------------------------------------------------------------------------

/**
 * Check and resolve reaction fire as a unit moves along a path.
 * For each hex entered, enemies with front-arc coverage and sufficient range
 * may fire.
 *
 * Mutates unit health. Returns all reaction combat results.
 * Movement stops if the moving unit is destroyed.
 */
export function resolveReactionFire(
  movingUnitId: string,
  path: number[],
  allUnits: Unit[],
  tiles: Tile[],
): CombatResult[] {
  const movingUnit = allUnits.find((u) => u.id === movingUnitId);
  if (!movingUnit || movingUnit.currentHealth <= 0) return [];

  const results: CombatResult[] = [];
  const reactedThisTurn = new Set<string>();

  for (let i = 1; i < path.length; i++) {
    const prevHex = path[i - 1];
    const currentHex = path[i];

    // Update unit position and facing
    movingUnit.tileIndex = currentHex;
    const dir = tiles[prevHex].neighbours.indexOf(currentHex);
    if (dir !== -1) {
      movingUnit.facing = dir as HexSegment;
    }

    // Check enemies that could react
    for (const enemy of allUnits) {
      if (enemy.ownerId === movingUnit.ownerId) continue;
      if (enemy.currentHealth <= 0) continue;
      if (reactedThisTurn.has(enemy.id)) continue;

      // Range check
      const enemyRange = enemy.attributes.rangeAttack ?? 0;
      const attackRange = Math.max(enemyRange, (enemy.attributes.attack ?? 0) > 0 ? 1 : 0);
      const dist = graphDistance(tiles, enemy.tileIndex, movingUnit.tileIndex);
      if (dist < 0 || dist > attackRange) continue;

      // Front arc check: moving unit must be in enemy's front arc
      const approachFromEnemy = getApproachDirection(tiles, enemy.tileIndex, movingUnit.tileIndex);
      const arcFromEnemy = classifyAttackArc(enemy.facing, approachFromEnemy);
      if (arcFromEnemy !== 'front') continue;

      // Fire reaction
      reactedThisTurn.add(enemy.id);
      const result = resolveAttack(enemy.id, movingUnitId, allUnits, tiles);
      results.push(result);

      // If moving unit is destroyed, stop movement
      if (movingUnit.currentHealth <= 0) {
        return results;
      }
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
