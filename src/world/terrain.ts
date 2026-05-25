/**
 * Terrain generation using simplex-like noise on the sphere.
 * Uses a seeded PRNG for deterministic generation.
 *
 * Three independent dimensions per tile:
 *   TerrainType  — grassland | plains | tundra | desert | ocean
 *   ElevationType — flat | rolling | hills | mountain  (always set, including ocean tiles)
 *   forested      — boolean                            (false for ocean/tundra/desert)
 *
 * Ocean is determined by a separate noise ranking (bottom 30% by rank),
 * independent of ElevationType — so flat land tiles exist.
 */

import { Vec3, TerrainType, ElevationType } from './types.js';

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** Simple seeded PRNG (mulberry32) */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Gradient noise
// ---------------------------------------------------------------------------

/** 3D gradient noise (simplified) for sphere-based terrain */
function gradientNoise3D(
  pos: Vec3,
  frequency: number,
  gradients: Vec3[],
  permutation: number[]
): number {
  const fx = pos.x * frequency;
  const fy = pos.y * frequency;
  const fz = pos.z * frequency;

  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const ty = fy - iy;
  const tz = fz - iz;

  // Smoothstep
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const sz = tz * tz * (3 - 2 * tz);

  function hash(x: number, y: number, z: number): number {
    const a = permutation[((x % 256) + 256) % 256];
    const b = permutation[((a + y) % 256 + 256) % 256];
    return permutation[((b + z) % 256 + 256) % 256];
  }

  function grad(hashVal: number, dx: number, dy: number, dz: number): number {
    const g = gradients[hashVal % gradients.length];
    return g.x * dx + g.y * dy + g.z * dz;
  }

  const n000 = grad(hash(ix,     iy,     iz    ),  tx,      ty,      tz    );
  const n100 = grad(hash(ix + 1, iy,     iz    ),  tx - 1,  ty,      tz    );
  const n010 = grad(hash(ix,     iy + 1, iz    ),  tx,      ty - 1,  tz    );
  const n110 = grad(hash(ix + 1, iy + 1, iz    ),  tx - 1,  ty - 1,  tz    );
  const n001 = grad(hash(ix,     iy,     iz + 1),  tx,      ty,      tz - 1);
  const n101 = grad(hash(ix + 1, iy,     iz + 1),  tx - 1,  ty,      tz - 1);
  const n011 = grad(hash(ix,     iy + 1, iz + 1),  tx,      ty - 1,  tz - 1);
  const n111 = grad(hash(ix + 1, iy + 1, iz + 1),  tx - 1,  ty - 1,  tz - 1);

  const nx00 = n000 + sx * (n100 - n000);
  const nx10 = n010 + sx * (n110 - n010);
  const nx01 = n001 + sx * (n101 - n001);
  const nx11 = n011 + sx * (n111 - n011);

  const nxy0 = nx00 + sy * (nx10 - nx00);
  const nxy1 = nx01 + sy * (nx11 - nx01);

  return nxy0 + sz * (nxy1 - nxy0);
}

// ---------------------------------------------------------------------------
// Pole distance via BFS
// ---------------------------------------------------------------------------

/**
 * BFS from each polar pentagon outward.
 * Returns an array where poleDistance[i] is the minimum hop count from tile i
 * to either polar pentagon (0 = the pentagon itself, 1 = immediate neighbours, …).
 * Tiles with no polar pentagon reachable within maxDepth get Infinity.
 */
function computePoleDistances(
  positions: Vec3[],
  neighbours: number[][],
  sides: number[],
): number[] {
  const n = positions.length;
  const dist = new Array<number>(n).fill(Infinity);

  // The two polar pentagons are the pentagons with the highest and lowest y.
  // An icosahedron has exactly 12 pentagons; the top and bottom vertices are
  // the ones at y ≈ +1 and y ≈ -1.
  const pentagonIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sides[i] === 5) pentagonIndices.push(i);
  }
  pentagonIndices.sort((a, b) => Math.abs(positions[b].y) - Math.abs(positions[a].y));
  const polarPentagons = pentagonIndices.slice(0, 2); // top + bottom

  // Multi-source BFS from both polar pentagons simultaneously
  const queue: number[] = [];
  for (const src of polarPentagons) {
    dist[src] = 0;
    queue.push(src);
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist[cur];
    for (const nb of neighbours[cur]) {
      if (dist[nb] === Infinity) {
        dist[nb] = d + 1;
        queue.push(nb);
      }
    }
  }

  return dist;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TileTerrainData {
  terrainType: TerrainType;
  elevationType: ElevationType;
  forested: boolean;
}

