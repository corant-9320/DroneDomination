/**
 * Terrain generation using simplex-like noise on the sphere.
 * Uses a seeded PRNG for deterministic generation.
 *
 * Three independent dimensions per tile:
 *   TerrainType  — grassland | plains | tundra | desert | ocean
 *   ElevationType — flat | rolling | hills | mountain  (ocean tiles are always flat)
 *   forested      — boolean                            (false for ocean/tundra/desert)
 *
 * ─── Scale-aware feature sizing ──────────────────────────────────────────────
 * The map keeps the same *proportions* regardless of tessellation frequency:
 * targets (ocean/mountain/desert tile counts) scale with the tile count, and
 * polar bands scale with the pole-to-equator hop distance (`densityScale`).
 *
 * Feature *footprints* are deliberately enlarged beyond proportional growth by
 * `PATCH_BOOST`: mountain chains and desert blobs grow longer/wider and the
 * noise fields run at lower frequency, so on a bigger globe you get fewer, much
 * larger sweeping landforms (a mountain range spans dozens of hexes) instead of
 * a finely-stippled version of the small map. Tune PATCH_BOOST to taste.
 *
 * Base proportions (calibrated at the G(36) / 12,962-tile world):
 *   ocean ≈ 3.9%, mountain ≈ 3.9%, desert ≈ 2.3%, tundra ≈ polar caps.
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
 */
function computePoleDistances(
  positions: Vec3[],
  neighbours: number[][],
  sides: number[],
): number[] {
  const n = positions.length;
  const dist = new Array<number>(n).fill(Infinity);

  const pentagonIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sides[i] === 5) pentagonIndices.push(i);
  }
  pentagonIndices.sort((a, b) => Math.abs(positions[b].y) - Math.abs(positions[a].y));
  const polarPentagons = pentagonIndices.slice(0, 2);

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
// Mountain range generation
// ---------------------------------------------------------------------------

/**
 * Grow mountain ranges as jagged, irregular chains with branches.
 *
 * Each range uses a biased random walk: a weak directional bias keeps the
 * range from looping back on itself, but high random jitter and occasional
 * sharp turns produce the irregular, craggy look of real mountain chains.
 * Branches sprout from the spine at random points, adding offshoots.
 *
 * Returns a Set of tile indices that are mountain.
 */
