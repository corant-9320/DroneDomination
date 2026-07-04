/**
 * Shared fixtures for the combat test files (`combat.test.ts` and
 * `combat.resolve.test.ts`). Builders only — no assertions live here.
 */
import { Unit } from '../units.js';
import { Tile, Building } from '../types.js';
import type { CombatContext } from '../combat.js';

/** 7-tile hex grid: tile 0 centre, tiles 1–6 ring, with real 3D positions. */
export function createTestGrid(): Tile[] {
  const centerPos = { x: 0, y: 0, z: 1 };
  const angularSpacing = 0.15;

  const neighbourPositions: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    neighbourPositions.push({
      x: Math.sin(angularSpacing) * Math.sin(angle),
      y: Math.sin(angularSpacing) * Math.cos(angle),
      z: Math.cos(angularSpacing),
    });
  }

  const baseTile = {
    id: '', index: 0, sides: 6 as const, neighbours: [] as number[],
    position3d: centerPos, boundary: [], terrainType: 'plains' as const,
    height: 4, forested: false,
  };

  const tiles: Tile[] = [];
  tiles.push({ ...baseTile, id: 't0', index: 0, position3d: centerPos, neighbours: [1, 2, 3, 4, 5, 6] });
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push({ ...baseTile, id: `t${i}`, index: i, position3d: neighbourPositions[i - 1], neighbours: [0, next, prev, 0, next, prev] });
  }
  return tiles;
}

/** Linear chain of 6 tiles with real 3D positions for range/distance cases. */
export function createLinearGrid(): Tile[] {
  const baseTile = {
    id: '', index: 0, sides: 6 as const, neighbours: [] as number[],
    position3d: { x: 0, y: 0, z: 1 }, boundary: [],
    terrainType: 'plains' as const, height: 4, forested: false,
  };
  const spacing = 0.15;
  const tiles: Tile[] = [];
  for (let i = 0; i < 6; i++) {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < 5) neighbours.push(i + 1);
    while (neighbours.length < 6) neighbours.push(i);
    const theta = (i - 2.5) * spacing;
    tiles.push({ ...baseTile, id: `t${i}`, index: i, position3d: { x: Math.sin(theta), y: 0, z: Math.cos(theta) }, neighbours });
  }
  return tiles;
}

export function makeUnit(overrides: Partial<Unit> & { id: string; ownerId: string }): Unit {
  return {
    label: overrides.id, tileIndex: 0, segment: 0, facing: 0,
    attributes: { size: 3, kinetic: 2, rangeAttack: 2, limbMovement: 1 },
    currentHealth: 30, ...overrides,
  };
}

// An EW-bearing structure. `defence` is the EW screen radius/strength; omit
// `defence` (or pass attributes:undefined) for a plain unequipped building.
export function makeBuilding(
  overrides: Partial<Building> & { id: string; ownerId: string },
): Building {
  return { tileIndex: 0, segment: 0, ...overrides };
}

/** Build a CombatContext; buildings default to none. */
export function makeCtx(
  units: Unit[],
  tiles: Tile[],
  buildings: CombatContext['buildings'] = [],
): CombatContext {
  return { units, tiles, buildings };
}
