/**
 * World generation — pipeline orchestrator + terrain/river/city logic.
 *
 * ── Section map ──────────────────────────────────────────────────────────────
 *   PRNG          mulberry32 — re-exported from rng.ts for convenience
 *   SECTION 1     Goldberg geometry — re-exported from geodesic.ts
 *   SECTION 2     Terrain generation — noise, continents, mountains, deserts
 *   SECTION 3     River generation — downhill channels to the sea
 *   SECTION 4     City placement — 12 evenly-distributed settlements
 *   SECTION 5     generateWorld() — orchestrates all of the above
 *
 * ── Key invariants ───────────────────────────────────────────────────────────
 * - FREQUENCY controls globe size (tile count = 10·F²+2). Currently 100.
 * - Segment N of every tile faces neighbours[N] — enforced by geodesic.ts:
 *   alignBoundaryToNeighbours(). The movement system relies on this.
 * - CITY_COUNT = 12, cities never placed on ocean/tundra/desert/mountain.
 * - Rivers mark tiles with riverTo = downstream index; terrain becomes 'ocean'
 *   post-generation so river hexes are impassable to ground units.
 * - All randomness flows through mulberry32(seed) sub-sequences so the same
 *   seed always produces the same world.
 */

import { World, Tile, City, Vec3, TerrainType, ElevationType } from './types.js';
import * as v from './vec3.js';
import { graphDistance } from './pathfinding.js';

// Re-export PRNG and geometry from their focused modules
export { mulberry32 } from './rng.js';
export {
  generateGeodesicSphere,
  computeDual,
  type SubdividedMesh,
  type DualTile,
} from './geodesic.js';

import { mulberry32 } from './rng.js';
import { generateGeodesicSphere, computeDual } from './geodesic.js';

// ===========================================================================
// SECTION 2 — Terrain generation
// ===========================================================================

/**
 * Terrain generation using simplex-like noise on the sphere.
 * Uses a seeded PRNG (mulberry32, above) for deterministic generation.
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
 * ─── Earth-like land/ocean balance ──────────────────────────────────────────
 * Like Earth, the globe is mostly ocean with land gathered into a few large
 * continents. A low-frequency continental noise field defines height above/below
 * sea level; the highest-noise `LAND_FRACTION` of tiles become land, the rest
 * ocean. Low base frequency yields a handful of big contiguous landmasses with
 * natural coastlines rather than scattered islands. Mountains and deserts only
 * grow on land, and deserts are biased toward the subtropical latitudes (~±30°)
 * where Earth's great deserts sit.
 *
 * Base proportions:
 *   land ≈ 30% (continents), ocean ≈ 70%, with mountain/desert/tundra as
 *   sub-features of the land. Tundra still forms the polar caps.
 */

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
 * Grow mountain RANGES — one (or a few, on big continents) per landmass.
 *
 * Each range is an organic band roughly `SPINE_LEN` hexes long and up to
 * ~2·`MAX_HALF` hexes wide:
 *   1. Walk a gently-curving spine across the continent.
 *   2. Give every spine tile a smoothly-varying half-width (a random walk in
 *      [1, MAX_HALF]) so the band pinches and bulges.
 *   3. Flood out from the spine, including tiles within their nearest spine
 *      tile's half-width, plus a probabilistic one-tile fringe → ragged edges.
 *   4. Add a few short spurs branching off the spine.
 *
 * Big continents get several ranges (one per ~`TILES_PER_RANGE` land tiles) so
 * no single massif dominates; continents below `MIN_CONTINENT` stay bare.
 *
 * Returns a Set of tile indices that are mountain.
 */
