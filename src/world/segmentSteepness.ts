/**
 * Segment steepness computation — world-gen pass.
 *
 * Computes, for every tile and segment, the angle between the segment's
 * elevation-adjusted triangle normal and the local radial "up" direction on
 * the sphere. This is the *visible slope* the player sees in the first-person
 * view and is the authoritative steepness metric for the movement and building-
 * placement gates.
 *
 * The computation mirrors `buildVertexHeight` in `client/firstPersonTerrain.ts`
 * (cliff-aware cluster averaging, non-linear elevation curve, water pinning) so
 * the precomputed angle exactly matches the rendered gradient — no drift.
 *
 * Called once per world generation (Step 4.6), after terrain, rivers, and city
 * sanitisation are all finalised. Results are stored as `tile.segSteep`.
 *
 * ── Sync dependency ──────────────────────────────────────────────────────────
 * `STEEP_VERTICAL_EXAGGERATION` tracks `ELEV_WORLD_SCALE / HEX_WORLD_RADIUS`
 * in `client/firstPersonView.ts` (currently 4.4). If the visual exaggeration
 * changes, update this constant and re-run `scripts/calibrateSteepness.ts`.
 */

import { Tile, Vec3 } from './types.js';
import * as v3 from './vec3.js';
import { HEIGHT_LEVELS } from '../../shared/movementConstants.js';

// ---------------------------------------------------------------------------
// Public constant — must match client/firstPersonView.ts ELEV_WORLD_SCALE / HEX_WORLD_RADIUS
// ---------------------------------------------------------------------------

/**
 * Vertical exaggeration applied to elevation when computing steepness.
 * Must equal `ELEV_WORLD_SCALE / HEX_WORLD_RADIUS` in `firstPersonView.ts`
 * (currently `HEX_WORLD_RADIUS * 4.4 / HEX_WORLD_RADIUS = 4.4`).
 *
 * When the client changes its visual exaggeration, update this and recalibrate
 * thresholds via `scripts/calibrateSteepness.ts`.
 */
export const STEEP_VERTICAL_EXAGGERATION = 4.4;

// ---------------------------------------------------------------------------
// Internal constants (mirror firstPersonTerrain.ts)
// ---------------------------------------------------------------------------

/** Non-linear elevation curve exponent — must equal ELEV_CURVE_EXP in firstPersonTerrain.ts. */
const ELEV_CURVE_EXP = 4;

/** Render-only cliff threshold — must equal MAX_SLOPE_RENDER in firstPersonTerrain.ts. */
const MAX_SLOPE_RENDER = 3;

// ---------------------------------------------------------------------------
// Pure helpers (mirror firstPersonTerrain.ts counterparts)
// ---------------------------------------------------------------------------

/** Whether this tile is a water tile (river or open ocean, unless bridged). */
function isWaterTile(tile: Tile): boolean {
  if (tile.riverTo !== undefined) return true;
  return tile.terrainType === 'ocean';
}

/** Height used for cliff-edge comparison (water tiles read as 0). */
function cliffHeightFor(tile: Tile): number {
  return isWaterTile(tile) ? 0 : (tile.height ?? 0);
}

/** Whether the border between two tiles is a cliff (for vertex-height clustering). */
function isCliffEdge(a: Tile, b: Tile): boolean {
  return Math.abs(cliffHeightFor(a) - cliffHeightFor(b)) > MAX_SLOPE_RENDER;
}

/**
 * Normalized elevation height for a tile in `[0, 1]` (before scaling by hexRadius).
 * Mirrors `elevationWorldHeight(tile, 1.0)`:
 *   open ocean → −0.25
 *   all other  → pow(height / (HEIGHT_LEVELS-1), ELEV_CURVE_EXP)
 */
function elevationNorm(tile: Tile): number {
  const isOpenOcean = tile.terrainType === 'ocean' && tile.riverTo === undefined;
  if (isOpenOcean) return -0.25;
  const norm = (tile.height ?? 0) / (HEIGHT_LEVELS - 1);
  return Math.pow(norm, ELEV_CURVE_EXP);
}

