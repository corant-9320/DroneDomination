import { describe, it, expect } from 'vitest';
import { validateWorld, printValidation } from '../validate.js';
import { World, Tile, City } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
//
// validateWorld is the world-integrity gate. Its contract (design.md, Error
// Handling) is: structurally malformed worlds are REJECTED (passed === false)
// rather than triggering an unhandled throw. These tests feed a coherent but
// non-Goldberg baseline, then inject one defect at a time and assert the
// validator rejects it gracefully.
// ---------------------------------------------------------------------------

function onSphere(): { x: number; y: number; z: number } {
  return { x: 1, y: 0, z: 0 };
}

function makeTile(overrides: Partial<Tile> & { index: number }): Tile {
  return {
    id: `t${overrides.index}`,
    sides: 6,
    neighbours: [],
    position3d: onSphere(),
    boundary: [],
    terrainType: 'grassland',
    height: 1,
    forested: false,
    ...overrides,
  };
}

/**
 * A coherent world: in-range neighbour ids, symmetric where it matters,
 * all centroids on the unit sphere, valid city tile references. It is NOT a
 * real Goldberg solid (7 tiles, no pentagons), so it fails the count checks —
 * but it never throws, giving a clean base on which to inject single defects.
 */
function makeCoherentWorld(): World {
  // tile 0 is a central hex; tiles 1..6 are its leaf neighbours.
  const center = makeTile({ index: 0, sides: 6, neighbours: [1, 2, 3, 4, 5, 6], cityId: 'c0' });
  const leaves = [1, 2, 3, 4, 5, 6].map((i) =>
    makeTile({ index: i, sides: 1 as Tile['sides'], neighbours: [0] }),
  );
  const tiles = [center, ...leaves];

  const cities: City[] = [
    { id: 'c0', label: 'Capital', tileIndex: 0, neighbourCityIds: [], ownedHexes: [0] },
  ];

  return {
    tiles,
    cities,
    units: [],
    buildings: [],
    seed: 1,
    pentagonIndices: [],
  };
}

function clone(world: World): World {
  return structuredClone(world);
}

function checkByName(result: ReturnType<typeof validateWorld>, fragment: string) {
  return result.checks.find((c) => c.name.includes(fragment));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateWorld', () => {
  it('returns a structured result with a checks array and never throws on a coherent world', () => {
    const world = makeCoherentWorld();
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(typeof result.passed).toBe('boolean');
  });

  it('rejects a non-Goldberg tile count (wrong pentagon/count) without throwing', () => {
    const world = makeCoherentWorld();
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'pentagon_count')?.passed).toBe(false);
    expect(checkByName(result, 'Goldberg number')?.passed).toBe(false);
  });

  it('rejects a world with a self-neighbour without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.tiles[0].neighbours = [0, 2, 3, 4, 5, 6];
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'self-neighbours')?.passed).toBe(false);
  });

  it('rejects a world where sides != neighbour count without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.tiles[0].sides = 5; // neighbours still length 6
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'sides == neighbour count')?.passed).toBe(false);
  });

  it('rejects a world with an asymmetric adjacency without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.tiles[1].neighbours = []; // tile 0 -> 1 but not reverse
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'adjacency is symmetric')?.passed).toBe(false);
  });

  it('rejects a world with a centroid off the unit sphere without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.tiles[0].position3d = { x: 5, y: 5, z: 5 };
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'centroids on unit sphere')?.passed).toBe(false);
  });

  it('rejects a world with duplicate city tiles without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.cities.push({
      id: 'c1',
      label: 'Twin',
      tileIndex: 0,
      neighbourCityIds: [],
      ownedHexes: [0],
    });
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'duplicate city tiles')?.passed).toBe(false);
  });

  it('rejects a world with the wrong city count without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.cities = [];
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'city_count')?.passed).toBe(false);
  });

  it('rejects a world referencing a non-existent neighbour city without throwing', () => {
    const world = clone(makeCoherentWorld());
    world.cities[0].neighbourCityIds = ['ghost'];
    let result!: ReturnType<typeof validateWorld>;
    expect(() => {
      result = validateWorld(world);
    }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(checkByName(result, 'city-neighbour graph symmetric')?.passed).toBe(false);
  });

  it('printValidation does not throw for a rejected result', () => {
    const result = validateWorld(makeCoherentWorld());
    expect(() => printValidation(result)).not.toThrow();
  });
});
