/**
 * Property 27: Seeded default network is deterministic and invariant-legal.
 *
 * Feature: oil-logistics-system, Property 27: Seeded default network is
 * deterministic and invariant-legal (deep-equal across invocations; satisfies
 * every field-level invariant, all entities `ownerId === homeFactionId`).
 *
 * Validates: Requirements 13.1, 13.8, 13.9
 *   13.9 — generating the Default_Test_World twice from the default seed yields an
 *          identical Seeded_Logistics_Network.
 *   13.1 — the seeded network is fully operational, i.e. every entity obeys the
 *          same field-level invariants (clamps/bounds) as a player-built network.
 *   13.8 — every seeded structure and Transportation_Unit belongs to the
 *          Home_Faction (`ownerId === homeFactionId`).
 *
 * Test strategy / iteration choice
 * --------------------------------
 * The Seeded_Logistics_Network exists ONLY when the world is generated with the
 * real `generateWorld(DEFAULT_SEED)` (it gates seeding on `seed === DEFAULT_SEED`),
 * so this test must call the real generator — there is no cheaper fixture that
 * produces the seeded network. `generateWorld` is fixed at FREQUENCY=100 (~100k
 * tiles) and is therefore expensive, so we do NOT drive this with a 100+ iteration
 * fast-check loop over random inputs: the seeded network is a single deterministic
 * instance, not a family parameterised by a random input. Instead we generate the
 * DEFAULT_SEED world a small number of times (twice, for the determinism check) and
 * assert the invariants EXHAUSTIVELY over every entity of the single generated
 * network. Determinism of the pure seeding step itself is additionally checked
 * cheaply by invoking `seedDefaultLogisticsNetwork` twice on fresh empty states
 * over the already-generated tiles (no extra world generation).
 *
 * Named exports only; `.js` import extensions throughout.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { generateWorld } from '../generate.js';
import {
  seedDefaultLogisticsNetwork,
  createEmptyLogisticsState,
} from '../logisticsSeed.js';
import { transportTier } from '../logistics.js';
import {
  DEFAULT_SEED,
  WELL_STORAGE_CAPACITY,
  ROUTE_CAPACITY_MIN,
  ROUTE_CAPACITY_MAX,
  TRANSPORT_CARGO_MIN,
  TRANSPORT_CARGO_MAX,
  HUB_STORAGE_CAPACITY,
  HOME_CITY_REFINED_PRODUCT_MAX,
} from '../../../shared/logisticsConstants.js';
import type { World } from '../types.js';
import type { LogisticsState } from '../../../shared/logisticsTypes.js';

// Full FREQUENCY=100 world generation is the dominant cost; two generations plus
// steepness/river passes comfortably fit inside a generous timeout.
const GEN_TIMEOUT_MS = 300_000;

/** Home_Faction id, matching how `generateWorld` derives it: cities[0].ownerId ?? id. */
function homeFactionOf(world: World): string {
  const home = world.cities[0];
  return home.ownerId ?? home.id;
}