function growMountainRanges(
  numTiles: number,
  neighbours: number[][],
  poleDistances: number[],
  targetCount: number,
  rng: () => number,
  featureScale: number,
  poleMin: number,
): Set<number> {
  const mountains = new Set<number>();

  // Candidate seeds: tiles not too close to poles
  const candidates: number[] = [];
  for (let i = 0; i < numTiles; i++) {
    if (poleDistances[i] > poleMin) candidates.push(i);
  }

  // Shuffle candidates for random seed selection
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  /**
   * Walk a single chain of `length` tiles starting from `start`.
   * `biasDirIdx` is the preferred neighbour index (−1 = no bias).
   * Returns the tiles added.
   */
  function walkChain(start: number, length: number, biasDirIdx: number): number[] {
    const chain: number[] = [start];
    let current = start;
    let bias = biasDirIdx; // preferred direction index into neighbours array

    for (let step = 1; step < length; step++) {
      const nbrs = neighbours[current];
      if (nbrs.length === 0) break;

      // Build weighted candidate list.
      // Each neighbour gets a weight:
      //   - base weight 1.0 for all valid neighbours
      //   - +1.5 bonus if it matches the current bias direction (weak pull)
      //   - +0.5 bonus for directions adjacent to bias (allows gentle curves)
      //   - 0 weight if too close to pole or already mountain (avoid merging)
      const weights: number[] = [];
      let totalWeight = 0;

      for (let d = 0; d < nbrs.length; d++) {
        const nb = nbrs[d];
        if (poleDistances[nb] <= poleMin) { weights.push(0); continue; }
        if (mountains.has(nb))       { weights.push(0); continue; }

        let w = 1.0;
        if (bias >= 0) {
          const diff = Math.abs(d - bias);
          const wrap = Math.min(diff, nbrs.length - diff); // handle circular neighbour list
          if (wrap === 0)      w += 1.5; // same direction
          else if (wrap === 1) w += 0.5; // one step off — gentle curve
          // wrap >= 2: no bonus — sharp turn, but still possible
        }
        weights.push(w);
        totalWeight += w;
      }

      if (totalWeight === 0) break;

      // Weighted random pick
      let pick = rng() * totalWeight;
      let chosen = -1;
      for (let d = 0; d < weights.length; d++) {
        pick -= weights[d];
        if (pick <= 0) { chosen = d; break; }
      }
      if (chosen < 0) chosen = weights.findIndex((w) => w > 0);
      if (chosen < 0) break;

      // Occasionally inject a sharp direction change (jagged kink)
      // ~20% chance per step to reset bias to a random valid direction
      if (rng() < 0.20) {
        const validDirs = weights.map((w, d) => w > 0 ? d : -1).filter((d) => d >= 0);
        if (validDirs.length > 0) {
          bias = validDirs[Math.floor(rng() * validDirs.length)];
        }
      } else {
        bias = chosen; // continue in the direction we just moved
      }

      current = nbrs[chosen];
      chain.push(current);
    }

    return chain;
  }

  let seedIdx = 0;

  while (mountains.size < targetCount && seedIdx < candidates.length) {
    const seed = candidates[seedIdx++];
    if (mountains.has(seed)) continue;
    if (poleDistances[seed] <= poleMin) continue;

    // Main spine: 4–22 tiles (× featureScale), random initial direction
    const spineLength = Math.max(2, Math.round((4 + Math.floor(rng() * 19)) * featureScale));
    const initBias = Math.floor(rng() * (neighbours[seed]?.length || 6));
    const spine = walkChain(seed, spineLength, initBias);

    for (const t of spine) mountains.add(t);

    // Branches: 0–3 offshoots sprouting from random spine points
    const branchCount = Math.floor(rng() * 4); // 0–3
    for (let b = 0; b < branchCount; b++) {
      const branchOrigin = spine[Math.floor(rng() * spine.length)];
      const branchLength = Math.max(2, Math.round((2 + Math.floor(rng() * 7)) * featureScale)); // 2–8 tiles × scale
      // Pick a bias direction perpendicular-ish to the spine
      const nbrs = neighbours[branchOrigin];
      const perpBias = nbrs ? Math.floor(rng() * nbrs.length) : -1;
      const branch = walkChain(branchOrigin, branchLength, perpBias);
      for (const t of branch) mountains.add(t);
    }

    // Widen: randomly thicken ~40% of spine tiles by one neighbour
    for (const t of spine) {
      if (rng() < 0.40) {
        const nbrs = neighbours[t];
        const valid = nbrs.filter((nb) => !mountains.has(nb) && poleDistances[nb] > poleMin);
        if (valid.length > 0) {
          mountains.add(valid[Math.floor(rng() * valid.length)]);
        }
      }
    }
  }

  return mountains;
}

// ---------------------------------------------------------------------------
// Desert patch generation
// ---------------------------------------------------------------------------

/**
 * Grow desert patches as contiguous blobs seeded by noise.
 * Seeds are tiles with high desert noise value, far from poles.
 * Each patch flood-fills outward to a random size.
 */
