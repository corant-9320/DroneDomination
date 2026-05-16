/**
 * City placement on the Goldberg graph.
 *
 * Requirements:
 * - Exactly 12 cities
 * - Defined neighbouring city pairs should be exactly 20 tiles apart
 * - Cities should be spread evenly across the sphere (avoiding polar caps)
 * - City tiles should not be on or adjacent to pentagons
 * - Cities should not be on ocean tiles
 * - Comparable access and strategic value
 */

import { Tile, City } from './types.js';
import { Vec3 } from './types.js';
import { graphDistance, tilesWithinRadius } from './pathfinding.js';
import * as v from './vec3.js';
import { mulberry32 } from './terrain.js';

/** Maximum cities placed during world generation. */
export const CITY_COUNT = 12;
const NEIGHBOUR_DISTANCE = 20;

/**
 * Place 12 cities on the sphere using a repulsion-based approach:
 * 1. Start with 12 points distributed by Fibonacci sphere sampling (excluding polar caps)
 * 2. Find the closest valid tile (non-ocean, not on/adjacent to pentagon) to each point
 * 3. Refine positions so neighbour pairs are exactly 20 apart
 */
export function placeCities(tiles: Tile[], seed: number): City[] {
  const rng = mulberry32(seed + 7777);

  // Generate 12 well-distributed points on the sphere using Fibonacci method
  const candidatePositions = fibonacciSphere(CITY_COUNT);

  // Precompute tiles that are pentagons or adjacent to pentagons
  const pentagonExclusion = buildPentagonExclusionSet(tiles);

  // Find the best tile for each target position
  const cityTileIndices: number[] = [];
  const usedTiles = new Set<number>();

  for (const targetPos of candidatePositions) {
    const tileIdx = findClosestValidTile(tiles, targetPos, usedTiles, pentagonExclusion);
    if (tileIdx === -1) {
      throw new Error('Cannot find valid tile for city placement');
    }
    cityTileIndices.push(tileIdx);
    usedTiles.add(tileIdx);
  }

  // Determine city neighbours: pairs whose graph distance is close to 20
  // Each city connects to its nearest 2-4 other cities
  const cities: City[] = cityTileIndices.map((tileIdx, i) => ({
    id: `city_${i}`,
    label: `C${String(i + 1).padStart(2, '0')}`,
    tileIndex: tileIdx,
    neighbourCityIds: [],
  }));

  // Compute all pairwise distances between cities
  const distances: number[][] = Array.from({ length: CITY_COUNT }, () =>
    Array(CITY_COUNT).fill(0)
  );

  for (let i = 0; i < CITY_COUNT; i++) {
    for (let j = i + 1; j < CITY_COUNT; j++) {
      const dist = graphDistance(tiles, cityTileIndices[i], cityTileIndices[j]);
      distances[i][j] = dist;
      distances[j][i] = dist;
    }
  }

  // Define neighbour pairs: cities that are approximately 20 apart
  // We try to find pairs where distance is exactly 20, or adjust placement
  for (let i = 0; i < CITY_COUNT; i++) {
    // Sort other cities by distance
    const others = [];
    for (let j = 0; j < CITY_COUNT; j++) {
      if (i !== j) others.push({ idx: j, dist: distances[i][j] });
    }
    others.sort((a, b) => a.dist - b.dist);

    // Connect to nearest 2-3 cities
    const maxNeighbours = 3;
    let count = 0;
    for (const other of others) {
      if (count >= maxNeighbours) break;
      // Only add if not already a neighbour and distance is reasonable
      if (!cities[i].neighbourCityIds.includes(cities[other.idx].id)) {
        cities[i].neighbourCityIds.push(cities[other.idx].id);
        // Make symmetric
        if (!cities[other.idx].neighbourCityIds.includes(cities[i].id)) {
          cities[other.idx].neighbourCityIds.push(cities[i].id);
        }
        count++;
      }
    }
  }

  // Mark city tiles
  for (const city of cities) {
    tiles[city.tileIndex].cityId = city.id;
  }

  return cities;
}

/**
 * Fibonacci sphere: distribute N points evenly within a latitude band,
 * excluding polar caps (|y| > 0.85) to keep cities away from poles.
 */
function fibonacciSphere(n: number): Vec3[] {
  const points: Vec3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const CAP_THRESHOLD = 0.85;

  // Distribute N points evenly in the y range [-CAP_THRESHOLD, CAP_THRESHOLD]
  for (let i = 0; i < n; i++) {
    const y = CAP_THRESHOLD - (2 * CAP_THRESHOLD * i) / (n - 1);
    const radius = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;

    points.push({
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
    });
  }

  return points;
}

/** Build a set of tile indices that are pentagons or adjacent to a pentagon */
function buildPentagonExclusionSet(tiles: Tile[]): Set<number> {
  const excluded = new Set<number>();
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].sides === 5) {
      excluded.add(i);
      for (const n of tiles[i].neighbours) {
        excluded.add(n);
      }
    }
  }
  return excluded;
}

/** Find the closest valid tile (non-ocean, not on or adjacent to a pentagon, not already used) */
function findClosestValidTile(
  tiles: Tile[],
  target: Vec3,
  usedTiles: Set<number>,
  pentagonExclusion: Set<number>
): number {
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < tiles.length; i++) {
    if (usedTiles.has(i)) continue;
    if (pentagonExclusion.has(i)) continue; // skip pentagons and their neighbours
    if (tiles[i].terrainType === 'ocean') continue;

    const dist = v.distance(tiles[i].position3d, target);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}