// ---------------------------------------------------------------------------
// Phase A: cliff-aware vertex height lookup (server-side mirror of buildVertexHeight)
// ---------------------------------------------------------------------------

/**
 * Key for a 3D boundary vertex, quantised to 5 decimal places (matching the
 * compact wire format rounding in toCompactTile: `Math.round(v * 1e5) / 1e5`).
 */
function vKey3(p: Vec3): string {
  return `${Math.round(p.x * 1e5)}:${Math.round(p.y * 1e5)}:${Math.round(p.z * 1e5)}`;
}

/**
 * Build a per-(tile, vertex) elevation-norm lookup, cliff-aware, using the 3D
 * boundary positions stored in each `Tile`. Mirrors `buildVertexHeight` from
 * `client/firstPersonTerrain.ts` but operates on the 3D Goldberg graph
 * (boundary vertices on the unit sphere) instead of the flat projection.
 *
 * For each boundary vertex we find all tiles that share it (via the same
 * quantised key), run a union-find excluding cliff borders, average elevationNorm
 * within each cluster, and pin water clusters to their water level.
 *
 * Returns a lookup: `(tileIndex, vertexKey) → elevationNorm in [−0.25, 1]`.
 */
function buildSphereVertexHeight(tiles: Tile[]): Map<string, number> {
  // vKey3(vertex) → list of tile indices that have this vertex in their boundary
  const vTiles = new Map<string, number[]>();

  for (const tile of tiles) {
    if (!tile.boundary || tile.boundary.length < tile.sides) continue;
    // Also register the tile centre (used as the "centre vertex" for each segment)
    const ck = vKey3(tile.position3d);
    let arr = vTiles.get(ck);
    if (!arr) { arr = []; vTiles.set(ck, arr); }
    if (!arr.includes(tile.index)) arr.push(tile.index);

    for (const bv of tile.boundary) {
      const k = vKey3(bv);
      let barr = vTiles.get(k);
      if (!barr) { barr = []; vTiles.set(k, barr); }
      if (!barr.includes(tile.index)) barr.push(tile.index);
    }
  }

  // `${vKey3(vertex)}|${tileIndex}` → cluster-averaged elevationNorm
  const heightByVT = new Map<string, number>();

  for (const [k, tileIdxs] of vTiles) {
    const n = tileIdxs.length;
    // Union-find: join pairs not separated by a cliff
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!isCliffEdge(tiles[tileIdxs[i]], tiles[tileIdxs[j]])) {
          parent[find(i)] = find(j);
        }
      }
    }

    // Average within each cluster; pin water clusters to their water level
    const cluster = new Map<number, { sum: number; count: number; water: number | null }>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const tile = tiles[tileIdxs[i]];
      const h = elevationNorm(tile);
      const water = isWaterTile(tile) ? h : null;
      const acc = cluster.get(root);
      if (acc) {
        acc.sum += h;
        acc.count++;
        if (water !== null) acc.water = acc.water === null ? water : Math.min(acc.water, water);
      } else {
        cluster.set(root, { sum: h, count: 1, water });
      }
    }
    for (let i = 0; i < n; i++) {
      const acc = cluster.get(find(i))!;
      const height = acc.water !== null ? acc.water : acc.sum / acc.count;
      heightByVT.set(`${k}|${tileIdxs[i]}`, height);
    }
  }

  return heightByVT;
}

// ---------------------------------------------------------------------------
// Core geometry: angle of a single segment
// ---------------------------------------------------------------------------

/**
 * Compute the steepness (radians) of a single segment triangle, given the
 * elevated 3D positions of its three vertices (tile centre, boundary[N],
 * boundary[N+1]) and the outward radial direction at the segment centroid.
 *
 * Returns θ ∈ [0, π/2].
 *
 * Exported for unit testing.
 */
