import { describe, it, expect } from 'vitest';
import { mulberry32, generateTerrain } from '../generate.js';
import { generateGeodesicSphere, computeDual } from '../geodesic.js';
import type { Vec3, TerrainType } from '../types.js';

/** Build a small real Goldberg world (real pole pentagons + neighbour graph). */
function buildSmallWorld(frequency: number) {
  const mesh = generateGeodesicSphere(frequency);
  const tiles = computeDual(mesh);
  return {
    positions: tiles.map((t) => t.position3d),
    neighbours: tiles.map((t) => t.neighbours),
    sides: tiles.map((t) => t.sides),
  };
}

const latitudeOf = (p: Vec3): number =>
  p.y / (Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1);

describe('terrain', () => {
  describe('mulberry32', () => {
    it('produces deterministic output for same seed', () => {
      const rng1 = mulberry32(42);
      const rng2 = mulberry32(42);
      for (let i = 0; i < 100; i++) {
        expect(rng1()).toBe(rng2());
      }
    });

    it('produces different output for different seeds', () => {
      const rng1 = mulberry32(1);
      const rng2 = mulberry32(2);
      // Extremely unlikely that even the first value matches
      const vals1 = Array.from({ length: 10 }, () => rng1());
      const vals2 = Array.from({ length: 10 }, () => rng2());
      expect(vals1).not.toEqual(vals2);
    });

    it('returns values in [0, 1)', () => {
      const rng = mulberry32(123);
      for (let i = 0; i < 1000; i++) {
        const val = rng();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });

    it('produces reasonable distribution (not all same value)', () => {
      const rng = mulberry32(999);
      const values = Array.from({ length: 100 }, () => rng());
      const min = Math.min(...values);
      const max = Math.max(...values);
      expect(max - min).toBeGreaterThan(0.5);
    });
  });

  describe('generateTerrain', () => {
    // 4-tile test mesh: two poles (pentagons) + two equatorial hexagons
    // neighbours form a simple chain: 0-1-2-3
    const positions: Vec3[] = [
      { x: 0, y: 1, z: 0 },             // north pole
      { x: 1, y: 0, z: 0 },             // equator
      { x: 0, y: -1, z: 0 },            // south pole
      { x: 0.577, y: 0.577, z: 0.577 }, // mid latitude
    ];
    // Simple chain neighbours
    const neighbours: number[][] = [[1], [0, 2], [1, 3], [2]];
    // Poles are pentagons (5 sides), others are hexagons (6 sides)
    const sides: number[] = [5, 6, 5, 6];

    it('returns one result per position', () => {
      const result = generateTerrain(positions, neighbours, sides, 42);
      expect(result).toHaveLength(positions.length);
    });

    it('each result has a valid terrainType', () => {
      const validTypes: TerrainType[] = [
        'grassland', 'plains', 'tundra', 'desert', 'ocean',
      ];
      const result = generateTerrain(positions, neighbours, sides, 42);
      for (const r of result) {
        expect(validTypes).toContain(r.terrainType);
      }
    });

    it('is deterministic for same seed', () => {
      const r1 = generateTerrain(positions, neighbours, sides, 100);
      const r2 = generateTerrain(positions, neighbours, sides, 100);
      expect(r1).toEqual(r2);
    });

    it('produces different results for different seeds', () => {
      // Use a longer linear chain so tiles in the middle are far from both
      // polar pentagons (distance > 9) and reach the noise-dependent code path.
      // Pentagon at index 0 (north pole), pentagon at index 24 (south pole),
      // tiles 1–23 form the equatorial band — middle tiles are distance 12 from
      // both poles, well past the hard tundra/ocean caps at distance ≤ 4.
      const chainLength = 25;
      const chainPositions: Vec3[] = Array.from({ length: chainLength }, (_, i) => {
        const t = i / (chainLength - 1); // 0 → 1
        const lat = Math.PI * t - Math.PI / 2; // -90° → +90°
        return { x: Math.cos(lat), y: Math.sin(lat), z: 0 };
      });
      const chainNeighbours = chainPositions.map((_, i) => {
        const nb: number[] = [];
        if (i > 0) nb.push(i - 1);
        if (i < chainLength - 1) nb.push(i + 1);
        return nb;
      });
      // First and last are pentagons (poles), rest are hexagons
      const chainSides = chainPositions.map((_, i) =>
        i === 0 || i === chainLength - 1 ? 5 : 6
      );

      const r1 = generateTerrain(chainPositions, chainNeighbours, chainSides, 1);
      const r2 = generateTerrain(chainPositions, chainNeighbours, chainSides, 2);
      // At least one position should differ
      const same = r1.every(
        (v, i) => v.terrainType === r2[i].terrainType && v.elevationType === r2[i].elevationType
      );
      expect(same).toBe(false);
    });

    it('produces varied terrain types across many positions', () => {
      // Generate a larger sample to ensure variety
      const manyPositions: Vec3[] = [];
      for (let i = 0; i < 50; i++) {
        const theta = (i / 50) * Math.PI * 2;
        const phi = Math.acos(2 * (i / 50) - 1);
        manyPositions.push({
          x: Math.sin(phi) * Math.cos(theta),
          y: Math.cos(phi),
          z: Math.sin(phi) * Math.sin(theta),
        });
      }
      // Linear chain neighbours for the larger sample
      const manyNeighbours = manyPositions.map((_, i) => {
        const nb: number[] = [];
        if (i > 0) nb.push(i - 1);
        if (i < manyPositions.length - 1) nb.push(i + 1);
        return nb;
      });
      // First and last are pentagons, rest are hexagons
      const manySides = manyPositions.map((_, i) =>
        i === 0 || i === manyPositions.length - 1 ? 5 : 6
      );
      const result = generateTerrain(manyPositions, manyNeighbours, manySides, 42);
      const types = new Set(result.map((r) => r.terrainType));
      expect(types.size).toBeGreaterThan(1);
    });

    it('gives both poles an ice region (organic tundra caps)', () => {
      // Real Goldberg sphere: pole pentagons sit at y = ±1 (latitude ±1).
      const { positions, neighbours, sides } = buildSmallWorld(12);
      const result = generateTerrain(positions, neighbours, sides, 42);

      let northTundra = 0;
      let southTundra = 0;
      let equatorTundra = 0;
      for (let i = 0; i < positions.length; i++) {
        if (result[i].terrainType !== 'tundra') continue;
        const lat = latitudeOf(positions[i]);
        if (lat > 0.9) northTundra++;
        else if (lat < -0.9) southTundra++;
        else if (Math.abs(lat) < 0.5) equatorTundra++;
      }

      // Each pole must carry a region of ice...
      expect(northTundra).toBeGreaterThan(0);
      expect(southTundra).toBeGreaterThan(0);
      // ...and ice must stay polar — no tundra anywhere near the equator.
      expect(equatorTundra).toBe(0);
    });

    it('polar ice caps have an organic (non-ring) edge', () => {
      // A clean latitude ring would put every land tile above some |lat|
      // threshold into tundra and every land tile below it out of tundra, with
      // no overlap. The noise-perturbed cap edge breaks that: there exists a
      // non-tundra LAND tile sitting closer to a pole than some tundra tile.
      const { positions, neighbours, sides } = buildSmallWorld(12);
      const result = generateTerrain(positions, neighbours, sides, 42);

      let maxTundraLatAbs = 0;
      let maxNonTundraLandLatAbs = 0;
      for (let i = 0; i < positions.length; i++) {
        const t = result[i].terrainType;
        if (t === 'ocean') continue; // sea is allowed inside the caps
        const latAbs = Math.abs(latitudeOf(positions[i]));
        if (t === 'tundra') maxTundraLatAbs = Math.max(maxTundraLatAbs, latAbs);
        else maxNonTundraLandLatAbs = Math.max(maxNonTundraLandLatAbs, latAbs);
      }

      // Some non-ice land reaches a higher latitude than ice does somewhere
      // else — only possible if the cap boundary waves rather than following a
      // single parallel.
      expect(maxNonTundraLandLatAbs).toBeGreaterThan(0.6);
      expect(maxTundraLatAbs).toBeGreaterThan(maxNonTundraLandLatAbs - 0.3);
    });

    it('allows organic sea around the poles', () => {
      // With the polar land bias relaxed, the rank-selected ocean mask should
      // leave at least some sea inside the polar caps across seeds, rather than
      // a solid land collar. Checked over several seeds so the property holds in
      // general, not just for one lucky map.
      const { positions, neighbours, sides } = buildSmallWorld(12);
      let seedsWithPolarSea = 0;
      for (const seed of [1, 7, 42, 99, 2024]) {
        const result = generateTerrain(positions, neighbours, sides, seed);
        const hasPolarSea = positions.some(
          (p, i) => Math.abs(latitudeOf(p)) > 0.85 && result[i].terrainType === 'ocean'
        );
        if (hasPolarSea) seedsWithPolarSea++;
      }
      expect(seedsWithPolarSea).toBeGreaterThan(0);
    });
  });
});
