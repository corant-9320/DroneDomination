/**
 * Terrain generation using simplex-like noise on the sphere.
 * Uses a seeded PRNG for deterministic generation.
 */

import { Vec3, TerrainType, Tile } from './types.js';
import { dot } from './vec3.js';

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

  // Simple value noise with trilinear interpolation
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

  const n000 = grad(hash(ix, iy, iz), tx, ty, tz);
  const n100 = grad(hash(ix + 1, iy, iz), tx - 1, ty, tz);
  const n010 = grad(hash(ix, iy + 1, iz), tx, ty - 1, tz);
  const n110 = grad(hash(ix + 1, iy + 1, iz), tx - 1, ty - 1, tz);
  const n001 = grad(hash(ix, iy, iz + 1), tx, ty, tz - 1);
  const n101 = grad(hash(ix + 1, iy, iz + 1), tx - 1, ty, tz - 1);
  const n011 = grad(hash(ix, iy + 1, iz + 1), tx, ty - 1, tz - 1);
  const n111 = grad(hash(ix + 1, iy + 1, iz + 1), tx - 1, ty - 1, tz - 1);

  const nx00 = n000 + sx * (n100 - n000);
  const nx10 = n010 + sx * (n110 - n010);
  const nx01 = n001 + sx * (n101 - n001);
  const nx11 = n011 + sx * (n111 - n011);

  const nxy0 = nx00 + sy * (nx10 - nx00);
  const nxy1 = nx01 + sy * (nx11 - nx01);

  return nxy0 + sz * (nxy1 - nxy0);
}

/** Generate terrain for all tiles */
export function generateTerrain(
  positions: Vec3[],
  seed: number
): { terrainType: TerrainType; elevation: number }[] {
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

  return positions.map((pos) => {
    // Multi-octave noise for elevation
    let elevation = 0;
    elevation += gradientNoise3D(pos, 3, gradients, permutation) * 0.5;
    elevation += gradientNoise3D(pos, 6, gradients, permutation) * 0.25;
    elevation += gradientNoise3D(pos, 12, gradients, permutation) * 0.125;
    elevation += gradientNoise3D(pos, 24, gradients, permutation) * 0.0625;

    // Normalize to [0, 1]
    elevation = (elevation + 1) / 2;
    elevation = Math.max(0, Math.min(1, elevation));

    // Latitude factor (poles are colder)
    const latitude = Math.abs(pos.y); // 0 at equator, 1 at poles

    const terrainType = classifyTerrain(elevation, latitude);

    return { terrainType, elevation };
  });
}

function classifyTerrain(elevation: number, latitude: number): TerrainType {
  // --- Polar band overrides (latitude = |pos.y|, 1 = pole) ---
  // With G(24,0) each ring ≈ 3.75° of colatitude.
  // 2 rings from pole → colatitude ~7.5° → y > 0.99
  // Next 1 ring → colatitude ~11° → y > 0.98

  // Tundra: only the 2 tiles closest to the pole
  if (latitude > 0.99) return 'tundra';

  // Polar ocean buffer: 1 tile-width separating tundra from habitable land
  if (latitude > 0.98) return 'ocean';

  // Green band beyond the ocean: force productive terrain so polar cities
  // are not disadvantaged. Use elevation to vary between forest/grassland.
  if (latitude > 0.90) {
    if (elevation > 0.65) return 'forest';
    return 'grassland';
  }

  // --- Normal terrain classification below latitude 0.90 ---

  // Ocean
  if (elevation < 0.35) return 'ocean';

  // Mountains at high elevation
  if (elevation > 0.8) return 'mountain';

  // Hills
  if (elevation > 0.65) return 'hills';

  // Desert at low latitude, mid elevation
  if (latitude < 0.25 && elevation > 0.4 && elevation < 0.55) return 'desert';

  // Forest at mid latitudes
  if (latitude > 0.3 && latitude < 0.65 && elevation > 0.45) return 'forest';

  // Grassland
  if (elevation > 0.45) return 'grassland';

  // Plains (default land)
  return 'plains';
}
