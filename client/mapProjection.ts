/**
 * Map projection — BFS + tangent-plane projection for the local hex map.
 *
 * Takes a centre tile index and a BFS radius, walks the tile graph, and
 * projects each tile's 3D boundary polygon onto the 2D tangent plane at the
 * centre tile. Pentagons (s === 5) are excluded because their 5-sided geometry
 * doesn't fit the hex rendering pipeline.
 *
 * This is a pure function with no side effects — it only reads world tile data
 * and returns a flat array of projected tiles. It can be called any time the
 * camera centre changes.
 */

import { TileData } from './worldData.js';

/** A tile projected onto the tangent plane at the map centre. */
export interface FlatTile {
  tileIndex: number;
  /** Projected centre position in tangent-plane coordinates. */
  cx: number;
  cy: number;
  /** Projected boundary polygon vertices in tangent-plane coordinates. */
  poly: { x: number; y: number }[];
  /** BFS hop distance from the centre tile. */
  distance: number;
}

/**
 * Build a flat 2D view of the hex grid centred on `centreIdx`.
 *
 * Algorithm:
 * 1. BFS out `radius` hops from `centreIdx` to collect visible tiles.
 * 2. Compute an orthonormal tangent-plane basis at the centre tile's position
 *    on the unit sphere (normal, tangent, binormal).
 * 3. Project each tile's 3D position and boundary polygon onto that plane by
 *    dotting the offset vector with the tangent and binormal axes.
 *
 * The resulting coordinates are in tangent-plane units (roughly radians of arc
 * at the sphere surface). The caller scales them to screen pixels.
 *
 * @param tiles - Full tile array from WorldData.
 * @param centreIdx - Index of the tile to centre the view on.
 * @param radius - BFS hop radius (10 gives a comfortable local view).
 */
export function buildFlatView(
  tiles: TileData[],
  centreIdx: number,
  radius: number,
): FlatTile[] {
  // --- BFS to collect tiles within radius ---
  const distances = new Map<number, number>();
  distances.set(centreIdx, 0);
  const queue: [number, number][] = [[centreIdx, 0]];
  let head = 0;

  while (head < queue.length) {
    const [current, dist] = queue[head++];
    if (dist >= radius) continue;
    const tile = tiles[current];
    for (const n of tile.n) {
      if (!distances.has(n)) {
        distances.set(n, dist + 1);
        queue.push([n, dist + 1]);
      }
    }
  }

  // --- Build tangent-plane basis at the centre tile ---
  const centre = tiles[centreIdx];
  const [cx, cy, cz] = centre.pos;

  // The normal is the centre position on the unit sphere.
  const nx = cx, ny = cy, nz = cz;

  // Choose a tangent vector perpendicular to the normal.
  // When the normal is nearly vertical (|ny| ≥ 0.9), use a different axis to
  // avoid a degenerate cross product.
  let tx: number, ty: number, tz: number;
  if (Math.abs(ny) < 0.9) {
    tx = nz; ty = 0; tz = -nx;
  } else {
    tx = 0; ty = -nz; tz = ny;
  }
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
  tx /= tLen; ty /= tLen; tz /= tLen;

  // Binormal = cross(normal, tangent) — completes the right-handed basis.
  let bx = ny * tz - nz * ty;
  let by = nz * tx - nx * tz;
  let bz = nx * ty - ny * tx;
  const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
  bx /= bLen; by /= bLen; bz /= bLen;

  // Project a 3D point onto the tangent plane by dotting its offset from the
  // centre with the tangent (x) and binormal (y) axes.
  const project = (p: [number, number, number]): { x: number; y: number } => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    return {
      x: dx * tx + dy * ty + dz * tz,
      y: dx * bx + dy * by + dz * bz,
    };
  };

  // --- Project each visible tile ---
  const result: FlatTile[] = [];
  for (const [tileIdx, dist] of distances) {
    const tile = tiles[tileIdx];
    // Pentagons (s === 5) are excluded — their 5-sided geometry doesn't fit
    // the hex rendering pipeline and they appear at the poles/seams.
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
