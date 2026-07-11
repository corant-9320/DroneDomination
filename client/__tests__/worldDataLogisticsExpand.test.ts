/// <reference types="node" />
// Feature: oil-logistics-system, Task 15.5: client mirror/expand example tests
//
// Drives the REAL client expand path (`loadWorld` -> `expandCompactSave` ->
// `regenerateTilesFromSeed`) with a stubbed `sessionStorage` + mocked `fetch`,
// and asserts that a compact save's `logistics` payload is mirrored onto
// `WorldData.logistics` unchanged (Req 6.4, 12.1) and that the
// `logistics.bridges` / `logistics.clearedForests` index overlays are applied
// onto the right regenerated tiles (`tile.bridge` / `tile.clearedForest`).
//
// Req 12.1 (client-mirror independence): this file imports ONLY from `client/*`
// and `shared/*` — never from `src/` or `server/`. A guard test below reads this
// file's own source and fails on any such import.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireTile, CompactSave } from '../../shared/wireTypes.js';
import type { LogisticsState } from '../../shared/logisticsTypes.js';

// ─── Synthetic world helpers ────────────────────────────────────────────────

/** Minimal valid regenerated wire tile. `idx` is what the overlays index by. */
function makeTile(idx: number, overrides: Partial<WireTile> = {}): WireTile {
  return {
    idx,
    s: 6,
    n: [],
    pos: [0, 0, 0],
    b: [],
    terrain: 'plains',
    ...overrides,
  };
}

const TILE_COUNT = 12;

/** Server `/api/world-tiles` regeneration response shape. */
function makeRegen() {
  const tiles = Array.from({ length: TILE_COUNT }, (_, i) => makeTile(i));
  return {
    tiles,
    pentagonIndices: [0],
    tileCount: TILE_COUNT,
    pentagonCount: 1,
    hexCount: TILE_COUNT - 1,
  };
}

/** A fully-populated logistics payload (one of every entity). */
function makeLogistics(): LogisticsState {
  return {
    wells: [
      {
        id: 'well_1',
        ownerId: 'faction_home',
        tileIndex: 4,
        segment: 2,
        storedOil: 70,
        hitPoints: 100,
        maxHitPoints: 100,
      },
    ],
    refineries: [
      {
        id: 'ref_1',
        ownerId: 'faction_home',
        tileIndex: 6,
        segments: [0, 1],
        heldOil: 30,
        refinedProductAvailable: 15,
        hitPoints: 200,
        maxHitPoints: 200,
      },
    ],
    routes: [
      {
        id: 'route_1',
        ownerId: 'faction_home',
        fromStructureId: 'well_1',
        toStructureId: 'ref_1',
        segments: [4, 5, 6],
        capacity: 100,
        tier: 'road',
        travelTime: 3,
        operable: true,
      },
    ],
    transports: [
      {
        id: 'trans_1',
        ownerId: 'faction_home',
        routeId: 'route_1',
        cargoType: 'oil',
        cargo: 40,
        cargoCapacity: 100,
        speed: 1,
        defence: 1,
        upgrades: 0,
        tier: 'van',
        inTransit: false,
        turnsRemaining: 0,
        unitId: 'unit_trans_1',
      },
    ],
    hubs: [
      {
        id: 'hub_1',
        ownerId: 'faction_home',
        tileIndex: 8,
        segment: 0,
        buffer: 0,
        routeIds: ['route_1'],
        hitPoints: 150,
        maxHitPoints: 150,
      },
    ],
    home: {
      faction_home: { factionId: 'faction_home', refinedProduct: 500, oil: 120 },
    },
    tasks: [
      {
        id: 'task_1',
        kind: 'well',
        unitId: 'unit_eng_1',
        tileIndex: 9,
        segment: 3,
        turnsRemaining: 2,
        ownerId: 'faction_home',
      },
    ],
    clearedForests: [3, 7],
    bridges: [2, 5],
  };
}

/** Build a compact save carrying the given logistics payload. */
function makeSave(logistics: LogisticsState, extra: Partial<CompactSave> = {}): CompactSave {
  return {
    format: 'compact',
    seed: 1234,
    cities: [],
    units: [],
    buildings: [],
    logistics,
    ...extra,
  };
}

