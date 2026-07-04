import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  getBearingBetweenTiles,
  calculateOrientationBonus,
  calculateOrientationArmourPenalty,
  MAX_ORIENTATION_ARMOUR_PENALTY,
  classifyArcFromAngle,
} from '../combatFacing.js';
import type { Tile, Vec3 } from '../types.js';

/**
 * Feature: unit-test-coverage — behavioural coverage for combatFacing.ts.
 *
 * Exercises the REAL bearing/orientation geometry (no mocks) on synthetic tile
 * grids with hand-placed 3D positions and explicit neighbour rings.
 *
 * Constants/thresholds derived from COMBAT_RULES.md §4 (Orientation & Facing):
 *   - orientation bonus range: 0.0 (head-on) .. 2.0 (perfect rear)
 *   - arc classification: 0–60° front, 60–120° side, 120–180° rear
 */

// --- Constants from COMBAT_RULES.md §4 ---------------------------------------
const MAX_ORIENTATION_BONUS = 2; // §4: 180° → 2.0
const FRONT_MAX_DEG = 60; // §4: 0–60° front
const SIDE_MAX_DEG = 120; // §4: 60–120° side, 120–180° rear

// --- Minimal Vec3 helpers (test-local) ---------------------------------------
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(dot(v, v));
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// --- Tangent-plane frame (mirrors combatFacing tangentProject basis) ---------
// Building the same east/north frame the source uses lets us place a tile at a
// chosen bearing from the defender, so bearings are deterministic.
function buildFrame(origin: Vec3): { east: Vec3; north: Vec3 } {
  let up: Vec3 = { x: 0, y: 1, z: 0 };
  if (Math.abs(dot(origin, up)) > 0.99) up = { x: 1, y: 0, z: 0 };
  const east = normalize(cross(up, origin));
  const north = cross(origin, east);
  return { east, north };
}

// A defender position well away from the poles (avoids the basis fallback).
const DEFENDER_POS: Vec3 = normalize({ x: 0.6, y: 0.2, z: 0.7 });
const FRAME = buildFrame(DEFENDER_POS);

/** Position on the sphere whose bearing from the defender is `bearing` rad. */
function posAtBearing(bearing: number): Vec3 {
  const tangent = add(
    scale(FRAME.east, Math.sin(bearing)),
    scale(FRAME.north, Math.cos(bearing)),
  );
  return normalize(add(DEFENDER_POS, scale(tangent, 0.02)));
}

function makeTile(index: number, position3d: Vec3, neighbours: number[] = []): Tile {
  return {
    id: `t${index}`,
    index,
    sides: 6,
    neighbours,
    position3d,
    boundary: [],
    terrainType: 'plains',
    height: 4,
    forested: false,
  } as Tile;
}

/**
 * Build a 3-tile grid: defender(0), attacker(1) at `approach` bearing, and the
 * defender's facing-neighbour(2) at `facing` bearing. Defender faces index 0 of
 * its neighbours (tile 2).
 */
function makeGrid(approachBearing: number, facingBearing: number): Tile[] {
  const defender = makeTile(0, DEFENDER_POS, [2]);
  const attacker = makeTile(1, posAtBearing(approachBearing));
  const facingNeighbour = makeTile(2, posAtBearing(facingBearing));
  return [defender, attacker, facingNeighbour];
}

const TWO_PI = 2 * Math.PI;

