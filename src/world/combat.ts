/**
 * Combat System — deterministic drone combat on a hex grid.
 *
 * Core mechanics: facing arcs, armour, electronic defence aura,
 * formation support, splash damage, reaction fire.
 *
 * Terrain is intentionally excluded from this version.
 */

import { Tile } from './types.js';
import { Unit, HexSegment } from './units.js';
import { graphDistance } from './pathfinding.js';
import { TurnState, canMove, canPivot, recordMove, recordPivot } from './turnState.js';

// ---------------------------------------------------------------------------
// Attack arc classification
// ---------------------------------------------------------------------------

/** Attack arc relative to the defender's facing. */
export type AttackArc = 'front' | 'frontSide' | 'side' | 'rear' | 'unknown';

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
 * Classify the attack arc based on the defender's facing and the
 * approach direction (direction from defender toward attacker).
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
    case 1: return 'frontSide'; // front-right
    case 5: return 'frontSide'; // front-left
    case 2: return 'side';      // side-right
    case 4: return 'side';      // side-left
    case 3: return 'rear';
    default: return 'unknown';
  }
}

/** Get the damage modifier for an attack arc. */
export function getFacingModifier(arc: AttackArc): number {
  switch (arc) {
    case 'front': return -1;
    case 'frontSide': return 0;
    case 'side': return 1;
    case 'rear': return 2;
    case 'unknown': return 0;
  }
}

// ---------------------------------------------------------------------------
// Formation support
// ---------------------------------------------------------------------------

/**
 * Count adjacent friendly units that provide formation support.
 * Adjacent = neighbouring hex or same hex (different segment).
 * Destroyed units (currentHealth <= 0) do not provide support.
 * Capped at +2.
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
// Electronic defence (EW aura)
// ---------------------------------------------------------------------------

/**
 * Get the best defence value among friendly units within 1 hex of the target.
 * Excludes the target itself and destroyed units.
 */
export function getBestNearbyDefense(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  let best = 0;
  const targetTile = tiles[target.tileIndex];

  for (const unit of allUnits) {
    if (unit.id === target.id) continue;
    if (unit.ownerId !== target.ownerId) continue;
    if (unit.currentHealth <= 0) continue;

    const isNearby =
      unit.tileIndex === target.tileIndex ||
      targetTile.neighbours.includes(unit.tileIndex);

    if (isNearby) {
      const def = unit.attributes.defence ?? 0;
      if (def > best) best = def;
    }
  }

  return best;
}

/**
 * Calculate effective defence for a target unit.
 * effectiveDefense = ownDefense + bestNearbyDefense + formationSupport
 * Clamped to max 7. Reduced by 1 if encircled (min 0).
 */
export function getEffectiveDefense(
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  const ownDefense = target.attributes.defence ?? 0;
  const nearbyDefense = getBestNearbyDefense(target, allUnits, tiles);
  const formation = getAdjacentFriendlySupport(target, allUnits, tiles);

  let effective = ownDefense + nearbyDefense + formation;

  // Encirclement check
  if (isEncircled(target, allUnits, tiles)) {
    effective -= 1;
  }

  return Math.max(0, Math.min(7, effective));
}

// ---------------------------------------------------------------------------
// Encirclement
// ---------------------------------------------------------------------------

/**
 * A unit is encircled if enemy units occupy 3 or more distinct adjacent
 * directions around it.
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
// Damage calculation
// ---------------------------------------------------------------------------

/**
 * Calculate direct damage from attacker to target.
 * rawDamage = attacker.attackPower + facingModifier
 * finalDamage = rawDamage - target.armour - floor(effectiveDefense / 2)
 * Clamped: min 0, max target.currentHealth
 */
export function calculateDirectDamage(
  attacker: Unit,
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): { damage: number; arc: AttackArc; facingMod: number; effectiveDefense: number } {
  const approachDir = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const arc = classifyAttackArc(target.facing, approachDir);
  const facingMod = getFacingModifier(arc);
  const effectiveDefense = getEffectiveDefense(target, allUnits, tiles);

  const attackPower = attacker.attributes.attack ?? 0;
  const armour = target.attributes.armour ?? 0;
  const defenseReduction = Math.floor(effectiveDefense / 2);

  const rawDamage = attackPower + facingMod;
  const finalDamage = Math.max(0, Math.min(target.currentHealth, rawDamage - armour - defenseReduction));

  return { damage: finalDamage, arc, facingMod, effectiveDefense };
}

