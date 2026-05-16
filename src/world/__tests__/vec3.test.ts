import { describe, it, expect } from 'vitest';
import * as v from '../vec3.js';
import type { Vec3 } from '../types.js';

describe('vec3', () => {
  const a: Vec3 = { x: 1, y: 2, z: 3 };
  const b: Vec3 = { x: 4, y: 5, z: 6 };
  const zero: Vec3 = { x: 0, y: 0, z: 0 };

  describe('add', () => {
    it('adds two vectors component-wise', () => {
      expect(v.add(a, b)).toEqual({ x: 5, y: 7, z: 9 });
    });

    it('identity with zero vector', () => {
      expect(v.add(a, zero)).toEqual(a);
    });
  });

  describe('sub', () => {
    it('subtracts two vectors component-wise', () => {
      expect(v.sub(b, a)).toEqual({ x: 3, y: 3, z: 3 });
    });

    it('subtracting self yields zero', () => {
      expect(v.sub(a, a)).toEqual(zero);
    });
  });

  describe('scale', () => {
    it('scales by a positive factor', () => {
      expect(v.scale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    });

    it('scales by zero', () => {
      expect(v.scale(a, 0)).toEqual(zero);
    });

    it('scales by negative factor', () => {
      expect(v.scale(a, -1)).toEqual({ x: -1, y: -2, z: -3 });
    });
  });

  describe('dot', () => {
    it('computes dot product', () => {
      // 1*4 + 2*5 + 3*6 = 32
      expect(v.dot(a, b)).toBe(32);
    });

    it('dot with self gives squared length', () => {
      expect(v.dot(a, a)).toBe(14); // 1+4+9
    });

    it('dot of perpendicular vectors is zero', () => {
      const x: Vec3 = { x: 1, y: 0, z: 0 };
      const y: Vec3 = { x: 0, y: 1, z: 0 };
      expect(v.dot(x, y)).toBe(0);
    });
  });

  describe('cross', () => {
    it('cross of parallel vectors is zero', () => {
      const r = v.cross(a, v.scale(a, 3));
      expect(r.x).toBeCloseTo(0);
      expect(r.y).toBeCloseTo(0);
      expect(r.z).toBeCloseTo(0);
    });

    it('x cross y = z', () => {
      const x: Vec3 = { x: 1, y: 0, z: 0 };
      const y: Vec3 = { x: 0, y: 1, z: 0 };
      expect(v.cross(x, y)).toEqual({ x: 0, y: 0, z: 1 });
    });

    it('is anti-commutative', () => {
      const ab = v.cross(a, b);
      const ba = v.cross(b, a);
      expect(ab.x).toBeCloseTo(-ba.x);
      expect(ab.y).toBeCloseTo(-ba.y);
      expect(ab.z).toBeCloseTo(-ba.z);
    });
  });

  describe('length', () => {
    it('computes euclidean length', () => {
      expect(v.length({ x: 3, y: 4, z: 0 })).toBeCloseTo(5);
    });

    it('zero vector has zero length', () => {
      expect(v.length(zero)).toBe(0);
    });

    it('unit vectors have length 1', () => {
      expect(v.length({ x: 1, y: 0, z: 0 })).toBe(1);
    });
  });

  describe('normalize', () => {
    it('produces a unit-length vector', () => {
      const n = v.normalize(a);
      expect(v.length(n)).toBeCloseTo(1);
    });

    it('preserves direction', () => {
      const n = v.normalize({ x: 3, y: 0, z: 0 });
      expect(n).toEqual({ x: 1, y: 0, z: 0 });
    });

    it('returns zero for zero vector', () => {
      expect(v.normalize(zero)).toEqual(zero);
    });
  });

  describe('lerp', () => {
    it('t=0 returns first vector', () => {
      expect(v.lerp(a, b, 0)).toEqual(a);
    });

    it('t=1 returns second vector', () => {
      expect(v.lerp(a, b, 1)).toEqual(b);
    });

    it('t=0.5 returns midpoint', () => {
      const mid = v.lerp(a, b, 0.5);
      expect(mid.x).toBeCloseTo(2.5);
      expect(mid.y).toBeCloseTo(3.5);
      expect(mid.z).toBeCloseTo(4.5);
    });
  });

  describe('midpoint', () => {
    it('returns a normalized point between two vectors', () => {
      const m = v.midpoint(a, b);
      expect(v.length(m)).toBeCloseTo(1);
    });
  });

  describe('distance', () => {
    it('distance from self is zero', () => {
      expect(v.distance(a, a)).toBe(0);
    });

    it('computes correct euclidean distance', () => {
      const p: Vec3 = { x: 1, y: 0, z: 0 };
      const q: Vec3 = { x: 4, y: 0, z: 0 };
      expect(v.distance(p, q)).toBeCloseTo(3);
    });
  });

  describe('equals', () => {
    it('identical vectors are equal', () => {
      expect(v.equals(a, { ...a })).toBe(true);
    });

    it('different vectors are not equal', () => {
      expect(v.equals(a, b)).toBe(false);
    });

    it('respects epsilon for floating point', () => {
      const near: Vec3 = { x: 1 + 1e-11, y: 2, z: 3 };
      expect(v.equals(a, near)).toBe(true);
    });

    it('values beyond epsilon are not equal', () => {
      const far: Vec3 = { x: 1 + 1e-9, y: 2, z: 3 };
      expect(v.equals(a, far)).toBe(false);
    });
  });
});
