/**
 * Validation suite for the authoritative Goldberg world.
 * Checks all graph invariants from the specification.
 */

import { World, Tile, City } from './types.js';
import { graphDistance } from './pathfinding.js';
import { CITY_COUNT } from './generate.js';

export interface ValidationResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

export function validateWorld(world: World): ValidationResult {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const { tiles, cities, pentagonIndices } = world;

  // --- Graph invariants ---

  // Total tile count must be a valid Goldberg number: T = 10·F² + 2 for some
  // integer frequency F. This stays correct regardless of the chosen FREQUENCY.
  const f2 = (tiles.length - 2) / 10;
  const fApprox = Math.sqrt(Math.max(0, f2));
  const fRounded = Math.round(fApprox);
  const isGoldbergCount = Number.isInteger(f2) && fRounded * fRounded === f2;
  checks.push({
    name: 'total_tiles is a Goldberg number (10·F² + 2)',
    passed: isGoldbergCount,
    detail: `Got ${tiles.length} (F≈${fApprox.toFixed(2)})`,
  });

  // Pentagon count — always exactly 12 for a Goldberg polyhedron
  const pentagons = tiles.filter((t) => t.sides === 5);
  checks.push({
    name: 'pentagon_count == 12',
    passed: pentagons.length === 12,
    detail: `Got ${pentagons.length}`,
  });

  // Hex count == total − 12 pentagons
  const hexes = tiles.filter((t) => t.sides === 6);
  checks.push({
    name: 'hex_count == total - 12',
    passed: hexes.length === tiles.length - 12,
    detail: `Got ${hexes.length}`,
  });

  // Every tile has sides == neighbours.length
  let sidesMatch = true;
  let sidesDetail = '';
  for (const tile of tiles) {
    if (tile.neighbours.length !== tile.sides) {
      sidesMatch = false;
      sidesDetail = `Tile ${tile.index}: sides=${tile.sides}, neighbours=${tile.neighbours.length}`;
      break;
    }
  }
  checks.push({
    name: 'sides == neighbour count for all tiles',
    passed: sidesMatch,
    detail: sidesMatch ? 'All match' : sidesDetail,
  });

  // No self-neighbours
  let noSelfNeighbour = true;
  let selfDetail = '';
  for (const tile of tiles) {
    if (tile.neighbours.includes(tile.index)) {
      noSelfNeighbour = false;
      selfDetail = `Tile ${tile.index} lists itself as neighbour`;
      break;
    }
  }
  checks.push({
    name: 'no self-neighbours',
    passed: noSelfNeighbour,
    detail: noSelfNeighbour ? 'OK' : selfDetail,
  });

  // All neighbour IDs are valid
  let allValid = true;
  let validDetail = '';
  for (const tile of tiles) {
    for (const n of tile.neighbours) {
      if (n < 0 || n >= tiles.length) {
        allValid = false;
        validDetail = `Tile ${tile.index} has invalid neighbour ${n}`;
        break;
      }
    }
    if (!allValid) break;
  }
  checks.push({
    name: 'all neighbour IDs valid',
    passed: allValid,
    detail: allValid ? 'OK' : validDetail,
  });

  // Adjacency is symmetric
  let symmetric = true;
  let symDetail = '';
  for (const tile of tiles) {
    for (const n of tile.neighbours) {
      const neighbour = tiles[n];
      if (neighbour === undefined) {
        symmetric = false;
        symDetail = `Tile ${tile.index} → out-of-range neighbour ${n}`;
        break;
      }
      if (!neighbour.neighbours.includes(tile.index)) {
        symmetric = false;
        symDetail = `Tile ${tile.index} → ${n} but not reverse`;
        break;
      }
    }
    if (!symmetric) break;
  }
  checks.push({
    name: 'adjacency is symmetric',
    passed: symmetric,
    detail: symmetric ? 'OK' : symDetail,
  });

  // Graph is fully connected (BFS from tile 0)
  const visited = new Uint8Array(tiles.length);
  const queue = [0];
  visited[0] = 1;
  let visitCount = 1;
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const tile = tiles[current];
    if (tile === undefined) continue;
    for (const n of tile.neighbours) {
      if (n >= 0 && n < tiles.length && !visited[n]) {
        visited[n] = 1;
        visitCount++;
        queue.push(n);
      }
    }
  }
  checks.push({
    name: 'graph is fully connected',
    passed: visitCount === tiles.length,
    detail: `Reachable: ${visitCount}/${tiles.length}`,
  });

  // All tile centroids on unit sphere
  let onSphere = true;
  let sphereDetail = '';
  for (const tile of tiles) {
    const { x, y, z } = tile.position3d;
    const r = Math.sqrt(x * x + y * y + z * z);
    if (Math.abs(r - 1.0) > 1e-6) {
      onSphere = false;
      sphereDetail = `Tile ${tile.index}: radius=${r}`;
      break;
    }
  }
  checks.push({
    name: 'all centroids on unit sphere',
    passed: onSphere,
    detail: onSphere ? 'OK' : sphereDetail,
  });

  // --- City invariants ---

  checks.push({
    name: `city_count == ${CITY_COUNT}`,
    passed: cities.length === CITY_COUNT,
    detail: `Got ${cities.length}`,
  });

  // All city tile IDs valid
  const allCityTilesValid = cities.every(
    (c) => c.tileIndex >= 0 && c.tileIndex < tiles.length
  );
  checks.push({
    name: 'all city tile IDs valid',
    passed: allCityTilesValid,
    detail: allCityTilesValid ? 'OK' : 'Some city tile IDs out of range',
  });

  // No two cities on same tile
  const cityTileSet = new Set(cities.map((c) => c.tileIndex));
  checks.push({
    name: 'no duplicate city tiles',
    passed: cityTileSet.size === cities.length,
    detail: `Unique: ${cityTileSet.size}/${cities.length}`,
  });

  // City tiles are marked
  let allMarked = true;
  for (const city of cities) {
    const tile = tiles[city.tileIndex];
    if (tile === undefined || tile.cityId !== city.id) {
      allMarked = false;
      break;
    }
  }
  checks.push({
    name: 'all city tiles marked',
    passed: allMarked,
    detail: allMarked ? 'OK' : 'Some city tiles not marked',
  });

  // City tiles are not pentagons
  const noCityPentagons = cities.every((c) => tiles[c.tileIndex]?.sides === 6);
  checks.push({
    name: 'no city on pentagon tile',
    passed: noCityPentagons,
    detail: noCityPentagons ? 'OK' : 'Some cities on pentagon tiles',
  });

  // City tiles are not adjacent to pentagons
  const pentagonIndexSet = new Set(
    tiles.filter((t) => t.sides === 5).map((t) => t.index)
  );
  const noCityAdjacentPentagon = cities.every((c) =>
    (tiles[c.tileIndex]?.neighbours ?? []).every((n) => !pentagonIndexSet.has(n))
  );
  checks.push({
    name: 'no city adjacent to pentagon',
    passed: noCityAdjacentPentagon,
    detail: noCityAdjacentPentagon ? 'OK' : 'Some cities adjacent to pentagon tiles',
  });

  // City-neighbour symmetry
  let neighSymmetric = true;
  let neighSymDetail = '';
  for (const city of cities) {
    for (const nId of city.neighbourCityIds) {
      const neighbour = cities.find((c) => c.id === nId);
      if (!neighbour) {
        neighSymmetric = false;
        neighSymDetail = `${city.id} references non-existent city ${nId}`;
        break;
      }
      if (!neighbour.neighbourCityIds.includes(city.id)) {
        neighSymmetric = false;
        neighSymDetail = `${city.id} → ${nId} but not reverse`;
        break;
      }
    }
    if (!neighSymmetric) break;
  }
  checks.push({
    name: 'city-neighbour graph symmetric',
    passed: neighSymmetric,
    detail: neighSymmetric ? 'OK' : neighSymDetail,
  });

  // --- segSteep integrity ---

  let segSteepOk = true;
  let segSteepDetail = '';
  for (const tile of tiles) {
    if (tile.segSteep === undefined) {
      segSteepOk = false;
      segSteepDetail = `Tile ${tile.index} missing segSteep`;
      break;
    }
    if (tile.segSteep.length !== tile.sides) {
      segSteepOk = false;
      segSteepDetail = `Tile ${tile.index}: segSteep.length=${tile.segSteep.length}, sides=${tile.sides}`;
      break;
    }
    const HALF_PI = Math.PI / 2;
    for (let s = 0; s < tile.segSteep.length; s++) {
      const v = tile.segSteep[s];
      if (!Number.isFinite(v) || v < 0 || v > HALF_PI + 1e-9) {
        segSteepOk = false;
        segSteepDetail = `Tile ${tile.index} seg ${s}: segSteep=${v} out of [0, π/2]`;
        break;
      }
    }
    if (!segSteepOk) break;
  }
  checks.push({
    name: 'segSteep set on all tiles, length == sides, values in [0, π/2]',
    passed: segSteepOk,
    detail: segSteepOk ? 'OK' : segSteepDetail,
  });

  // --- Summary ---
  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

export function printValidation(result: ValidationResult): void {
  console.log('\n=== World Validation ===\n');
  for (const check of result.checks) {
    const icon = check.passed ? '✓' : '✗';
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
  }
  console.log(`\n  Overall: ${result.passed ? 'PASSED' : 'FAILED'}\n`);
}
