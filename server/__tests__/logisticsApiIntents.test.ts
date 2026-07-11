// Feature: oil-logistics-system, Task 13.5 — intent rejections + ownership recording.
//
// Unit tests for the authoritative logistics intent appliers in
// `server/logisticsApi.ts`. Two concerns:
//
//   1. Rejections are REJECT-AND-PRESERVE: a rejected intent returns `{ error }`
//      with the correct reason and leaves `MatchState.logistics` byte-for-byte
//      unchanged (asserted against a deep-clone snapshot). Covers insufficient
//      Refined_Product (Req 5.3), invalid route endpoints (Req 6.2), route
//      transport cap (Req 8.12), invalid hub placement (Req 11.2), and
//      other-player ownership (Req 12.3).
//   2. Successful construction records `ownerId === activeFaction` on the built
//      structure / engineer task (Structure_Owner, Req 12.1).
//
// Fixtures are minimal: a `MatchState` with an empty (or lightly-seeded)
// `LogisticsState`, a home stock funded or under-funded via the symbolic
// `CONSTRUCTION_COST` table, and small `Tile[]` arrays whose array index matches
// each tile's logical index. Named exports, `.js` imports.

import { describe, it, expect } from 'vitest';
import {
  applyBuildRefineryIntent,
  applyBuildRouteIntent,
  applyAddRefinerySegmentIntent,
  applyBuildDistributionHubIntent,
  applyPurchaseTransportIntent,
  applyUpgradeTransportIntent,
  applyBuildOilWellIntent,
} from '../logisticsApi.js';
import {
  CONSTRUCTION_COST,
  MAX_TRANSPORTS_PER_ROUTE,
} from '../../shared/logisticsConstants.js';
import type { MatchState } from '../../shared/matchTypes.js';
import type {
  LogisticsState,
  LogisticsRoute,
  Transport,
  Refinery,
  OilWell,
} from '../../shared/logisticsTypes.js';
import type { WireUnit } from '../../shared/wireTypes.js';
import type { Tile } from '../../src/world/types.js';

const FACTION = 'faction-a';
const OTHER = 'faction-b';

// ─── Fixture builders ─────────────────────────────────────────────────────────

