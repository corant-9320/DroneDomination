import { describe, it, expect } from 'vitest';
import { mulberry32, generateTerrain } from '../terrain.js';
import type { Vec3, TerrainType } from '../types.js';

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

    it('polar pentagon and its two hex rings are tundra', () => {
      // Build a small radial mesh: pentagon at index 0, ring-1 at 1-5, ring-2 at 6-15
      // (mimics the actual Goldberg pole structure)
      const polePositions: Vec3[] = [
        { x: 0, y: 1, z: 0 }, // 0: north pole pentagon
      ];
      // Ring 1: 5 tiles
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        polePositions.push({ x: Math.cos(a) * 0.1, y: 0.995, z: Math.sin(a) * 0.1 });
      }
      // Ring 2: 10 tiles
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        polePositions.push({ x: Math.cos(a) * 0.2, y: 0.98, z: Math.sin(a) * 0.2 });
      }
      // Ring 3 (should NOT be tundra by hard cap): 15 tiles
      for (let i = 0; i < 15; i++) {
        const a = (i / 15) * Math.PI * 2;
        polePositions.push({ x: Math.cos(a) * 0.4, y: 0.92, z: Math.sin(a) * 0.4 });
      }

      const poleNeighbours: number[][] = polePositions.map(() => []);
      // Pentagon (0) connects to ring-1 (1-5)
      for (let i = 1; i <= 5; i++) {
        poleNeighbours[0].push(i);
        poleNeighbours[i].push(0);
      }
      // Ring-1 connects to ring-2
      for (let i = 1; i <= 5; i++) {
        const r2a = 6 + (i - 1) * 2;
        const r2b = 6 + ((i - 1) * 2 + 1) % 10;
        poleNeighbours[i].push(r2a, r2b);
        poleNeighbours[r2a].push(i);
        poleNeighbours[r2b].push(i);
      }
      // Ring-2 connects to ring-3
      for (let i = 6; i <= 15; i++) {
        const r3 = 16 + (i - 6);
        poleNeighbours[i].push(r3);
        poleNeighbours[r3].push(i);
      }

      const poleSides = polePositions.map((_, i) => (i === 0 ? 5 : 6));
      const result = generateTerrain(polePositions, poleNeighbours, poleSides, 42);

      // Pentagon (dist 0) must be tundra
      expect(result[0].terrainType).toBe('tundra');
      // Ring 1 (dist 1) must be tundra
      for (let i = 1; i <= 5; i++) {
        expect(result[i].terrainType).toBe('tundra');
      }
      // Ring 2 (dist 2) must be tundra
      for (let i = 6; i <= 15; i++) {
        expect(result[i].terrainType).toBe('tundra');
      }
    });

    it('rings 3 and 4 around the polar pentagon are ocean', () => {
      // Build a fully-connected 6-ring radial mesh around a polar pentagon.
      // Every tile in each ring is connected to its ring neighbours AND to
      // at least one tile in the adjacent rings, so BFS distances are exact.
      //
      // Ring sizes chosen to match the Goldberg pole structure:
      //   ring 0: 1  (pentagon)
      //   ring 1: 5
      //   ring 2: 10
      //   ring 3: 15  ← must be ocean (dist 3 buffer)
      //   ring 4: 20  ← must be ocean (dist 4 buffer)
      //   ring 5: 60  (outer land — large enough to dilute the bottom-30% pool)
      const ringSizes = [1, 5, 10, 15, 20, 60];
      const ringStart = ringSizes.reduce<number[]>((acc, s, i) => {
        acc.push(i === 0 ? 0 : acc[i - 1] + ringSizes[i - 1]);
        return acc;
      }, []);
      const total = ringSizes.reduce((a, b) => a + b, 0);

      const pp: Vec3[] = [];
      for (let r = 0; r < ringSizes.length; r++) {
        const size = ringSizes[r];
        for (let i = 0; i < size; i++) {
          const a = (i / Math.max(size, 1)) * Math.PI * 2;
          const y = 1 - r * 0.05;
          const xz = Math.sqrt(Math.max(0, 1 - y * y));
          pp.push({ x: Math.cos(a) * xz, y, z: Math.sin(a) * xz });
        }
      }

      const nb: number[][] = Array.from({ length: total }, () => []);

      function connect(a: number, b: number) {
        if (!nb[a].includes(b)) { nb[a].push(b); nb[b].push(a); }
      }

      // Intra-ring connections (ring around each ring)
      for (let r = 0; r < ringSizes.length; r++) {
        const size = ringSizes[r];
        if (size < 2) continue;
        for (let i = 0; i < size; i++) {
          connect(ringStart[r] + i, ringStart[r] + (i + 1) % size);
        }
      }

      // Inter-ring connections (each tile connects to its nearest in the next ring)
      for (let r = 0; r < ringSizes.length - 1; r++) {
        const aSize = ringSizes[r], bSize = ringSizes[r + 1];
        for (let ai = 0; ai < aSize; ai++) {
          const bi = Math.floor(ai * bSize / aSize);
          connect(ringStart[r] + ai, ringStart[r + 1] + bi);
        }
        // Also connect in the other direction to ensure full coverage
        for (let bi = 0; bi < bSize; bi++) {
          const ai = Math.floor(bi * aSize / bSize);
          connect(ringStart[r] + ai, ringStart[r + 1] + bi);
        }
      }

      const s = pp.map((_, i) => (i === 0 ? 5 : 6));
      const result = generateTerrain(pp, nb, s, 42);

      // Rings 3 and 4 must be ocean (pole-distance buffer, immune to isOcean flag)
      for (let i = ringStart[3]; i < ringStart[3] + ringSizes[3]; i++) {
        expect(result[i].terrainType).toBe('ocean');
      }
      for (let i = ringStart[4]; i < ringStart[4] + ringSizes[4]; i++) {
        expect(result[i].terrainType).toBe('ocean');
      }
    });
  });
});
