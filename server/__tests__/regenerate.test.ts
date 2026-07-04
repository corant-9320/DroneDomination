import { describe, it, expect, beforeAll } from 'vitest';
import { regenerateTiles, type RegenerateResult } from '../regenerate.js';
import { FREQUENCY } from '../../src/world/generate.js';

/**
 * Integration / smoke coverage for `server/regenerate.ts` (previously 0%).
 *
 * `regenerateTiles(seed)` is a thin, deterministic wrapper over the seed-driven
 * world generator: it regenerates the full tile array + cities in compact wire
 * format. Randomness is controlled through the seed (mulberry32 in
 * `src/world/rng.ts`), so the same seed must reproduce the same world. No mocks
 * — the module performs no fs/network IO.
 *
 * generateWorld is hardcoded to FREQUENCY=100, so each call is expensive; we
 * generate once for the structural asserts and once more to prove determinism.
 */

const SEED = 0x5eed_1234;
const GEN_TIMEOUT_MS = 120_000;

// Goldberg tile count: T = 10·F² + 2.
const EXPECTED_TILE_COUNT = 10 * FREQUENCY * FREQUENCY + 2;

describe('regenerateTiles — seed-driven tile regeneration', () => {
  let result: RegenerateResult;

  beforeAll(() => {
    result = regenerateTiles(SEED);
  }, GEN_TIMEOUT_MS);

  it('regenerates the full Goldberg tile set for the frequency', () => {
    expect(result.tileCount).toBe(EXPECTED_TILE_COUNT);
    expect(result.tiles.length).toBe(EXPECTED_TILE_COUNT);
  });

  it('keeps pentagon + hex counts consistent with the tile total', () => {
    expect(result.pentagonCount).toBe(result.pentagonIndices.length);
    expect(result.pentagonCount + result.hexCount).toBe(result.tileCount);
    // A Goldberg polyhedron always has exactly 12 pentagons.
    expect(result.pentagonCount).toBe(12);
  });

  it('returns cities anchored to valid tile indices', () => {
    expect(result.cities.length).toBeGreaterThan(0);
    for (const c of result.cities) {
      expect(c.tileIndex).toBeGreaterThanOrEqual(0);
      expect(c.tileIndex).toBeLessThan(result.tileCount);
      expect(typeof c.id).toBe('string');
    }
  });
});

describe('regenerateTiles — determinism', () => {
  it('reproduces the same world for the same seed', () => {
    const a = regenerateTiles(SEED);
    const b = regenerateTiles(SEED);
    expect(b.tileCount).toBe(a.tileCount);
    expect(b.pentagonCount).toBe(a.pentagonCount);
    expect(b.cities.length).toBe(a.cities.length);
    expect(b.pentagonIndices).toEqual(a.pentagonIndices);
    // Spot-check tile payloads at both ends rather than deep-comparing 100k tiles.
    expect(b.tiles[0]).toEqual(a.tiles[0]);
    expect(b.tiles[b.tiles.length - 1]).toEqual(a.tiles[a.tiles.length - 1]);
  }, GEN_TIMEOUT_MS);
});