function growMountainRanges(
  numTiles: number,
  neighbours: number[][],
  poleDistances: number[],
  rng: () => number,
  poleMin: number,
  isLand: boolean[],
  positions: Vec3[],
): Set<number> {
  const mountains = new Set<number>();
  const eligible = (i: number): boolean => isLand[i] && poleDistances[i] > poleMin;

  // A range is a single meandering CENTRELINE about SPINE_LEN hexes long, walked
  // step-by-step along a continent-scale tectonic axis with a travelling-sine
  // wobble. The centreline is then widened into a band a few hexes across, and a
  // handful of short spurs fork off perpendicular to the sides. Heights ramp down
  // through the surrounding apron (see landHeight), so a range reads as one
  // continuous ridge rising out of foothills — not a round blob with radiating
  // spider-leg spurs.
  const SPINE_LEN_MIN = 56;      // target centreline length in hexes
  const SPINE_LEN_MAX = 72;
  const MIN_CONTINENT = 600;
  const TILES_PER_RANGE = 8500;
  const BAND_HALF_MAX = 2;       // band half-width (band spans up to 2*this+1 hexes)
  const FRINGE_CHANCE = 0.3;     // ragged one-hex fringe just beyond the band
  const SPUR_COUNT_MIN = 1;      // short lateral spurs per range
  const SPUR_COUNT_MAX = 3;
  const SPUR_LEN_MIN = 7;
  const SPUR_LEN_MAX = 16;

  const compId = new Int32Array(numTiles).fill(-1);
  const compSize: number[] = [];
  const compTiles: number[][] = [];
  for (let i = 0; i < numTiles; i++) {
    if (!eligible(i) || compId[i] >= 0) continue;
    const id = compSize.length;
    const tiles: number[] = [];
    const stack = [i];
    compId[i] = id;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      tiles.push(cur);
      for (const nb of neighbours[cur]) {
        if (eligible(nb) && compId[nb] < 0) { compId[nb] = id; stack.push(nb); }
      }
    }
    compSize.push(tiles.length);
    compTiles.push(tiles);
  }

  function safeNormalize(a: Vec3): Vec3 {
    const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    return len > 1e-9 ? { x: a.x / len, y: a.y / len, z: a.z / len } : { x: 1, y: 0, z: 0 };
  }

  function tangentAxis(at: Vec3): Vec3 {
    const theta = rng() * Math.PI * 2;
    const raw: Vec3 = { x: Math.cos(theta), y: rng() * 0.18 - 0.09, z: Math.sin(theta) };
    const radial = v.dot(raw, at);
    return safeNormalize({ x: raw.x - radial * at.x, y: raw.y - radial * at.y, z: raw.z - radial * at.z });
  }

  function pickWeighted(candidates: { idx: number; score: number }[]): number {
    let total = 0;
    for (const c of candidates) total += Math.max(0.001, c.score);
    let pick = rng() * total;
    for (const c of candidates) {
      pick -= Math.max(0.001, c.score);
      if (pick <= 0) return c.idx;
    }
    return candidates[candidates.length - 1].idx;
  }

  /**
   * Walk a meandering centreline of about `targetLen` hexes. From `start`, every
   * step advances along `axis` (keeping a consistent heading so the line never
   * doubles back into a blob) while a travelling sine nudges it sideways across
   * `crossAxis` for sweeping curvature. Distances are normalised by the local hop
   * size so the scoring is tessellation-independent.
   */
  function traceSpine(start: number, comp: number, axis: Vec3, targetLen: number): number[] {
    const spine: number[] = [start];
    const seen = new Set<number>([start]);
    let cur = start;
    let lastDir: Vec3 | undefined;

    const crossAxis = safeNormalize(v.cross(axis, positions[start]));
    const phase = rng() * Math.PI * 2;
    const freq = 0.10 + rng() * 0.06;       // wobble cycles along the line
    const amp = 0.010 + rng() * 0.010;      // wobble amplitude (cross-axis units)
    const baseCross = v.dot(positions[start], crossAxis);

    function localHop(t: number): number {
      let hop = Infinity;
      for (const nb of neighbours[t]) {
        const d = v.distance(positions[nb], positions[t]);
        if (d < hop) hop = d;
      }
      return Number.isFinite(hop) && hop > 0 ? hop : 1;
    }

    for (let step = 1; step < targetLen; step++) {
      const curProj = v.dot(positions[cur], axis);
      const desiredCross = baseCross + Math.sin(step * freq + phase) * amp;
      const hop = localHop(cur);

      const candidates: { idx: number; score: number }[] = [];
      for (const nb of neighbours[cur]) {
        if (!eligible(nb) || compId[nb] !== comp || seen.has(nb)) continue;
        const axisProgress = (v.dot(positions[nb], axis) - curProj) / hop;   // ~ -1..1
        if (axisProgress <= 0) continue;                                     // always move forward
        const crossErr = Math.abs(v.dot(positions[nb], crossAxis) - desiredCross) / hop;
        const stepDir = safeNormalize(v.sub(positions[nb], positions[cur]));
        const inertia = lastDir ? v.dot(stepDir, lastDir) : 0.5;
        const score = 1.0 + axisProgress * 3.0 - crossErr * 1.2 + Math.max(0, inertia) * 1.0;
        candidates.push({ idx: nb, score });
      }

      if (candidates.length === 0) {
        // Relax forward-only rule so a coastline pinch doesn't cut the range
        // short; prefer whichever neighbour reaches furthest along the axis.
        for (const nb of neighbours[cur]) {
          if (!eligible(nb) || compId[nb] !== comp || seen.has(nb)) continue;
          candidates.push({ idx: nb, score: 1.0 + (v.dot(positions[nb], axis) - curProj) / hop });
        }
      }
      if (candidates.length === 0) break;

      const next = pickWeighted(candidates);
      lastDir = safeNormalize(v.sub(positions[next], positions[cur]));
      cur = next;
      seen.add(cur);
      spine.push(cur);
    }
    return spine;
  }

  /**
   * Grow a short spur of `len` hexes forking off the centreline at `origin`,
   * heading roughly perpendicular to `alongDir` (off to one side) with inertia.
   * Returns the spur tiles (centreline only — widening happens later).
   */
  function growSpur(origin: number, comp: number, alongDir: Vec3, len: number): number[] {
    const normal = safeNormalize(positions[origin]);
    const sideSign = rng() < 0.5 ? -1 : 1;
    const lateral = safeNormalize(v.cross(normal, alongDir)); // perpendicular, in tangent plane
    let dir: Vec3 = v.scale(lateral, sideSign);

    const spur: number[] = [origin];
    const seen = new Set<number>([origin]);
    let cur = origin;

    for (let i = 0; i < len; i++) {
      const candidates: { idx: number; score: number }[] = [];
      for (const nb of neighbours[cur]) {
        if (!eligible(nb) || compId[nb] !== comp || seen.has(nb)) continue;
        const stepDir = safeNormalize(v.sub(positions[nb], positions[cur]));
        const heading = v.dot(stepDir, dir);                  // follow the spur out
        const offSpine = Math.abs(v.dot(stepDir, alongDir));  // discourage hugging the ridge
        candidates.push({ idx: nb, score: 1.0 + Math.max(0, heading) * 3.0 - offSpine * 1.0 });
      }
      if (candidates.length === 0) break;
      const next = pickWeighted(candidates);
      dir = safeNormalize(v.sub(positions[next], positions[cur]));
      cur = next;
      seen.add(cur);
      spur.push(cur);
    }
    return spur;
  }

  /**
   * Widen centreline tiles into a band. Each centreline tile carries a half-width;
   * a multi-source BFS over eligible land tags every nearby tile with its nearest
   * centreline tile's half-width and includes it if within that half-width, plus a
   * sparse ragged fringe one hex beyond.
   */
  function widenBand(centreHalf: Map<number, number>, comp: number): void {
    const dist = new Map<number, number>();
    const srcHalf = new Map<number, number>();
    const queue: number[] = [];
    let head = 0;
    for (const [t, hw] of centreHalf) {
      dist.set(t, 0);
      srcHalf.set(t, hw);
      mountains.add(t);
      queue.push(t);
    }
    while (head < queue.length) {
      const curT = queue[head++];
      const d = dist.get(curT)!;
      const hw = srcHalf.get(curT)!;
      if (d >= hw + 1) continue;            // expand one hex past the band for the fringe
      for (const nb of neighbours[curT]) {
        if (!eligible(nb) || compId[nb] !== comp || dist.has(nb)) continue;
        dist.set(nb, d + 1);
        srcHalf.set(nb, hw);
        queue.push(nb);
        if (d + 1 <= hw) mountains.add(nb);
        else if (rng() < FRINGE_CHANCE) mountains.add(nb); // ragged edge
      }
    }
  }

  for (let id = 0; id < compSize.length; id++) {
    if (compSize[id] < MIN_CONTINENT) continue;
    const tiles = compTiles[id];
    const rangeCount = Math.max(1, Math.round(compSize[id] / TILES_PER_RANGE));

    for (let r = 0; r < rangeCount; r++) {
      const anchor = tiles[Math.floor(rng() * tiles.length)];
      const axis = tangentAxis(positions[anchor]);
      // Start on the trailing (low-projection) edge so the line sweeps across the
      // landmass rather than starting in its middle.
      const sorted = tiles.slice().sort((a, b) => v.dot(positions[a], axis) - v.dot(positions[b], axis));
      const lowBand = Math.max(1, Math.floor(sorted.length * 0.15));
      const start = sorted[Math.floor(rng() * lowBand)];
      const targetLen = SPINE_LEN_MIN + Math.floor(rng() * (SPINE_LEN_MAX - SPINE_LEN_MIN + 1));
      const spine = traceSpine(start, id, axis, targetLen);
      if (spine.length < 40) continue;

      // Smoothly-varying band half-width: a bounded random walk in [1, BAND_HALF_MAX]
      // so the ridge pinches and bulges instead of being a uniform sausage.
      const centreHalf = new Map<number, number>();
      let hw = 1 + Math.floor(rng() * BAND_HALF_MAX);
      for (const t of spine) {
        if (rng() < 0.35) hw += rng() < 0.5 ? -1 : 1;
        hw = Math.max(1, Math.min(BAND_HALF_MAX, hw));
        centreHalf.set(t, hw);
      }

      // A few short spurs forking off to the sides (thinner than the main ridge).
      const spurCount = SPUR_COUNT_MIN + Math.floor(rng() * (SPUR_COUNT_MAX - SPUR_COUNT_MIN + 1));
      for (let s = 0; s < spurCount; s++) {
        const k = 6 + Math.floor(rng() * Math.max(1, spine.length - 12));
        const prev = spine[Math.max(0, k - 3)];
        const next = spine[Math.min(spine.length - 1, k + 3)];
        const alongDir = safeNormalize(v.sub(positions[next], positions[prev]));
        const spurLen = SPUR_LEN_MIN + Math.floor(rng() * (SPUR_LEN_MAX - SPUR_LEN_MIN + 1));
        const spur = growSpur(spine[k], id, alongDir, spurLen);
        for (const t of spur) if (!centreHalf.has(t)) centreHalf.set(t, 1);
      }

      widenBand(centreHalf, id);
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
  isLand: boolean[],
  blocked: Set<number>,
): Set<number> {
  const desert = new Set<number>();

  // Sort candidates by desert noise (highest first) — these become patch seeds
  const candidates = Array.from({ length: numTiles }, (_, i) => i)
    .filter((i) => isLand[i] && !blocked.has(i) && poleDistances[i] > poleMin && desertNoise[i] > 0)
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
        if (!isLand[nb] || blocked.has(nb)) continue;
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
// Terrain public API
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
  const frequency = Math.sqrt(Math.max(1, (numTiles - 2) / 10));
  const densityScale = frequency / 36;
  const targetScale = numTiles / 12962;
  const poleScale = Math.max(1, densityScale);

  // The old generator ranked one noise field, which creates ugly circular seas
  // and huge beige zones. This version builds a planet-like map in three passes:
  //   1. broad continent/ocean anchors + low-frequency noise -> exact 60/40 mask
  //   2. mountain ranges and elevation -> relief
  //   3. latitude/moisture climate -> grassland/plains/desert/tundra + forests
  const LAND_FRACTION = 0.61;
  const poleDistances = computePoleDistances(positions, neighbours, sides);

  const pentagonIndices = Array.from({ length: numTiles }, (_, i) => i)
    .filter((i) => sides[i] === 5)
    .sort((a, b) => Math.abs(positions[b].y) - Math.abs(positions[a].y));
  const polarPentagons = new Set<number>(pentagonIndices.slice(0, 2));

  function randomUnit(): Vec3 {
    const z = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(theta), y: z, z: r * Math.sin(theta) };
  }

  function randomNonPolarUnit(maxAbsY = 0.78): Vec3 {
    let p = randomUnit();
    let guard = 0;
    while (Math.abs(p.y) > maxAbsY && guard++ < 100) p = randomUnit();
    return p;
  }

  // A small number of continent/ocean anchors gives recognisable landmasses
  // instead of static-like noise. Ocean anchors are stronger and wider so the
  // 40% sea tends to connect into oceans rather than perfect inland ponds.
  const landAnchors = Array.from({ length: 9 }, () => ({
    centre: randomNonPolarUnit(0.82),
    radius: 0.70 + rng() * 0.38,
    weight: 0.80 + rng() * 0.55,
  }));
  const oceanAnchors = Array.from({ length: 6 }, () => ({
    centre: randomNonPolarUnit(0.88),
    radius: 0.82 + rng() * 0.42,
    weight: 0.95 + rng() * 0.75,
  }));

  const continentScore = positions.map((pos) => {
    const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z) || 1;
    const latAbs = Math.abs(pos.y / len);

    let land = -2.0;
    for (const a of landAnchors) {
      const dot = v.dot(pos, a.centre);
      const edge = Math.cos(a.radius);
      const influence = (dot - edge) / (1 - edge);
      land = Math.max(land, influence * a.weight);
    }

    let ocean = -2.0;
    for (const a of oceanAnchors) {
      const dot = v.dot(pos, a.centre);
      const edge = Math.cos(a.radius);
      const influence = (dot - edge) / (1 - edge);
      ocean = Math.max(ocean, influence * a.weight);
    }

    // Fractal coastline signal: large lobes define continents, then two finer
    // octaves chew into the shoreline. Because the mask is still rank-selected,
    // this changes coastline geometry without breaking the 60/40 target.
    const broadNoise =
      gradientNoise3D(pos, 0.85, gradients, permutation) * 0.34 +
      gradientNoise3D(pos, 1.70, gradients, permutation) * 0.28 +
      gradientNoise3D(pos, 3.40, gradients, permutation) * 0.20 +
      gradientNoise3D(pos, 6.80, gradients, permutation) * 0.13 +
      gradientNoise3D(pos, 13.6, gradients, permutation) * 0.07;

    // Only a gentle pull toward land at the very poles, so an ice core always
    // survives. Mid-polar latitudes are left neutral so the rank-selected ocean
    // mask can carve organic, random sea around the caps instead of a solid
    // land collar.
    const polarLift = latAbs > 0.95 ? 0.06 : 0;
    return land - ocean + broadNoise + polarLift;
  });

  const sortedByContinent = continentScore
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e - a.e);

  const landCount = Math.round(numTiles * LAND_FRACTION);
  const isLandMap = new Array<boolean>(numTiles).fill(false);
  sortedByContinent.slice(0, landCount).forEach(({ i }) => { isLandMap[i] = true; });

  // Hard requirement: each pole is a pentagon, and each polar pentagon remains land.
  for (const i of polarPentagons) isLandMap[i] = true;

  // Prevent isolated one-hex sea/land noise by applying a tiny majority filter.
  // Then re-trim back to the 60% land target so the final ratio stays honest.
  for (let pass = 0; pass < 2; pass++) {
    const next = isLandMap.slice();
    for (let i = 0; i < numTiles; i++) {
      if (polarPentagons.has(i)) { next[i] = true; continue; }
      const landN = neighbours[i].filter((nb) => isLandMap[nb]).length;
      if (isLandMap[i] && landN <= 1) next[i] = false;
      else if (!isLandMap[i] && landN >= neighbours[i].length - 1) next[i] = true;
    }
    for (let i = 0; i < numTiles; i++) isLandMap[i] = next[i];
  }

  // Shape coastlines as headlands and bays, not one-hex static.
  //
  // The previous pass flipped individual coastal tiles using high-frequency
  // noise; it technically made a jagged edge, but visually it produced the
  // one-hex zipper pattern called out in review. This pass operates in patches:
  //   - bays: connected coastal land chunks are carved into sea
  //   - headlands: connected coastal sea chunks are raised into land
  // Bays and headlands are paired tile-for-tile so the 60/40 land target stays
  // stable, and every patch has a minimum footprint so the coastline changes in
  // coves, inlets and peninsulas rather than isolated hexes.
  {
    const COAST_PATCHES = Math.max(18, Math.round(frequency * 0.42));
    const MIN_PATCH = Math.max(10, Math.round(frequency * 0.18));
    const MAX_PATCH = Math.max(MIN_PATCH + 12, Math.round(frequency * 0.85));

    const coastalSeeds = (wantLand: boolean): { i: number; score: number }[] => {
      const out: { i: number; score: number }[] = [];
      for (let i = 0; i < numTiles; i++) {
        if (polarPentagons.has(i) || isLandMap[i] !== wantLand) continue;
        const landN = neighbours[i].filter((nb) => isLandMap[nb]).length;
        const seaN = neighbours[i].length - landN;
        if (landN === 0 || seaN === 0) continue;

        // Low/mid frequency only. This produces lobe-scale structure; high
        // frequency is deliberately avoided because it creates single-hex chop.
        const bayHeadlandSignal =
          gradientNoise3D(positions[i], 1.8, gradients, permutation) * 0.46 +
          gradientNoise3D(positions[i], 3.2, gradients, permutation) * 0.34 +
          gradientNoise3D(positions[i], 5.6, gradients, permutation) * 0.20;
        const exposure = Math.min(landN, seaN) / Math.max(1, neighbours[i].length);
        out.push({ i, score: bayHeadlandSignal + exposure * 0.35 + rng() * 0.04 });
      }
      out.sort((a, b) => b.score - a.score);
      return out;
    };

    const baySeeds = coastalSeeds(true);   // land -> sea
    const headSeeds = coastalSeeds(false); // sea -> land
    const reserved = new Set<number>();

    function growCoastPatch(seed: number, wantLand: boolean, targetSize: number): number[] {
      if (reserved.has(seed) || isLandMap[seed] !== wantLand || polarPentagons.has(seed)) return [];

      const patch: number[] = [];
      const inPatch = new Set<number>([seed]);
      const frontier: number[] = [seed];

      while (frontier.length > 0 && patch.length < targetSize) {
        // Prefer older frontier entries most of the time so patches advance as
        // coherent lobes; occasional random picks keep them organic.
        const pickIndex = rng() < 0.72 ? 0 : Math.floor(rng() * frontier.length);
        const cur = frontier.splice(pickIndex, 1)[0];
        if (reserved.has(cur) || polarPentagons.has(cur) || isLandMap[cur] !== wantLand) continue;

        const landN = neighbours[cur].filter((nb) => isLandMap[nb]).length;
        const seaN = neighbours[cur].length - landN;
        const isCoastal = landN > 0 && seaN > 0;

        // Let the patch push a few tiles inland/offshore, but keep it anchored
        // to the coast by requiring either coastal contact or an existing patch
        // neighbour. This creates bays/headlands instead of random islands.
        const touchesPatch = neighbours[cur].some((nb) => inPatch.has(nb));
        if (!isCoastal && !touchesPatch) continue;

        patch.push(cur);

        const ordered = neighbours[cur]
          .filter((nb) => !inPatch.has(nb) && !reserved.has(nb) && !polarPentagons.has(nb) && isLandMap[nb] === wantLand)
          .map((nb) => {
            const nLand = neighbours[nb].filter((x) => isLandMap[x]).length;
            const nSea = neighbours[nb].length - nLand;
            const coastiness = nLand > 0 && nSea > 0 ? 1 : 0;
            const lobeNoise =
              gradientNoise3D(positions[nb], 2.4, gradients, permutation) * 0.65 +
              gradientNoise3D(positions[nb], 4.8, gradients, permutation) * 0.35;
            return { nb, score: coastiness * 0.7 + lobeNoise + rng() * 0.1 };
          })
          .sort((a, b) => b.score - a.score)
          .map((x) => x.nb);

        // Add several neighbours, not one, so the footprint grows as an area.
        const addCount = Math.min(ordered.length, 2 + Math.floor(rng() * 3));
        for (let k = 0; k < addCount; k++) {
          inPatch.add(ordered[k]);
          frontier.push(ordered[k]);
        }
      }

      if (patch.length < MIN_PATCH) return [];
      for (const t of patch) reserved.add(t);
      return patch;
    }

    const bayPatches: number[][] = [];
    const headlandPatches: number[][] = [];
    let bayCursor = 0;
    let headCursor = 0;

    for (let p = 0; p < COAST_PATCHES; p++) {
      const bayTarget = MIN_PATCH + Math.floor(rng() * (MAX_PATCH - MIN_PATCH + 1));
      let bay: number[] = [];
      while (bayCursor < baySeeds.length && bay.length === 0) {
        bay = growCoastPatch(baySeeds[bayCursor++].i, true, bayTarget);
      }
      if (bay.length === 0) break;
      bayPatches.push(bay);

      // Match the bay with one or more headland patches of roughly equal area.
      const heads: number[] = [];
      let attempts = 0;
      while (headCursor < headSeeds.length && heads.length < bay.length && attempts++ < 80) {
        const remaining = bay.length - heads.length;
        const headTarget = Math.max(MIN_PATCH, Math.min(MAX_PATCH, remaining));
        const head = growCoastPatch(headSeeds[headCursor++].i, false, headTarget);
        if (head.length > 0) heads.push(...head.slice(0, remaining));
      }

      if (heads.length < MIN_PATCH) {
        // Not enough compensating sea coast found; abandon this bay so the land
        // ratio does not drift and we do not create an unpaired bite.
        for (const t of bay) reserved.delete(t);
        bayPatches.pop();
        continue;
      }
      headlandPatches.push(heads);
    }

    for (let k = 0; k < Math.min(bayPatches.length, headlandPatches.length); k++) {
      const bay = bayPatches[k];
      const head = headlandPatches[k];
      const n = Math.min(bay.length, head.length);
      for (let j = 0; j < n; j++) {
        isLandMap[bay[j]] = false;
        isLandMap[head[j]] = true;
      }
    }

    // Final clean-up removes any tiny accidental islands/pinholes created at
    // patch edges, without flattening the larger headlands and bays.
    for (let pass = 0; pass < 2; pass++) {
      const next = isLandMap.slice();
      for (let i = 0; i < numTiles; i++) {
        if (polarPentagons.has(i)) { next[i] = true; continue; }
        const landN = neighbours[i].filter((nb) => isLandMap[nb]).length;
        if (isLandMap[i] && landN <= 1) next[i] = false;
        else if (!isLandMap[i] && landN >= neighbours[i].length - 1) next[i] = true;
      }
      for (let i = 0; i < numTiles; i++) isLandMap[i] = next[i];
    }
  }

  const landAfterSmooth = isLandMap.reduce((sum, land) => sum + (land ? 1 : 0), 0);
  if (landAfterSmooth !== landCount) {
    const candidates = continentScore
      .map((e, i) => ({ e, i }))
      .filter(({ i }) => !polarPentagons.has(i))
      .sort((a, b) => landAfterSmooth < landCount ? b.e - a.e : a.e - b.e);
    let delta = Math.abs(landCount - landAfterSmooth);
    for (const { i } of candidates) {
      if (delta <= 0) break;
      if (landAfterSmooth < landCount && !isLandMap[i]) { isLandMap[i] = true; delta--; }
      else if (landAfterSmooth > landCount && isLandMap[i]) { isLandMap[i] = false; delta--; }
    }
  }

  const isOceanMap = isLandMap.map((land) => !land);

  const POLE_MOUNTAIN_MIN = Math.round(8  * poleScale);
  const POLE_CITY_MIN     = Math.round(16 * poleScale);

  const mountainSet = growMountainRanges(
    numTiles, neighbours, poleDistances, rng, POLE_MOUNTAIN_MIN, isLandMap, positions
  );

  const APRON_R = 7;
  const distToMountain = new Array<number>(numTiles).fill(Infinity);
  {
    const q: number[] = [];
    let head = 0;
    for (const m of mountainSet) { distToMountain[m] = 0; q.push(m); }
    while (head < q.length) {
      const c = q[head++];
      const d = distToMountain[c];
      if (d >= APRON_R) continue;
      for (const nb of neighbours[c]) {
        if (!isLandMap[nb] || distToMountain[nb] !== Infinity) continue;
        distToMountain[nb] = d + 1;
        q.push(nb);
      }
    }
  }

  // Distance to sea drives coastal moisture and helps avoid all-inland beige.
  const distToOcean = new Array<number>(numTiles).fill(Infinity);
  {
    const q: number[] = [];
    let head = 0;
    for (let i = 0; i < numTiles; i++) if (isOceanMap[i]) { distToOcean[i] = 0; q.push(i); }
    while (head < q.length) {
      const c = q[head++];
      const d = distToOcean[c];
      if (d >= 24) continue;
      for (const nb of neighbours[c]) {
        if (distToOcean[nb] !== Infinity) continue;
        distToOcean[nb] = d + 1;
        q.push(nb);
      }
    }
  }

  const climateNoise = positions.map((pos) =>
    gradientNoise3D(pos, 2.0, gradients, permutation) * 0.45 +
    gradientNoise3D(pos, 5.0, gradients, permutation) * 0.25 +
    gradientNoise3D(pos, 11.0, gradients, permutation) * 0.10
  );

  const elevNoise = positions.map((pos) =>
    gradientNoise3D(pos, 3.5, gradients, permutation) * 0.45 +
    gradientNoise3D(pos, 7.0, gradients, permutation) * 0.25 +
    gradientNoise3D(pos, 14.0, gradients, permutation) * 0.10
  );

  // Coherent peak field: lower-frequency than earlier versions so summit
  // heights flow along a range instead of flickering as isolated white/grey blobs.
  const peakNoise = positions.map((pos) =>
    gradientNoise3D(pos, 6.5, gradients, permutation) * 0.70 +
    gradientNoise3D(pos, 13.0, gradients, permutation) * 0.30
  );

  let eMin = Infinity, eMax = -Infinity;
  for (const e of elevNoise) { if (e < eMin) eMin = e; if (e > eMax) eMax = e; }
  const eRange = eMax - eMin || 1;
  let pMin = Infinity, pMax = -Infinity;
  for (const p of peakNoise) { if (p < pMin) pMin = p; if (p > pMax) pMax = p; }
  const pRange = pMax - pMin || 1;

  const APRON_PEAK = 8.5;
  const APRON_STEP = 1.35;

  const landHeight = (i: number): number => {
    if (mountainSet.has(i)) {
      const pn = (peakNoise[i] - pMin) / pRange;
      return 9 + Math.min(2, Math.floor(pn * 3));
    }
    const baseH = Math.round(((elevNoise[i] - eMin) / eRange) * 6); // mostly 0-6
    const d = distToMountain[i];
    const apron = Number.isFinite(d) ? APRON_PEAK - d * APRON_STEP : -Infinity;
    return Math.max(0, Math.min(8, Math.round(Math.max(baseH, apron))));
  };

  const heightBand = (h: number): ElevationType =>
    h >= 9 ? 'mountain' : h >= 6 ? 'hills' : h >= 3 ? 'rolling' : 'flat';

  // Build heights once, then smooth only mountain-core heights.  This avoids
  // salt-and-pepper 9/10/11 peak blobs while keeping visible summit variation.
  const heights = new Array<number>(numTiles).fill(0);
  for (let i = 0; i < numTiles; i++) {
    if (!isOceanMap[i]) heights[i] = landHeight(i);
  }
  smoothMountainPeakHeights(heights, mountainSet, neighbours);

  // ── Organic polar ice caps ─────────────────────────────────────────────────
  // Ice is latitude-driven, but the cap EDGE is perturbed by low-frequency noise
  // so each pole gets a wavy, organic blob instead of a clean parallel ring.
  // Both poles are covered because latitude is symmetric (|y|). The pole
  // pentagons are forced to ice so a core always survives even when the noise
  // shrinks a cap. Ocean tiles that fall inside a cap simply stay ocean — that
  // is what gives the organic, random polar sea interspersed with the ice.
  const ICE_LAT_EDGE  = 0.90; // base |latitude| where ice begins (~64°)
  const ICE_EDGE_WAVE = 0.20; // how far the noise pushes the cap edge in/out
  const iceField = positions.map((pos) => {
    const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z) || 1;
    const latAbs = Math.abs(pos.y / len);
    const wave =
      gradientNoise3D(pos, 2.2, gradients, permutation) * 0.62 +
      gradientNoise3D(pos, 4.6, gradients, permutation) * 0.38;
    return latAbs + wave * ICE_EDGE_WAVE;
  });
  const isPolarIce = (i: number): boolean =>
    polarPentagons.has(i) || iceField[i] >= ICE_LAT_EDGE;

  return positions.map((pos, i) => {
    if (isOceanMap[i]) {
      return { terrainType: 'ocean', elevationType: 'flat', height: 0, forested: false };
    }

    const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z) || 1;
    const latAbs = Math.abs(pos.y / len);
    const temp = Math.max(0, 1 - Math.pow(latAbs, 1.7));
    const coastal = Math.max(0, 1 - Math.min(distToOcean[i], 18) / 18);
    const mountainDry = Number.isFinite(distToMountain[i]) ? Math.max(0, 1 - distToMountain[i] / 7) * 0.16 : 0;
    const moisture = Math.max(0, Math.min(1,
      0.46 + climateNoise[i] + coastal * 0.34 - mountainDry - (latAbs > 0.82 ? 0.08 : 0)
    ));
    const subtropical = 1 - Math.min(1, Math.abs(latAbs - 0.45) / 0.28);

    const height = heights[i];
    const elevationType = heightBand(height);
    const isMountain = mountainSet.has(i) || elevationType === 'mountain';

    let terrainType: TerrainType;
    if (isPolarIce(i)) {
      terrainType = 'tundra';
    } else if (!isMountain && temp > 0.45 && subtropical > 0.35 && moisture < 0.36 && height <= 5) {
      terrainType = 'desert';
    } else if (isMountain) {
      terrainType = 'plains';
    } else if (moisture > 0.38 && temp > 0.30) {
      terrainType = 'grassland';
    } else {
      terrainType = 'plains';
    }

    // Keep polar city exclusion meaningful even if a rare warm/noisy tile sneaks in.
    if (poleDistances[i] < POLE_CITY_MIN && terrainType === 'grassland' && latAbs > 0.68) {
      terrainType = 'plains';
    }

    const forested =
      terrainType === 'grassland' &&
      elevationType !== 'mountain' &&
      moisture > 0.52 &&
      temp > 0.38 &&
      climateNoise[i] > -0.05;

    return { terrainType, elevationType, height, forested };
  });
}


