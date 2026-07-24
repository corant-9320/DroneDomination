// Phase 3 — versioned world-data contracts: facade compatibility test.
//
// Verifies `client/worldData.ts` still exports every symbol the ~40 existing
// consumers rely on, with the same runtime identity as the underlying
// `client/world/**` modules (not a re-implementation).

import { describe, it, expect } from 'vitest';
import type { BuildingData } from '../world/model.js';

// `worldData.ts` -> `world/repository.ts` -> `debug.ts` reads `window` and
// `localStorage` at module-eval time; stub them before importing anything.
const g = globalThis as unknown as { window: unknown; localStorage: Storage };
g.window = g.window ?? {};
g.localStorage = g.localStorage ?? ({
  getItem: () => 'off',
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
} as Storage);

const worldData: typeof import('../worldData.js') = await import('../worldData.js');
const model: typeof import('../world/model.js') = await import('../world/model.js');
const repository: typeof import('../world/repository.js') = await import('../world/repository.js');

describe('worldData.ts — compatibility facade', () => {
  it('re-exports buildingAsAttackerUnit from world/model.ts (same function identity)', () => {
    expect(worldData.buildingAsAttackerUnit).toBe(model.buildingAsAttackerUnit);
  });

  it('re-exports getWorld/getCompactSave/loadWorld/applyNewWorld from world/repository.ts', () => {
    expect(worldData.getWorld).toBe(repository.getWorld);
    expect(worldData.getCompactSave).toBe(repository.getCompactSave);
    expect(worldData.loadWorld).toBe(repository.loadWorld);
    expect(worldData.applyNewWorld).toBe(repository.applyNewWorld);
  });

  it('buildingAsAttackerUnit produces the expected synthetic unit shape', () => {
    const building: BuildingData = {
      id: 'building_3',
      ownerId: 'city_0',
      tileIndex: 10,
      segment: 2,
      attributes: { kinetic: 3 },
    };
    const unit = worldData.buildingAsAttackerUnit(building);
    expect(unit.id).toBe('building_3');
    expect(unit.label).toBe('Building #3');
    expect(unit.tileIndex).toBe(10);
    expect(unit.segment).toBe(2);
    expect(unit.facing).toBe(2);
    expect(unit.attributes.size).toBe(1);
    expect(unit.currentHealth).toBe(10);
  });
});