export function segmentSteepnessAngle(
  centerElevated: Vec3,
  v0Elevated: Vec3,
  v1Elevated: Vec3,
  radialUp: Vec3,
): number {
  // Triangle normal (winding-independent: use absolute dot)
  const edge0 = v3.sub(v0Elevated, centerElevated);
  const edge1 = v3.sub(v1Elevated, centerElevated);
  const rawNormal = v3.cross(edge0, edge1);
  const lenN = v3.length(rawNormal);
  // Guard degenerate triangle (coincident vertices → zero cross product)
  if (lenN < 1e-14) return 0;
  const normal = v3.scale(rawNormal, 1 / lenN);

  // Tilt from horizontal = acos(|dot(normal, up)|), clamped to [0, π/2]
  const absDot = Math.min(1, Math.abs(v3.dot(normal, radialUp)));
  return Math.acos(absDot);
}

// ---------------------------------------------------------------------------
// Phase B: per-tile, per-segment angle
// ---------------------------------------------------------------------------

/**
 * Compute segSteep (radians per segment) for every tile in place, mutating
 * each tile's `segSteep` array. Pure w.r.t. inputs other than the assignment.
 *
 * Safe to call exactly once, after tiles, boundaries, heights, and rivers are
 * all finalised.
 *
 * Postconditions: every tile has `segSteep` set, `length === tile.sides`,
 * each entry is a finite number in `[0, π/2]`.
 */
export function computeSegmentSteepness(tiles: Tile[]): void {
  // Phase A: build the cliff-aware vertex-height lookup once.
  const heightByVT = buildSphereVertexHeight(tiles);

  const lookup = (tile: Tile, vertex: Vec3): number => {
    const key = `${vKey3(vertex)}|${tile.index}`;
    const h = heightByVT.get(key);
    if (h !== undefined) return h;
    // Fallback: use the tile's own elevationNorm (shouldn't happen on real tiles)
    return elevationNorm(tile);
  };

  // Phase B: per-tile, per-segment
  for (const tile of tiles) {
    const sides = tile.sides;

    // Graceful fallback for test tiles with no boundary data
    if (!tile.boundary || tile.boundary.length < sides) {
      tile.segSteep = new Array<number>(sides).fill(0);
      continue;
    }

    // Horizontal scale: mean chord distance from tile centre to boundary vertices
    let hexR = 0;
    for (const bv of tile.boundary) hexR += v3.distance(tile.position3d, bv);
    hexR /= tile.boundary.length;
    // Guard extremely small tiles (shouldn't happen on a real Goldberg sphere)
    if (hexR < 1e-10) {
      tile.segSteep = new Array<number>(sides).fill(0);
      continue;
    }

    // Elevated tile centre
    const hCenter = lookup(tile, tile.position3d);
    const scale = STEEP_VERTICAL_EXAGGERATION * hexR;
    const centerElevated: Vec3 = v3.scale(tile.position3d, 1 + hCenter * scale);

    const steep: number[] = new Array<number>(sides);

    for (let N = 0; N < sides; N++) {
      const a = tile.boundary[N];
      const d = tile.boundary[(N + 1) % sides];

      const hA = lookup(tile, a);
      const hD = lookup(tile, d);

      const v0Elevated: Vec3 = v3.scale(a, 1 + hA * scale);
      const v1Elevated: Vec3 = v3.scale(d, 1 + hD * scale);

      // Local "up" = outward radial at the segment centroid (average of 3 sphere points)
      const centroidRaw: Vec3 = {
        x: (tile.position3d.x + a.x + d.x) / 3,
        y: (tile.position3d.y + a.y + d.y) / 3,
        z: (tile.position3d.z + a.z + d.z) / 3,
      };
      const radialUp = v3.normalize(centroidRaw);

      steep[N] = segmentSteepnessAngle(centerElevated, v0Elevated, v1Elevated, radialUp);
    }

    tile.segSteep = steep;
  }
}
