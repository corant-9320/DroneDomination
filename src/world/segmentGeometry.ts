/**
 * Segment Geometry — server-side segment centroids and segment-aware distance.
 *
 * Each hex tile is subdivided into 6 triangular segments (0–5). Segment N
 * is the triangle formed by the tile center and boundary vertices N and N+1.
 * This module computes the 3D centroid of each segment on the unit sphere,
 * enabling segment-aware distance for combat and movement.
 *
 * ─── DISTANCE MODEL ──────────────────────────────────────────────────────────
 *
 * The "segment distance" between two units is the chord distance between their
 * segment centroids, normalised to hex-spacing units:
 *
 *   segmentDistance = chordDist(centroidA, centroidB) / averageHexSpacing
 *
 * Where averageHexSpacing is the chord distance between adjacent tile centers.
 * This gives ~1.0 for adjacent tile-center to tile-center, and fractional
 * values for same-hex or segment-offset positions.
 *
 * For range validation (integer gate), the graph distance (BFS hops) is still
 * used. The segment distance feeds only into range efficiency (falloff) and
 * movement cost calculations, providing sub-hex granularity.
 *
 * ─── FALLBACK BEHAVIOUR ──────────────────────────────────────────────────────
 *
 * If a tile has no boundary data (empty array, as in test grids), the segment
 * centroid falls back to the tile center. This preserves backward compatibility
 * with existing tests.
 */

import { Tile, Vec3 } from './types.js';
import { HexSegment } from './units.js';
import * as v3 from './vec3.js';
import { graphDistance } from './pathfinding.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fraction of the distance from tile center to boundary edge midpoint that
 * the segment centroid sits at. The geometric centroid of the triangle
 * (center, v0, v1) is at 1/3 of the way from center to the edge midpoint,
 * but we use 1/3 as the natural centroid position.
 */
const SEGMENT_CENTROID_FACTOR = 1 / 3;

// ---------------------------------------------------------------------------
// Segment centroid computation
// ---------------------------------------------------------------------------

/**
 * Compute the 3D position (on the unit sphere) of a segment's centroid.
 *
 * Segment N is the triangle: (tile.position3d, boundary[N], boundary[(N+1) % sides]).
 * The centroid is the average of those three points, normalised back to the sphere.
 *
 * If the tile has no boundary data, returns the tile center (graceful fallback).
 */
export function getSegmentCentroid3D(tile: Tile, segment: HexSegment): Vec3 {
  if (!tile.boundary || tile.boundary.length < tile.sides) {
    return tile.position3d;
  }

  const sides = tile.boundary.length;
  const v0 = tile.boundary[segment % sides];
  const v1 = tile.boundary[(segment + 1) % sides];

  // Average of the three triangle vertices
  const centroid: Vec3 = {
    x: (tile.position3d.x + v0.x + v1.x) / 3,
    y: (tile.position3d.y + v0.y + v1.y) / 3,
    z: (tile.position3d.z + v0.z + v1.z) / 3,
  };

  // Project back onto the unit sphere
  return v3.normalize(centroid);
}

// ---------------------------------------------------------------------------
// Hex spacing calibration
// ---------------------------------------------------------------------------

/**
 * Compute the average chord distance between adjacent tile centers for a
 * given tile. This is used to normalise segment distances to "hex units."
 *
 * Returns the mean chord distance to all neighbours of the tile.
 * If the tile has no neighbours, returns a sensible default (~0.1 for a
 * Goldberg polyhedron with ~600 tiles).
 */
export function getLocalHexSpacing(tile: Tile, tiles: Tile[]): number {
  if (tile.neighbours.length === 0) return 0.1;

  let total = 0;
  for (const nIdx of tile.neighbours) {
    total += v3.distance(tile.position3d, tiles[nIdx].position3d);
  }
  return total / tile.neighbours.length;
}

// ---------------------------------------------------------------------------
// Segment-aware distance
// ---------------------------------------------------------------------------

/**
 * Compute the segment-aware distance between two units, measured as the
 * chord distance between their segment centroids normalised to hex-spacing
 * units.
 *
 * This provides sub-hex granularity: two units leaning toward each other on
 * adjacent tiles will have a distance < 1.0, while units leaning away from
 * each other will have distance > 1.0.
 *
 * For same-hex units (different segments), returns the intra-hex distance
 * (typically 0.3–0.7 hex units).
 *
 * Falls back to the graph distance if boundary data is unavailable on
 * BOTH tiles.
 */
export function segmentDistance(
  tiles: Tile[],
  fromTileIndex: number,
  fromSegment: HexSegment,
  toTileIndex: number,
  toSegment: HexSegment,
): number {
  const fromTile = tiles[fromTileIndex];
  const toTile = tiles[toTileIndex];

  // If both tiles lack boundary data, fall back to pure graph distance
  const fromHasBoundary = fromTile.boundary && fromTile.boundary.length >= fromTile.sides;
  const toHasBoundary = toTile.boundary && toTile.boundary.length >= toTile.sides;

  if (!fromHasBoundary && !toHasBoundary) {
    const gd = graphDistance(tiles, fromTileIndex, toTileIndex);
    return gd >= 0 ? gd : Infinity;
  }

  const centroidA = getSegmentCentroid3D(fromTile, fromSegment);
  const centroidB = getSegmentCentroid3D(toTile, toSegment);
  const chordDist = v3.distance(centroidA, centroidB);

  // Normalise by local hex spacing (average of both tiles' spacings)
  const spacingA = getLocalHexSpacing(fromTile, tiles);
  const spacingB = getLocalHexSpacing(toTile, tiles);
  const avgSpacing = (spacingA + spacingB) / 2;

  if (avgSpacing < 1e-10) {
    return graphDistance(tiles, fromTileIndex, toTileIndex);
  }

  return chordDist / avgSpacing;
}

/**
 * Compute the effective combat distance between attacker and target.
 *
 * This is the primary function used by combat resolution. It returns the
 * segment-aware fractional distance that feeds into range efficiency.
 *
 * The integer graph distance is still used separately for the range gate
 * (can the attack reach at all?).
 */
export function effectiveCombatDistance(
  tiles: Tile[],
  attacker: { tileIndex: number; segment: HexSegment },
  target: { tileIndex: number; segment: HexSegment },
): number {
  return segmentDistance(
    tiles,
    attacker.tileIndex,
    attacker.segment,
    target.tileIndex,
    target.segment,
  );
}

/**
 * Compute the segment-aware movement distance between a unit's current
 * position and a destination segment on a target tile.
 *
 * Used by the movement system to calculate sub-hex travel costs.
 * For intra-hex repositioning (same tile, different segment), returns
 * the fractional distance within the hex.
 */
export function segmentMovementDistance(
  tiles: Tile[],
  fromTileIndex: number,
  fromSegment: HexSegment,
  toTileIndex: number,
  toSegment: HexSegment,
): number {
  return segmentDistance(tiles, fromTileIndex, fromSegment, toTileIndex, toSegment);
}