/**
 * Smooth high mountain cells so peaks read as ridges instead of salt-and-pepper
 * blobs.  Mountain cores remain in the 9-11 band, but isolated 11s surrounded by
 * 9s are pulled toward the local median.  A final local-majority pass enforces
 * the design target that at least half of a mountain tile's mountain neighbours
 * are within one elevation step whenever the range geometry allows it.
 */
function smoothMountainPeakHeights(
  heights: number[],
  mountainSet: Set<number>,
  neighbours: number[][],
): void {
  const mountainTiles = Array.from(mountainSet);
  if (mountainTiles.length === 0) return;

  const clampPeak = (h: number): number => Math.max(9, Math.min(11, Math.round(h)));

  // Diffuse summit height along connected ridges without letting peaks leave the
  // mountain band.  This keeps sweeping ranges visually coherent while preserving
  // some 9/10/11 variation.
  for (let pass = 0; pass < 4; pass++) {
    const next = heights.slice();
    for (const i of mountainTiles) {
      const mns = neighbours[i].filter((nb) => mountainSet.has(nb));
      if (mns.length === 0) continue;
      const avg = (heights[i] * 1.4 + mns.reduce((sum, nb) => sum + heights[nb], 0)) / (mns.length + 1.4);
      next[i] = clampPeak(avg);
    }
    for (const i of mountainTiles) heights[i] = next[i];
  }

  // Local-majority relaxation: if fewer than half the mountain neighbours are
  // within one step, nudge this tile to the local median.  This directly targets
  // the requested "within one elevation 50% of the time" behaviour.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const next = heights.slice();
    for (const i of mountainTiles) {
      const mns = neighbours[i].filter((nb) => mountainSet.has(nb));
      if (mns.length < 2) continue;
      const close = mns.filter((nb) => Math.abs(heights[i] - heights[nb]) <= 1).length;
      if (close * 2 >= mns.length) continue;
      const local = [heights[i], ...mns.map((nb) => heights[nb])].sort((a, b) => a - b);
      const median = local[Math.floor(local.length / 2)];
      const h = clampPeak(median);
      if (h !== heights[i]) { next[i] = h; changed = true; }
    }
    for (const i of mountainTiles) heights[i] = next[i];
    if (!changed) break;
  }
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

  return forestNoise > 0.15;
}

