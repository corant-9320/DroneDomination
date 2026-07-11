/**
 * Round-trip serialization coverage for the logistics wire payload (Task 12.3).
 *
 * `toCompactWorld` (src/world/compact.ts) copies `logistics` straight onto the
 * WireWorld — the wire and authoritative `LogisticsState` shapes are identical
 * (unlike tiles/units, there is no field-name mapping). Because there is NO
 * separate expand function in `compact.ts` (the production expand lives
 * client-side in `client/worldData.ts`), this test asserts the round-trip at the
 * serialize boundary:
 *
 *   1. `wireWorld.logistics` deep-equals the input `LogisticsState` (the
 *      straight-copy serialization preserves every field), and
 *   2. `JSON.parse(JSON.stringify(wireWorld)).logistics` deep-equals the input
 *      (the payload survives wire transit unchanged).
 *
 * The fixture populates at least one of every entity so no array is empty:
 * a well, a refinery with 2 segments, a road + a highway route, a van/truck/
 * juggernaut transport, a hub, a home stock, an engineer task, a cleared-forest
 * index, and a bridge index — all fully typed per `shared/logisticsTypes.ts`.
 */

import { describe, it, expect } from 'vitest';
import { toCompactWorld } from '../compact.js';
import type {
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
} from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Populated fixture — one of each entity, every array non-empty.
// ---------------------------------------------------------------------------

function buildPopulatedLogisticsState(): LogisticsState {
  const well: OilWell = {
    id: 'well-1',
    ownerId: 'faction-a',
    tileIndex: 10,
    segment: 2,
    storedOil: 40,
    hitPoints: 100,
    maxHitPoints: 100,
  };

  const refinery: Refinery = {
    id: 'refinery-1',
    ownerId: 'faction-a',
    tileIndex: 12,
    segments: [0, 1],
    heldOil: 30,
    refinedProductAvailable: 15,
    hitPoints: 200,
    maxHitPoints: 200,
  };

  const roadRoute: LogisticsRoute = {
    id: 'route-road-1',
    ownerId: 'faction-a',
    fromStructureId: 'well-1',
    toStructureId: 'hub-1',
    segments: [10, 11, 12],
    capacity: 100,
    tier: 'road',
    travelTime: 3,
    operable: true,
  };

  const highwayRoute: LogisticsRoute = {
    id: 'route-highway-1',
    ownerId: 'faction-a',
    fromStructureId: 'hub-1',
    toStructureId: 'home-a',
    segments: [12, 13, 14, 15],
    capacity: 300,
    tier: 'highway',
    travelTime: 2,
    operable: true,
  };

  const vanTransport: Transport = {
    id: 'transport-van-1',
    ownerId: 'faction-a',
    routeId: 'route-road-1',
    cargoType: 'oil',
    cargo: 20,
    cargoCapacity: 50,
    speed: 2,
    defence: 1,
    upgrades: 0,
    tier: 'van',
    inTransit: true,
    turnsRemaining: 2,
    unitId: 'unit-van-1',
  };

  const truckTransport: Transport = {
    id: 'transport-truck-1',
    ownerId: 'faction-a',
    routeId: 'route-highway-1',
    cargoType: 'product',
    cargo: 100,
    cargoCapacity: 200,
    speed: 3,
    defence: 2,
    upgrades: 2,
    tier: 'truck',
    inTransit: false,
    turnsRemaining: 0,
    unitId: 'unit-truck-1',
  };

  const juggernautTransport: Transport = {
    id: 'transport-jugg-1',
    ownerId: 'faction-a',
    routeId: 'route-highway-1',
    cargoType: null,
    cargo: 0,
    cargoCapacity: 500,
    speed: 4,
    defence: 4,
    upgrades: 4,
    tier: 'juggernaut',
    inTransit: false,
    turnsRemaining: 0,
    unitId: 'unit-jugg-1',
  };

  const hub: DistributionHub = {
    id: 'hub-1',
    ownerId: 'faction-a',
    tileIndex: 12,
    segment: 3,
    buffer: 120,
    routeIds: ['route-road-1', 'route-highway-1'],
    hitPoints: 150,
    maxHitPoints: 150,
  };

  const homeStock: HomeStock = {
    factionId: 'faction-a',
    refinedProduct: 500,
    oil: 80,
  };

  const task: EngineerTask = {
    id: 'task-1',
    kind: 'well',
    unitId: 'engineer-1',
    tileIndex: 20,
    segment: 4,
    turnsRemaining: 3,
    ownerId: 'faction-a',
  };

  return {
    wells: [well],
    refineries: [refinery],
    routes: [roadRoute, highwayRoute],
    transports: [vanTransport, truckTransport, juggernautTransport],
    hubs: [hub],
    home: { 'faction-a': homeStock },
    tasks: [task],
    clearedForests: [30],
    bridges: [40],
  };
}

// ---------------------------------------------------------------------------
// Task 12.3
// ---------------------------------------------------------------------------

describe('logistics wire-format round-trip', () => {
  // Feature: oil-logistics-system, Task 12.3: round-trip serialization of a
  // populated LogisticsState through toCompactWorld preserves every field, and
  // the payload survives JSON wire transit unchanged.
  // Validates: Requirements 5.5, 6.4, 12.1
  it('copies a populated LogisticsState onto the wire payload preserving every field', () => {
    const state = buildPopulatedLogisticsState();

    // Non-logistics args: empty arrays are valid — toCompactWorld maps tiles/units
    // but empty arrays map to empty arrays.
    const wireWorld = toCompactWorld(42, [], [], [], [], [], state);

    // Sanity: every array in the fixture is non-empty (one of each entity).
    expect(state.wells.length).toBeGreaterThan(0);
    expect(state.refineries[0].segments).toHaveLength(2);
    expect(state.routes.map((r) => r.tier)).toEqual(['road', 'highway']);
    expect(state.transports.map((t) => t.tier)).toEqual(['van', 'truck', 'juggernaut']);
    expect(state.hubs.length).toBeGreaterThan(0);
    expect(Object.keys(state.home).length).toBeGreaterThan(0);
    expect(state.tasks.length).toBeGreaterThan(0);
    expect(state.clearedForests.length).toBeGreaterThan(0);
    expect(state.bridges.length).toBeGreaterThan(0);

    // Straight-copy serialization: structural equality with the input.
    expect(wireWorld.logistics).toEqual(state);
  });

  it('survives JSON wire transit with structural equality preserved', () => {
    const state = buildPopulatedLogisticsState();
    const wireWorld = toCompactWorld(42, [], [], [], [], [], state);

    const rebuilt = JSON.parse(JSON.stringify(wireWorld)) as typeof wireWorld;

    expect(rebuilt.logistics).toEqual(state);
  });

  it('omits the logistics payload when none is provided', () => {
    const wireWorld = toCompactWorld(42, [], [], [], [], []);
    expect(wireWorld.logistics).toBeUndefined();
  });
});
