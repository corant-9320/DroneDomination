/**
 * No world seed ships with pre-built oil infrastructure.
 *
 * Every seed — including the fixed DEFAULT_SEED used for the committed
 * Default_Test_World — must generate an EMPTY LogisticsState (no wells,
 * refineries, routes, hubs, or transports). Standard Oil_Deposit tile
 * placement still runs unconditionally for every seed (`placeOilDeposits`),
 * so it is only the built infrastructure that is universally absent.
 *
 * This replaces the earlier Req 13.10 "arbitrary seed" property, which
 * distinguished a special DEFAULT_SEED that shipped with a Seeded_Logistics_Network.
 * That distinction has been removed: no seed seeds infrastructure.
 *
 * Cost note: generateWorld is hardcoded to FREQUENCY=100 (~100k tiles), so each
 * call takes several seconds. We use a small fixed set of seeds (including
 * DEFAULT_SEED) generated ONCE in beforeAll, plus a single second generation of
 * one seed for the determinism / non-alteration pair-check — rather than
 * fast-check's random per-iteration generation, which would rebuild a full
 * world every run and is infeasible here.
 *
 * Named exports only; `.js` import extensions throughout.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { generateWorld } from '../generate.js';
import { DEFAULT_SEED } from '../../../shared/logisticsConstants.js';
import type { World } from '../types.js';

// ---------------------------------------------------------------------------
// Fixed seeds — includes DEFAULT_SEED itself to prove it is no longer special.
// ---------------------------------------------------------------------------

const TEST_SEEDS = [DEFAULT_SEED, 1, 7, 20250101] as const;

// The seed whose world we generate twice to prove determinism + non-alteration.
const DETERMINISM_SEED = TEST_SEEDS[0];

// generateWorld at FREQUENCY=100 is multi-second; generating five worlds up
// front needs a generous timeout.
const GEN_TIMEOUT_MS = 300_000;

describe('generateWorld — no seed ships with pre-built oil infrastructure', () => {
  // seed -> single generated world (generated once, asserted many times).
  const worlds = new Map<number, World>();
  // Second generation of DETERMINISM_SEED for the pair-check.
  let determinismDupe: World;

  beforeAll(() => {
    for (const seed of TEST_SEEDS) {
      worlds.set(seed, generateWorld(seed));
    }
    determinismDupe = generateWorld(DETERMINISM_SEED);
  }, GEN_TIMEOUT_MS);

  it('attaches a LogisticsState to every world regardless of seed', () => {
    for (const seed of TEST_SEEDS) {
      expect(worlds.get(seed)!.logistics).toBeDefined();
    }
  });

  it('carries NO built infrastructure for any seed: wells/refineries/routes/hubs/transports are all empty', () => {
    for (const seed of TEST_SEEDS) {
      const logistics = worlds.get(seed)!.logistics!;
      expect(logistics.wells).toEqual([]);
      expect(logistics.refineries).toEqual([]);
      expect(logistics.routes).toEqual([]);
      expect(logistics.hubs).toEqual([]);
      expect(logistics.transports).toEqual([]);
    }
  });

  it('leaves home stocks, engineer tasks, and terrain overlays empty for every seed', () => {
    for (const seed of TEST_SEEDS) {
      const logistics = worlds.get(seed)!.logistics!;
      expect(logistics.home).toEqual({});
      expect(logistics.tasks).toEqual([]);
      expect(logistics.clearedForests).toEqual([]);
      expect(logistics.bridges).toEqual([]);
    }
  });

  it('still performs standard oil-deposit placement for every seed: some tile has resourceType "oil"', () => {
    // Confirms that deposit placement runs universally even though the
    // network stays empty (above).
    for (const seed of TEST_SEEDS) {
      const oilTiles = worlds.get(seed)!.tiles.filter((t) => t.resourceType === 'oil');
      expect(oilTiles.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic and otherwise unchanged: regenerating a seed yields deep-equal tiles/cities/units with an empty network', () => {
    const first = worlds.get(DETERMINISM_SEED)!;
    const second = determinismDupe;

    expect(second.tiles).toEqual(first.tiles);
    expect(second.cities).toEqual(first.cities);
    expect(second.units).toEqual(first.units);

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