// ===========================================================================
// SECTION 3 — River generation
// ===========================================================================

/**
 * River generation.
 *
 * Rivers are **whole hexes of water** that flow all the way to the sea. Each
 * river starts on a mountain-height tile and carves a path downhill, but rather
 * than fragile steepest-descent (which can dead-end in a basin), it routes by
 * *distance to the nearest ocean*: every step moves to a neighbour that is
 * strictly closer to the coast, so a river is guaranteed to reach the sea.
 * Among the closer-to-sea neighbours the lowest one is chosen, so the channel
 * still follows the terrain naturally.
 *
 * When a river runs into an existing river it stops (the two join); the shared
 * downstream channel then carries both to the sea. Rivers stay a single hex wide
 * all the way to the coast — there is no estuary widening.
 *
 * A river tile is marked by `Tile.riverTo` — the downstream neighbour tile it
 * flows toward (the final land tile points at the ocean it empties into).
 * Rendering treats any tile with `riverTo` set as open water.
 *
 * ─── Tunables ───────────────────────────────────────────────────────────────
 *   RIVER_DENSITY   — rivers per tile; higher = more rivers (scales with globe).
 *   SOURCE_HEIGHT   — minimum tile height to be a river source (mountain band).
 *   MAX_RIVER_LEN   — hard cap on river length (loop/blow-up guard).
 */

