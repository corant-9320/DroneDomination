// Phase 3 — versioned world-data contracts: repository tests.
//
// Covers `client/world/repository.ts`: cache reuse, session-storage load,
// default-scenario load, canonical version-1 data written by applyNewWorld,
// applyNewWorld rejecting invalid input before storage mutation or reload,
// session handoff cleanup, no cache publication after failure, and bundled
// scenario validation.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WireTile } from '../../shared/wireTypes.js';

function installSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
  return store;
}

function installBrowserGlobals(): { reloadCalls: number } {
  const g = globalThis as unknown as { window: Record<string, unknown>; localStorage: Storage };
  const state = { reloadCalls: 0 };
  g.window = {
    location: { reload: () => { state.reloadCalls++; } },
  };
  g.localStorage = {
    getItem: () => 'off',
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as Storage;
  return state;
}

const TILE_COUNT = 6;

function makeTile(idx: number, overrides: Partial<WireTile> = {}): WireTile {
  return { idx, s: 6, n: [], pos: [0, 0, 0], b: [], terrain: 'plains', ...overrides };
}

function makeRegenResponse() {
  const tiles = Array.from({ length: TILE_COUNT }, (_, i) => makeTile(i));
  return { tiles, pentagonIndices: [], tileCount: TILE_COUNT, pentagonCount: 0, hexCount: TILE_COUNT };
}

function makeCompactSave(overrides: Record<string, unknown> = {}) {
  return {
    format: 'compact',
    formatVersion: 1,
    seed: 4242,
    cities: [{ id: 'city_0', label: 'C', tileIndex: 0, neighbourCityIds: [] }],
    units: [],
    buildings: [],
    ...overrides,
  };
}

function installFetchMock(handlers: { worldTiles?: unknown; defaultScenario?: unknown } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/world-tiles') {
      return { ok: true, status: 200, json: async () => handlers.worldTiles ?? makeRegenResponse() };
    }
    if (typeof url === 'string' && url.startsWith('/default-scenario.json')) {
      return { ok: true, status: 200, json: async () => handlers.defaultScenario ?? makeCompactSave() };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function importRepository() {
  vi.resetModules();
  return import('../world/repository.js');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadWorld — cache reuse', () => {
  it('returns the cached world on a second call without refetching', async () => {
    installBrowserGlobals();
    installSessionStorage();
    const fetchMock = installFetchMock();
    const { loadWorld } = await importRepository();
    const first = await loadWorld();
    const second = await loadWorld();
    expect(second).toBe(first);
    // Only the /api/world-tiles + default-scenario fetches from the first load.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('loadWorld — session-storage handoff', () => {
  it('loads and clears a session-storage world handoff', async () => {
    installBrowserGlobals();
    const store = installSessionStorage();
    store.set('drone-domination-world', JSON.stringify(makeCompactSave({ seed: 777 })));
    installFetchMock();
    const { loadWorld } = await importRepository();
    const world = await loadWorld();
    expect(world.seed).toBe(777);
    expect(store.has('drone-domination-world')).toBe(false);
  });
});

describe('loadWorld — default-scenario fallback', () => {
  it('fetches the bundled default scenario when no handoff is present', async () => {
    installBrowserGlobals();
    installSessionStorage();
    const fetchMock = installFetchMock({ defaultScenario: makeCompactSave({ seed: 4242 }) });
    const { loadWorld } = await importRepository();
    const world = await loadWorld();
    expect(world.seed).toBe(4242);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/default-scenario.json'));
  });

  it('normalizes a legacy unversioned default scenario', async () => {
    installBrowserGlobals();
    installSessionStorage();
    const legacy = makeCompactSave();
    delete (legacy as Record<string, unknown>).formatVersion;
    installFetchMock({ defaultScenario: legacy });
    const { loadWorld } = await importRepository();
    const world = await loadWorld();
    expect(world.seed).toBe(4242);
  });

  it('rejects a malformed bundled scenario without publishing a partial world', async () => {
    installBrowserGlobals();
    installSessionStorage();
    installFetchMock({ defaultScenario: { format: 'compact', formatVersion: 1, seed: 'not-a-number', cities: [], units: [] } });
    const { loadWorld, getWorld } = await importRepository();
    await expect(loadWorld()).rejects.toThrow();
    expect(getWorld()).toBeNull();
  });
});

describe('applyNewWorld', () => {
  it('decodes and normalizes to canonical version-1 data, then reloads', async () => {
    const state = installBrowserGlobals();
    const store = installSessionStorage();
    const { applyNewWorld } = await importRepository();

    const legacy = makeCompactSave();
    delete (legacy as Record<string, unknown>).formatVersion;
    applyNewWorld(legacy);

    const stored = store.get('drone-domination-world');
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!) as { formatVersion: number };
    expect(parsed.formatVersion).toBe(1);
    expect(state.reloadCalls).toBe(1);
  });

  it('rejects invalid input before writing to session storage or reloading', async () => {
    const state = installBrowserGlobals();
    const store = installSessionStorage();
    const { applyNewWorld } = await importRepository();

    expect(() => applyNewWorld({ format: 'compact', formatVersion: 1, seed: 'nope', cities: [], units: [] })).toThrow();
    expect(store.has('drone-domination-world')).toBe(false);
    expect(state.reloadCalls).toBe(0);
  });
});
