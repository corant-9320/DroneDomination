/**
 * Combat Facing — arc classification and orientation geometry.
 *
 * Pure functions operating on tile adjacency and unit facing values.
 * No damage calculations, no state mutation.
 */

import { Tile } from './types.js';
import { Unit } from './units.js';

// ---------------------------------------------------------------------------
// Orientation types
// ---------------------------------------------------------------------------

/** Target orientation relative to the attacker. */
export type TargetOrientation = 'front' | 'side' | 'rear';

/** Legacy alias kept for API compatibility. */
export type AttackArc = 'front' | 'side' | 'rear' | 'unknown';

// ---------------------------------------------------------------------------
// Orientation bonus
// ---------------------------------------------------------------------------

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
// Hex direction helpers
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