/** Approximate number of rivers per tile (≈ tiles/4000 → ~25 on a G100 world). */
export const RIVER_DENSITY = 1 / 4000;
/** Minimum discrete height (0–11) for a tile to seed a river. */
export const SOURCE_HEIGHT = 9;
/** @deprecated Rivers are now a single hex wide; estuary widening was removed. */
export const ESTUARY_REACH = 2;
/** Safety cap on the number of tiles in a single river. */
export const MAX_RIVER_LEN = 400;

/**
 * River meander shape. Rivers are carved as a sine wave: the seaward heading is
 * swung from side to side by sin(phase), advancing to the coast.
 */
/** Sideways swing of the sine wave (higher = wider meanders). */
const MEANDER_AMP = 2.6;
/** Phase advance per tile — sets the wave's wavelength (radians per tile). */
const MEANDER_FREQ = 0.5;
/** Random jitter added to the sine swing each step (0 = a perfect sine). */
const MEANDER_JITTER = 0.5;
/** A river may climb at most this many height levels on a sideways step. */
const MEANDER_CLIMB_TOLERANCE = 1;

/**
 * Guarantee every river tile drains to the sea. Any river tile whose `riverTo`
 * chain does not reach open ocean (it dead-ended inland, was orphaned by a city
 * clearing its doorstep, or formed a loop) is re-routed straight down the
 * oceanDist gradient to the coast — which strictly decreases to 0, so the tail
 * is acyclic and always reaches the sea. Tiles in `forbidden` (e.g. city hexes
 * and their doorsteps) are never carved through; a river a city fully blocks is
 * truncated cleanly rather than left dangling. Sea-reaching rivers are left
 * untouched, so existing meanders are preserved.
 *
 * "Sea" means real open ocean (`terrainType === 'ocean'` with no `riverTo`);
 * river tiles (which also carry terrain 'ocean' once converted) are not sinks.
 */
