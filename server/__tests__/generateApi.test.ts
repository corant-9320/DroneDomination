import { describe, it, expect, beforeAll } from 'vitest';
import {
  handleGenerate,
  MAX_CITIES,
  type GenerateResult,
} from '../generateApi.js';

/**
 * Integration / smoke coverage for the world-generation request path
 * (`server/generateApi.ts`, previously 0% covered).
 *
 * These are representative end-to-end examples, NOT property tests: each call
 * runs the real pipeline (generateWorld → validateWorld → selectEnemyCities →
 * spawnInitialUnits → foundCities → compact assembly). `handleGenerate` derives
 * its own world seed internally from `Date.now()`/`Math.random()`, so the tests
 * assert structural invariants that hold for any seed rather than pinned values.
 * No mocks — the module touches no external IO boundary (no fs/network).
 *
 * generateWorld runs at FREQUENCY=100 (~100k tiles), so each generation is
 * expensive; we generate once in beforeAll and assert many invariants against
 * the single result, with one extra example for input clamping.
 */

interface CompactWorld {
  format: string;
  seed: number;
  cities: Array<{
    id: string;
    label: string;
    tileIndex: number;
    neighbourCityIds: string[];
    isPlayerHome?: boolean;
    ownerId: string;
    ownedHexes: number[];
  }>;
  units: Array<{
    id: string;
    ownerId: string;
    tileIndex: number;
    currentHealth: number;
    attributes: unknown;
  }>;
  buildings: Array<{ id: string; ownerId: string; tileIndex: number }>;
}

// Full world generation is slow at FREQUENCY=100; allow ample time.
const GEN_TIMEOUT_MS = 120_000;

describe('handleGenerate — world generation request path', () => {
  let result: GenerateResult;
  let world: CompactWorld;

  beforeAll(() => {
    result = handleGenerate({ enemies: 3, spacing: 30 });
    world = result.world as CompactWorld;
  }, GEN_TIMEOUT_MS);

  it('succeeds and returns a compact world payload', () => {
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(world).toBeDefined();
    expect(world.format).toBe('compact');
    expect(typeof world.seed).toBe('number');
  });

  it('emits the requested number of active cities (1 player + N enemies)', () => {
    // enemies=3 → 4 active cities, well within MAX_CITIES.
    expect(world.cities.length).toBe(4);
    expect(world.cities.length).toBeLessThanOrEqual(MAX_CITIES);
  });

  it('marks exactly one player-home city', () => {
    const homes = world.cities.filter((c) => c.isPlayerHome);
    expect(homes.length).toBe(1);
  });

  it('gives every active city an owner and at least its capital hex', () => {
    for (const c of world.cities) {
      expect(typeof c.ownerId).toBe('string');
      expect(c.ownedHexes.length).toBeGreaterThanOrEqual(1);
      expect(c.ownedHexes).toContain(c.tileIndex);
    }
  });

  it('restricts neighbour references to active cities only', () => {
    const activeIds = new Set(world.cities.map((c) => c.id));
    for (const c of world.cities) {
      for (const nid of c.neighbourCityIds) {
        expect(activeIds.has(nid)).toBe(true);
      }
    }
  });

  it('spawns units for the active cities with valid health', () => {
    expect(world.units.length).toBeGreaterThan(0);
    for (const u of world.units) {
      expect(typeof u.ownerId).toBe('string');
      expect(u.currentHealth).toBeGreaterThan(0);
      expect(u.attributes).toBeDefined();
    }
  });

  it('founds at least one building per active city', () => {
    expect(world.buildings.length).toBeGreaterThanOrEqual(world.cities.length);
  });
});

describe('handleGenerate — input clamping', () => {
  it('clamps an over-large enemy count to MAX_CITIES - 1', () => {
    // enemies far above the cap → player + (MAX_CITIES - 1) enemies = MAX_CITIES.
    const res = handleGenerate({ enemies: 999, spacing: 999 });
    expect(res.success).toBe(true);
    const w = res.world as CompactWorld;
    expect(w.cities.length).toBe(MAX_CITIES);
  }, GEN_TIMEOUT_MS);
});
