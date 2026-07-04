/**
 * Shared fixtures for the movement test files (`movement.test.ts` and
 * `movement.reach.test.ts`). Builders only — no assertions live here.
 */
import { Unit, HexSegment } from '../units.js';
import type { Tile } from '../types.js';

export function makeTile(overrides: Partial<Tile> & { index: number; neighbours: number[] }): Tile {
  return {
    id: `tile_${overrides.index}`,
    sides: 6,
    position3d: { x: 0, y: 0, z: 1 },
    boundary: [],
    terrainType: 'plains',
    height: 4,
    forested: false,
    ...overrides,
  } as Tile;
}

/**
 * Linear chain: 0 — 1 — 2 — 3 — 4
 * All plains/rolling/not forested by default.
 */
export function linearGrid(n: number = 5): Tile[] {
  return Array.from({ length: n }, (_, i) => {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < n - 1) neighbours.push(i + 1);
    // Pad to 6 neighbours (self-links for missing)
    while (neighbours.length < 6) neighbours.push(i);
    return makeTile({ index: i, neighbours });
  });
}

/**
 * 7-tile hex grid: tile 0 centre, tiles 1-6 ring.
 */
export function hexGrid(): Tile[] {
  const tiles: Tile[] = [];
  tiles.push(makeTile({ index: 0, neighbours: [1, 2, 3, 4, 5, 6] }));
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push(makeTile({ index: i, neighbours: [0, next, prev, 0, next, prev] }));
  }
  return tiles;
}

export function makeUnit(overrides: Partial<Unit> & { id: string }): Unit {
  return {
    label: overrides.id,
    ownerId: 'p1',
    tileIndex: 0,
    segment: 0 as HexSegment,
    facing: 0 as HexSegment,
    attributes: { size: 3, wheeledMovement: 3 },
    currentHealth: 30,
    ...overrides,
  };
}
