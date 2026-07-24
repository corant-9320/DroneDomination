// Regression + coverage for the shuttle-transport intent appliers
// (server/logistics/shuttle.ts): applyCreateShuttleTransportIntent,
// applyStopShuttleTransportIntent.
//
// Regression: the reported bug was "selected the refinery hex as destination
// but it says there was no road to that hex, but there was" — the shuttle
// creation check only searched `logistics.routes` (real LogisticsRoute
// entities), but the only road-building UI actually wired up in the game is
// the God Mode "Build Road" action, which records a `standaloneRoadSegments`
// overlay instead. This suite asserts creation succeeds when the two
// structures are connected ONLY by a standalone overlay, and still rejects
// when genuinely no road exists.

import { describe, it, expect } from 'vitest';
import {
  applyCreateShuttleTransportIntent,
  applyStopShuttleTransportIntent,
} from '../logistics/shuttle.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import type { MatchState } from '../../shared/matchTypes.js';
import type { LogisticsState, OilWell, Refinery, Transport } from '../../shared/logisticsTypes.js';
import type { Tile } from '../../src/world/types.js';
import { encodeSeg } from '../../shared/segmentGraph.js';

const FACTION = 'faction-a';
const OTHER = 'faction-b';

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

function makeState(logistics: LogisticsState): MatchState {
  return {
    matchId: 'm',
    seed: 1,
    factions: [FACTION, OTHER],
    activeFactionIndex: 0,
    turn: 1,
    units: [],
    buildings: [],
    logistics,
    unitTurn: {},
    version: 1,
  };
}

function fundHome(logistics: LogisticsState, refinedProduct: number): void {
  logistics.home[FACTION] = { factionId: FACTION, refinedProduct, oil: 0 };
}

/** A linear chain of n hex tiles: tile i is adjacent to i-1 and i+1. */
function makeChain(n: number): Tile[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    index: i,
    sides: 6,
    neighbours: [i - 1, i + 1].filter((x) => x >= 0 && x < n),
    position3d: { x: 0, y: 0, z: 0 },
    boundary: [],
    terrainType: 'plains',
    height: 1,
    forested: false,
    segSteep: [0, 0, 0, 0, 0, 0],
  } as Tile));
}

/** A genuinely segment-graph-adjacent road path from tile 0 to tile n-1. */
function chainRoadKeys(tiles: Tile[]): number[] {
  const n = tiles.length;
  if (n === 1) return [encodeSeg(0, 0)];
  const keys: number[] = [encodeSeg(0, tiles[0].neighbours.indexOf(1))];
  for (let i = 1; i < n; i++) {
    const arrival = tiles[i].neighbours.indexOf(i - 1);
    keys.push(encodeSeg(i, arrival));
    if (i < n - 1) {
      const departure = tiles[i].neighbours.indexOf(i + 1);
      if (departure !== arrival) keys.push(encodeSeg(i, departure));
    }
  }
  return keys;
}

function makeWell(id: string, tileIndex: number, segment: number, ownerId = FACTION): OilWell {
  return { id, ownerId, tileIndex, segment, storedOil: 0, hitPoints: 40, maxHitPoints: 40 };
}

function makeRefinery(id: string, tileIndex: number, segments: number[], ownerId = FACTION): Refinery {
  return {
    id, ownerId, tileIndex, segments,
    heldOil: 0, refinedProductAvailable: 0, hitPoints: 40, maxHitPoints: 40,
  };
}