describe('seedDefaultLogisticsNetwork — Property 27: deterministic and invariant-legal', () => {
  // Generate the DEFAULT_SEED world twice (Req 13.9 needs two full generations to
  // compare). worldA doubles as the source of tiles/entities for the legality and
  // ownership checks below, so no further generation is needed.
  let worldA: World;
  let worldB: World;
  let homeFactionId: string;

  beforeAll(() => {
    worldA = generateWorld(DEFAULT_SEED);
    worldB = generateWorld(DEFAULT_SEED);
    homeFactionId = homeFactionOf(worldA);
  }, GEN_TIMEOUT_MS);

  it(
    'seeds a populated network so the legality/ownership checks are non-vacuous',
    () => {
      const net = worldA.logistics as LogisticsState;
      // Sanity: the DEFAULT_SEED world must actually carry a seeded network, else
      // the exhaustive per-entity assertions below would pass vacuously.
      expect(net.wells.length).toBeGreaterThanOrEqual(1);
      expect(net.refineries.length).toBeGreaterThanOrEqual(1);
      expect(net.routes.length).toBeGreaterThanOrEqual(1);
      expect(net.hubs.length).toBeGreaterThanOrEqual(1);
      expect(net.transports.length).toBeGreaterThanOrEqual(1);
    },
    GEN_TIMEOUT_MS,
  );

  it(
    'Req 13.9 — generating the DEFAULT_SEED world twice yields a deep-equal logistics network',
    () => {
      // JSON deep-equal over the whole logistics container (wells, refineries,
      // routes, transports, hubs, home stock, tasks, overlays).
      expect(worldA.logistics).toEqual(worldB.logistics);
    },
    GEN_TIMEOUT_MS,
  );

  it(
    'Req 13.9 — seedDefaultLogisticsNetwork is deterministic on fresh states over the same tiles',
    () => {
      // Cheap determinism check of the pure seeding step itself (no extra world
      // generation): two fresh empty states seeded from identical tiles + faction
      // id must be deep-equal.
      const stateA = createEmptyLogisticsState();
      const stateB = createEmptyLogisticsState();
      seedDefaultLogisticsNetwork(stateA, worldA.tiles, homeFactionId);
      seedDefaultLogisticsNetwork(stateB, worldA.tiles, homeFactionId);
      expect(stateA).toEqual(stateB);

      // …and it reproduces the network embedded in the generated world.
      expect(stateA).toEqual(worldA.logistics);
    },
    GEN_TIMEOUT_MS,
  );

  it(
    'Req 13.1 — every seeded entity satisfies its field-level invariants',
    () => {
      const net = worldA.logistics as LogisticsState;

      // Oil_Wells: 0 <= storedOil <= WELL_STORAGE_CAPACITY (Req 3.2/3.6).
      for (const well of net.wells) {
        expect(Number.isInteger(well.storedOil)).toBe(true);
        expect(well.storedOil).toBeGreaterThanOrEqual(0);
        expect(well.storedOil).toBeLessThanOrEqual(WELL_STORAGE_CAPACITY);
        expect(well.hitPoints).toBeGreaterThan(0);
      }

      // Refineries: held/produced amounts are non-negative integers; >= 1 segment.
      for (const refinery of net.refineries) {
        expect(refinery.segments.length).toBeGreaterThanOrEqual(1);
        expect(refinery.heldOil).toBeGreaterThanOrEqual(0);
        expect(refinery.refinedProductAvailable).toBeGreaterThanOrEqual(0);
        expect(refinery.hitPoints).toBeGreaterThan(0);
      }

      // Routes: capacity in [MIN, MAX]; travelTime is a whole number >= 1 (Req 6.5, 7.3).
      for (const route of net.routes) {
        expect(route.capacity).toBeGreaterThanOrEqual(ROUTE_CAPACITY_MIN);
        expect(route.capacity).toBeLessThanOrEqual(ROUTE_CAPACITY_MAX);
        expect(route.travelTime).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(route.travelTime)).toBe(true);
      }

      // Transports: cargo in [0, cargoCapacity]; cargoCapacity in [MIN, MAX];
      // tier === transportTier(upgrades) (Req 8.3, 14.3–14.5).
      for (const transport of net.transports) {
        expect(transport.cargoCapacity).toBeGreaterThanOrEqual(TRANSPORT_CARGO_MIN);
        expect(transport.cargoCapacity).toBeLessThanOrEqual(TRANSPORT_CARGO_MAX);
        expect(transport.cargo).toBeGreaterThanOrEqual(0);
        expect(transport.cargo).toBeLessThanOrEqual(transport.cargoCapacity);
        expect(transport.upgrades).toBeGreaterThanOrEqual(0);
        expect(transport.tier).toBe(transportTier(transport.upgrades));
      }

      // Distribution_Hubs: 0 <= buffer <= HUB_STORAGE_CAPACITY (Req 11.3).
      for (const hub of net.hubs) {
        expect(hub.buffer).toBeGreaterThanOrEqual(0);
        expect(hub.buffer).toBeLessThanOrEqual(HUB_STORAGE_CAPACITY);
        expect(hub.hitPoints).toBeGreaterThan(0);
      }

      // Home_City Refined_Product in [0, HOME_CITY_REFINED_PRODUCT_MAX] (Req 5.5/5.7).
      for (const home of Object.values(net.home)) {
        expect(home.refinedProduct).toBeGreaterThanOrEqual(0);
        expect(home.refinedProduct).toBeLessThanOrEqual(HOME_CITY_REFINED_PRODUCT_MAX);
        expect(home.oil).toBeGreaterThanOrEqual(0);
      }
    },
    GEN_TIMEOUT_MS,
  );

  it(
    'Req 13.8 — every seeded structure and transport is owned by the Home_Faction',
    () => {
      const net = worldA.logistics as LogisticsState;

      for (const well of net.wells) expect(well.ownerId).toBe(homeFactionId);
      for (const refinery of net.refineries) expect(refinery.ownerId).toBe(homeFactionId);
      for (const route of net.routes) expect(route.ownerId).toBe(homeFactionId);
      for (const hub of net.hubs) expect(hub.ownerId).toBe(homeFactionId);
      for (const transport of net.transports) expect(transport.ownerId).toBe(homeFactionId);

      // The network's home stock is keyed by the Home_Faction id (connected to the
      // Home_City — Req 13.8).
      expect(net.home[homeFactionId]).toBeDefined();
    },
    GEN_TIMEOUT_MS,
  );
});
