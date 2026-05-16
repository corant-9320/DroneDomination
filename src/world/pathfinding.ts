/**
 * Graph distance and pathfinding on the authoritative Goldberg tile graph.
 * All distance calculations use BFS/Dijkstra over tile adjacency.
 */

import { Tile } from './types.js';

/** BFS graph distance between two tiles. Returns -1 if unreachable. */
export function graphDistance(
  tiles: Tile[],
  fromIndex: number,
  toIndex: number
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

/** BFS collecting all tiles within a given radius */
export function tilesWithinRadius(
  tiles: Tile[],
  centreIndex: number,
  radius: number
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

/** A* pathfinding using great-circle heuristic */
export function findPath(
  tiles: Tile[],
  fromIndex: number,
  toIndex: number,
  costFn?: (tile: Tile) => number
): number[] | null {
  if (fromIndex === toIndex) return [fromIndex];

  const cost = costFn || (() => 1);
  const target = tiles[toIndex].position3d;

  // Heuristic: angular distance on unit sphere / average tile angular size
  const avgTileAngle = Math.PI / 60; // approximate for circumference ~120 tiles
  function heuristic(idx: number): number {
    const pos = tiles[idx].position3d;
    const dotProduct = pos.x * target.x + pos.y * target.y + pos.z * target.z;
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
    // Find node in openSet with lowest fScore
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
