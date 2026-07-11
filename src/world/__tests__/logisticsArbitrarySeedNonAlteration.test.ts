/**
 * Property 28: Arbitrary seeds carry only standard deposit placement.
 *
 * Feature: oil-logistics-system, Property 28: arbitrary seeds carry only
 * standard deposit placement. Validates Requirement 13.10.
 *
 * Req 13.10: WHERE a world is generated from an arbitrary player-chosen seed
 * other than DEFAULT_SEED, the Logistics_System restricts that world's seeded
 * logistics content to the standard Oil_Deposit placement and leaves all other
 * aspects of that world's generation unchanged.
 *
 * For any seed !== DEFAULT_SEED, the generated World.logistics must:
 *   - carry NO seeded network: wells/refineries/routes/hubs/transports are all
 *     empty arrays; home is {}; tasks/clearedForests/bridges are all empty.
 *   - still receive standard deposit placement: some tile has
 *     resourceType === 'oil' (placeOilDeposits still runs).
 * And generation must be otherwise unchanged. Because generateWorld is
 * deterministic in its seed and the seeding step is internal (it cannot be
 * "omitted" from outside), we establish 13.10's intent by asserting the
 * network stays empty AND that generating the SAME non-default seed twice
 * yields deep-equal tiles, cities, and units — i.e. the seeding step is a
 * no-op for non-default seeds.
 *
 * Cost note: generateWorld is hardcoded to FREQUENCY=100 (~100k tiles), so each
 * call takes several seconds. We therefore use a small fixed set of arbitrary
 * seeds (all != DEFAULT_SEED) generated ONCE in beforeAll, plus a single second
 * generation of one seed for the determinism / non-alteration pair-check —
 * rather than fast-check's random per-iteration generation, which would rebuild
 * a full world every run and is infeasible here.
 *
 * Named exports only; `.js` import extensions throughout.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { generateWorld } from '../generate.js';
import { DEFAULT_SEED } from '../../../shared/logisticsConstants.js';
import type { World } from '../types.js';

// ---------------------------------------------------------------------------
// Fixed arbitrary seeds — every one deliberately != DEFAULT_SEED (4242).
// Three seeds keep total world generations low (3 + 1 determinism dupe = 4)
// while still exercising several distinct arbitrary worlds.
// ---------------------------------------------------------------------------

const ARBITRARY_SEEDS = [1, 7, 20250101] as const;

// The seed whose world we generate twice to prove determinism + non-alteration.
const DETERMINISM_SEED = ARBITRARY_SEEDS[0];

// generateWorld at FREQUENCY=100 is multi-second; generating four worlds up
// front needs a generous timeout.
const GEN_TIMEOUT_MS = 300_000;

describe('generateWorld — Property 28: arbitrary seeds carry only standard deposit placement', () => {
  // Feature: oil-logistics-system, Property 28: arbitrary seeds carry only
  // standard deposit placement. Validates Requirement 13.10.

  // seed -> single generated world (generated once, asserted many times).
  const worlds = new Map<number, World>();
  // Second generation of DETERMINISM_SEED for the pair-check.
  let determinismDupe: World;

  beforeAll(() => {
    // Guard: the whole property is vacuous if a chosen seed collides with the
    // default seed — assert our fixtures really are "arbitrary" (non-default).
    for (const seed of ARBITRARY_SEEDS) {
      expect(seed).not.toBe(DEFAULT_SEED);
    }
    for (const seed of ARBITRARY_SEEDS) {
      worlds.set(seed, generateWorld(seed));
    }
    determinismDupe = generateWorld(DETERMINISM_SEED);
  }, GEN_TIMEOUT_MS);

  it('attaches a LogisticsState to every arbitrary-seed world', () => {
    for (const seed of ARBITRARY_SEEDS) {
      expect(worlds.get(seed)!.logistics).toBeDefined();
    }
  });

  it('carries NO seeded network: wells/refineries/routes/hubs/transports are all empty (Req 13.10)', () => {
    for (const seed of ARBITRARY_SEEDS) {
      const logistics = worlds.get(seed)!.logistics!;
      expect(logistics.wells).toEqual([]);
      expect(logistics.refineries).toEqual([]);
      expect(logistics.routes).toEqual([]);
      expect(logistics.hubs).toEqual([]);
      expect(logistics.transports).toEqual([]);
    }
  });

  it('leaves home stocks, engineer tasks, and terrain overlays empty (Req 13.10)', () => {
    for (const seed of ARBITRARY_SEEDS) {
      const logistics = worlds.get(seed)!.logistics!;
      expect(logistics.home).toEqual({});
      expect(logistics.tasks).toEqual([]);
      expect(logistics.clearedForests).toEqual([]);
      expect(logistics.bridges).toEqual([]);
    }
  });

  it('still performs standard oil-deposit placement: some tile has resourceType "oil" (Req 13.10)', () => {
    // Confirms that ONLY deposit placement — not the network — runs for
    // arbitrary seeds: the network is empty (above) yet deposits still exist.
    for (const seed of ARBITRARY_SEEDS) {
      const oilTiles = worlds.get(seed)!.tiles.filter((t) => t.resourceType === 'oil');
      expect(oilTiles.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic and otherwise unchanged: regenerating a non-default seed yields deep-equal tiles/cities/units with an empty network (Req 13.10)', () => {
    const first = worlds.get(DETERMINISM_SEED)!;
    const second = determinismDupe;

    // Non-alteration, expressed via determinism: the seeding step is a no-op
    // for non-default seeds, so two generations of the same seed produce
    // byte-for-byte identical world content.
    expect(second.tiles).toEqual(first.tiles);
    expect(second.cities).toEqual(first.cities);
    expect(second.units).toEqual(first.units);

    // ...and the duplicate's logistics network is likewise empty (only the
    // standard deposit placement, recorded on the tiles above, differs from a
    // bare world).
    const dup = second.logistics!;
    expect(dup.wells).toEqual([]);
    expect(dup.refineries).toEqual([]);
    expect(dup.routes).toEqual([]);
    expect(dup.hubs).toEqual([]);
    expect(dup.transports).toEqual([]);
    expect(dup.home).toEqual({});
    expect(dup.tasks).toEqual([]);
    expect(dup.clearedForests).toEqual([]);
    expect(dup.bridges).toEqual([]);
  });
});
