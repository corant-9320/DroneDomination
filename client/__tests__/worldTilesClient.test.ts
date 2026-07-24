// Phase 3 — versioned world-data contracts: tile-regeneration client tests.
//
// Covers `client/world/tilesClient.ts`: successful decode, non-2xx response,
// network failure, invalid JSON, missing fields, count mismatch, invalid tile
// index, and invalid neighbour index.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WireTile } from '../../shared/wireTypes.js';

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

function makeTile(idx: number, overrides: Partial<WireTile> = {}): WireTile {
  return { idx, s: 6, n: [], pos: [0, 0, 0], b: [], terrain: 'plains', ...overrides };
}

function makeValidResponse() {
  const tiles = [makeTile(0, { n: [1] }), makeTile(1, { n: [0] })];
  return { tiles, pentagonIndices: [], tileCount: 2, pentagonCount: 0, hexCount: 2 };
}

function mockFetch(impl: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(impl) as unknown as typeof fetch;
}

async function importTilesClient() {
  installBrowserGlobals();
  vi.resetModules();
  return import('../world/tilesClient.js');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('regenerateTilesFromSeed', () => {
  it('decodes a successful, well-formed response', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => makeValidResponse() }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    const result = await regenerateTilesFromSeed(42);
    expect(result.tileCount).toBe(2);
    expect(result.tiles).toHaveLength(2);
  });

  it('throws on a non-2xx response', async () => {
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/500/);
  });

  it('throws on a network failure', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/network down/);
  });

  it('throws on invalid JSON in the response body', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/Unexpected token/);
  });

  it('rejects a response missing required fields', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ tiles: [] }) }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/Invalid \/api\/world-tiles response/);
  });

  it('rejects a tileCount/tiles.length mismatch', async () => {
    const bad = { ...makeValidResponse(), tileCount: 5 };
    mockFetch(async () => ({ ok: true, status: 200, json: async () => bad }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/tileCount/);
  });

  it('rejects an out-of-range pentagon index', async () => {
    const bad = { ...makeValidResponse(), pentagonIndices: [99], pentagonCount: 1, hexCount: 1 };
    mockFetch(async () => ({ ok: true, status: 200, json: async () => bad }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/pentagon index/);
  });

  it('rejects an out-of-range neighbour index', async () => {
    const bad = { ...makeValidResponse(), tiles: [makeTile(0, { n: [99] }), makeTile(1)] };
    mockFetch(async () => ({ ok: true, status: 200, json: async () => bad }));
    const { regenerateTilesFromSeed } = await importTilesClient();
    await expect(regenerateTilesFromSeed(42)).rejects.toThrow(/neighbour index/);
  });
});