describe('applyCreateShuttleTransportIntent', () => {
  it('regression: succeeds when the two structures are connected only by a standalone road overlay (God Mode "Build Road"), not a LogisticsRoute', () => {
    const n = 5;
    const tiles = makeChain(n);
    const roadKeys = chainRoadKeys(tiles);

    const logistics = emptyLogistics();
    // Well and refinery sit on segments distinct from the road path itself,
    // mirroring how a structure's footprint segment differs from the road
    // segment that serves it.
    const wellSegment = (tiles[0].neighbours.indexOf(1) + 1) % 6;
    const refinerySegment = (tiles[n - 1].neighbours.indexOf(n - 2) + 1) % 6;
    logistics.wells.push(makeWell('well-1', 0, wellSegment));
    logistics.refineries.push(makeRefinery('refinery-1', n - 1, [refinerySegment]));
    logistics.standaloneRoadSegments = roadKeys;
    fundHome(logistics, 10_000);
    const state = makeState(logistics);

    const result = applyCreateShuttleTransportIntent(state, tiles, FACTION, {
      kind: 'createShuttleTransport',
      fromStructureId: 'well-1',
      toStructureId: 'refinery-1',
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.transports).toHaveLength(1);
    const transport = state.logistics.transports[0];
    expect(transport.ownerId).toBe(FACTION);
    expect(transport.shuttleMode).toBe(true);
    expect(transport.shuttlePath).toBeDefined();
    expect(transport.shuttlePath!.length).toBeGreaterThanOrEqual(2);
    expect(transport.shuttlePosition).toBe(0);
    expect(transport.shuttleDirection).toBe(1);
    expect(transport.shuttleStopped).toBe(false);
    expect(transport.cargo).toBe(0);
    expect(transport.cargoType).toBeNull();
  });

  it('succeeds when connected by a real LogisticsRoute', () => {
    const n = 4;
    const tiles = makeChain(n);
    const roadKeys = chainRoadKeys(tiles);

    const logistics = emptyLogistics();
    logistics.wells.push(makeWell('well-1', 0, 0));
    logistics.refineries.push(makeRefinery('refinery-1', n - 1, [0]));
    logistics.routes.push({
      id: 'route-1',
      ownerId: FACTION,
      fromStructureId: 'well-1',
      toStructureId: 'refinery-1',
      segments: roadKeys,
      capacity: 100,
      tier: 'road',
      travelTime: 1,
      operable: true,
    });
    fundHome(logistics, 10_000);
    const state = makeState(logistics);

    const result = applyCreateShuttleTransportIntent(state, tiles, FACTION, {
      kind: 'createShuttleTransport',
      fromStructureId: 'well-1',
      toStructureId: 'refinery-1',
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.transports).toHaveLength(1);
  });

  it('rejects when genuinely no road connects the two structures (reject-and-preserve)', () => {
    const n = 5;
    const tiles = makeChain(n);
    const logistics = emptyLogistics();
    logistics.wells.push(makeWell('well-1', 0, 0));
    logistics.refineries.push(makeRefinery('refinery-1', n - 1, [0]));
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const before = structuredClone(state.logistics);

    const result = applyCreateShuttleTransportIntent(state, tiles, FACTION, {
      kind: 'createShuttleTransport',
      fromStructureId: 'well-1',
      toStructureId: 'refinery-1',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics).toEqual(before);
  });

  it("rejects when the destination structure belongs to another player (reject-and-preserve)", () => {
    const n = 3;
    const tiles = makeChain(n);
    const roadKeys = chainRoadKeys(tiles);
    const logistics = emptyLogistics();
    logistics.wells.push(makeWell('well-1', 0, 0));
    logistics.refineries.push(makeRefinery('refinery-1', n - 1, [0], OTHER));
    logistics.standaloneRoadSegments = roadKeys;
    fundHome(logistics, 10_000);
    const state = makeState(logistics);
    const before = structuredClone(state.logistics);

    const result = applyCreateShuttleTransportIntent(state, tiles, FACTION, {
      kind: 'createShuttleTransport',
      fromStructureId: 'well-1',
      toStructureId: 'refinery-1',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics).toEqual(before);
  });

  it('rejects insufficient Refined_Product (reject-and-preserve)', () => {
    const n = 3;
    const tiles = makeChain(n);
    const roadKeys = chainRoadKeys(tiles);
    const logistics = emptyLogistics();
    logistics.wells.push(makeWell('well-1', 0, 0));
    logistics.refineries.push(makeRefinery('refinery-1', n - 1, [0]));
    logistics.standaloneRoadSegments = roadKeys;
    fundHome(logistics, CONSTRUCTION_COST.transportUnit - 1);
    const state = makeState(logistics);
    const before = structuredClone(state.logistics);

    const result = applyCreateShuttleTransportIntent(state, tiles, FACTION, {
      kind: 'createShuttleTransport',
      fromStructureId: 'well-1',
      toStructureId: 'refinery-1',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics).toEqual(before);
  });
});

describe('applyStopShuttleTransportIntent', () => {
  function makeShuttle(id: string, ownerId = FACTION): Transport {
    return {
      id, ownerId, routeId: '', cargoType: null, cargo: 0, cargoCapacity: 5,
      speed: 1, defence: 1, upgrades: 0, tier: 'van', inTransit: false, turnsRemaining: 0,
      unitId: `${id}-unit`, shuttleMode: true, shuttlePath: [0, 1, 2], shuttlePosition: 1,
      shuttleDirection: 1, shuttleStopped: false,
    };
  }

  it('stops an owned shuttle', () => {
    const logistics = emptyLogistics();
    logistics.transports.push(makeShuttle('t1'));
    const state = makeState(logistics);

    const result = applyStopShuttleTransportIntent(state, [], FACTION, {
      kind: 'stopShuttleTransport',
      transportId: 't1',
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.transports[0].shuttleStopped).toBe(true);
  });

  it("rejects stopping another player's shuttle (reject-and-preserve)", () => {
    const logistics = emptyLogistics();
    logistics.transports.push(makeShuttle('t1', OTHER));
    const state = makeState(logistics);
    const before = structuredClone(state.logistics);

    const result = applyStopShuttleTransportIntent(state, [], FACTION, {
      kind: 'stopShuttleTransport',
      transportId: 't1',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics).toEqual(before);
  });

  it('rejects stopping a non-shuttle transport (reject-and-preserve)', () => {
    const logistics = emptyLogistics();
    logistics.transports.push({
      id: 't1', ownerId: FACTION, routeId: 'route-1', cargoType: null, cargo: 0, cargoCapacity: 5,
      speed: 1, defence: 1, upgrades: 0, tier: 'van', inTransit: false, turnsRemaining: 0,
      unitId: 't1-unit',
    });
    const state = makeState(logistics);
    const before = structuredClone(state.logistics);

    const result = applyStopShuttleTransportIntent(state, [], FACTION, {
      kind: 'stopShuttleTransport',
      transportId: 't1',
    });

    expect(result.error).toBeTruthy();
    expect(state.logistics).toEqual(before);
  });
});