function growDesertPatches(
  numTiles: number,
  neighbours: number[][],
  poleDistances: number[],
  desertNoise: number[],
  targetCount: number,
  rng: () => number,
  featureScale: number,
  poleMin: number,
): Set<number> {
  const desert = new Set<number>();

  // Sort candidates by desert noise (highest first) — these become patch seeds
  const candidates = Array.from({ length: numTiles }, (_, i) => i)
    .filter((i) => poleDistances[i] > poleMin && desertNoise[i] > 0)
    .sort((a, b) => desertNoise[b] - desertNoise[a]);

  for (const seed of candidates) {
    if (desert.size >= targetCount) break;
    if (desert.has(seed)) continue;

    // Patch size: 5–40 tiles (× featureScale)
    const patchSize = Math.max(3, Math.round((5 + Math.floor(rng() * 36)) * featureScale));
    const patch: number[] = [seed];
    const frontier: number[] = [seed];
    const inPatch = new Set<number>([seed]);

    while (frontier.length > 0 && patch.length < patchSize) {
      // Pick a random frontier tile
      const fi = Math.floor(rng() * frontier.length);
      const current = frontier[fi];
      frontier.splice(fi, 1);

      for (const nb of neighbours[current]) {
        if (inPatch.has(nb)) continue;
        if (poleDistances[nb] <= poleMin) continue;
        inPatch.add(nb);
        patch.push(nb);
        frontier.push(nb);
        if (patch.length >= patchSize) break;
      }
    }

    for (const t of patch) desert.add(t);
  }

  return desert;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TileTerrainData {
  terrainType: TerrainType;
  elevationType: ElevationType;
  /** Discrete terrain height 0–11. Ocean tiles are 0. */
  height: number;
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

  const numTiles = positions.length;

  // --- Scale-aware feature sizing ------------------------------------------
  // Derive the tessellation frequency from the tile count (T = 10·F² + 2) so
  // terrain features track the globe size without a hard-coded frequency here.
  const frequency = Math.sqrt(Math.max(1, (numTiles - 2) / 10));
  // densityScale = 1.0 at the original G(36) world; >1 on a bigger globe.
  const densityScale = frequency / 36;
  // Enlarge feature footprints beyond proportional growth → fewer, larger,
  // sweeping landforms. Bump this for even broader regions.
  const PATCH_BOOST = 1.6;
  const featureScale = densityScale * PATCH_BOOST;
  // Lower noise frequencies → physically larger ocean/desert/elevation blobs.
  const noiseScale = 1 / PATCH_BOOST;
  // Keep ocean/mountain/desert *proportions* constant as the globe grows.
  const targetScale = numTiles / 12962;
  // Polar bands (tundra cap, ocean ring, near-polar fade) scale with hop
  // distance so the caps stay the same fraction of the globe. Clamped to ≥1 so
  // they never fall below the baseline G(36) structure (and tiny test meshes
  // keep the original hop thresholds).
  const poleScale = Math.max(1, densityScale);
  const POLE_TUNDRA_CAP   = Math.round(2  * poleScale);
  const POLE_OCEAN_BUFFER = Math.round(4  * poleScale);
  const POLE_NEARPOLAR    = Math.round(9  * poleScale);
  const POLE_MOUNTAIN_MIN = Math.round(8  * poleScale);
  const POLE_DESERT_MIN   = Math.round(15 * poleScale);
  const POLE_GRASS_FLAT   = Math.round(12 * poleScale);
  const POLE_GRASS_HILLS  = Math.round(20 * poleScale);
  const poleBands: PoleBands = {
    tundraCap: POLE_TUNDRA_CAP,
    oceanBuffer: POLE_OCEAN_BUFFER,
    nearPolar: POLE_NEARPOLAR,
    grassFlat: POLE_GRASS_FLAT,
    grassHills: POLE_GRASS_HILLS,
  };

  // --- Pole distances ---
  const poleDistances = computePoleDistances(positions, neighbours, sides);

  // ---------------------------------------------------------------------------
  // Step 1: Ocean — proportional to tile count (~3.9%).
  // Use noise ranking: lowest-noise tiles become ocean. Lower noise frequency
  // (× noiseScale) makes ocean basins broader on a larger globe.
  // ---------------------------------------------------------------------------
  const OCEAN_TARGET = Math.round(500 * targetScale);
  const oceanFraction = OCEAN_TARGET / numTiles;

  const oceanNoise = positions.map((pos) => {
    let e = 0;
    e += gradientNoise3D(pos, 3  * noiseScale, gradients, permutation) * 0.5;
    e += gradientNoise3D(pos, 6  * noiseScale, gradients, permutation) * 0.25;
    e += gradientNoise3D(pos, 12 * noiseScale, gradients, permutation) * 0.125;
    e += gradientNoise3D(pos, 24 * noiseScale, gradients, permutation) * 0.0625;
    return e;
  });

  const sortedByOcean = oceanNoise
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e - b.e);

  const oceanCutoff = Math.floor(numTiles * oceanFraction);
  const isOceanMap = new Array<boolean>(numTiles).fill(false);
  sortedByOcean.slice(0, oceanCutoff).forEach(({ i }) => { isOceanMap[i] = true; });

  // ---------------------------------------------------------------------------
  // Step 2: Mountain ranges — target ~500 mountain tiles
  // Grown as elongated chains, then surrounded by hills/rolling buffers.
  // ---------------------------------------------------------------------------
  const MOUNTAIN_TARGET = Math.round(500 * targetScale);

  const mountainSet = growMountainRanges(
    numTiles, neighbours, poleDistances, MOUNTAIN_TARGET, rng, featureScale, POLE_MOUNTAIN_MIN
  );

  // Hills buffer: all non-mountain neighbours of mountain tiles
  const hillsSet = new Set<number>();
  for (const mt of mountainSet) {
    for (const nb of neighbours[mt]) {
      if (!mountainSet.has(nb)) hillsSet.add(nb);
    }
  }

  // Rolling buffer: all non-mountain, non-hills neighbours of hills tiles
  const rollingSet = new Set<number>();
  for (const ht of hillsSet) {
    for (const nb of neighbours[ht]) {
      if (!mountainSet.has(nb) && !hillsSet.has(nb)) rollingSet.add(nb);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Desert patches — target ~300 tiles, contiguous, far from poles
  // Desert can be flat or rolling elevation.
  // ---------------------------------------------------------------------------
  const DESERT_TARGET = Math.round(300 * targetScale);

  const desertNoise = positions.map((pos) =>
    gradientNoise3D(pos, 4 * noiseScale, gradients, permutation) * 0.6 +
    gradientNoise3D(pos, 8 * noiseScale, gradients, permutation) * 0.4
  );

  const desertSet = growDesertPatches(
    numTiles, neighbours, poleDistances, desertNoise, DESERT_TARGET, rng, featureScale, POLE_DESERT_MIN
  );

  // ---------------------------------------------------------------------------
  // Step 4: Assign ElevationType per tile
  //
  // Priority:
  //   mountainSet → 'mountain'
  //   hillsSet    → 'hills'
  //   rollingSet  → 'rolling'
  //   desertSet   → 'flat' or 'rolling' (random 50/50)
  //   ocean       → use noise-based quartile (visual variety under water)
  //   remainder   → noise-based quartile (flat/rolling/hills distributed)
  //
  // For non-special tiles we still use a noise field for natural variation,
  // but we cap it at 'hills' (mountains are only from the range algorithm).
  // ---------------------------------------------------------------------------
  const elevNoise = positions.map((pos) => {
    let e = 0;
    e += gradientNoise3D(pos, 5  * noiseScale, gradients, permutation) * 0.5;
    e += gradientNoise3D(pos, 10 * noiseScale, gradients, permutation) * 0.25;
    e += gradientNoise3D(pos, 20 * noiseScale, gradients, permutation) * 0.125;
    return e;
  });

  // Rank non-special land tiles for flat/rolling/hills distribution
  const normalLandIndices = Array.from({ length: numTiles }, (_, i) => i)
    .filter((i) => !mountainSet.has(i) && !hillsSet.has(i) && !rollingSet.has(i) && !desertSet.has(i));

  const sortedNormal = normalLandIndices
    .map((i) => ({ e: elevNoise[i], i }))
    .sort((a, b) => a.e - b.e);

  const normalElevMap = new Map<number, ElevationType>();
  const nq = Math.floor(sortedNormal.length / 3);
  sortedNormal.forEach(({ i }, rank) => {
    if (rank < nq)           normalElevMap.set(i, 'flat');
    else if (rank < nq * 2)  normalElevMap.set(i, 'rolling');
    else                     normalElevMap.set(i, 'hills');
  });

  // Normalise the elevation noise to 0–1 so it can drive within-band height
  // variation (each band spans 3 discrete levels). Smooth + spatially coherent,
  // so neighbouring tiles get similar heights and slopes read naturally.
  let eMin = Infinity;
  let eMax = -Infinity;
  for (const e of elevNoise) {
    if (e < eMin) eMin = e;
    if (e > eMax) eMax = e;
  }
  const eRange = eMax - eMin || 1;
  /** Map an elevation band + tile noise to a discrete height 0–11. */
  const bandHeight = (band: ElevationType, i: number): number => {
    const base =
      band === 'mountain' ? 9 :
      band === 'hills'    ? 6 :
      band === 'rolling'  ? 3 : 0;
    const norm = (elevNoise[i] - eMin) / eRange;     // 0–1
    const offset = Math.min(2, Math.max(0, Math.floor(norm * 3)));
    return base + offset;                            // band-base + 0..2
  };

  // ---------------------------------------------------------------------------
  // Step 5: Tundra — polar caps (same logic as before)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Step 6: Assemble final terrain data
  // ---------------------------------------------------------------------------
  return positions.map((pos, i) => {
    const poleDist = poleDistances[i];
    const isOcean  = isOceanMap[i];

    // --- ElevationType ---
    let elevationType: ElevationType;
    if (mountainSet.has(i)) {
      elevationType = 'mountain';
    } else if (hillsSet.has(i)) {
      elevationType = 'hills';
    } else if (rollingSet.has(i)) {
      elevationType = 'rolling';
    } else if (desertSet.has(i)) {
      // Desert can be flat or rolling
      elevationType = rng() < 0.5 ? 'flat' : 'rolling';
    } else {
      elevationType = normalElevMap.get(i) ?? 'flat';
    }

    // --- TerrainType ---
    const isMountainHill = hillsSet.has(i) && !mountainSet.has(i);
    const terrainType = classifyTerrain(
      isOcean, elevationType, poleDist, mountainSet.has(i), desertSet.has(i), isMountainHill, rng, poleBands
    );

    // Ocean tiles are always flat — no elevation geometry
    if (terrainType === 'ocean') elevationType = 'flat';

    // Discrete height 0–11: ocean is 0, otherwise band base + noise offset.
    const height = terrainType === 'ocean' ? 0 : bandHeight(elevationType, i);

    // --- Forested ---
    const forestNoise = gradientNoise3D(pos, 5, gradients, permutation);
    const forested = classifyForested(terrainType, elevationType, forestNoise);

    return { terrainType, elevationType, height, forested };
  });
}

// ---------------------------------------------------------------------------
// Terrain classification
// ---------------------------------------------------------------------------

/** Scaled polar-band hop thresholds (computed per-world from tile density). */
interface PoleBands {
  tundraCap: number;
  oceanBuffer: number;
  nearPolar: number;
  grassFlat: number;
  grassHills: number;
}

function classifyTerrain(
  isOcean: boolean,
  elevationType: ElevationType,
  poleDist: number,
  isMountain: boolean,
  isDesert: boolean,
  isMountainHill: boolean,
  rng: () => number,
  pole: PoleBands,
): TerrainType {
  // --- Hard tundra cap: pentagon + polar rings ---
  if (poleDist <= pole.tundraCap) return 'tundra';

  // --- Ocean buffer just outside the tundra cap ---
  if (poleDist <= pole.oceanBuffer) return 'ocean';

  // --- Near-polar band: tundra probability fades with distance ---
  if (poleDist <= pole.nearPolar) {
    const span = Math.max(1, pole.nearPolar - pole.oceanBuffer);
    const tundraChance = (pole.nearPolar + 1 - poleDist) / span;
    if (rng() < tundraChance) return 'tundra';
  }

  // --- Ocean ---
  if (isOcean) return 'ocean';

  // --- Desert patches (pre-computed) ---
  if (isDesert) return 'desert';

  // --- Mountain tiles → plains (high altitude, sparse vegetation) ---
  if (isMountain) return 'plains';

  // --- Hills adjacent to mountains → plains (rocky foothills) ---
  if (isMountainHill) return 'plains';

  // --- Grassland for flat/rolling/hills land ---
  if (elevationType === 'flat' || elevationType === 'rolling') {
    return poleDist > pole.grassFlat ? 'grassland' : 'plains';
  }

  // hills → grassland near equator, plains further out
  if (elevationType === 'hills') {
    return poleDist > pole.grassHills ? 'grassland' : 'plains';
  }

  return 'plains';
}

// ---------------------------------------------------------------------------
// Vegetation classification
// ---------------------------------------------------------------------------

function classifyForested(
  terrain: TerrainType,
  elevationType: ElevationType,
  forestNoise: number,
): boolean {
  if (terrain === 'ocean')    return false;
  if (terrain === 'tundra')   return false;
  if (terrain === 'desert')   return false;
  if (terrain === 'plains')   return false;
  if (elevationType === 'mountain') return false;

  // Eligible: grassland at flat/rolling/hills elevation only
  return forestNoise > 0.15; // ~42% forested coverage
}
