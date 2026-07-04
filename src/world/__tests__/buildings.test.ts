import { describe, it, expect } from 'vitest';
import {
  cityForFaction,
  makePlacementContext,
  constructBuilding,
  foundCity,
  foundCities,
  checkCityIntegrity,
} from '../buildings.js';
import { World, Tile, City } from '../types.js';
import { segKey } from '../../../shared/buildings.js';

// ---------------------------------------------------------------------------
// Helpers — a central hex (tile 0) ringed by six ground-passable leaf hexes.
// This gives the capital six external passable faces so founding/through-street
// logic behaves like a real city hex.
// ---------------------------------------------------------------------------

function makeTile(overrides: Partial<Tile> & { index: number }): Tile {
  return {
    id: `t${overrides.index}`,
    sides: 6,
    neighbours: [],
    position3d: { x: 1, y: 0, z: 0 },
    boundary: [],
    terrainType: 'grassland',
    height: 1,
    forested: false,
    ...overrides,
  };
}

function makeWorld(capitalNeighbourTerrain = 'grassland'): World {
  const center = makeTile({ index: 0, sides: 6, neighbours: [1, 2, 3, 4, 5, 6] });
  const leaves = [1, 2, 3, 4, 5, 6].map((i) =>
    makeTile({ index: i, sides: 1 as Tile['sides'], neighbours: [0], terrainType: capitalNeighbourTerrain as Tile['terrainType'] }),
  );
  const cities: City[] = [
    { id: 'red', label: 'Red Capital', tileIndex: 0, neighbourCityIds: [] },
  ];
  return {
    tiles: [center, ...leaves],
    cities,
    units: [],
    buildings: [],
    seed: 1,
    pentagonIndices: [],
  };
}

// ---------------------------------------------------------------------------
// cityForFaction
// ---------------------------------------------------------------------------

describe('cityForFaction', () => {
  it('resolves a city by its own id when ownerId is unset', () => {
    const world = makeWorld();
    expect(cityForFaction(world, 'red')?.id).toBe('red');
  });

  it('resolves a city by an explicit ownerId', () => {
    const world = makeWorld();
    world.cities[0].ownerId = 'blue';
    expect(cityForFaction(world, 'blue')?.id).toBe('red');
    expect(cityForFaction(world, 'red')).toBeUndefined();
  });

  it('returns undefined for an unknown faction', () => {
    expect(cityForFaction(makeWorld(), 'green')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makePlacementContext
// ---------------------------------------------------------------------------

describe('makePlacementContext', () => {
  it('exposes ground-passability and resolves tiles by index', () => {
    const world = makeWorld();
    world.tiles[1].terrainType = 'ocean';
    const ctx = makePlacementContext(world, 'red');

    expect(ctx.getTile(0)?.groundPassable).toBe(true);
    expect(ctx.getTile(1)?.groundPassable).toBe(false); // ocean
    expect(ctx.getTile(999)).toBeUndefined(); // out of range
    expect(ctx.factionId).toBe('red');
  });

  it('defaults city hexes to the capital tile when none are owned yet', () => {
    const ctx = makePlacementContext(makeWorld(), 'red');
    expect([...ctx.cityHexes]).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// foundCity / foundCities
// ---------------------------------------------------------------------------

describe('foundCity', () => {
  it('places a free founding building and marks the capital hex owned', () => {
    const world = makeWorld();
    const building = foundCity(world, world.cities[0]);

    expect(building).not.toBeNull();
    expect(world.buildings).toContain(building);
    expect(world.tiles[0].cityId).toBe('red');
    expect(world.tiles[0].ownerId).toBe('red');
    expect(world.cities[0].ownedHexes).toContain(0);
    expect(world.tiles[0].buildingIds).toContain(building!.id);
  });

  it('returns null when no legal founding segment exists (capital sealed by ocean)', () => {
    const world = makeWorld('ocean'); // every capital face is impassable
    const building = foundCity(world, world.cities[0]);
    expect(building).toBeNull();
    expect(world.buildings).toHaveLength(0);
  });

  it('founds every city via foundCities', () => {
    const world = makeWorld();
    foundCities(world);
    expect(world.buildings).toHaveLength(1);
    expect(world.cities[0].ownedHexes).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// constructBuilding
// ---------------------------------------------------------------------------

describe('constructBuilding', () => {
  it('allocates sequential building ids and commits to the world', () => {
    const world = makeWorld();
    foundCity(world, world.cities[0]); // building_0 on some segment

    const used = world.buildings[0].segment;
    const free = used === 0 ? 1 : 0;
    const result = constructBuilding(world, 'red', { tileIndex: 0, segment: free });

    expect(result.success).toBe(true);
    expect(result.building?.id).toBe('building_1');
    expect(world.buildings).toHaveLength(2);
  });

  it('rejects placement on an already-occupied segment', () => {
    const world = makeWorld();
    foundCity(world, world.cities[0]);
    const occupied = world.buildings[0].segment;

    const result = constructBuilding(world, 'red', { tileIndex: 0, segment: occupied });
    expect(result.success).toBe(false);
    expect(result.validation.legal).toBe(false);
    expect(result.building).toBeUndefined();
  });

  it('rejects placement on an impassable tile', () => {
    const world = makeWorld();
    world.tiles[0].terrainType = 'ocean';
    const result = constructBuilding(world, 'red', { tileIndex: 0, segment: 0 }, { founding: true });
    expect(result.success).toBe(false);
    expect(result.validation.reason).toBe('impassable-tile');
  });
});

// ---------------------------------------------------------------------------
// checkCityIntegrity
// ---------------------------------------------------------------------------

describe('checkCityIntegrity', () => {
  it('reports no issues for a freshly founded city', () => {
    const world = makeWorld();
    foundCity(world, world.cities[0]);
    expect(checkCityIntegrity(world)).toEqual([]);
  });

  it('flags a hex with no through-street once its segments are sealed', () => {
    const world = makeWorld();
    world.cities[0].ownedHexes = [0];
    // Seal segments 0..4, leaving only one open face (< 2 passable faces).
    for (let s = 0; s < 5; s++) {
      world.buildings.push({ id: `building_${s}`, ownerId: 'red', tileIndex: 0, segment: s });
    }
    const issues = checkCityIntegrity(world);
    const noStreet = issues.find((i) => i.kind === 'no-through-street');
    expect(noStreet).toBeDefined();
    expect(noStreet?.cityId).toBe('red');
    expect(noStreet?.tiles).toContain(0);
  });

  it('builds the occupancy set keyed by tile:segment', () => {
    // Sanity guard on the shared segKey helper the integrity check relies on.
    expect(segKey(0, 3)).toBe('0:3');
  });
});