/** Generate terrain for all tiles */
export function generateTerrain(
  positions: Vec3[],
  neighbours: number[][],
  sides: number[],
  seed: number
): TileTerrainData[] {
  const rng = mulberry32(seed);

  // Build permutation table
  const permutation: number[] = [];
  for (let i = 0; i < 256; i++) permutation.push(i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }

  // Build gradient table
  const gradients: Vec3[] = [];
  for (let i = 0; i < 256; i++) {
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    gradients.push({
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.sin(phi) * Math.sin(theta),
      z: Math.cos(phi),
    });
  }

  // --- Pole distances (hop count from nearest polar pentagon) ---
  const poleDistances = computePoleDistances(positions, neighbours, sides);

  // --- Pass 1: noise ranking used for two independent purposes ---
  // The same noise field drives both ElevationType (quartiles) and the ocean
  // flag (bottom 30% by rank). These are separate outputs — a flat tile is
  // not necessarily ocean, and an ocean tile can be any elevation type.
  const numTiles = positions.length;
  const rawElevations = positions.map((pos) => {
    let e = 0;
    e += gradientNoise3D(pos, 3,  gradients, permutation) * 0.5;
    e += gradientNoise3D(pos, 6,  gradients, permutation) * 0.25;
    e += gradientNoise3D(pos, 12, gradients, permutation) * 0.125;
    e += gradientNoise3D(pos, 24, gradients, permutation) * 0.0625;
    return e; // raw value — only the rank matters
  });

  const sortedIndices = rawElevations
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e - b.e);

  // ElevationType: four equal quartiles across all tiles
  const elevationTypeMap = new Array<ElevationType>(numTiles);
  const q = Math.floor(numTiles / 4);
  sortedIndices.forEach(({ i }, rank) => {
    if (rank < q)           elevationTypeMap[i] = 'flat';
    else if (rank < q * 2)  elevationTypeMap[i] = 'rolling';
    else if (rank < q * 3)  elevationTypeMap[i] = 'hills';
    else                    elevationTypeMap[i] = 'mountain';
  });

  // Ocean flag: bottom 30% by noise rank (independent of elevation quartile)
  const oceanCutoff = Math.floor(numTiles * 0.30);
  const isOceanMap = new Array<boolean>(numTiles).fill(false);
  sortedIndices.slice(0, oceanCutoff).forEach(({ i }) => { isOceanMap[i] = true; });

  // --- Pass 2: classify each tile across all three dimensions ---
  return positions.map((pos, i) => {
    const elevationType = elevationTypeMap[i];
    const poleDist      = poleDistances[i];
    const isOcean       = isOceanMap[i];

    const terrainType = classifyTerrain(isOcean, elevationType, poleDist, rng);
    const forested    = classifyForested(terrainType, elevationType,
                          gradientNoise3D(pos, 5, gradients, permutation));

    return { terrainType, elevationType, forested };
  });
}

// ---------------------------------------------------------------------------
// Terrain classification — returns one of the 5 terrain types
// ---------------------------------------------------------------------------

/**
 * Pole distance zones (hop count from the polar pentagon):
 *
 *   0          — the polar pentagon itself          (1 tile)
 *   1          — first hex ring                     (5 tiles)
 *   2          — second hex ring                    (10 tiles)
 *   ─────────────────────────────────────────────── total: 16 tiles of tundra
 *   3          — ocean buffer ring
 *   4          — ocean buffer ring
 *   ───────────────────────────────────────────────
 *   5+         — normal terrain classification
 *
 * The near-polar band (dist 5–9) blends tundra into plains with rising probability.
 */
function classifyTerrain(
  isOcean: boolean,
  elevationType: ElevationType,
  poleDist: number,
  rng: () => number,
): TerrainType {
  // --- Hard tundra cap: pentagon + 2 hex rings ---
  if (poleDist <= 2) return 'tundra';

  // --- Ocean buffer just outside the tundra cap ---
  if (poleDist <= 4) return 'ocean';

  // --- Near-polar band (dist 5–9): tundra probability fades with distance.
  //     Evaluated before the ocean flag so polar land isn't swallowed by water. ---
  if (poleDist <= 9) {
    const tundraChance = (10 - poleDist) / 5; // 1.0 at dist 5 → 0.2 at dist 9
    if (rng() < tundraChance) return 'tundra';
  }

  // --- Ocean: bottom 30% of tiles by noise rank ---
  if (isOcean) return 'ocean';

  // --- Equatorial desert: small patches (far from poles, rolling elevation) ---
  if (poleDist > 30 && elevationType === 'rolling' && rng() > 0.7) {
    return 'desert';
  }

  // --- Mid-latitude grassland (most common land type) ---
  if (elevationType === 'flat' || elevationType === 'rolling' ||
      (elevationType === 'hills' && poleDist < 28)) {
    return 'grassland';
  }

  // --- Plains: hills far from equator and all mountains ---
  return 'plains';
}

// ---------------------------------------------------------------------------
// Vegetation classification — forested or clear
// ---------------------------------------------------------------------------

/**
 * Determine whether a tile has forest cover.
 *
 * Rules:
 *   ocean   → always clear
 *   tundra  → always clear
 *   desert  → always clear
 *   mountain elevation → always clear (too high)
 *   otherwise → noise threshold (~42% forested)
 */
function classifyForested(
  terrain: TerrainType,
  elevationType: ElevationType,
  forestNoise: number,
): boolean {
  if (terrain === 'ocean')   return false;
  if (terrain === 'tundra')  return false;
  if (terrain === 'desert')  return false;
  if (elevationType === 'mountain') return false;

  // Eligible: grassland/plains at flat/rolling/hills elevation
  return forestNoise > 0.15; // ~42% forested coverage
}