function ensureRiverDrainage(tiles: Tile[], forbidden?: Set<number>): void {
  const n = tiles.length;
  const isSea = (i: number) => tiles[i].terrainType === 'ocean' && tiles[i].riverTo === undefined;
  const heightOf = (i: number) => tiles[i].height ?? 0;

  // oceanDist: BFS hops to the nearest sea tile.
  const oceanDist = new Array<number>(n).fill(Infinity);
  const queue: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) if (isSea(i)) { oceanDist[i] = 0; queue.push(i); }
  while (head < queue.length) {
    const c = queue[head++];
    for (const nb of tiles[c].neighbours) {
      if (oceanDist[nb] === Infinity) { oceanDist[nb] = oceanDist[c] + 1; queue.push(nb); }
    }
  }

  // down[i]: neighbour with the smallest (strictly lower) oceanDist, skipping
  // forbidden tiles. Following down[] always reaches a sea tile.
  const down = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (isSea(i)) continue;
    let bestNb = -1, bestDist = oceanDist[i], bestH = Infinity;
    for (const nb of tiles[i].neighbours) {
      if (forbidden && forbidden.has(nb)) continue;
      const d = oceanDist[nb];
      if (!Number.isFinite(d) || d >= oceanDist[i]) continue;
      const h = heightOf(nb);
      if (d < bestDist || (d === bestDist && h < bestH)) { bestDist = d; bestH = h; bestNb = nb; }
    }
    down[i] = bestNb;
  }

  const reachesSea = (start: number): boolean => {
    let c = start, guard = 0;
    const seen = new Set<number>();
    while (guard++ < n) {
      const nx = tiles[c].riverTo;
      if (nx === undefined) return false;
      if (isSea(nx)) return true;
      if (seen.has(nx)) return false;        // cycle
      seen.add(nx);
      c = nx;
    }
    return false;
  };

  // Dry-run: does following down[] from `start` reach the sea without hitting a
  // dead end (a tile whose only descents are forbidden)?
  const downReachesSea = (start: number): boolean => {
    let c = start, guard = 0;
    while (guard++ < n) {
      if (isSea(c)) return true;
      const nb = down[c];
      if (nb < 0) return false;
      c = nb;
    }
    return false;
  };

  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (tiles[i].riverTo === undefined) continue;   // not a river tile
      if (reachesSea(i)) continue;
      changed = true;
      if (downReachesSea(i)) {
        // Commit a steepest-descent tail down to the sea.
        let c = i, guard = 0;
        while (guard++ < n) {
          if (isSea(c)) break;
          const nb = down[c];
          if (nb < 0) break;
          tiles[c].riverTo = nb;
          if (isSea(nb)) break;
          c = nb;
        }
      } else {
        // Blocked from the sea (e.g. a city walls off the only outlet) — end the
        // river here cleanly instead of leaving a dangling pointer.
        tiles[i].riverTo = undefined;
      }
    }
    if (!changed) break;
  }
}

/**
 * Carve rivers into `tiles`, mutating each river tile's `riverTo`.
 * Deterministic for a given seed.
 */
