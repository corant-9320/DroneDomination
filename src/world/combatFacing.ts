/**
 * Combat Facing — bearing-based orientation geometry.
 *
 * Orientation bonus is calculated from the straight-line bearing between
 * attacker and target, compared against the defender's facing direction angle.
 *
 * Uses a flat-earth (tangent-plane) approximation of the 3D tile positions —
 * valid because combat ranges are small relative to the globe radius.
 *
 * The bonus is continuous from 0 (head-on) to +2 (perfect rear shot),
 * linearly interpolated based on the angular difference.
 *
 * Pure functions — no damage calculations, no state mutation.
 */

import { Tile, Vec3 } from './types.js';
import { Unit } from './units.js';

// ---------------------------------------------------------------------------
// Orientation types
// ---------------------------------------------------------------------------

/** Target orientation relative to the attacker. */
export type TargetOrientation = 'front' | 'side' | 'rear';

/** Arc classification for UI/wire compatibility. */
export type AttackArc = 'front' | 'side' | 'rear' | 'unknown';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum orientation bonus (perfect rear attack). */
const MAX_ORIENTATION_BONUS = 2;

// ---------------------------------------------------------------------------
// Vec3 helpers (local, avoids import cycle with vec3.ts)
// ---------------------------------------------------------------------------

function v3sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function v3scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function v3len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// ---------------------------------------------------------------------------
// Flat-earth bearing calculation
// ---------------------------------------------------------------------------

/**
 * Project a direction vector onto the tangent plane at `origin` on the unit
 * sphere. Returns the projected 2D vector as [tx, ty] in an arbitrary but
 * consistent local frame (east/north on the tangent plane).
 *
 * The tangent plane basis is derived from the origin's position:
 *   - "east" = cross(up, origin) normalized  (up = [0,1,0] or fallback)
 *   - "north" = cross(origin, east)
 *
 * This gives a consistent local 2D frame for angle calculations.
 */
function tangentProject(origin: Vec3, target: Vec3): [number, number] {
  // Direction in 3D from origin to target
  const dir = v3sub(target, origin);

  // Remove the radial component (project onto tangent plane)
  const radialComponent = v3dot(dir, origin); // origin is ~unit length
  const tangent: Vec3 = {
    x: dir.x - radialComponent * origin.x,
    y: dir.y - radialComponent * origin.y,
    z: dir.z - radialComponent * origin.z,
  };

  // Build a local 2D frame on the tangent plane
  // "up" reference — use world Y unless origin is near a pole
  let up: Vec3 = { x: 0, y: 1, z: 0 };
  const originDotUp = Math.abs(v3dot(origin, up));
  if (originDotUp > 0.99) {
    up = { x: 1, y: 0, z: 0 }; // fallback near poles
  }

  // east = cross(up, origin), normalized
  const eastRaw: Vec3 = {
    x: up.y * origin.z - up.z * origin.y,
    y: up.z * origin.x - up.x * origin.z,
    z: up.x * origin.y - up.y * origin.x,
  };
  const eastLen = v3len(eastRaw);
  if (eastLen < 1e-10) return [0, 0];
  const east: Vec3 = { x: eastRaw.x / eastLen, y: eastRaw.y / eastLen, z: eastRaw.z / eastLen };

  // north = cross(origin, east)
  const north: Vec3 = {
    x: origin.y * east.z - origin.z * east.y,
    y: origin.z * east.x - origin.x * east.z,
    z: origin.x * east.y - origin.y * east.x,
  };

  // Project tangent vector onto local frame
  const tx = v3dot(tangent, east);
  const ty = v3dot(tangent, north);
  return [tx, ty];
}

/**
 * Calculate the bearing angle (radians, measured clockwise from local north)
 * from one tile to another, using a flat-earth tangent-plane projection.
 *
 * Returns the angle in radians [0, 2π), or NaN if tiles are coincident.
 */
