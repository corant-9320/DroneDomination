// Phase 3 — versioned world-data contracts: expansion tests.
//
// Covers `client/world/expand.ts::expandCompactSave`: tile regeneration,
// logistics state copy, legacy + logistics bridge overlays, cleared forests,
// generated city-marker filtering, city-owned-hex reapplication, home-city
// fallback, founding-building compatibility, and rejection of invalid or
// out-of-range saved data before any cache publication would occur.
//
// This supersedes/extends the older worldDataLogisticsExpand.test.ts by
// exercising expandCompactSave directly (not through the repository), and
// adds the new out-of-range / invalid-reference rejection coverage.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WireTile, WireCity } from '../../shared/wireTypes.js';
import type { LogisticsState } from '../../shared/logisticsTypes.js';
import type { CompactSaveV1 } from '../../shared/wireTypes.js';

function installBrowserGlobals(): void {
  const g = globalThis as unknown as { window: unknown; localStorage: Storage };
  g.window = g.window ?? {};
  g.localStorage = {
    getItem: () => 'off',
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as Storage;
}

const TILE_COUNT = 12;

function makeTile(idx: number, overrides: Partial<WireTile> = {}): WireTile {
  return { idx, s: 6, n: [], pos: [0, 0, 0], b: [], terrain: 'plains', ...overrides };
}

function makeRegenResponse() {
  const tiles = Array.from({ length: TILE_COUNT }, (_, i) => makeTile(i));
  return { tiles, pentagonIndices: [0], tileCount: TILE_COUNT, pentagonCount: 1, hexCount: TILE_COUNT - 1 };
}

function installFetchMock(response: unknown = makeRegenResponse()) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => response }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeCity(id: string, tileIndex: number, ownedHexes?: number[]): WireCity {
  return { id, label: id, tileIndex, neighbourCityIds: [], ownedHexes };
}

function makeLogistics(overrides: Partial<LogisticsState> = {}): LogisticsState {
  return {
    wells: [], refineries: [], routes: [], transports: [], hubs: [],
    home: {}, tasks: [], clearedForests: [], bridges: [],
    ...overrides,
  };
}

function makeSave(overrides: Partial<CompactSaveV1> = {}): CompactSaveV1 {
  return {
    format: 'compact',
    formatVersion: 1,
    seed: 1234,
    cities: [],
    units: [],
    buildings: [],
    ...overrides,
  };
}

async function importExpand() {
  installBrowserGlobals();
  vi.resetModules();
  return import('../world/expand.js');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('expandCompactSave — tile regeneration', () => {
  it('regenerates tiles from the seed via /api/world-tiles', async () => {
    const fetchMock = installFetchMock();
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave());
    expect(fetchMock).toHaveBeenCalledWith('/api/world-tiles', expect.any(Object));
    expect(world.tiles).toHaveLength(TILE_COUNT);
    expect(world.tileCount).toBe(TILE_COUNT);
  });
});

describe('expandCompactSave — logistics', () => {
  it('copies the logistics state onto WorldData.logistics unchanged', async () => {
    installFetchMock();
    const logistics = makeLogistics({ home: { f: { factionId: 'f', refinedProduct: 10, oil: 2 } } });
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ logistics }));
    expect(world.logistics).toEqual(logistics);
  });

  it('applies logistics.bridges and logistics.clearedForests as tile overlays', async () => {
    installFetchMock();
    const logistics = makeLogistics({ bridges: [2, 5], clearedForests: [3] });
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ logistics }));
    expect(world.tiles[2].bridge).toBe(true);
    expect(world.tiles[5].bridge).toBe(true);
    expect(world.tiles[3].clearedForest).toBe(true);
    expect(world.tiles[0].bridge).toBeUndefined();
  });

  it('unions legacy save.bridges with logistics.bridges without clobbering either', async () => {
    installFetchMock();
    const logistics = makeLogistics({ bridges: [5] });
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ bridges: [10], logistics }));
    expect(world.tiles[10].bridge).toBe(true);
    expect(world.tiles[5].bridge).toBe(true);
  });

  it('loads a save with no logistics payload without touching overlays', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave());
    expect(world.logistics).toBeUndefined();
    for (const tile of world.tiles) {
      expect(tile.bridge).toBeUndefined();
      expect(tile.clearedForest).toBeUndefined();
    }
  });
});

describe('expandCompactSave — city handling', () => {
  it('clears generated city markers for cities filtered out of the save', async () => {
    installFetchMock({ ...makeRegenResponse(), tiles: [makeTile(0, { city: 'ghost_city' }), ...Array.from({ length: TILE_COUNT - 1 }, (_, i) => makeTile(i + 1))] });
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ cities: [makeCity('city_0', 3)] }));
    expect(world.tiles[0].city).toBeUndefined();
  });

  it('reapplies city-owned hexes onto the regenerated tiles', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ cities: [makeCity('city_0', 3, [3, 4])] }));
    expect(world.tiles[3].city).toBe('city_0');
    expect(world.tiles[4].city).toBe('city_0');
  });

  it('falls back to the first city as player home when none is marked', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ cities: [makeCity('city_0', 3), makeCity('city_1', 4)] }));
    expect(world.cities[0].isPlayerHome).toBe(true);
  });

  it('does not override an already-marked player home city', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const cities = [makeCity('city_0', 3), { ...makeCity('city_1', 4), isPlayerHome: true }];
    const world = await expandCompactSave(makeSave({ cities }));
    expect(world.cities[0].isPlayerHome).toBeUndefined();
    expect(world.cities[1].isPlayerHome).toBe(true);
  });

  it('founds a city with no building (compatibility fallback for older saves)', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const world = await expandCompactSave(makeSave({ cities: [makeCity('city_0', 3)] }));
    expect(world.buildings.some((b) => b.ownerId === 'city_0')).toBe(true);
  });
});

describe('expandCompactSave — validation before publication', () => {
  it('rejects out-of-range city tileIndex', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    await expect(expandCompactSave(makeSave({ cities: [makeCity('city_0', 9999)] }))).rejects.toThrow();
  });

  it('rejects out-of-range unit tileIndex', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const units = [{ id: 'u', label: 'U', ownerId: 'f', tileIndex: 9999, segment: 0 as const, facing: 0 as const, attributes: {}, currentHealth: 5 }];
    await expect(expandCompactSave(makeSave({ units }))).rejects.toThrow();
  });

  it('rejects out-of-range battleCentreTile', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    await expect(expandCompactSave(makeSave({ battleCentreTile: 9999 }))).rejects.toThrow();
  });

  it('rejects out-of-range logistics well tileIndex', async () => {
    installFetchMock();
    const logistics = makeLogistics({
      wells: [{ id: 'w', ownerId: 'f', tileIndex: 9999, segment: 0, storedOil: 0, hitPoints: 1, maxHitPoints: 1 }],
    });
    const { expandCompactSave } = await importExpand();
    await expect(expandCompactSave(makeSave({ logistics }))).rejects.toThrow();
  });

  it('rejects an out-of-range legacy bridge index', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    await expect(expandCompactSave(makeSave({ bridges: [9999] }))).rejects.toThrow();
  });

  it('rejects invalid persisted building component values', async () => {
    installFetchMock();
    const { expandCompactSave } = await importExpand();
    const buildings = [{ id: 'b', ownerId: 'f', tileIndex: 0, segment: 0 as const, attributes: { kinetic: 9 } }];
    await expect(expandCompactSave(makeSave({ buildings }))).rejects.toThrow(/outside the allowed range/);
  });
});
