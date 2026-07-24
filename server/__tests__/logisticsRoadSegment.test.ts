// Feature: engineer road building (Phase 1) — one segment at a time.
//
// Covers the two new code paths:
//   1. `applyBuildRoadSegmentIntent` — an Engineer_Unit paves the segment it is
//      standing on, producing a timed `road` EngineerTask. Rejections are
//      reject-and-preserve (state left byte-for-byte unchanged).
//   2. `resolveLogisticsTurn` stage 1 — a finished `road` task appends its
//      encoded segment key to `standaloneRoadSegments` and the task is dropped.
//
// Behaviour, not balance: task duration is asserted via `engineerTaskDuration`
// rather than a pinned turn count, so an ENGINEER_TASK_BASE change won't break
// these tests.

import { describe, it, expect } from 'vitest';
import { applyBuildRoadSegmentIntent } from '../logistics/bridgesAndForest.js';
import { GOD_MODE_LOGISTICS_POLICY } from '../logistics/context.js';
import { engineerTaskDuration } from '../../src/world/logistics/tasks.js';
import { resolveLogisticsTurn } from '../../src/world/logistics/turn.js';
import { CONSTRUCTION_COST } from '../../shared/logisticsConstants.js';
import { encodeSeg } from '../../shared/segmentGraph.js';
import type { MatchState } from '../../shared/matchTypes.js';
import type { LogisticsState, LogisticsTile } from '../../shared/logisticsTypes.js';
import type { WireUnit } from '../../shared/wireTypes.js';
import type { Tile } from '../../src/world/types.js';

const FACTION = 'faction-a';
const OTHER = 'faction-b';
const TILE = 0;
const SEG = 2;

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

function fundHome(logistics: LogisticsState, refinedProduct: number): void {
  logistics.home[FACTION] = { factionId: FACTION, refinedProduct, oil: 0 };
}

function makeTile(opts: { forested?: boolean; terrainType?: Tile['terrainType'] } = {}): Tile {
  return {
    id: `t${TILE}`,
    index: TILE,
    sides: 6,
    neighbours: [],
    position3d: { x: 0, y: 0, z: 0 },
    boundary: [],
    terrainType: opts.terrainType ?? 'plains',
    height: 1,
    forested: opts.forested ?? false,
    segSteep: [0, 0, 0, 0, 0, 0],
  } as Tile;
}

/** An engineer standing on TILE/SEG with the given engineer attribute. */
function makeEngineer(engineer: number, ownerId = FACTION): WireUnit {
  return {
    id: 'eng-1',
    ownerId,
    tileIndex: TILE,
    segment: SEG,
    facing: 0,
    attributes: { size: 1, engineer, wheeledMovement: 1 },
    currentHealth: 10,
  } as unknown as WireUnit;
}

const AFFORDABLE = CONSTRUCTION_COST.routeRoadPerSegment;