export function getBearingBetweenTiles(
  tiles: Tile[],
  fromIndex: number,
  toIndex: number,
): number {
  const from = tiles[fromIndex].position3d;
  const to = tiles[toIndex].position3d;

  const [tx, ty] = tangentProject(from, to);
  const len = Math.sqrt(tx * tx + ty * ty);
  if (len < 1e-12) return NaN;

  // atan2(east, north) gives clockwise-from-north bearing
  return (Math.atan2(tx, ty) + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Get the facing angle of a unit — the bearing from the unit's tile toward
 * the neighbour tile indicated by its `facing` index.
 *
 * Returns radians [0, 2π), or NaN if facing index is invalid.
 */
export function getFacingAngle(
  tiles: Tile[],
  unitTileIndex: number,
  facing: number,
): number {
  const tile = tiles[unitTileIndex];
  if (facing < 0 || facing >= tile.neighbours.length) return NaN;
  const neighbourIndex = tile.neighbours[facing];
  return getBearingBetweenTiles(tiles, unitTileIndex, neighbourIndex);
}

/**
 * Calculate the continuous orientation bonus (0 to MAX_ORIENTATION_BONUS)
 * based on the angular difference between:
 *   - The approach bearing (bearing from defender toward attacker)
 *   - The defender's facing direction angle
 *
 * Angular difference of 0° (head-on, attacker in front) → bonus 0
 * Angular difference of 180° (perfect rear shot) → bonus MAX_ORIENTATION_BONUS (2)
 * Linear interpolation between.
 *
 * The result is rounded to 1 decimal place for clean combat numbers.
 */
export function calculateOrientationBonus(
  tiles: Tile[],
  attackerTileIndex: number,
  defenderTileIndex: number,
  defenderFacing: number,
): number {
  if (attackerTileIndex === defenderTileIndex) return 0;

  // Bearing from defender toward attacker (approach direction)
  const approachBearing = getBearingBetweenTiles(tiles, defenderTileIndex, attackerTileIndex);
  if (isNaN(approachBearing)) return 0;

  // Defender's facing angle
  const facingAngle = getFacingAngle(tiles, defenderTileIndex, defenderFacing);
  if (isNaN(facingAngle)) return 0;

  // Angular difference (0 to π)
  let diff = Math.abs(approachBearing - facingAngle);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;

  // Linear interpolation: 0° → 0 bonus, 180° → MAX bonus
  const rawBonus = (diff / Math.PI) * MAX_ORIENTATION_BONUS;

  // Round to 1 decimal place for clean combat numbers
  return Math.round(rawBonus * 10) / 10;
}

// ---------------------------------------------------------------------------
// Arc classification (for UI display and wire compatibility)
// ---------------------------------------------------------------------------

/**
 * Classify the attack arc into front/side/rear based on the continuous
 * angular difference. Used for display and combat log purposes.
 *
 * - 0°–60°   → front
 * - 60°–120° → side
 * - 120°–180° → rear
 */
export function classifyArcFromAngle(angleDiffRadians: number): AttackArc {
  const deg = (angleDiffRadians * 180) / Math.PI;
  if (deg <= 60) return 'front';
  if (deg <= 120) return 'side';
  return 'rear';
}

/**
 * Get the angular difference (0 to π radians) between the approach bearing
 * and the defender's facing. Returns NaN if positions are coincident.
 */
export function getAngularDifference(
  tiles: Tile[],
  attackerTileIndex: number,
  defenderTileIndex: number,
  defenderFacing: number,
): number {
  if (attackerTileIndex === defenderTileIndex) return NaN;

  const approachBearing = getBearingBetweenTiles(tiles, defenderTileIndex, attackerTileIndex);
  if (isNaN(approachBearing)) return NaN;

  const facingAngle = getFacingAngle(tiles, defenderTileIndex, defenderFacing);
  if (isNaN(facingAngle)) return NaN;

  let diff = Math.abs(approachBearing - facingAngle);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff;
}

// ---------------------------------------------------------------------------
// Legacy API — kept for compatibility with existing consumers
// ---------------------------------------------------------------------------

/**
 * Get the orientation bonus based on the target's facing relative to attacker.
 * Legacy discrete version — maps arc labels to fixed bonuses.
 * Kept for tests and non-tile-aware callers.
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
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Hex direction helpers (still needed for movement/facing updates)
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
 *
 * Still used by movement code to set unit facing on move.
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
 * approach direction (discrete neighbour index based).
 *
 * DEPRECATED for combat bonus calculation — use calculateOrientationBonus instead.
 * Retained for legacy tests and non-tile-geometry callers.
 */
export function classifyAttackArc(
  defenderFacing: number,
  approachDirection: number,
): AttackArc {
  if (approachDirection < 0) return 'unknown';

  const diff = ((approachDirection - defenderFacing) % 6 + 6) % 6;

  switch (diff) {
    case 0: return 'front';
    case 1: return 'front';
    case 5: return 'front';
    case 2: return 'side';
    case 4: return 'side';
    case 3: return 'rear';
    default: return 'unknown';
  }
}

/**
 * Get the orientation bonus for a classified attack arc.
 * Legacy discrete version — use calculateOrientationBonus for the new
 * continuous bearing-based system.
 */
export function getFacingModifier(arc: AttackArc): number {
  return getOrientationBonus(arc === 'unknown' ? 'front' : arc);
}

// ---------------------------------------------------------------------------
// Crossfire bonus (optional)
// ---------------------------------------------------------------------------

/**
 * @deprecated Crossfire bonus is deprecated and always returns 0.
 * Retained for API compatibility — will be removed in a future release.
 */
export function getCrossfireBonus(
  _attacker: Unit,
  _target: Unit,
  _otherAttackers: Unit[],
  _tiles: Tile[],
): number {
  return 0;
}