// ─── Environment stubs ──────────────────────────────────────────────────────
//
// The test env is node (no DOM). `loadWorld`'s sessionStorage branch and
// `regenerateTilesFromSeed`'s fetch are stubbed so the real expand path runs
// without a browser or server.

function installSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
  return store;
}

/**
 * Stub the minimal browser globals `client/debug.ts` reads at import time.
 * `localStorage` returns `'off'` so debug logging stays disabled and silent.
 */
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

/** Load a save through the real client expand path and return the WorldData. */
async function loadSave(save: CompactSave) {
  installBrowserGlobals();
  const store = installSessionStorage();
  store.set('drone-domination-world', JSON.stringify(save));

  const regen = makeRegen();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => regen,
  }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

  // Fresh module state so the module-level world cache does not leak between tests.
  vi.resetModules();
  const { loadWorld } = await import('../worldData.js');
  const world = await loadWorld();
  return { world, fetchMock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('client logistics mirror/expand path', () => {
  let logistics: LogisticsState;

  beforeEach(() => {
    logistics = makeLogistics();
  });

  it('mirrors the logistics payload onto WorldData.logistics unchanged', async () => {
    const { world } = await loadSave(makeSave(logistics));

    // Straight copy — every field survives the wire round-trip (Req 6.4, 12.1).
    expect(world.logistics).toEqual(logistics);
    expect(world.logistics?.wells[0].storedOil).toBe(70);
    expect(world.logistics?.transports[0].tier).toBe('van');
    expect(world.logistics?.home.faction_home.refinedProduct).toBe(500);
  });

  it('regenerates tiles from the seed via /api/world-tiles', async () => {
    const { world, fetchMock } = await loadSave(makeSave(logistics));

    expect(fetchMock).toHaveBeenCalledWith('/api/world-tiles', expect.any(Object));
    expect(world.tiles).toHaveLength(TILE_COUNT);
    expect(world.tileCount).toBe(TILE_COUNT);
  });

  it('applies logistics.bridges as tile.bridge overlays on the right tiles', async () => {
    const { world } = await loadSave(makeSave(logistics));

    for (const idx of logistics.bridges) {
      expect(world.tiles[idx].bridge).toBe(true);
    }
    // Tiles not in the overlay are left untouched.
    const bridged = new Set(logistics.bridges);
    for (const tile of world.tiles) {
      if (!bridged.has(tile.idx)) expect(tile.bridge).toBeUndefined();
    }
  });

  it('applies logistics.clearedForests as tile.clearedForest overlays on the right tiles', async () => {
    const { world } = await loadSave(makeSave(logistics));

    for (const idx of logistics.clearedForests) {
      expect(world.tiles[idx].clearedForest).toBe(true);
    }
    const cleared = new Set(logistics.clearedForests);
    for (const tile of world.tiles) {
      if (!cleared.has(tile.idx)) expect(tile.clearedForest).toBeUndefined();
    }
  });

  it('combines legacy save.bridges with logistics.bridges overlays', async () => {
    // Player-built bridges (save.bridges) and logistics bridges both set the
    // same render flag and must not clobber one another.
    const { world } = await loadSave(makeSave(logistics, { bridges: [10] }));

    expect(world.tiles[10].bridge).toBe(true); // legacy overlay
    expect(world.tiles[2].bridge).toBe(true); // logistics overlay
    expect(world.tiles[5].bridge).toBe(true);
  });

  it('loads a save with no logistics payload without touching overlays', async () => {
    const save: CompactSave = {
      format: 'compact',
      seed: 1234,
      cities: [],
      units: [],
      buildings: [],
    };
    const { world } = await loadSave(save);

    expect(world.logistics).toBeUndefined();
    for (const tile of world.tiles) {
      expect(tile.bridge).toBeUndefined();
      expect(tile.clearedForest).toBeUndefined();
    }
  });
});

describe('client-mirror import independence (Req 12.1)', () => {
  it('this test imports nothing from src/ or server/', () => {
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    const imports = source.match(/from\s+['"][^'"]+['"]/g) ?? [];
    const offending = imports.filter((i: string) => /['"](\.\.\/)+(src|server)\//.test(i));
    expect(offending).toEqual([]);
  });
});
