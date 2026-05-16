/**
 * World generation entry point.
 * Generates the complete authoritative Goldberg G(24,0) world.
 */

import { World, Tile } from './types.js';
import { generateGeodesicSphere, computeDual } from './goldberg.js';
import { generateTerrain } from './terrain.js';
import { placeCities } from './cities.js';

const FREQUENCY = 24;

export function generateWorld(seed: number): World {
  console.log(`Generating Goldberg G(${FREQUENCY},0) world with seed ${seed}...`);
  console.time('total');

  // Step 1: Generate the geodesic sphere (subdivided icosahedron)
  console.time('geodesic');
  const mesh = generateGeodesicSphere(FREQUENCY);
  console.log(`  Geodesic mesh: ${mesh.vertices.length} vertices, ${mesh.triangles.length} triangles`);
  console.timeEnd('geodesic');

  // Step 2: Compute the dual polyhedron (Goldberg tiles)
  console.time('dual');
  const dualTiles = computeDual(mesh);
  console.log(`  Dual tiles: ${dualTiles.length}`);
  console.timeEnd('dual');

  const pentagonIndices = dualTiles
    .filter((t) => t.sides === 5)
    .map((t) => t.index);
  const hexCount = dualTiles.filter((t) => t.sides === 6).length;

  console.log(`  Pentagons: ${pentagonIndices.length}, Hexagons: ${hexCount}`);

  // Step 3: Generate terrain
  console.time('terrain');
  const positions = dualTiles.map((t) => t.position3d);
  const terrainData = generateTerrain(positions, seed);
  console.timeEnd('terrain');

  // Step 4: Build authoritative tiles
  const tiles: Tile[] = dualTiles.map((dt, i) => ({
    id: `tile_${dt.index}`,
    index: dt.index,
    sides: dt.sides,
    neighbours: dt.neighbours,
    position3d: dt.position3d,
    boundary: dt.boundary,
    terrainType: terrainData[i].terrainType,
    elevation: terrainData[i].elevation,
  }));

  // Step 5: Place cities
  console.time('cities');
  const cities = placeCities(tiles, seed);
  console.log(`  Cities placed: ${cities.length}`);
  console.timeEnd('cities');

  console.timeEnd('total');

  return {
    tiles,
    cities,
    units: [],
    seed,
    pentagonIndices,
  };
}
