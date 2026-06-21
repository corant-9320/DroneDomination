/**
 * Shared range-check logic — used by both client and server.
 *
 * Computes segment-distance and compares against the weapon range threshold
 * so client and server always agree on whether a target is in range.
 *
 * The tile interface is minimal so both TileData (client) and Tile (server)
 * can satisfy it via a thin adapter.
 */

// ─── Constants (must match src/world/combatFormula.ts) ───────────────────────────

/** Each point of rangeAttack extends range by this many hex-units of segment distance. */
export const SEGMENT_RANGE_PER_POINT = 0.5;

/** Base reach — a unit with rangeAttack=0 can hit adjacent segments within this. */
export const SEGMENT_RANGE_BASE = 1.0;

// ─── Minimal tile interface ───────────────────────────────────────────────────

export interface RangeTile {
  /** 3D position on the unit sphere [x, y, z]. */
  pos: [number, number, number];
  /** Boundary polygon vertices [[x,y,z], ...]. May be empty for test grids. */
  boundary: [number, number, number][];
  /** Neighbour tile indices. */
  neighbours: number[];
  /** Number of sides (5 or 6). */
  sides: number;
}

// ─── Vec3 helpers (inlined to avoid import dependencies) ──────────────────────

function v3sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function v3length(v: [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function v3distance(a: [number, number, number], b: [number, number, number]): number {
  return v3length(v3sub(a, b));
}

function v3normalize(v: [number, number, number]): [number, number, number] {
  const len = v3length(v);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

// ─── Segment centroid ─────────────────────────────────────────────────────────

/**
 * Compute the 3D centroid of a segment triangle (tile center + two boundary verts),
 * projected back onto the unit sphere.
 */
function getSegmentCentroid(tile: RangeTile, segment: number): [number, number, number] {
  if (!tile.boundary || tile.boundary.length < tile.sides) {
    return tile.pos;
  }
  const sides = tile.boundary.length;
  const v0 = tile.boundary[segment % sides];
  const v1 = tile.boundary[(segment + 1) % sides];
  return v3normalize([
    (tile.pos[0] + v0[0] + v1[0]) / 3,
    (tile.pos[1] + v0[1] + v1[1]) / 3,
    (tile.pos[2] + v0[2] + v1[2]) / 3,
  ]);
}

// ─── Hex spacing ──────────────────────────────────────────────────────────────

function getLocalHexSpacing(tile: RangeTile, tiles: RangeTile[]): number {
  if (tile.neighbours.length === 0) return 0.1;
  let total = 0;
  for (const nIdx of tile.neighbours) {
    total += v3distance(tile.pos, tiles[nIdx].pos);
  }
  return total / tile.neighbours.length;
}

// ─── Segment distance ─────────────────────────────────────────────────────────

/**
 * Compute the segment-aware distance between two positions.
 * Same formula as src/world/segmentGeometry.ts:segmentDistance.
 */
export function segmentDistance(
  tiles: RangeTile[],
  fromTile: number,
  fromSegment: number,
  toTile: number,
  toSegment: number,
): number {
  // Same segment: distance is 0
  if (fromTile === toTile && fromSegment === toSegment) {
    return 0;
  }

  const from = tiles[fromTile];
  const to = tiles[toTile];

  const fromHasBoundary = from.boundary && from.boundary.length >= from.sides;
  const toHasBoundary = to.boundary && to.boundary.length >= to.sides;

  if (!fromHasBoundary && !toHasBoundary) {
    // Fallback: BFS graph distance
    return graphDistanceBFS(tiles, fromTile, toTile);
  }

  const centroidA = getSegmentCentroid(from, fromSegment);
  const centroidB = getSegmentCentroid(to, toSegment);
  const chordDist = v3distance(centroidA, centroidB);

  const spacingA = getLocalHexSpacing(from, tiles);
  const spacingB = getLocalHexSpacing(to, tiles);
  const avgSpacing = (spacingA + spacingB) / 2;

  if (avgSpacing < 1e-10) {
    return graphDistanceBFS(tiles, fromTile, toTile);
  }

  return chordDist / avgSpacing;
}

// ─── Range threshold ──────────────────────────────────────────────────────────

/**
 * Get the weapon range threshold in segment-distance units.
 */
export function getRangeThreshold(rangeAttack: number): number {
  return rangeAttack * SEGMENT_RANGE_PER_POINT + SEGMENT_RANGE_BASE;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a target is within weapon range of an attacker.
 *
 * Uses the same segment-distance formula as the server combat system.
 * Both client and server should call this to determine attack eligibility.
 */
export function isTargetInRange(
  tiles: RangeTile[],
  attacker: { tileIndex: number; segment: number; rangeAttack: number; hasWeapon: boolean },
  target: { tileIndex: number; segment: number },
): boolean {
  if (!attacker.hasWeapon) return false;
  const threshold = getRangeThreshold(attacker.rangeAttack);
  const dist = segmentDistance(tiles, attacker.tileIndex, attacker.segment, target.tileIndex, target.segment);
  return dist <= threshold;
}

/**
 * Compute the maximum tile-hop count that approximates the segment-distance range.
 * Used for BFS-based overlay computations (movement range zones).
 *
 * Conservative: returns ceil(threshold) so the BFS zone is always >= actual range.
 */
export function weaponRangeInTileHops(rangeAttack: number, hasWeapon: boolean): number {
  if (!hasWeapon) return 0;
  if (rangeAttack <= 0) return 1; // melee only: adjacent tile
  return Math.ceil(getRangeThreshold(rangeAttack));
}

/**
 * Whether a unit has any offensive weapon — at least 1 point in kinetic,
 * splashAttack, rangeAttack, or antiAir. Single source of truth for the
 * "can this unit attack at all" check.
 */
export function hasWeapon(attributes: {
  rangeAttack?: number;
  kinetic?: number;
  splashAttack?: number;
  antiAir?: number;
}): boolean {
  return (
    (attributes.rangeAttack ?? 0) > 0 ||
    (attributes.kinetic ?? 0) > 0 ||
    (attributes.splashAttack ?? 0) > 0 ||
    (attributes.antiAir ?? 0) > 0
  );
}

/**
 * Convenience overload: derive `hasWeapon` from a unit's attribute bag and return
 * the tile-hop weapon range.  Avoids duplicating the has-weapon check in every caller.
 *
 * A unit "has a weapon" if it has at least 1 point in any offensive attribute:
 * kinetic, splashAttack, rangeAttack, or antiAir.
 */
export function weaponRangeFromAttributes(attributes: {
  rangeAttack?: number;
  kinetic?: number;
  splashAttack?: number;
  antiAir?: number;
}): number {
  return weaponRangeInTileHops(attributes.rangeAttack ?? 0, hasWeapon(attributes));
}

// ─── Internal BFS ─────────────────────────────────────────────────────────────

function graphDistanceBFS(tiles: RangeTile[], from: number, to: number): number {
  if (from === to) return 0;
  const visited = new Set<number>();
  visited.add(from);
  const queue: { idx: number; d: number }[] = [{ idx: from, d: 0 }];
  let head = 0;
  while (head < queue.length) {
    const { idx, d } = queue[head++];
    for (const n of tiles[idx].neighbours) {
      if (n === to) return d + 1;
      if (!visited.has(n)) {
        visited.add(n);
        queue.push({ idx: n, d: d + 1 });
      }
    }
  }
  return Infinity;
}