describe('applyBuildRoadSegmentIntent — engineer paves its own segment', () => {
  it('queues a road task on the engineer\'s own tile and segment', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE);
    const state = makeState(logistics, [makeEngineer(3)]);

    const result = applyBuildRoadSegmentIntent(state, [makeTile()], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toBeUndefined();
    expect(state.logistics.tasks).toHaveLength(1);
    const task = state.logistics.tasks[0];
    expect(task.kind).toBe('road');
    expect(task.tileIndex).toBe(TILE);
    expect(task.segment).toBe(SEG);
    expect(task.ownerId).toBe(FACTION);
    expect(task.unitId).toBe('eng-1');
    // Duration follows the shared engineer-task curve, not a pinned constant.
    expect(task.turnsRemaining).toBe(engineerTaskDuration(3));
  });

  it('charges the per-segment road cost', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE + 15);
    const state = makeState(logistics, [makeEngineer(1)]);

    applyBuildRoadSegmentIntent(state, [makeTile()], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(state.logistics.home[FACTION].refinedProduct).toBe(15);
  });

  it('does not charge under the development God Mode policy', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, 0);
    const state = makeState(logistics, [makeEngineer(1)]);

    const result = applyBuildRoadSegmentIntent(
      state,
      [makeTile()],
      FACTION,
      { kind: 'buildRoadSegment', unitId: 'eng-1' },
      GOD_MODE_LOGISTICS_POLICY,
    );

    expect(result.error).toBeUndefined();
    expect(state.logistics.tasks).toHaveLength(1);
  });

  it('rejects a non-engineer unit and preserves state', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE);
    const state = makeState(logistics, [makeEngineer(0)]);
    const before = structuredClone(state.logistics);

    const result = applyBuildRoadSegmentIntent(state, [makeTile()], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toMatch(/engineer/i);
    expect(state.logistics).toEqual(before);
  });

  it("rejects another faction's unit and preserves state", () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE);
    const state = makeState(logistics, [makeEngineer(3, OTHER)]);
    const before = structuredClone(state.logistics);

    const result = applyBuildRoadSegmentIntent(state, [makeTile()], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toBeDefined();
    expect(state.logistics).toEqual(before);
  });

  it('rejects a segment that already carries a road and preserves state', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE);
    logistics.standaloneRoadSegments = [encodeSeg(TILE, SEG)];
    const state = makeState(logistics, [makeEngineer(3)]);
    const before = structuredClone(state.logistics);

    const result = applyBuildRoadSegmentIntent(state, [makeTile()], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toMatch(/already occupied/i);
    expect(state.logistics).toEqual(before);
  });

  it('rejects a duplicate pending road task on the same segment', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE * 2);
    const state = makeState(logistics, [makeEngineer(3)]);
    const tiles = [makeTile()];

    applyBuildRoadSegmentIntent(state, tiles, FACTION, { kind: 'buildRoadSegment', unitId: 'eng-1' });
    const result = applyBuildRoadSegmentIntent(state, tiles, FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toMatch(/already occupied/i);
    expect(state.logistics.tasks).toHaveLength(1);
  });

  it('rejects an uncleared forest tile and preserves state', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE);
    const state = makeState(logistics, [makeEngineer(3)]);
    const before = structuredClone(state.logistics);

    const result = applyBuildRoadSegmentIntent(state, [makeTile({ forested: true })], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toMatch(/forest/i);
    expect(state.logistics).toEqual(before);
  });

  it('rejects insufficient Refined_Product and preserves state', () => {
    const logistics = emptyLogistics();
    fundHome(logistics, AFFORDABLE - 1);
    const state = makeState(logistics, [makeEngineer(3)]);
    const before = structuredClone(state.logistics);

    const result = applyBuildRoadSegmentIntent(state, [makeTile()], FACTION, {
      kind: 'buildRoadSegment',
      unitId: 'eng-1',
    });

    expect(result.error).toMatch(/insufficient/i);
    expect(state.logistics).toEqual(before);
  });
});

describe('resolveLogisticsTurn — road task completion', () => {
  const TILES: LogisticsTile[] = [
    { index: 0, neighbours: [1], terrainType: 'plains', height: 0, forested: false },
    { index: 1, neighbours: [0], terrainType: 'plains', height: 0, forested: false },
  ];

  /** State holding a single road task that completes after `turnsRemaining` turns. */
  function stateWithRoadTask(turnsRemaining: number): LogisticsState {
    const logistics = emptyLogistics();
    logistics.tasks.push({
      id: 'task-road-1',
      kind: 'road',
      unitId: 'eng-1',
      tileIndex: TILE,
      segment: SEG,
      turnsRemaining,
      ownerId: FACTION,
    });
    return logistics;
  }

  it('adds the paved segment to standaloneRoadSegments and drops the task', () => {
    const { logistics } = resolveLogisticsTurn(stateWithRoadTask(1), TILES, FACTION);

    expect(logistics.standaloneRoadSegments).toEqual([encodeSeg(TILE, SEG)]);
    expect(logistics.tasks).toHaveLength(0);
  });

  it('leaves an unfinished road task pending with no road yet', () => {
    const { logistics } = resolveLogisticsTurn(stateWithRoadTask(3), TILES, FACTION);

    expect(logistics.standaloneRoadSegments).toBeUndefined();
    expect(logistics.tasks).toHaveLength(1);
    expect(logistics.tasks[0].turnsRemaining).toBe(2);
  });

  it('preserves road segments already built when a new one completes', () => {
    const logistics = stateWithRoadTask(1);
    logistics.standaloneRoadSegments = [encodeSeg(1, 0)];

    const resolved = resolveLogisticsTurn(logistics, TILES, FACTION).logistics;

    expect(resolved.standaloneRoadSegments).toEqual([encodeSeg(1, 0), encodeSeg(TILE, SEG)]);
  });

  it("does not tick another faction's road task", () => {
    const logistics = stateWithRoadTask(1);
    logistics.tasks[0].ownerId = OTHER;

    const resolved = resolveLogisticsTurn(logistics, TILES, FACTION).logistics;

    expect(resolved.standaloneRoadSegments).toBeUndefined();
    expect(resolved.tasks[0].turnsRemaining).toBe(1);
  });
});
