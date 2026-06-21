/**
 * Graph distance and pathfinding on the authoritative Goldberg tile graph.
 *
 * This file is a compatibility re-export layer. The canonical implementations
 * now live in `shared/pathfinding.ts` so both the client (AI turn) and server
 * share the same algorithms.
 *
 * The server-side `Tile` type differs from the shared `PathTile` only in how
 * the 3D position is stored (`position3d: {x,y,z}` vs `pos: [x,y,z]`). The
 * adapter below creates PathTile wrappers that preserve array indices so the
 * results map back 1:1 to the original tiles array.
 *
 * All existing importers of this file continue to work unchanged.
 */

import { Tile } from './types.js';
import {
  graphDistance as sharedGraphDistance,
  tilesWithinRadius as sharedTilesWithinRadius,
  findPath as sharedFindPath,
  type PathTile,
} from '../../shared/pathfinding.js';

/**
 * Lightweight adapter: wraps a Tile[] for shared pathfinding functions.
 * Each PathTile[i] corresponds to tiles[i] so indices are directly usable.
 *
 * `neighbours` reuses the same array reference, so shared algorithms that
 * only read neighbours work correctly without copying data.
 */
class TilePathAdapter implements PathTile {
  readonly neighbours: number[];
  readonly pos: [number, number, number];

  constructor(tile: Tile) {
    this.neighbours = tile.neighbours; // same reference — no copy
    this.pos = [tile.position3d.x, tile.position3d.y, tile.position3d.z];
  }
}

function toPathTiles(tiles: Tile[]): PathTile[] {
  return tiles.map((t) => new TilePathAdapter(t));
}

// ---------------------------------------------------------------------------
// Public API (same signatures as before the refactor)
// ---------------------------------------------------------------------------

/** BFS graph distance between two tiles. Returns -1 if unreachable. */
export function graphDistance(
  tiles: Tile[],
  fromIndex: number,
  toIndex: number,
): number {
  return sharedGraphDistance(toPathTiles(tiles), fromIndex, toIndex);
}

/** BFS collecting all tiles within a given radius. */
export function tilesWithinRadius(
  tiles: Tile[],
  centreIndex: number,
  radius: number,
): Map<number, number> {
  return sharedTilesWithinRadius(toPathTiles(tiles), centreIndex, radius);
}

/**
 * A* pathfinding using great-circle heuristic.
 *
 * The costFn variant receives an original server Tile. Internally we use
 * an index-keyed Map so the lookup is O(1) rather than O(n).
 */
export function findPath(
  tiles: Tile[],
  fromIndex: number,
  toIndex: number,
  costFn?: (tile: Tile) => number,
): number[] | null {
  const pathTiles = toPathTiles(tiles);

  if (!costFn) {
    return sharedFindPath(pathTiles, fromIndex, toIndex);
  }

  // Build a Map from PathTile → original Tile index for O(1) lookup in costFn.
  const indexMap = new Map<PathTile, number>();
  for (let i = 0; i < pathTiles.length; i++) indexMap.set(pathTiles[i], i);

  return sharedFindPath(pathTiles, fromIndex, toIndex, (pt) => {
    const idx = indexMap.get(pt);
    return idx !== undefined ? costFn(tiles[idx]) : 1;
  });
}