describe('combatFacing — bearing geometry', () => {
  it('places tiles at the requested bearing (frame sanity check)', () => {
    // Bearing is returned in [0, 2π); compare modulo 2π so a value that wraps
    // (e.g. ~2π for a requested 0) still matches.
    const target = 1.3;
    const tiles = makeGrid(target, 0);
    const b = getBearingBetweenTiles(tiles, 0, 1);
    const wrappedDiff = Math.min(
      Math.abs(b - target),
      TWO_PI - Math.abs(b - target),
    );
    expect(wrappedDiff).toBeLessThan(1e-6);
  });

  describe('Feature: unit-test-coverage, Property 10: Orientation bonus is bounded [0,2], head-on→0, rear→2, non-decreasing with angular difference', () => {
    it('bonus stays within [0, 2] for any approach/facing pair', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: TWO_PI, noNaN: true }),
          fc.double({ min: 0, max: TWO_PI, noNaN: true }),
          (approach, facing) => {
            const tiles = makeGrid(approach, facing);
            const bonus = calculateOrientationBonus(tiles, 1, 0, 0);
            return bonus >= 0 && bonus <= MAX_ORIENTATION_BONUS;
          },
        ),
        { numRuns: 200 },
      );
    });

    it('bonus is non-decreasing as angular difference increases', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: TWO_PI, noNaN: true }), // base facing bearing
          fc.double({ min: 0, max: Math.PI, noNaN: true }), // angular diff d1
          fc.double({ min: 0, max: Math.PI, noNaN: true }), // angular diff d2
          (facing, dA, dB) => {
            const dLow = Math.min(dA, dB);
            const dHigh = Math.max(dA, dB);
            const bonusLow = calculateOrientationBonus(
              makeGrid((facing + dLow) % TWO_PI, facing),
              1,
              0,
              0,
            );
            const bonusHigh = calculateOrientationBonus(
              makeGrid((facing + dHigh) % TWO_PI, facing),
              1,
              0,
              0,
            );
            // Rounding to 1 dp is monotonic; tolerance absorbs reconstruction noise.
            return bonusHigh >= bonusLow - 1e-9;
          },
        ),
        { numRuns: 200 },
      );
    });

    it('head-on approach (0° difference) yields bonus 0', () => {
      const tiles = makeGrid(1.234, 1.234); // approach == facing
      expect(calculateOrientationBonus(tiles, 1, 0, 0)).toBe(0);
    });

    it('perfect rear approach (180° difference) yields bonus 2', () => {
      const facing = 0.9;
      const tiles = makeGrid((facing + Math.PI) % TWO_PI, facing);
      expect(calculateOrientationBonus(tiles, 1, 0, 0)).toBe(MAX_ORIENTATION_BONUS);
    });

    it('perpendicular approach (90° difference) yields bonus ~1', () => {
      const facing = 2.0;
      const tiles = makeGrid((facing + Math.PI / 2) % TWO_PI, facing);
      expect(calculateOrientationBonus(tiles, 1, 0, 0)).toBeCloseTo(1, 5);
    });
  });

  describe('calculateOrientationArmourPenalty (0–3, front→rear)', () => {
    it('head-on approach (0°) yields penalty 0', () => {
      const tiles = makeGrid(1.234, 1.234);
      expect(calculateOrientationArmourPenalty(tiles, 1, 0, 0)).toBe(0);
    });

    it('perfect rear approach (180°) yields penalty 3', () => {
      const facing = 0.9;
      const tiles = makeGrid((facing + Math.PI) % TWO_PI, facing);
      expect(calculateOrientationArmourPenalty(tiles, 1, 0, 0)).toBe(MAX_ORIENTATION_ARMOUR_PENALTY);
    });

    it('perpendicular approach (90°) yields penalty ~1.5', () => {
      const facing = 2.0;
      const tiles = makeGrid((facing + Math.PI / 2) % TWO_PI, facing);
      expect(calculateOrientationArmourPenalty(tiles, 1, 0, 0)).toBeCloseTo(1.5, 5);
    });

    it('stays within [0, 3] and never negative', () => {
      const facing = 1.1;
      for (const approach of [0, 0.5, 1.1, 2.0, 3.0, 4.5, 6.0]) {
        const tiles = makeGrid(approach % TWO_PI, facing);
        const p = calculateOrientationArmourPenalty(tiles, 1, 0, 0);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(MAX_ORIENTATION_ARMOUR_PENALTY);
      }
    });
  });

  describe('Feature: unit-test-coverage, Property 11: classifyArcFromAngle returns front 0–60°, side 60–120°, rear 120–180° per COMBAT_RULES §4', () => {
    it('classifies any angular difference per the documented thresholds', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: Math.PI, noNaN: true }),
          (angleRad) => {
            const deg = (angleRad * 180) / Math.PI;
            const expected =
              deg <= FRONT_MAX_DEG ? 'front' : deg <= SIDE_MAX_DEG ? 'side' : 'rear';
            return classifyArcFromAngle(angleRad) === expected;
          },
        ),
        { numRuns: 200 },
      );
    });

    it('classifies representative angles', () => {
      const deg = (d: number) => (d * Math.PI) / 180;
      expect(classifyArcFromAngle(deg(0))).toBe('front');
      expect(classifyArcFromAngle(deg(45))).toBe('front');
      expect(classifyArcFromAngle(deg(60))).toBe('front'); // boundary inclusive
      expect(classifyArcFromAngle(deg(90))).toBe('side');
      expect(classifyArcFromAngle(deg(120))).toBe('side'); // boundary inclusive
      expect(classifyArcFromAngle(deg(135))).toBe('rear');
      expect(classifyArcFromAngle(deg(180))).toBe('rear');
    });
  });

  describe('degenerate geometry', () => {
    it('getBearingBetweenTiles returns NaN for coincident tiles', () => {
      const pos: Vec3 = normalize({ x: 0.3, y: 0.5, z: 0.8 });
      const tiles = [makeTile(0, pos), makeTile(1, { ...pos })];
      expect(Number.isNaN(getBearingBetweenTiles(tiles, 0, 1))).toBe(true);
      // Same index is trivially coincident too.
      expect(Number.isNaN(getBearingBetweenTiles(tiles, 0, 0))).toBe(true);
    });

    it('calculateOrientationBonus returns 0 when attacker and defender share a tile index and no segments provided', () => {
      const tiles = makeGrid(1.0, 2.0);
      expect(calculateOrientationBonus(tiles, 0, 0, 0)).toBe(0);
    });

    it('calculateOrientationBonus returns 0 when attacker and defender are coincident', () => {
      // Attacker tile (index 1) placed at the defender's exact position.
      const defender = makeTile(0, DEFENDER_POS, [2]);
      const attacker = makeTile(1, { ...DEFENDER_POS });
      const facingNeighbour = makeTile(2, posAtBearing(1.5));
      const tiles = [defender, attacker, facingNeighbour];
      expect(calculateOrientationBonus(tiles, 1, 0, 0)).toBe(0);
    });
  });
});
