import { describe, it, expect } from 'vitest';
import { spawnInitialUnits, findOutwardSegment } from '../spawn.js';
import { validateAttributes } from '../units.js';
import type { Tile } from '../types.js';

/**
 * Helper: create a minimal hex tile with 6 neighbours.
 */
function makeHexTile(index: number, neighbours: number[]): Tile {
  return {
    id: `tile_${index}`,
    index,
    sides: 6,
    neighbours,
    position3d: { x: 0, y: 0, z: 0 },
    boundary: [],
    terrainType: 'plains',
  } as unknown as Tile;
}

/**
 * Build a minimal tile array with a city tile (index 0) surrounded by 6 neighbours.
 */
function buildSimpleMap(): Tile[] {
  const tiles: Tile[] = [
    makeHexTile(0, [1, 2, 3, 4, 5, 6]),
    makeHexTile(1, [0, 2, 6, 7, 8, 9]),
    makeHexTile(2, [0, 1, 3, 10, 11, 12]),
    makeHexTile(3, [0, 2, 4, 13, 14, 15]),
    makeHexTile(4, [0, 3, 5, 16, 17, 18]),
    makeHexTile(5, [0, 4, 6, 19, 20, 21]),
    makeHexTile(6, [0, 5, 1, 22, 23, 24]),
  ];
  // Pad with placeholder tiles for indices 7–24
  for (let i = 7; i <= 24; i++) {
    tiles.push(makeHexTile(i, [0, 1, 2, 3, 4, 5]));
  }
  return tiles;
}

describe('spawn', () => {
  describe('spawnInitialUnits', () => {
    it('produces 6 units per city', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      expect(units).toHaveLength(6);
    });

    it('produces 12 units for 2 cities', () => {
      const tiles = buildSimpleMap();
      const cities = [
        { id: 'city_0', tileIndex: 0 },
        { id: 'city_1', tileIndex: 0 },
      ];
      const units = spawnInitialUnits(tiles, cities);
      expect(units).toHaveLength(12);
    });

    it('all units have unique ids', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      const ids = units.map((u) => u.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all units are owned by the city', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        expect(unit.ownerId).toBe('city_0');
      }
    });

    it('units have splashAttack or rangeAttack (not meleeAttack)', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        expect(unit.attributes).not.toHaveProperty('meleeAttack');
        const hasSplash = (unit.attributes.splashAttack ?? 0) > 0;
        const hasRange = (unit.attributes.rangeAttack ?? 0) > 0;
        expect(hasSplash || hasRange).toBe(true);
      }
    });

    it('units have valid attributes (pass validateAttributes)', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        const errors = validateAttributes(unit.attributes);
        expect(errors).toEqual([]);
      }
    });

    it('units have exactly one movement type each', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        const movementKeys = ['wheeledMovement', 'limbMovement', 'flightMovement'] as const;
        const presentMovement = movementKeys.filter(
          (k) => (unit.attributes[k] ?? 0) > 0
        );
        expect(presentMovement).toHaveLength(1);
      }
    });

    it('produces 3 splash units and 3 ranged units', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      const splashUnits = units.filter((u) => (u.attributes.splashAttack ?? 0) > 0);
      const rangedUnits = units.filter((u) => (u.attributes.rangeAttack ?? 0) > 0);
      expect(splashUnits).toHaveLength(3);
      expect(rangedUnits).toHaveLength(3);
    });

    it('all units spawn at size 1 with full health (10)', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        expect(unit.attributes.size).toBe(1);
        expect(unit.currentHealth).toBe(10);
      }
    });

    it('units are placed on neighbour tiles (not the city tile itself)', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        expect(unit.tileIndex).not.toBe(0);
        expect(unit.tileIndex).toBeGreaterThan(0);
      }
    });

    it('units are placed in alternating neighbours (indices 0, 2, 4)', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      const placedTiles = new Set(units.map((u) => u.tileIndex));
      expect(placedTiles).toContain(1);
      expect(placedTiles).toContain(3);
      expect(placedTiles).toContain(5);
      expect(placedTiles.size).toBe(3);
    });

    it('each neighbour tile has exactly 2 units', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      const countByTile = new Map<number, number>();
      for (const unit of units) {
        countByTile.set(unit.tileIndex, (countByTile.get(unit.tileIndex) ?? 0) + 1);
      }
      for (const count of countByTile.values()) {
        expect(count).toBe(2);
      }
    });

    it('segment values are valid HexSegment (0–5)', () => {
      const tiles = buildSimpleMap();
      const cities = [{ id: 'city_0', tileIndex: 0 }];
      const units = spawnInitialUnits(tiles, cities);
      for (const unit of units) {
        expect(unit.segment).toBeGreaterThanOrEqual(0);
        expect(unit.segment).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('findOutwardSegment', () => {
    it('returns the opposite segment from the city direction', () => {
      const tiles = buildSimpleMap();
      const segment = findOutwardSegment(tiles, 1, 0);
      expect(segment).toBe(3);
    });

    it('returns 0 when city tile is not a neighbour', () => {
      const tiles = buildSimpleMap();
      const segment = findOutwardSegment(tiles, 7, 99);
      expect(segment).toBe(0);
    });

    it('returns a valid segment index (0–5) for all ring tiles', () => {
      const tiles = buildSimpleMap();
      for (let i = 1; i <= 6; i++) {
        const segment = findOutwardSegment(tiles, i, 0);
        expect(segment).toBeGreaterThanOrEqual(0);
        expect(segment).toBeLessThanOrEqual(5);
      }
    });

    it('outward segment is always half-way around from city direction', () => {
      const tiles = buildSimpleMap();
      const segment = findOutwardSegment(tiles, 3, 0);
      const cityDir = tiles[3].neighbours.indexOf(0);
      const expected = (cityDir + 3) % 6;
      expect(segment).toBe(expected);
    });
  });
});