function emptyLogistics(): LogisticsState {
  return {
    wells: [],
    refineries: [],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

function makeState(logistics: LogisticsState, units: WireUnit[] = []): MatchState {
  return {
    matchId: 'm',
    seed: 1,
    factions: [FACTION, OTHER],
    activeFactionIndex: 0,
    turn: 1,
    units,
    buildings: [],
    logistics,
    unitTurn: {},
    version: 1,
  };
}

/** Give the acting faction a home stock with `refinedProduct` refined product. */
function fundHome(logistics: LogisticsState, refinedProduct: number): void {
  logistics.home[FACTION] = { factionId: FACTION, refinedProduct, oil: 0 };
}

interface TileOpts {
  neighbours?: number[];
  terrainType?: Tile['terrainType'];
  forested?: boolean;
  segSteep?: number[];
  resourceType?: string;
  ownerId?: string;
}

/** A minimal flat land Tile whose array position equals its logical index. */
function makeTile(index: number, opts: TileOpts = {}): Tile {
  return {
    id: `t${index}`,
    index,
    sides: 6,
    neighbours: opts.neighbours ?? [],
    position3d: { x: 0, y: 0, z: 0 },
    boundary: [],
    terrainType: opts.terrainType ?? 'plains',
    height: 1,
    forested: opts.forested ?? false,
    segSteep: opts.segSteep ?? [0, 0, 0, 0, 0, 0],
    resourceType: opts.resourceType,
    ownerId: opts.ownerId,
  } as Tile;
}

function makeWell(id: string, tileIndex: number, ownerId = FACTION): OilWell {
  return { id, ownerId, tileIndex, segment: 0, storedOil: 0, hitPoints: 40, maxHitPoints: 40 };
}

function makeRoute(id: string, ownerId = FACTION): LogisticsRoute {
  return {
    id,
    ownerId,
    fromStructureId: 'well-1',
    toStructureId: 'home',
    segments: [0, 1],
    capacity: 100,
    tier: 'road',
    travelTime: 1,
    operable: true,
  };
}

function makeTransport(id: string, routeId: string, ownerId = FACTION): Transport {
  return {
    id,
    ownerId,
    routeId,
    cargoType: null,
    cargo: 0,
    cargoCapacity: 100,
    speed: 1,
    defence: 1,
    upgrades: 0,
    tier: 'van',
    inTransit: false,
    turnsRemaining: 0,
    unitId: `${id}-unit`,
  };
}

/** Deep snapshot of the logistics state for reject-and-preserve assertions. */
function snapshot(state: MatchState): LogisticsState {
  return structuredClone(state.logistics);
}

// ─── Rejections: reject-and-preserve ────────────────────────────────────────────

describe('logistics intent rejections (reject-and-preserve)', () => {
  it('rejects buildRefinery when Refined_Product is insufficient (Req 5.3)', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, CONSTRUCTION_COST.refineryFirstSegment - 1); // one short
    const state = makeState(logistics);
    const tiles = [makeTile(0)];
    const before = snapshot(state);

    const result = applyBuildRefineryIntent(state, tiles, FACTION, {
      kind: 'buildRefinery',
      tileIndex: 0,
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics.refineries).toHaveLength(0);
    expect(state.logistics.home[FACTION].refinedProduct).toBe(
      CONSTRUCTION_COST.refineryFirstSegment - 1,
    );
    expect(state.logistics).toEqual(before);
  });

  it('rejects buildRoute with identical endpoints (Req 6.2)', () => {
    const logistics = emptyLogistics();
    logistics.wells.push(makeWell('well-1', 0));
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const tiles = [makeTile(0, { neighbours: [] })];
    const before = snapshot(state);

    const result = applyBuildRouteIntent(state, tiles, FACTION, {
      kind: 'buildRoute',
      fromStructureId: 'well-1',
      toStructureId: 'well-1',
      path: [0],
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics.routes).toHaveLength(0);
    expect(state.logistics).toEqual(before);
  });

  it('rejects purchaseTransport when the route is at the transport cap (Req 8.12)', () => {
    const logistics = emptyLogistics();
    logistics.routes.push(makeRoute('route-1'));
    for (let i = 0; i < MAX_TRANSPORTS_PER_ROUTE; i++) {
      logistics.transports.push(makeTransport(`transport-${i}`, 'route-1'));
    }
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const before = snapshot(state);

    const result = applyPurchaseTransportIntent(state, [], FACTION, {
      kind: 'purchaseTransport',
      routeId: 'route-1',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics.transports).toHaveLength(MAX_TRANSPORTS_PER_ROUTE);
    expect(state.logistics).toEqual(before);
  });

  it('rejects an invalid distribution-hub placement (Req 11.2)', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const tiles = [makeTile(0, { neighbours: [1, 2, 3, 4, 5] })];
    const before = snapshot(state);

    const result = applyBuildDistributionHubIntent(state, tiles, FACTION, {
      kind: 'buildDistributionHub',
      tileIndex: 0,
      segment: 99, // out of range
      routeIds: [],
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics.hubs).toHaveLength(0);
    expect(state.logistics).toEqual(before);
  });

  it("rejects addRefinerySegment on another player's refinery (Req 12.3)", () => {
    const logistics = emptyLogistics();
    const refinery: Refinery = {
      id: 'refinery-1',
      ownerId: OTHER,
      tileIndex: 0,
      segments: [0],
      heldOil: 0,
      refinedProductAvailable: 0,
      hitPoints: 40,
      maxHitPoints: 40,
    };
    logistics.refineries.push(refinery);
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const tiles = [makeTile(0)];
    const before = snapshot(state);

    const result = applyAddRefinerySegmentIntent(state, tiles, FACTION, {
      kind: 'addRefinerySegment',
      refineryId: 'refinery-1',
      segment: 1,
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics.refineries[0].segments).toEqual([0]);
    expect(state.logistics).toEqual(before);
  });

  it("rejects upgradeTransport on another player's transport (Req 12.3)", () => {
    const logistics = emptyLogistics();
    logistics.routes.push(makeRoute('route-1'));
    logistics.transports.push(makeTransport('transport-1', 'route-1', OTHER));
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const before = snapshot(state);

    const result = applyUpgradeTransportIntent(state, [], FACTION, {
      kind: 'upgradeTransport',
      transportId: 'transport-1',
      stat: 'cargo',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics).toEqual(before);
  });
});

// ─── Ownership recording on successful construction (Req 12.1) ───────────────────

describe('ownership recording on constructed structures (Req 12.1)', () => {
  it('records ownerId on a built refinery', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, CONSTRUCTION_COST.refineryFirstSegment);
    const state = makeState(logistics);
    const tiles = [makeTile(0)];

    const result = applyBuildRefineryIntent(state, tiles, FACTION, {
      kind: 'buildRefinery',
      tileIndex: 0,
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.refineries).toHaveLength(1);
    expect(state.logistics.refineries[0].ownerId).toBe(FACTION);
  });

  it('records ownerId on a built route', () => {
    const logistics = emptyLogistics();
    logistics.wells.push(makeWell('well-1', 0));
    logistics.wells.push(makeWell('well-2', 1));
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const tiles = [
      makeTile(0, { neighbours: [1] }),
      makeTile(1, { neighbours: [0] }),
    ];

    const result = applyBuildRouteIntent(state, tiles, FACTION, {
      kind: 'buildRoute',
      fromStructureId: 'well-1',
      toStructureId: 'well-2',
      path: [0, 1],
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.routes).toHaveLength(1);
    expect(state.logistics.routes[0].ownerId).toBe(FACTION);
  });

  it('records ownerId on a purchased transport', () => {
    const logistics = emptyLogistics();
    logistics.routes.push(makeRoute('route-1'));
    fundHome(logistics, 10_000);
    const state = makeState(logistics);

    const result = applyPurchaseTransportIntent(state, [], FACTION, {
      kind: 'purchaseTransport',
      routeId: 'route-1',
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.transports).toHaveLength(1);
    expect(state.logistics.transports[0].ownerId).toBe(FACTION);
  });

  it('records ownerId on the engineer task started by buildOilWell', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, CONSTRUCTION_COST.oilWell);
    const engineer: WireUnit = {
      id: 'eng-1',
      label: 'Engineer',
      ownerId: FACTION,
      tileIndex: 0,
      segment: 0,
      facing: 0,
      attributes: { engineer: 3 },
      currentHealth: 10,
    };
    const state = makeState(logistics, [engineer]);
    const tiles = [makeTile(0, { resourceType: 'oil' })];

    const result = applyBuildOilWellIntent(state, tiles, FACTION, {
      kind: 'buildOilWell',
      unitId: 'eng-1',
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.tasks).toHaveLength(1);
    expect(state.logistics.tasks[0].kind).toBe('well');
    expect(state.logistics.tasks[0].ownerId).toBe(FACTION);
  });
});
