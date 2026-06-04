/**
 * localMapProjection.ts — Pure coordinate math for the local map.
 *
 * Extracted from LocalMapView (P1 refactor).
 * All functions are stateless; they take all required data as parameters.
 */

import { WorldData } from './worldData.js';
import { FlatTileRef } from './mapInput.js';

/** Local alias — shape matches FlatTileRef from mapInput.ts */
export type FlatTile = FlatTileRef;

// ─── Flat view builder ────────────────────────────────────────────────────────

/**
 * BFS out from centreIdx up to `radius` hops, skip pentagons, and project
 * each tile's boundary polygon onto the tangent plane at the centre tile.
 *
 * Returns an array of FlatTile objects ready for rendering.
 */
export function buildFlatView(
  world: WorldData,
  centreIdx: number,
  radius: number,
): FlatTile[] {
  // BFS
  const distances = new Map<number, number>();
  distances.set(centreIdx, 0);
  const queue: [number, number][] = [[centreIdx, 0]];
  let head = 0;

  while (head < queue.length) {
    const [current, dist] = queue[head++];
    if (dist >= radius) continue;
    const tile = world.tiles[current];
    for (const n of tile.n) {
      if (!distances.has(n)) {
        distances.set(n, dist + 1);
        queue.push([n, dist + 1]);
      }
    }
  }

  // Build tangent-plane basis at centre
  const centre = world.tiles[centreIdx];
  const [cx, cy, cz] = centre.pos;

  // Normal = centre position (unit sphere)
  const nx = cx, ny = cy, nz = cz;

  // Tangent vector
  let tx: number, ty: number, tz: number;
  if (Math.abs(ny) < 0.9) {
    tx = nz; ty = 0; tz = -nx;
  } else {
    tx = 0; ty = -nz; tz = ny;
  }
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
  tx /= tLen; ty /= tLen; tz /= tLen;

  // Binormal = cross(normal, tangent)
  let bx = ny * tz - nz * ty;
  let by = nz * tx - nx * tz;
  let bz = nx * ty - ny * tx;
  const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
  bx /= bLen; by /= bLen; bz /= bLen;

  const project = (p: [number, number, number]): { x: number; y: number } => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    return {
      x: dx * tx + dy * ty + dz * tz,
      y: dx * bx + dy * by + dz * bz,
    };
  };

  const result: FlatTile[] = [];
  for (const [tileIdx, dist] of distances) {
    const tile = world.tiles[tileIdx];
    // Skip pentagons
    if (tile.s === 5) continue;

    const projected = project(tile.pos);
    const poly = tile.b.map((v) => project(v));

    result.push({
      tileIndex: tileIdx,
      cx: projected.x,
      cy: projected.y,
      poly,
      distance: dist,
    });
  }

  return result;
}

// ─── Coordinate converters ────────────────────────────────────────────────────

/**
 * Convert world-space tangent-plane coordinates to canvas screen coordinates.
 *
 * @param wx       World x (tangent plane)
 * @param wy       World y (tangent plane)
 * @param rect     Canvas bounding client rect
 * @param scale    Zoom factor
 * @param offsetX  Pan offset in screen pixels
 * @param offsetY  Pan offset in screen pixels
 */
export function worldToScreen(
  wx: number,
  wy: number,
  rect: DOMRect,
  scale: number,
  offsetX: number,
  offsetY: number,
): [number, number] {
  const w = rect.width;
  const h = rect.height;
  const baseScale = Math.min(w, h) * 3.5;

  const sx = w / 2 + wx * baseScale * scale + offsetX;
  const sy = h / 2 + -wy * baseScale * scale + offsetY;
  return [sx, sy];
}

/**
 * Convert canvas screen coordinates back to world-space tangent-plane coordinates.
 */
export function screenToWorld(
  sx: number,
  sy: number,
  rect: DOMRect,
  scale: number,
  offsetX: number,
  offsetY: number,
): [number, number] {
  const w = rect.width;
  const h = rect.height;
  const baseScale = Math.min(w, h) * 3.5;

  const wx = (sx - w / 2 - offsetX) / (baseScale * scale);
  const wy = -(sy - h / 2 - offsetY) / (baseScale * scale);
  return [wx, wy];
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

/**
 * Find which flat tile (if any) contains the screen-space point (sx, sy).
 * Returns the tileIndex, or -1 if no tile was hit.
 *
 * @param flatTiles  The current flat tile list
 * @param sx         Screen x
 * @param sy         Screen y
 * @param wts        worldToScreen function bound to current view params
 * @param stw        screenToWorld function bound to current view params
 */
export function findTileAt(
  flatTiles: FlatTile[],
  sx: number,
  sy: number,
  stw: (sx: number, sy: number) => [number, number],
): number {
  const [wx, wy] = stw(sx, sy);

  for (const ft of flatTiles) {
    if (pointInPoly(wx, wy, ft.poly)) {
      return ft.tileIndex;
    }
  }
  return -1;
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true if (px, py) is inside the polygon.
 */
export function pointInPoly(
  px: number,
  py: number,
  poly: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Screen radius helper ─────────────────────────────────────────────────────

/**
 * Average screen-space radius for a visible hex (centre to vertex mean).
 */
export function screenHexRadius(
  ft: FlatTile,
  wts: (wx: number, wy: number) => [number, number],
): number {
  const [csx, csy] = wts(ft.cx, ft.cy);
  let radius = 0;
  for (const v of ft.poly) {
    const [vx, vy] = wts(v.x, v.y);
    radius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
  }
  return radius / Math.max(1, ft.poly.length);
}
