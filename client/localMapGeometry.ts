/**
 * localMapGeometry.ts — Pure geometry and pathfinding functions for the local map.
 *
 * Extracted from LocalMapView (P7 refactor). None of these functions
 * access class state; they take all required data as parameters and can be
 * unit-tested in isolation.
 */

import { TileData } from './worldData.js';
import { FlatTileRef } from './mapInput.js';
import {
  screenAngleBetweenTiles,
  screenAngleToSpriteFacing,
} from './facing.js';

// ─── Facing helpers ───────────────────────────────────────────────────────────

/**
 * @deprecated Use `screenAngleBetweenTiles` from `facing.ts`.
 * Thin wrapper kept so existing callers (debugState, localMap) keep working.
 */
export function computeFacingAngle(
  fromTileIndex: number,
  toTileIndex: number,
  flatTiles: FlatTileRef[],
  tiles: TileData[],
): number {
  return screenAngleBetweenTiles(fromTileIndex, toTileIndex, flatTiles, tiles);
}

/**
 * @deprecated Use `screenAngleToSpriteFacing` from `facing.ts`.
 * Thin wrapper kept for back-compat. Note the result is a SpriteFacing
 * (fixed screen mapping), NOT a NeighbourFacing — do not store it in unit.facing.
 */
export function angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5 {
  return screenAngleToSpriteFacing(angle);
}

// ─── Segment helpers ──────────────────────────────────────────────────────────

/**
 * Find the best free segment for a unit arriving at a hex.
 * Prefers `sourceSegment`; if taken, searches outward (±1, ±2, ±3 mod 6).
 * Returns −1 if all six segments are occupied (shouldn't happen for ≤5 units).
 */
export function findPreferredSegment(
  sourceSegment: number,
  occupied: Set<number>,
): number {
  if (!occupied.has(sourceSegment)) return sourceSegment;
  for (let dist = 1; dist <= 3; dist++) {
    const cw = (sourceSegment + dist) % 6;
    if (!occupied.has(cw)) return cw;
    const ccw = (sourceSegment - dist + 6) % 6;
    if (!occupied.has(ccw)) return ccw;
  }
  return -1;
}

/**
 * Hit-test a world-space point against the triangular segments of a hex tile.
 * Returns segment index 0–5, or −1 if the point is not inside any triangle.
 *
 * The `worldToScreen` parameter is passed in rather than closing over the view,
 * keeping this function pure with respect to rendering state.
 */
export function findSegmentAt(
  sx: number,
  sy: number,
  ft: FlatTileRef,
  worldToScreen: (wx: number, wy: number) => [number, number],
  screenToWorld: (sx: number, sy: number) => [number, number],
): number {
  if (ft.poly.length < 6) return -1;
  const [wx, wy] = screenToWorld(sx, sy);
  for (let seg = 0; seg < ft.poly.length; seg++) {
    const v0 = ft.poly[seg];
    const v1 = ft.poly[(seg + 1) % ft.poly.length];
    if (pointInTriangle(wx, wy, ft.cx, ft.cy, v0.x, v0.y, v1.x, v1.y)) {
      return seg;
    }
  }
  return -1;
}

// ─── Geometry primitives ──────────────────────────────────────────────────────

/**
 * Barycentric point-in-triangle test.
 * Returns true when (px, py) lies inside or on the boundary of the triangle
 * defined by vertices (ax, ay), (bx, by), (cx, cy).
 */
export function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-12) return false;
  const invDenom = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return u >= 0 && v >= 0 && u + v <= 1;
}
