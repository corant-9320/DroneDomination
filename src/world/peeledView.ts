/**
 * Peeled Local Map View.
 *
 * Generates a flattened 2D chart of a local region around a centre tile.
 * Uses tangent-plane projection at the centre tile's position.
 * All tile IDs remain authoritative — this is a view, not a separate map.
 */

import { Tile, Vec3 } from './types.js';
import { tilesWithinRadius } from './pathfinding.js';
import * as v from './vec3.js';

export interface PeeledTile {
  /** Authoritative tile index */
  tileIndex: number;
  /** 2D position in local chart coordinates */
  x: number;
  y: number;
  /** Graph distance from centre */
  distance: number;
}

export interface PeeledView {
  centreTileIndex: number;
  radius: number;
  tiles: PeeledTile[];
}

/**
 * Generate a peeled local map view around a centre tile.
 *
 * @param allTiles - The authoritative tile array
 * @param centreTileIndex - Index of the centre tile
 * @param radius - Graph radius to include (recommended 12-14)
 */
export function generatePeeledView(
  allTiles: Tile[],
  centreTileIndex: number,
  radius: number
): PeeledView {
  // Step 1: Collect all tiles within graph radius via BFS
  const distanceMap = tilesWithinRadius(allTiles, centreTileIndex, radius);

  // Step 2: Build tangent-plane projection
  const centre = allTiles[centreTileIndex].position3d;
  const normal = v.normalize(centre);

  // Build local tangent basis (X, Y perpendicular to normal)
  let tangentX: Vec3;
  if (Math.abs(normal.y) < 0.9) {
    tangentX = v.normalize(v.cross(normal, { x: 0, y: 1, z: 0 }));
  } else {
    tangentX = v.normalize(v.cross(normal, { x: 1, y: 0, z: 0 }));
  }
  const tangentY = v.normalize(v.cross(normal, tangentX));

  // Step 3: Project each tile onto the tangent plane (including pentagons)
  const peeledTiles: PeeledTile[] = [];

  for (const [tileIndex, distance] of distanceMap) {
    const tilePos = allTiles[tileIndex].position3d;

    // Vector from centre to tile on the sphere
    const diff = v.sub(tilePos, centre);

    // Project onto tangent plane
    const x = v.dot(diff, tangentX);
    const y = v.dot(diff, tangentY);

    peeledTiles.push({ tileIndex, x, y, distance });
  }

  return {
    centreTileIndex,
    radius,
    tiles: peeledTiles,
  };
}

/**
 * Recenter the peeled view when the player pans near an edge.
 * Simply generates a new peeled view from the new centre.
 * Gameplay state is unchanged — only the view changes.
 */
export function recenterPeeledView(
  allTiles: Tile[],
  newCentreTileIndex: number,
  radius: number
): PeeledView {
  return generatePeeledView(allTiles, newCentreTileIndex, radius);
}
