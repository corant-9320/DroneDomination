/**
 * World generation entry point.
 * Generates the complete authoritative Goldberg G(100,0) world.
 */

import { World, Tile } from './types.js';
import { generateGeodesicSphere, computeDual } from './goldberg.js';
import { generateTerrain } from './terrain.js';
import { placeCities } from './cities.js';

/**
 * Geodesic subdivision frequency. Tile count = 10·F² + 2.
 *   F = 36  → 12,962 tiles (the original "asteroid"-scale world)
 *   F = 100 → 100,002 tiles (~7.7× the surface, ~2.8× the diameter)
 *
 * Terrain feature sizes scale automatically with tile density (see terrain.ts),
 * so a larger F yields a bigger world with proportionally larger landforms
 * rather than just a finer-grained version of the same map.
 *
 * Practical ceilings (see globe.ts notes): ~65k tiles was the old Uint16 wall
 * (now lifted to Uint32); JSON load/parse stays comfortable to ~130k tiles.
 */
export const FREQUENCY = 100;

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
  const positions  = dualTiles.map((t) => t.position3d);
  const neighbours = dualTiles.map((t) => t.neighbours);
  const sides      = dualTiles.map((t) => t.sides);
  const terrainData = generateTerrain(positions, neighbours, sides, seed);
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
    elevationType: terrainData[i].elevationType,
    height: terrainData[i].height,
    forested: terrainData[i].forested,
  }));

  // Debug: count tile type combinations
  console.log('\n=== Tile Type Distribution ===');

  // Terrain types
  const terrainCounts: Record<string, number> = {};
  for (const tile of tiles) {
    terrainCounts[tile.terrainType] = (terrainCounts[tile.terrainType] || 0) + 1;
  }
  console.log('\nTerrain types:');
  Object.entries(terrainCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });

  // Elevation types
  const elevCounts: Record<string, number> = {};
  for (const tile of tiles) {
    elevCounts[tile.elevationType] = (elevCounts[tile.elevationType] || 0) + 1;
  }
  console.log('\nElevation types:');
  Object.entries(elevCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });

  // Vegetation types (forested vs clear)
  const vegCounts: Record<string, number> = {};
  for (const tile of tiles) {
    const vegKey = tile.forested ? 'Forested' : 'Clear';
    vegCounts[vegKey] = (vegCounts[vegKey] || 0) + 1;
  }
  console.log('\nVegetation types:');
  Object.entries(vegCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });

  // All valid combinations
  const comboCounts: Record<string, number> = {};
  for (const tile of tiles) {
    let combo = tile.terrainType;
    // Elevation applies to all land tiles
    if (tile.terrainType !== 'ocean') {
      combo += `:${tile.elevationType}`;
    }
    // Vegetation applies to land tiles except tundra and desert
    if (tile.terrainType !== 'ocean' && tile.terrainType !== 'tundra' && tile.terrainType !== 'desert') {
      combo += tile.forested ? ':forested' : ':clear';
    }
    comboCounts[combo] = (comboCounts[combo] || 0) + 1;
  }
  console.log('\nValid combinations (terrain[:elevation][:vegetation]):');
  Object.entries(comboCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    console.log(`  ${k}: ${v}`);
  });

  // Step 5: Place cities
  console.time('cities');
  const cities = placeCities(tiles, seed);
  console.log(`  Cities placed: ${cities.length}`);
  console.timeEnd('cities');

  // Step 6: Sanitise city neighbourhoods
  // Tiles adjacent to a city must not be mountain or ocean — they would block
  // unit movement and look wrong next to a settlement.
  for (const city of cities) {
    for (const ni of tiles[city.tileIndex].neighbours) {
      const t = tiles[ni];
      if (t.terrainType === 'ocean') {
        // Promote to plains at flat elevation
        t.terrainType  = 'plains';
        t.elevationType = 'flat';
        t.height        = 1;
        t.forested      = false;
      } else if (t.elevationType === 'mountain') {
        // Demote mountain → hills, keep terrain type (already 'plains' for mountains)
        t.elevationType = 'hills';
        t.height        = 7;
      }
    }
  }

  console.timeEnd('total');

  return {
    tiles,
    cities,
    units: [],
    seed,
    pentagonIndices,
  };
}
