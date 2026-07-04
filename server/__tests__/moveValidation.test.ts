import { describe, it, expect } from 'vitest';
import { computeMovePath, validateMovePath } from '../combatApi.js';
import type { Tile } from '../../src/world/types.js';
import type { Unit } from '../../src/world/units.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

/**
 * Server-authority Phase 2 regression guard for move-path legality. Guards the
 * shared cost/geometry check used by both the stateless `/api/combat` move and
 * the authoritative match-session move.
 */

function attrs(p: Partial<UnitAttributes>): UnitAttributes {
  return {
    size: 5, kinetic: 0, armour: 0, defence: 0, splashAttack: 0, rangeAttack: 0,
    wheeledMovement: 0, limbMovement: 0, flightMovement: 0, repair: 0, antiAir: 0, ...p,
  };
}

/** Line of flat-plains hexes (passable to ground units). */
function lineTiles(n: number, over?: Partial<Tile>): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const neighbours: number[] = [];
    if (i + 1 < n) neighbours.push(i + 1);
    if (i - 1 >= 0) neighbours.push(i - 1);
    tiles.push({
      id: `t${i}`, index: i, sides: 6, neighbours,
      position3d: { x: i * 0.1, y: 0, z: 1 },
      boundary: [], terrainType: 'plains', height: 1, forested: false,
      ...over,
    });
  }
  return tiles;
}

function tankAt(tile: number): Unit {
  return { id: 'u', label: 'u', ownerId: 'p', tileIndex: tile, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 2 }) } as Unit;
}

describe('computeMovePath / validateMovePath', () => {
  it('returns a positive cost for a legal contiguous path', () => {
    const r = computeMovePath(tankAt(0), [0, 1, 2], lineTiles(5));
    expect('cost' in r).toBe(true);
    if ('cost' in r) expect(r.cost).toBeGreaterThan(0);
  });

  it('rejects a path that does not start at the unit\'s tile', () => {
    const r = computeMovePath(tankAt(0), [2, 3], lineTiles(5));
    expect(r).toHaveProperty('error');
    if ('error' in r) expect(r.error).toMatch(/start/i);
  });

  it('rejects a non-contiguous path', () => {
    const r = computeMovePath(tankAt(0), [0, 4], lineTiles(5));
    expect(r).toHaveProperty('error');
    if ('error' in r) expect(r.error).toMatch(/contiguous/i);
  });

  it('rejects a path crossing impassable terrain (ocean for a tank)', () => {
    const tiles = lineTiles(3);
    tiles[1].terrainType = 'ocean';
    const r = computeMovePath(tankAt(0), [0, 1], tiles);
    expect(r).toHaveProperty('error');
    if ('error' in r) expect(r.error).toMatch(/impassable/i);
  });

  it('validateMovePath accepts a short move within the budget', () => {
    expect(validateMovePath(tankAt(0), [0, 1], lineTiles(5))).toBeNull();
  });

  it('validateMovePath rejects a move beyond the unit\'s max movement', () => {
    // wheeled=2 budget; a long line of steps exceeds it.
    const reason = validateMovePath(tankAt(0), [0, 1, 2, 3, 4, 5, 6, 7, 8], lineTiles(10));
    expect(reason).toMatch(/budget/i);
  });

  it('flight ignores terrain — a drone may cross ocean', () => {
    const tiles = lineTiles(3, {});
    tiles[1].terrainType = 'ocean';
    const drone = { id: 'd', label: 'd', ownerId: 'p', tileIndex: 0, segment: 0, facing: 0, currentHealth: 10, attributes: attrs({ flightMovement: 3 }) } as Unit;
    const r = computeMovePath(drone, [0, 1, 2], tiles);
    expect('cost' in r).toBe(true);
  });
});