export function generateRivers(tiles: Tile[], seed: number): void {
  const rng = mulberry32(seed + 4242);
  const n = tiles.length;
  const targetCount = Math.max(3, Math.round(n * RIVER_DENSITY));

  const isOcean = (i: number) => tiles[i].terrainType === 'ocean';
  const heightOf = (i: number) => tiles[i].height ?? 0;

  // --- Distance to the nearest ocean tile (multi-source BFS) ---------------
  // oceanDist[i] = 0 for ocean, increasing inland. Rivers descend this gradient
  // so they always terminate at the coast.
  const oceanDist = new Array<number>(n).fill(Infinity);
  const queue: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) {
    if (isOcean(i)) { oceanDist[i] = 0; queue.push(i); }
  }
  while (head < queue.length) {
    const cur = queue[head++];
    const d = oceanDist[cur];
    for (const nb of tiles[cur].neighbours) {
      if (oceanDist[nb] === Infinity) { oceanDist[nb] = d + 1; queue.push(nb); }
    }
  }

  // --- Sources: mountain-height land tiles that can reach the sea ----------
  const sources: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!isOcean(i) && heightOf(i) >= SOURCE_HEIGHT && Number.isFinite(oceanDist[i])) {
      sources.push(i);
    }
  }
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }

  // --- Carve main channels --------------------------------------------------
  // Rivers are shaped as a sine wave with a little randomness. At each step the
  // heading is the seaward direction swung from side to side by sin(phase); the
  // river always advances toward the coast (it never steps away from the sea),
  // so the channel reads as a clean meandering wave that reliably reaches the
  // sea instead of tangling and cornering itself. Amplitude, wavelength and
  // phase are randomised per river, plus a small per-step jitter, so no two
  // rivers wave identically. The drainage-repair pass below is a safety net for
  // the rare tile that still corners.
  let made = 0;
  for (const src of sources) {
    if (made >= targetCount) break;
    if (tiles[src].riverTo !== undefined) continue;

    const visited = new Set<number>();
    let cur = src;
    let carved = false;
    let lastDir: Vec3 | undefined;
    // Randomise the wave per river (deterministic via the seeded rng).
    let phase = rng() * Math.PI * 2;
    const amp = MEANDER_AMP * (0.7 + 0.6 * rng());
    const freq = MEANDER_FREQ * (0.8 + 0.4 * rng());

    while (visited.size < MAX_RIVER_LEN) {
      visited.add(cur);

      // Local tangent frame: `up` is the surface normal, `seaDir` points down
      // the oceanDist gradient (toward the coast) within the tangent plane, and
      // `lateral` is perpendicular to it (the meander axis).
      const up = v.normalize(tiles[cur].position3d);
      let grad: Vec3 = { x: 0, y: 0, z: 0 };
      for (const nb of tiles[cur].neighbours) {
        const d = oceanDist[nb];
        if (!Number.isFinite(d)) continue;
        const w = oceanDist[cur] - d;          // +ve toward the sea
        grad = v.add(grad, v.scale(v.sub(tiles[nb].position3d, tiles[cur].position3d), w));
      }
      grad = v.sub(grad, v.scale(up, v.dot(grad, up)));   // project into tangent plane
      const seaDir = v.length(grad) > 1e-9 ? v.normalize(grad) : (lastDir ?? up);
      const lateral = v.normalize(v.cross(up, seaDir));

      // Sine-wave heading: seaward, swung sideways by sin(phase) with a touch of
      // randomness on the swing amount.
      const swing = Math.sin(phase) + (rng() - 0.5) * MEANDER_JITTER;
      const desired = v.normalize(v.add(seaDir, v.scale(lateral, amp * swing)));

      // Pick the unvisited neighbour that best matches the desired heading,
      // among those that still head toward the sea (progress >= 0) and don't
      // climb steeply. Argmax with a small jitter keeps the wave clean while
      // adding a little natural variation.
      let best = -1;
      let bestScore = -Infinity;
      for (const nb of tiles[cur].neighbours) {
        if (visited.has(nb)) continue;
        const d = oceanDist[nb];
        if (!Number.isFinite(d)) continue;
        if (oceanDist[cur] - d < -1) continue;                // at most one step away from the sea (wave crest)
        if (heightOf(nb) > heightOf(cur) + MEANDER_CLIMB_TOLERANCE) continue;
        const stepDir = v.normalize(v.sub(tiles[nb].position3d, tiles[cur].position3d));
        const score = v.dot(stepDir, desired) + (rng() - 0.5) * 0.15;
        if (score > bestScore) { bestScore = score; best = nb; }
      }

      if (best < 0) {
        // Cornered: fall back to the steepest seaward neighbour to keep moving.
        let bestD = oceanDist[cur];
        for (const nb of tiles[cur].neighbours) {
          if (visited.has(nb)) continue;
          const d = oceanDist[nb];
          if (Number.isFinite(d) && d < bestD) { bestD = d; best = nb; }
        }
      }
      if (best < 0) break;   // truly stuck — drainage-repair will rescue it

      tiles[cur].riverTo = best;
      carved = true;
      lastDir = v.normalize(v.sub(tiles[best].position3d, tiles[cur].position3d));
      phase += freq;

      if (isOcean(best)) break;
      if (tiles[best].riverTo !== undefined) break;
      cur = best;
    }

    if (carved) made++;
  }

  // --- Guarantee drainage to the sea ----------------------------------------
  // A meander can corner itself in a pocket (dead-ending inland) or, via a
  // merge, form a loop. ensureRiverDrainage re-routes any river tile that does
  // not reach the sea straight down the oceanDist gradient (acyclic, always
  // reaches the coast). Naturally sea-reaching meanders are left untouched.
  ensureRiverDrainage(tiles);

  // --- Channel width --------------------------------------------------------
  // Rivers are intentionally a single hex wide the whole way to the sea (no
  // estuary widening): each carries one thread of water that arcs to the coast.

  // --- Blend rivers into the terrain via elevation --------------------------
  // Requirement: a river hex's height is equal to the lowest neighbouring
  // elevation. We use the lowest non-river neighbour where possible so banks
  // define the channel floor; ocean is still a valid 0-height neighbour at the
  // mouth. This keeps rivers embedded in valleys instead of standing above them.
  const riverTiles: number[] = [];
  const riverSet = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (tiles[i].riverTo !== undefined) { riverTiles.push(i); riverSet.add(i); }
  }

  const originalHeight = tiles.map((t) => t.height ?? 0);
  for (const i of riverTiles) {
    let lowest = Infinity;
    for (const nb of tiles[i].neighbours) {
      if (!riverSet.has(nb) || isOcean(nb)) lowest = Math.min(lowest, originalHeight[nb]);
    }
    if (lowest === Infinity) {
      for (const nb of tiles[i].neighbours) lowest = Math.min(lowest, originalHeight[nb]);
    }
    tiles[i].height = Math.max(0, Math.min(originalHeight[i], lowest));
  }

  // Final consistency pass: each river tile is levelled to its lowest *bank*
  // (non-river) neighbour, ocean included at the mouth. Connected river
  // neighbours are deliberately excluded so the sea's 0-height does not
  // propagate up the channel and flatten the whole river — rivers descend with
  // the valley instead. This still prevents raised blue ridges, since a river
  // tile can never sit above the land around it.
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const i of riverTiles) {
      let lowest = Infinity;
      for (const nb of tiles[i].neighbours) {
        if (!riverSet.has(nb) || isOcean(nb)) lowest = Math.min(lowest, tiles[nb].height ?? 0);
      }
      if (lowest === Infinity) {
        for (const nb of tiles[i].neighbours) lowest = Math.min(lowest, tiles[nb].height ?? 0);
      }
      lowest = Math.max(0, lowest);
      if ((tiles[i].height ?? 0) !== lowest) {
        tiles[i].height = lowest;
        changed = true;
      }
    }
    if (!changed) break;
  }

}

// ===========================================================================
// SECTION 4 — City placement
// ===========================================================================

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
  // Generate evenly spread city target positions. The tile picker below scores
  // distance to the target plus habitability, so cities remain global but do not
  // land in ice, desert, rivers, mountains, or mountain foothill buffers.
  const candidatePositions = fibonacciSphere(CITY_COUNT);
  const pentagonExclusion = buildPentagonExclusionSet(tiles);
  const mountainExclusion = buildMountainExclusionSet(tiles, 2);
  const polarLimit = 0.74;

  const cityTileIndices: number[] = [];
  const usedTiles = new Set<number>();

  for (const targetPos of candidatePositions) {
    const tileIdx = findBestCityTile(
      tiles,
      targetPos,
      usedTiles,
      pentagonExclusion,
      mountainExclusion,
      polarLimit
    );
    if (tileIdx === -1) throw new Error('Cannot find valid tile for city placement');
    cityTileIndices.push(tileIdx);
    usedTiles.add(tileIdx);
  }

  const cities: City[] = cityTileIndices.map((tileIdx, i) => ({
    id: `city_${i}`,
    label: `C${String(i + 1).padStart(2, '0')}`,
    tileIndex: tileIdx,
    neighbourCityIds: [],
  }));

  const distances: number[][] = Array.from({ length: CITY_COUNT }, () =>
    Array<number>(CITY_COUNT).fill(0)
  );
  for (let i = 0; i < CITY_COUNT; i++) {
    for (let j = i + 1; j < CITY_COUNT; j++) {
      const dist = graphDistance(tiles, cityTileIndices[i], cityTileIndices[j]);
      distances[i][j] = dist;
      distances[j][i] = dist;
    }
  }

  for (let i = 0; i < CITY_COUNT; i++) {
    const others = [];
    for (let j = 0; j < CITY_COUNT; j++) if (i !== j) others.push({ idx: j, dist: distances[i][j] });
    others.sort((a, b) => a.dist - b.dist);

    let count = 0;
    for (const other of others) {
      if (count >= 3) break;
      if (!cities[i].neighbourCityIds.includes(cities[other.idx].id)) {
        cities[i].neighbourCityIds.push(cities[other.idx].id);
        if (!cities[other.idx].neighbourCityIds.includes(cities[i].id)) {
          cities[other.idx].neighbourCityIds.push(cities[i].id);
        }
        count++;
      }
    }
  }

  for (const city of cities) tiles[city.tileIndex].cityId = city.id;
  return cities;
}

/**
 * Fibonacci sphere: distribute N points evenly inside the habitable latitude
 * band. This avoids cities being "evenly" placed into the polar caps.
 */
function fibonacciSphere(n: number): Vec3[] {
  const points: Vec3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const CAP_THRESHOLD = 0.72;

  for (let i = 0; i < n; i++) {
    const y = CAP_THRESHOLD - (2 * CAP_THRESHOLD * (i + 0.5)) / n;
    const radius = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    points.push({ x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius });
  }

  return points;
}