/**
 * Calculate splash damage against a specific victim.
 * splashFinalDamage = attacker.splashDamage - floor(victim.armour / 2) - floor(victimEffectiveDefense / 2)
 * Clamped: min 0, max victim.currentHealth
 */
export function calculateSplashDamage(
  attacker: Unit,
  victim: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): number {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0) return 0;

  const armourReduction = Math.floor((victim.attributes.armour ?? 0) / 2);
  const effectiveDefense = getEffectiveDefense(victim, allUnits, tiles);
  const defenseReduction = Math.floor(effectiveDefense / 2);

  return Math.max(0, Math.min(victim.currentHealth, splashPower - armourReduction - defenseReduction));
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
  const { damage, arc, facingMod, effectiveDefense } = calculateDirectDamage(attacker, target, allUnits, tiles);

  // Apply direct damage
  target.currentHealth -= damage;
  const destroyedIds: string[] = [];
  if (target.currentHealth <= 0) {
    target.currentHealth = 0;
    destroyedIds.push(target.id);
  }

  // Splash damage
  const splashEvents: SplashEvent[] = [];
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower > 0) {
    const targetTile = tiles[target.tileIndex];
    const splashCandidates = allUnits.filter((u) => {
      if (u.id === target.id) return false;
      if (u.id === attacker.id) return false;
      if (u.currentHealth <= 0) return false;
      // Adjacent to primary target
      return (
        u.tileIndex === target.tileIndex ||
        targetTile.neighbours.includes(u.tileIndex)
      );
    });

    for (const victim of splashCandidates) {
      const splashDmg = calculateSplashDamage(attacker, victim, allUnits, tiles);
      if (splashDmg > 0) {
        victim.currentHealth -= splashDmg;
        const destroyed = victim.currentHealth <= 0;
        if (destroyed) {
          victim.currentHealth = 0;
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
    facingModifier: facingMod,
    targetArmour: target.attributes.armour ?? 0,
    targetEffectiveDefense: effectiveDefense,
    directDamage: damage,
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
// Movement with facing update
// ---------------------------------------------------------------------------

/**
 * Move a unit to a new hex, updating facing to the direction of movement.
 * Does NOT resolve reaction fire — call resolveReactionFire separately
 * if reaction fire is desired.
 *
 * If a TurnState is provided, enforces movement rules:
 *  - Inter-hex move requires available movement points.
 *  - Records the move (locks pivot for the rest of the turn).
 * Returns false if the move was rejected by turn-state rules.
 */
export function moveUnit(
  unit: Unit,
  toTileIndex: number,
  tiles: Tile[],
  segment?: HexSegment,
  turnState?: TurnState,
): boolean {
  const fromIndex = unit.tileIndex;
  const isInterHex = fromIndex !== toTileIndex;

  if (turnState) {
    if (isInterHex) {
      if (!canMove(unit, turnState)) return false;
    } else if (segment !== undefined || segment === undefined) {
      // Same-hex reposition is a pivot — check pivot rules
      // (only applies if facing/segment will actually change, but we
      //  gate on the guard regardless to keep API simple)
      if (!canPivot(unit, turnState)) return false;
    }
  }

  if (isInterHex) {
    const dir = getApproachDirection(tiles, fromIndex, toTileIndex);
    if (dir >= 0) {
      unit.facing = dir as HexSegment;
    }
    unit.tileIndex = toTileIndex;
    if (turnState) {
      recordMove(unit, turnState);
    }
  }

  if (segment !== undefined) {
    unit.segment = segment;
  }

  return true;
}

/**
 * Pivot a unit within its current hex (change facing and/or segment).
 * Free action but requires movement points remaining and no prior move.
 *
 * If no TurnState is provided, always succeeds (legacy/test usage).
 * Returns false if turn-state rules reject the pivot.
 */
export function pivotUnit(
  unit: Unit,
  newFacing: HexSegment,
  newSegment?: HexSegment,
  turnState?: TurnState,
): boolean {
  if (turnState) {
    if (!canPivot(unit, turnState)) return false;
    recordPivot(unit, turnState, newFacing, newSegment);
  } else {
    unit.facing = newFacing;
    if (newSegment !== undefined) {
      unit.segment = newSegment;
    }
  }
  return true;
}

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
  unitA.currentHealth = Math.max(0, healthA - resultB.directDamage);
  unitB.currentHealth = Math.max(0, healthB - resultA.directDamage);

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
