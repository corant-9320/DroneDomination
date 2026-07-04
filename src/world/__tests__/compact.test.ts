/**
 * Round-trip coverage for `src/world/compact.ts` (serialize-only module).
 *
 * `compact.ts` exports only the forward serializers — `toCompactTile`,
 * `toCompactUnit`, `toCompactBuilding`, `toCompactWorld`. There is NO inverse
 * in this module (the production inverse lives client-side in
 * `client/worldData.ts`, which is out of scope here). To test the round-trip
 * honestly we reconstruct a World from the compact wire shape in-test, reading
 * ONLY the fields the wire format actually carries. If a serializer dropped or
 * corrupted a field, the rebuilt world would diverge and Property 16 would
 * fail — so this is a genuine "no data loss" check, not a restatement of the
 * serializer.
 *
 * Note on lossy fields (asserted against the real contract, not invented):
 *   - position3d rounds to 1e6, boundary to 1e5 → compared with tolerance.
 *   - Tile.id / ownerId / buildingIds / unitIds / resourceType are NOT on the
 *     wire — they are intentionally excluded from the equivalence check.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toCompactWorld } from '../compact.js';
import type { Tile, Building, Vec3, TerrainType } from '../types.js';
import type { Unit, HexSegment } from '../units.js';
import type { UnitAttributes } from '../../../shared/unitTypes.js';
import type {
  WireTile,
  WireUnit,
  WireBuilding,
  WireWorld,
} from '../../../shared/wireTypes.js';

// ---------------------------------------------------------------------------
// In-test inverse: reconstruct authoritative shapes from the wire format.
// Reads ONLY wire fields, applying the documented defaults for omitted ones.
// ---------------------------------------------------------------------------

interface RoundTrippedTile {
  index: number;
  sides: 5 | 6;
  neighbours: number[];
  position3d: Vec3;
  boundary: Vec3[];
  terrainType: string;
  height: number;
  forested: boolean;
  riverTo: number | undefined;
  cityId: string | undefined;
}

function fromCompactTile(w: WireTile): RoundTrippedTile {
  return {
    index: w.idx,
    sides: w.s,
    neighbours: w.n,
    position3d: { x: w.pos[0], y: w.pos[1], z: w.pos[2] },
    boundary: w.b.map((v) => ({ x: v[0], y: v[1], z: v[2] })),
    terrainType: w.terrain,
    height: w.h ?? 0,
    forested: w.f ?? false, // serializer emits `t.forested || undefined`
    riverTo: w.rv,
    cityId: w.city,
  };
}

function fromCompactUnit(w: WireUnit): Unit {
  return {
    id: w.id,
    label: w.label,
    ownerId: w.ownerId,
    tileIndex: w.tileIndex,
    segment: w.segment,
    facing: w.facing,
    attributes: w.attributes,
    currentHealth: w.currentHealth,
  };
}

function fromCompactBuilding(w: WireBuilding): Building {
  return {
    id: w.id,
    ownerId: w.ownerId,
    tileIndex: w.tileIndex,
    segment: w.segment,
    attributes: w.attributes,
  };
}

// ---------------------------------------------------------------------------
// Generators — valid synthetic world fragments.
// ---------------------------------------------------------------------------

const TERRAINS: TerrainType[] = ['grassland', 'plains', 'tundra', 'desert', 'ocean'];
const SEGMENTS: HexSegment[] = [0, 1, 2, 3, 4, 5];

const arbCoord = fc.double({ min: -1, max: 1, noNaN: true });
const arbVec3 = fc.record({ x: arbCoord, y: arbCoord, z: arbCoord });
const arbAttrVal = fc.integer({ min: 0, max: 5 });

// A well-formed (but not necessarily game-valid) attribute bag: any subset of
// keys, integer values. Round-trip preserves whatever object is present.
const arbAttributes: fc.Arbitrary<UnitAttributes> = fc.record(
  {
    size: fc.integer({ min: 1, max: 5 }),
    kinetic: arbAttrVal,
    armour: arbAttrVal,
    defence: arbAttrVal,
    splashAttack: arbAttrVal,
    rangeAttack: arbAttrVal,
    wheeledMovement: arbAttrVal,
    limbMovement: arbAttrVal,
    flightMovement: arbAttrVal,
    repair: arbAttrVal,
    antiAir: arbAttrVal,
    engineer: arbAttrVal,
  },
  { requiredKeys: ['size'] },
);

const arbTile: fc.Arbitrary<Tile> = fc.record({
  index: fc.nat({ max: 5000 }),
  sides: fc.constantFrom<5 | 6>(5, 6),
  neighbours: fc.array(fc.nat({ max: 5000 }), { minLength: 0, maxLength: 6 }),
  position3d: arbVec3,
  boundary: fc.array(arbVec3, { minLength: 3, maxLength: 6 }),
  terrainType: fc.constantFrom(...TERRAINS),
  height: fc.integer({ min: 0, max: 11 }),
  forested: fc.boolean(),
  // riverTo omitted (undefined) or a tile index; cityId omitted or non-empty.
  riverTo: fc.option(fc.nat({ max: 5000 }), { nil: undefined }),
  cityId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
}) as fc.Arbitrary<Tile>;

const arbUnit: fc.Arbitrary<Unit> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  label: fc.string({ maxLength: 20 }),
  ownerId: fc.string({ minLength: 1, maxLength: 8 }),
  tileIndex: fc.nat({ max: 5000 }),
  segment: fc.constantFrom(...SEGMENTS),
  facing: fc.constantFrom(...SEGMENTS),
  attributes: arbAttributes,
  currentHealth: fc.integer({ min: 0, max: 50 }),
});

const arbBuilding: fc.Arbitrary<Building> = fc.record(
  {
    id: fc.string({ minLength: 1, maxLength: 10 }),
    ownerId: fc.string({ minLength: 1, maxLength: 8 }),
    tileIndex: fc.nat({ max: 5000 }),
    segment: fc.constantFrom(...SEGMENTS),
    attributes: fc.option(arbAttributes, { nil: undefined }),
  },
  { requiredKeys: ['id', 'ownerId', 'tileIndex', 'segment'] },
) as fc.Arbitrary<Building>;

const arbWorld = fc.record({
  seed: fc.integer({ min: 0, max: 2 ** 31 }),
  tiles: fc.array(arbTile, { minLength: 0, maxLength: 8 }),
  pentagonIndices: fc.array(fc.nat({ max: 5000 }), { maxLength: 12 }),
  units: fc.array(arbUnit, { minLength: 0, maxLength: 6 }),
  buildings: fc.array(arbBuilding, { minLength: 0, maxLength: 6 }),
});

// ---------------------------------------------------------------------------
// Equivalence helpers (tolerant on the lossy float fields only).
// ---------------------------------------------------------------------------

function expectVecClose(a: Vec3, b: Vec3, digits: number): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

function expectTileEquivalent(original: Tile, rebuilt: RoundTrippedTile): void {
  expect(rebuilt.index).toBe(original.index);
  expect(rebuilt.sides).toBe(original.sides);
  expect(rebuilt.neighbours).toEqual(original.neighbours);
  expect(rebuilt.terrainType).toBe(original.terrainType);
  expect(rebuilt.height).toBe(original.height);
  expect(rebuilt.forested).toBe(original.forested);
  expect(rebuilt.riverTo).toBe(original.riverTo);
  // cityId: serializer emits `t.cityId || undefined`, so empty → undefined.
  expect(rebuilt.cityId).toBe(original.cityId || undefined);
  expectVecClose(rebuilt.position3d, original.position3d, 5); // pos rounds to 1e6
  expect(rebuilt.boundary).toHaveLength(original.boundary.length);
  rebuilt.boundary.forEach((v, i) => expectVecClose(v, original.boundary[i], 4)); // b rounds to 1e5
}

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

describe('compact wire-format round-trip', () => {
  // Feature: unit-test-coverage, Property 16: converting a valid world to the
  // compact wire format and back yields an equivalent world (tiles, units, and
  // attributes preserved).
  // Validates: Requirements 3.5, 4.4, 5.2
  it('Property 16: round-trips a world through the compact wire format without data loss', () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        const wire: WireWorld = toCompactWorld(
          w.seed,
          w.tiles,
          w.pentagonIndices,
          [],
          w.units,
          w.buildings,
        );

        // World-level metadata.
        expect(wire.seed).toBe(w.seed);
        expect(wire.pentagonIndices).toEqual(w.pentagonIndices);
        expect(wire.tileCount).toBe(w.tiles.length);
        expect(wire.pentagonCount).toBe(w.pentagonIndices.length);
        expect(wire.hexCount).toBe(w.tiles.length - w.pentagonIndices.length);

        // Tiles: equivalent on every wire-carried field.
        expect(wire.tiles).toHaveLength(w.tiles.length);
        wire.tiles.forEach((wt, i) => expectTileEquivalent(w.tiles[i], fromCompactTile(wt)));

        // Units: every field is carried verbatim, including attributes.
        expect(wire.units).toHaveLength(w.units.length);
        wire.units.forEach((wu, i) => expect(fromCompactUnit(wu)).toEqual(w.units[i]));

        // Buildings: id/owner/tile/segment + optional attributes preserved.
        expect(wire.buildings).toHaveLength(w.buildings.length);
        wire.buildings.forEach((wb, i) => expect(fromCompactBuilding(wb)).toEqual(w.buildings[i]));
      }),
      { numRuns: 200 },
    );
  });

  // ── Example tests (specific shapes / edge cases) ──────────────────────────

  it('round-trips an empty world', () => {
    const wire = toCompactWorld(123, [], [], [], [], []);
    expect(wire.seed).toBe(123);
    expect(wire.tileCount).toBe(0);
    expect(wire.tiles).toEqual([]);
    expect(wire.units).toEqual([]);
    expect(wire.buildings).toEqual([]);
  });

  it('preserves unit attributes exactly through the round-trip', () => {
    const attributes: UnitAttributes = { size: 3, kinetic: 2, armour: 1, limbMovement: 2 };
    const unit: Unit = {
      id: 'u1',
      label: 'Scout',
      ownerId: 'p1',
      tileIndex: 7,
      segment: 2,
      facing: 4,
      attributes,
      currentHealth: 25,
    };
    const wire = toCompactWorld(1, [], [], [], [unit], []);
    expect(fromCompactUnit(wire.units[0])).toEqual(unit);
    expect(wire.units[0].attributes).toEqual(attributes);
  });

  it('omits a falsy cityId and false forested, restoring documented defaults', () => {
    const tile: Tile = {
      id: 't0',
      index: 0,
      sides: 6,
      neighbours: [1, 2, 3],
      position3d: { x: 0.5, y: -0.25, z: 0.123456789 },
      boundary: [
        { x: 0.1, y: 0.2, z: 0.3 },
        { x: -0.1, y: -0.2, z: -0.3 },
        { x: 0.4, y: 0.5, z: 0.6 },
      ],
      terrainType: 'ocean',
      height: 0,
      forested: false,
      cityId: '',
    };
    const wire = toCompactWorld(1, [tile], [], [], [], []);
    expect(wire.tiles[0].f).toBeUndefined();
    expect(wire.tiles[0].city).toBeUndefined();
    expectTileEquivalent(tile, fromCompactTile(wire.tiles[0]));
  });
});
