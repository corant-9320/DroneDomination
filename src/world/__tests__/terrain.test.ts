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
    const positions: Vec3[] = [
      { x: 0, y: 1, z: 0 },    // pole (high latitude)
      { x: 1, y: 0, z: 0 },    // equator
      { x: 0, y: -1, z: 0 },   // south pole
      { x: 0.577, y: 0.577, z: 0.577 }, // mid latitude
    ];

    it('returns one result per position', () => {
      const result = generateTerrain(positions, 42);
      expect(result).toHaveLength(positions.length);
    });

    it('each result has a valid terrainType', () => {
      const validTypes: TerrainType[] = [
        'plains', 'forest', 'mountain', 'desert',
        'ocean', 'tundra', 'grassland', 'hills',
      ];
      const result = generateTerrain(positions, 42);
      for (const r of result) {
        expect(validTypes).toContain(r.terrainType);
      }
    });

    it('elevation is in [0, 1]', () => {
      const result = generateTerrain(positions, 42);
      for (const r of result) {
        expect(r.elevation).toBeGreaterThanOrEqual(0);
        expect(r.elevation).toBeLessThanOrEqual(1);
      }
    });

    it('is deterministic for same seed', () => {
      const r1 = generateTerrain(positions, 100);
      const r2 = generateTerrain(positions, 100);
      expect(r1).toEqual(r2);
    });

    it('produces different results for different seeds', () => {
      const r1 = generateTerrain(positions, 1);
      const r2 = generateTerrain(positions, 2);
      // At least one position should differ
      const same = r1.every(
        (v, i) => v.terrainType === r2[i].terrainType && v.elevation === r2[i].elevation
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
      const result = generateTerrain(manyPositions, 42);
      const types = new Set(result.map((r) => r.terrainType));
      expect(types.size).toBeGreaterThan(1);
    });
  });
});
