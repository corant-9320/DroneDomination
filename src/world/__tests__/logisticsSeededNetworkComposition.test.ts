/**
 * Example test for the Seeded_Logistics_Network composition — Oil Logistics System.
 *
 * Feature: oil-logistics-system, seeded default-network composition.
 * Validates: Requirements 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8.
 *
 *   13.2 — the network includes >= 1 operational Oil_Well placed on an Oil_Deposit
 *          (its tile carries resourceType === 'oil').
 *   13.3 — the network includes a Refinery with two or more Refinery_Segments.
 *   13.4 — the network includes a Logistics_Route rendered as a Road.
 *   13.5 — the network includes a Logistics_Route rendered as a Highway.
 *   13.6 — the network includes a Distribution_Hub connecting two or more routes.
 *   13.7 — the network includes one Transportation_Unit of each Transport_Tier
 *          (van, truck, juggernaut), each assigned to a Logistics_Route.
 *   13.8 — every structure and Transportation_Unit belongs to the Home_Faction and
 *          the network is chained through to the Home_City.
 *
 * Test strategy
 * -------------
 * The seeded network is only built for the Default_Test_World (seed === DEFAULT_SEED),
 * via the real `generateWorld`. `generateWorld` is fixed at FREQUENCY=100 (~100k tiles)
 * and takes several seconds, so we generate the DEFAULT_SEED world exactly ONCE in
 * `beforeAll` and assert its composition across the cases below. This is an
 * example/unit test (no fast-check) as specified by the task.
 *
 * The Home_Faction id is derived exactly as `generateWorld` does:
 * `cities[0].ownerId ?? cities[0].id`.
 *
 * Named exports only; `.js` import extensions throughout.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { generateWorld } from '../generate.js';
import { DEFAULT_SEED } from '../../../shared/logisticsConstants.js';
import type { TransportTier } from '../../../shared/logisticsConstants.js';
import type { World } from '../types.js';
import type { LogisticsState } from '../../../shared/logisticsTypes.js';

// generateWorld at FREQUENCY=100 is multi-second; give the single generation a
// generous timeout.
const GEN_TIMEOUT_MS = 300_000;

describe('generateWorld(DEFAULT_SEED) — Seeded_Logistics_Network composition (Req 13.2–13.8)', () => {
  // Feature: oil-logistics-system, seeded default-network composition.
  // Validates: Requirements 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8.

  let world: World;
  let logistics: LogisticsState;
  let homeFactionId: string;

  beforeAll(() => {
    world = generateWorld(DEFAULT_SEED);
    expect(world.logistics).toBeDefined();
    logistics = world.logistics!;
    // Derived exactly as generate.ts does for the seeded network.
    expect(world.cities.length).toBeGreaterThan(0);
    homeFactionId = world.cities[0].ownerId ?? world.cities[0].id;
  }, GEN_TIMEOUT_MS);

  it('includes >= 1 operational Oil_Well seated on an oil-deposit tile (Req 13.2)', () => {
    expect(logistics.wells.length).toBeGreaterThanOrEqual(1);
    // A well only enters `state.wells` once its construction task completes, so
    // presence == operational. Assert at least one sits on an Oil_Deposit tile.
    const onOilDeposit = logistics.wells.filter(
      (w) => world.tiles[w.tileIndex]?.resourceType === 'oil',
    );
    expect(onOilDeposit.length).toBeGreaterThanOrEqual(1);
  });

  it('includes a Refinery with two or more Refinery_Segments (Req 13.3)', () => {
    const multiSegment = logistics.refineries.filter((r) => r.segments.length >= 2);
    expect(multiSegment.length).toBeGreaterThanOrEqual(1);
  });

  it('includes a Logistics_Route rendered as a Road (Req 13.4)', () => {
    expect(logistics.routes.some((r) => r.tier === 'road')).toBe(true);
  });

  it('includes a Logistics_Route rendered as a Highway (Req 13.5)', () => {
    expect(logistics.routes.some((r) => r.tier === 'highway')).toBe(true);
  });

  it('includes a Distribution_Hub connecting two or more routes (Req 13.6)', () => {
    const connectingHub = logistics.hubs.filter((h) => h.routeIds.length >= 2);
    expect(connectingHub.length).toBeGreaterThanOrEqual(1);
    // The hub's connected routes must be real routes in the network.
    const routeIds = new Set(logistics.routes.map((r) => r.id));
    for (const h of connectingHub) {
      for (const rid of h.routeIds) {
        expect(routeIds.has(rid)).toBe(true);
      }
    }
  });

  it('includes one Transportation_Unit of each Transport_Tier, each assigned to a route (Req 13.7)', () => {
    const tiers = new Set<TransportTier>(logistics.transports.map((t) => t.tier));
    expect(tiers.has('van')).toBe(true);
    expect(tiers.has('truck')).toBe(true);
    expect(tiers.has('juggernaut')).toBe(true);

    // Every transport is assigned to a real Logistics_Route.
    const routeIds = new Set(logistics.routes.map((r) => r.id));
    for (const t of logistics.transports) {
      expect(routeIds.has(t.routeId)).toBe(true);
    }
  });

  it('owns every structure and transport with the Home_Faction (Req 13.8)', () => {
    for (const w of logistics.wells) expect(w.ownerId).toBe(homeFactionId);
    for (const r of logistics.refineries) expect(r.ownerId).toBe(homeFactionId);
    for (const route of logistics.routes) expect(route.ownerId).toBe(homeFactionId);
    for (const h of logistics.hubs) expect(h.ownerId).toBe(homeFactionId);
    for (const t of logistics.transports) expect(t.ownerId).toBe(homeFactionId);
  });

  it('seats at least one Distribution_Hub inside the Home_City, and no well/refinery in any city', () => {
    // The in-city hub fuels the Home_City's upgrades (placement rule: at least
    // one hub must sit inside the city). Wells and refineries are map-only and
    // must never sit on a city tile.
    const isCityTile = (idx: number) => {
      const c = world.tiles[idx]?.cityId;
      return typeof c === 'string' && c.length > 0;
    };
    const homeTile = world.tiles.find((t) => t.cityId === homeFactionId);
    expect(homeTile).toBeDefined();

    const inCityHubs = logistics.hubs.filter((h) => h.tileIndex === homeTile!.index);
    expect(inCityHubs.length).toBeGreaterThanOrEqual(1);

    for (const w of logistics.wells) expect(isCityTile(w.tileIndex)).toBe(false);
    for (const r of logistics.refineries) expect(isCityTile(r.tileIndex)).toBe(false);
  });

  it('chains the network through to the Home_City (Req 13.8)', () => {
    // The Home_City tile is the tile carrying the home faction's city id.
    const homeTile = world.tiles.find((t) => t.cityId === homeFactionId);
    expect(homeTile).toBeDefined();

    // At least one route terminates at the Home_City — either its from/to
    // structure id equals the home city id (== home faction id), or one of its
    // endpoint segments is the Home_City tile.
    const terminatesAtHome = logistics.routes.some((r) => {
      if (r.fromStructureId === homeFactionId || r.toStructureId === homeFactionId) {
        return true;
      }
      const endpoints = [r.segments[0], r.segments[r.segments.length - 1]];
      return endpoints.includes(homeTile!.index);
    });
    expect(terminatesAtHome).toBe(true);
  });
});
