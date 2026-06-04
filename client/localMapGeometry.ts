/**
 * localMapGeometry.ts — Pure geometry and pathfinding functions for the local map.
 *
 * Extracted from LocalMapView (P7 refactor). None of these functions
 * access class state; they take all required data as parameters and can be
 * unit-tested in isolation.
 */

import { TileData } from './worldData.js';
import { UnitData } from './worldData.js';
import { FlatTileRef } from './mapInput.js';
import {
  getMovementMode,
  hexEntryCost as sharedHexEntryCost,
} from '../shared/movementConstants.js';

// ─── BFS pathfinding ──────────────────────────────────────────────────────────

/**
 * BFS pathfinding on the client tile graph.
 * Returns an array of tile indices from `from` to `to` (inclusive),
 * or null if unreachable. Ocean tiles are treated as impassable.
 */
export function findPathBFS(
  from: number,
  to: number,
  tiles: TileData[],
): number[] | null {
  if (from === to) return [from];

  const cameFrom = new Map<number, number>();
  const queue: number[] = [from];
  cameFrom.set(from, -1);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    if (current === to) {
      // Reconstruct path
      const path: number[] = [];
      let step = to;
      while (step !== -1) {
        path.unshift(step);
        step = cameFrom.get(step)!;
      }
      return path;
    }

    for (const neighbour of tiles[current].n) {
      if (cameFrom.has(neighbour)) continue;
      // Skip ocean (impassable)
      if (tiles[neighbour].terrain === 'ocean') continue;
      cameFrom.set(neighbour, current);
      queue.push(neighbour);
    }
  }

  return null;
}

// ─── Facing helpers ───────────────────────────────────────────────────────────

/**
 * Compute the facing angle (radians, canvas convention: 0=right, π/2=down)
 * for movement from one tile to another, using their tangent-plane positions
 * from the flat tile list. Falls back to 3D world positions if either tile
 * is not in the current flat view.
 */
export function computeFacingAngle(
  fromTileIndex: number,
  toTileIndex: number,
  flatTiles: FlatTileRef[],
  tiles: TileData[],
): number {
  let fromX = 0, fromY = 0, toX = 0, toY = 0;
  let foundFrom = false, foundTo = false;

  for (const ft of flatTiles) {
    if (ft.tileIndex === fromTileIndex) {
      fromX = ft.cx; fromY = ft.cy;
      foundFrom = true;
    }
    if (ft.tileIndex === toTileIndex) {
      toX = ft.cx; toY = ft.cy;
      foundTo = true;
    }
    if (foundFrom && foundTo) break;
  }

  if (foundFrom && foundTo) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    // In worldToScreen, Y is flipped (wy → -sy), so screen-up = +dy in world.
    // Canvas angle: atan2(screen_dy, screen_dx), where screen_dy = -dy (flipped)
    return Math.atan2(-dy, dx);
  }

  // Fallback: use 3D positions from world data
  const fromPos = tiles[fromTileIndex].pos;
  const toPos = tiles[toTileIndex].pos;
  const dx = toPos[0] - fromPos[0];
  const dz = toPos[2] - fromPos[2];
  return Math.atan2(-dz, dx);
}

/**
 * Convert a radian angle to the nearest facing index (0–5).
 * Segment 0 faces up (−π/2); each step rotates 60° clockwise.
 */
export function angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5 {
  // segmentAngle(i) = -π/2 + i * π/3
  // Invert: i = (angle + π/2) / (π/3)
  let idx = (angle + Math.PI / 2) / (Math.PI / 3);
  // Normalise to [0, 6)
  idx = ((idx % 6) + 6) % 6;
  return (Math.round(idx) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
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

// ─── Movement cost helpers ────────────────────────────────────────────────────

/**
 * Calculate how many BFS hops along a path a unit can afford.
 *
 * @param path            Array of tile indices (output of findPathBFS).
 * @param unit            The moving unit (used for movement mode).
 * @param remainingMP     Movement points remaining this turn.
 * @param hexesAlreadyMoved  Hexes the unit has already moved (for first-hex rule).
 * @param tiles           Full tile array.
 * @returns Number of hops (tiles entered) affordable within remainingMP.
 */
export function affordableHops(
  path: number[],
  unit: UnitData,
  remainingMP: number,
  hexesAlreadyMoved: number,
  tiles: TileData[],
): number {
  const mode = getMovementMode(unit.attributes);
  let spent = 0;
  let hops = 0;

  for (let i = 1; i < path.length; i++) {
    const isFirst = (hexesAlreadyMoved + i - 1) === 0;
    const cost = sharedHexEntryCost(tiles[path[i]], mode, isFirst);
    if (cost === Infinity) break;
    spent += cost;
    if (spent > remainingMP) break;
    hops++;
  }
  return hops;
}

/**
 * Calculate the actual MP spent for a given number of hops along a path.
 *
 * @param path            Array of tile indices (output of findPathBFS).
 * @param unit            The moving unit (used for movement mode).
 * @param hops            Number of steps to take along the path.
 * @param hexesAlreadyMoved  Hexes the unit has already moved (for first-hex rule).
 * @param tiles           Full tile array.
 * @returns Total MP cost for the given number of hops.
 */
export function mpSpentForHops(
  path: number[],
  unit: UnitData,
  hops: number,
  hexesAlreadyMoved: number,
  tiles: TileData[],
): number {
  const mode = getMovementMode(unit.attributes);
  let spent = 0;
  for (let i = 1; i <= hops && i < path.length; i++) {
    const isFirst = (hexesAlreadyMoved + i - 1) === 0;
    spent += sharedHexEntryCost(tiles[path[i]], mode, isFirst);
  }
  return spent;
}
