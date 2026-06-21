/**
 * Shared pathfinding — pure graph algorithms on any tile adjacency structure.
 *
 * Lives in `shared/` so both the client (AI turn, movement range) and the
 * server (city placement, generate API city selection) can use the exact same
 * logic without duplication.
 *
 * The tile interface is intentionally minimal: only `neighbours` (adjacency)
 * and `pos` (3-tuple position on the unit sphere, for the A* heuristic) are
 * required. Both `TileData` (client) and `Tile` (server) satisfy it via a
 * thin adapter — or directly, since both carry these fields.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *   graphDistance(tiles, from, to)                 BFS hop count, -1 if unreachable
 *   tilesWithinRadius(tiles, centre, radius)        BFS flood fill → Map<index, dist>
 *   findPath(tiles, from, to, costFn?)              A* with great-circle heuristic
 */

// ─── Minimal tile interface ───────────────────────────────────────────────────

/**
 * Minimal tile shape required by the pathfinding functions.
 * Satisfied by both `Tile` (src/world/types.ts) and `TileData` (client/worldData.ts).
 */
export interface PathTile {
  /** Adjacent tile indices. */
  neighbours: number[];
  /** 3D position on the unit sphere [x, y, z]. Used by the A* heuristic. */
  pos: [number, number, number];
}

// ─── BFS graph distance ───────────────────────────────────────────────────────

/**
 * BFS graph distance between two tiles.
 * Returns the minimum number of hops, or -1 if the target is unreachable.
 *
 * Uses a Uint8Array visited set for performance on large tile graphs (~100k tiles).
 */
export function graphDistance(
  tiles: PathTile[],
  fromIndex: number,
  toIndex: number,
): number {
  if (fromIndex === toIndex) return 0;

  const visited = new Uint8Array(tiles.length);
  const queue: [number, number][] = [[fromIndex, 0]];
  visited[fromIndex] = 1;

  let head = 0;
  while (head < queue.length) {
    const [current, dist] = queue[head++];
    for (const neighbour of tiles[current].neighbours) {
      if (neighbour === toIndex) return dist + 1;
      if (!visited[neighbour]) {
        visited[neighbour] = 1;
        queue.push([neighbour, dist + 1]);
      }
    }
  }

  return -1; // unreachable
}

// ─── BFS flood fill ───────────────────────────────────────────────────────────

/**
 * BFS flood fill collecting all tiles within a given radius.
 * Returns a Map<tileIndex, hopDistance> for every reachable tile within radius.
 */
export function tilesWithinRadius(
  tiles: PathTile[],
  centreIndex: number,
  radius: number,
): Map<number, number> {
  const distances = new Map<number, number>();
  distances.set(centreIndex, 0);

  const queue: [number, number][] = [[centreIndex, 0]];
  let head = 0;

  while (head < queue.length) {
    const [current, dist] = queue[head++];
    if (dist >= radius) continue;

    for (const neighbour of tiles[current].neighbours) {
      if (!distances.has(neighbour)) {
        distances.set(neighbour, dist + 1);
        queue.push([neighbour, dist + 1]);
      }
    }
  }

  return distances;
}

// ─── A* pathfinding ───────────────────────────────────────────────────────────

/**
 * A* pathfinding using a great-circle (angular distance) heuristic.
 *
 * The heuristic divides the angular distance between two points on the unit
 * sphere by the average tile angular size (~π/60 for a G(24,0) globe) to
 * produce an admissible hop-count estimate.
 *
 * @param costFn  Optional per-tile entry cost. Returning Infinity marks a tile
 *                impassable. Defaults to uniform cost 1.
 * @returns       Tile index path from `from` to `to` (inclusive), or null if
 *                no path exists.
 */
export function findPath(
  tiles: PathTile[],
  fromIndex: number,
  toIndex: number,
  costFn?: (tile: PathTile) => number,
): number[] | null {
  if (fromIndex === toIndex) return [fromIndex];

  const cost = costFn ?? (() => 1);
  const target = tiles[toIndex].pos;

  // Heuristic: angular distance on unit sphere / average tile angular size
  const avgTileAngle = Math.PI / 60; // approximate for G(24,0) circumference ~120 tiles
  function heuristic(idx: number): number {
    const pos = tiles[idx].pos;
    const dotProduct = pos[0] * target[0] + pos[1] * target[1] + pos[2] * target[2];
    const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
    return angle / avgTileAngle;
  }

  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const openSet = new Set<number>();

  gScore.set(fromIndex, 0);
  fScore.set(fromIndex, heuristic(fromIndex));
  openSet.add(fromIndex);

  while (openSet.size > 0) {
    // Find the node in openSet with the lowest fScore
    let current = -1;
    let bestF = Infinity;
    for (const node of openSet) {
      const f = fScore.get(node) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        current = node;
      }
    }

    if (current === toIndex) {
      // Reconstruct path
      const path: number[] = [current];
      let step = current;
      while (cameFrom.has(step)) {
        step = cameFrom.get(step)!;
        path.unshift(step);
      }
      return path;
    }

    openSet.delete(current);
    const currentG = gScore.get(current) ?? Infinity;

    for (const neighbour of tiles[current].neighbours) {
      const moveCost = cost(tiles[neighbour]);
      if (moveCost === Infinity) continue; // impassable

      const tentativeG = currentG + moveCost;
      const neighbourG = gScore.get(neighbour) ?? Infinity;

      if (tentativeG < neighbourG) {
        cameFrom.set(neighbour, current);
        gScore.set(neighbour, tentativeG);
        fScore.set(neighbour, tentativeG + heuristic(neighbour));
        openSet.add(neighbour);
      }
    }
  }

  return null; // no path found
}