/** Build a set of tile indices that are pentagons or adjacent to a pentagon */
function buildPentagonExclusionSet(tiles: Tile[]): Set<number> {
  const excluded = new Set<number>();
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].sides === 5) {
      excluded.add(i);
      for (const n of tiles[i].neighbours) excluded.add(n);
    }
  }
  return excluded;
}

/** Build a buffer around mountain-height tiles so cities do not spawn in ranges. */
function buildMountainExclusionSet(tiles: Tile[], radius: number): Set<number> {
  const excluded = new Set<number>();
  const queue: number[] = [];
  const dist = new Map<number, number>();

  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].elevationType === 'mountain') {
      excluded.add(i);
      queue.push(i);
      dist.set(i, 0);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(cur)!;
    if (d >= radius) continue;
    for (const nb of tiles[cur].neighbours) {
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      excluded.add(nb);
      queue.push(nb);
    }
  }

  return excluded;
}

function findBestCityTile(
  tiles: Tile[],
  target: Vec3,
  usedTiles: Set<number>,
  pentagonExclusion: Set<number>,
  mountainExclusion: Set<number>,
  polarLimit: number
): number {
  let bestIdx = -1;
  let bestScore = Infinity;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (usedTiles.has(i)) continue;
    if (pentagonExclusion.has(i)) continue;
    if (mountainExclusion.has(i)) continue;
    if (tile.terrainType === 'ocean') continue;
    if (tile.terrainType === 'tundra') continue;
    if (tile.terrainType === 'desert') continue;
    if (tile.riverTo !== undefined) continue;
    if (Math.abs(tile.position3d.y) > polarLimit) continue;

    // Keep cities from clustering without running an expensive BFS for every
    // candidate. Chord distance 0.24 is roughly 14 degrees on the sphere, which
    // is comfortably larger than the 18-hop minimum on the G100 globe.
    let tooClose = false;
    for (const used of usedTiles) {
      if (v.distance(tile.position3d, tiles[used].position3d) < 0.24) { tooClose = true; break; }
    }
    if (tooClose) continue;

    const targetDist = v.distance(tile.position3d, target);
    const coastBonus = tile.neighbours.some((nb) => tiles[nb].terrainType === 'ocean') ? -0.05 : 0;
    const biomePenalty = tile.terrainType === 'grassland' ? 0 : 0.08;
    const heightPenalty = Math.max(0, (tile.height ?? 0) - 3) * 0.015;
    const score = targetDist + biomePenalty + heightPenalty + coastBonus;

    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Backwards-compatible helper retained for any local tests that import it.
function findClosestValidTile(
  tiles: Tile[],
  target: Vec3,
  usedTiles: Set<number>,
  pentagonExclusion: Set<number>
): number {
  return findBestCityTile(tiles, target, usedTiles, pentagonExclusion, new Set<number>(), 0.74);
}

// ===========================================================================
// SECTION 5 — World generation entry point
// ===========================================================================

/**
 * Geodesic subdivision frequency. Tile count = 10·F² + 2.
 *   F = 36  → 12,962 tiles (the original "asteroid"-scale world)
 *   F = 100 → 100,002 tiles (~7.7× the surface, ~2.8× the diameter)
 *
 * Terrain feature sizes scale automatically with tile density (see SECTION 2),
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

  // Step 4.5: Rivers — carve downhill paths from mountain peaks to the sea.
  console.time('rivers');
  generateRivers(tiles, seed);
  const riverTileCount = tiles.filter((t) => t.riverTo !== undefined).length;
  console.log(`  River tiles: ${riverTileCount}`);
  console.timeEnd('rivers');

  // Rivers are water: the same terrain type as ocean, so they are impassable to
  // ground units (drones can still fly over). The `riverTo` marker is preserved
  // so the client renders them as river-blue and engineers can bridge them.
  // We KEEP the carved height (set in generateRivers) so the river blends into
  // the terrain as a valley — the globe extrudes river hexes by this height
  // rather than dropping them to sea level. ElevationType tracks that height.
  const heightBand = (h: number): Tile['elevationType'] =>
    h >= 9 ? 'mountain' : h >= 6 ? 'hills' : h >= 3 ? 'rolling' : 'flat';
  for (const t of tiles) {
    if (t.riverTo !== undefined) {
      t.terrainType = 'ocean';
      t.elevationType = heightBand(t.height ?? 0);
      t.forested = false;
    }
  }

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
    // A city's own hex is a settled, cleared site — never forested.
    tiles[city.tileIndex].forested = false;
    for (const ni of tiles[city.tileIndex].neighbours) {
      const t = tiles[ni];
      if (t.terrainType === 'ocean') {
        // Promote to plains at flat elevation
        t.terrainType  = 'plains';
        t.elevationType = 'flat';
        t.height        = 1;
        t.forested      = false;
        t.riverTo       = undefined; // no river running through a city's doorstep
      } else if (t.elevationType === 'mountain') {
        // Demote mountain → hills, keep terrain type (already 'plains' for mountains)
        t.elevationType = 'hills';
        t.height        = 7;
      }
    }
  }

  // City sanitisation can clear a river tile on a city's doorstep (rivers carry
  // terrain 'ocean', so the ocean→plains branch above also strips their
  // riverTo), orphaning the river upstream. Re-guarantee drainage, routing the
  // orphaned channels around the city (its hex + doorsteps are off-limits) to
  // the sea — or truncating cleanly where a city fully blocks the outlet. Then
  // reconcile terrain so every river tile reads as water and any truncated tile
  // reverts to land (no stray inland ocean).
  {
    const wasRiver = new Set<number>();
    for (let i = 0; i < tiles.length; i++) if (tiles[i].riverTo !== undefined) wasRiver.add(i);

    const forbidden = new Set<number>();
    for (const city of cities) {
      forbidden.add(city.tileIndex);
      for (const ni of tiles[city.tileIndex].neighbours) forbidden.add(ni);
    }
    ensureRiverDrainage(tiles, forbidden);

    const band = (h: number): Tile['elevationType'] =>
      h >= 9 ? 'mountain' : h >= 6 ? 'hills' : h >= 3 ? 'rolling' : 'flat';
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.riverTo !== undefined) {
        // Active river tile — water, same as ocean for movement.
        t.terrainType = 'ocean';
        t.elevationType = band(t.height ?? 0);
        t.forested = false;
      } else if (wasRiver.has(i)) {
        // Truncated channel — return it to passable land.
        t.terrainType = 'plains';
        t.elevationType = band(t.height ?? 0);
        t.forested = false;
      }
    }
  }

  // City sanitisation can alter neighbouring elevations after rivers have been
  // carved. Re-apply the river rule as the last terrain mutation: every river
  // tile has exactly the same height as its lowest neighbour.
  {
    const riverTiles = tiles
      .map((t, i) => (t.riverTo !== undefined ? i : -1))
      .filter((i) => i >= 0);
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const i of riverTiles) {
        let lowest = Infinity;
        for (const nb of tiles[i].neighbours) lowest = Math.min(lowest, tiles[nb].height ?? 0);
        lowest = Math.max(0, lowest);
        if ((tiles[i].height ?? 0) !== lowest) {
          tiles[i].height = lowest;
          changed = true;
        }
      }
      if (!changed) break;
    }
    const heightBandFinal = (h: number): Tile['elevationType'] =>
      h >= 9 ? 'mountain' : h >= 6 ? 'hills' : h >= 3 ? 'rolling' : 'flat';
    for (const i of riverTiles) tiles[i].elevationType = heightBandFinal(tiles[i].height ?? 0);
  }

  console.timeEnd('total');

  return {
    tiles,
    cities,
    units: [],
    buildings: [],
    seed,
    pentagonIndices,
  };
}
