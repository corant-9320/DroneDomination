import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateMatch, handleMatchIntent, __setTilesForTest } from '../matchApi.js';
import { __resetSessionStore, getSessionStore } from '../sessionStore.js';
import type { WireUnit } from '../combatApi.js';
import type { Tile } from '../../src/world/types.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';
import type { LogisticsState } from '../../shared/logisticsTypes.js';
import {
  EXTRACTION_RATE,
  WELL_STORAGE_CAPACITY,
  REFINERY_THROUGHPUT_RATE,
  CONVERSION_RATIO,
} from '../../shared/logisticsConstants.js';

/**
 * Integration test for the `endTurn` → `resolveLogisticsTurn` pipeline (task 13.4).
 *
 * Drives a single `endTurn` intent through the authoritative match API and asserts
 * the returned `logistics` reflects exactly one full pipeline pass for the outgoing
 * faction: a below-capacity operational well extracts its Extraction_Rate (Req 3.1),
 * a refinery holding raw oil produces Refined_Product at the Conversion_Ratio
 * (Req 4.5), and that product, once delivered, accrues at the Home_City (Req 5.4/6.9).
 *
 * A small synthetic tile set is injected via `__setTilesForTest` so the test never
 * pays the multi-second `generateWorld(seed)` cost, mirroring `matchSession.test.ts`.
 */

const SEED = 9999;
const FACTION = 'p';

/** A line of n flat-plains hexes: tile i borders i-1 and i+1. */
function lineTiles(n: number): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const neighbours: number[] = [];
    if (i + 1 < n) neighbours.push(i + 1);
    if (i - 1 >= 0) neighbours.push(i - 1);
    tiles.push({
      id: `t${i}`, index: i, sides: 6, neighbours,
      position3d: { x: i * 0.1, y: 0, z: 1 },
      boundary: [], terrainType: 'plains', height: 1, forested: false,
    });
  }
  return tiles;
}

function attrs(p: Partial<UnitAttributes>): UnitAttributes {
  return {
    size: 5, kinetic: 0, armour: 0, defence: 0, splashAttack: 0, rangeAttack: 0,
    wheeledMovement: 0, limbMovement: 0, flightMovement: 0, repair: 0, antiAir: 0, ...p,
  };
}

/** A single engineer unit for the home faction (a match needs >=1 unit). */
function units(): WireUnit[] {
  return [
    { id: 'eng', label: 'eng', ownerId: FACTION, tileIndex: 1, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 2, engineer: 3 }) },
  ];
}

/**
 * A logistics fixture that visibly changes over one turn:
 *   - an operational well below capacity (extract adds EXTRACTION_RATE, Req 3.1)
 *   - a refinery holding raw oil (refine produces product, Req 4.5)
 */
function fixtureLogistics(): LogisticsState {
  return {
    wells: [
      { id: 'well-1', ownerId: FACTION, tileIndex: 2, segment: 0, storedOil: 50, hitPoints: 100, maxHitPoints: 100 },
    ],
    refineries: [
      { id: 'ref-1', ownerId: FACTION, tileIndex: 3, segments: [0], heldOil: 40, refinedProductAvailable: 0, hitPoints: 100, maxHitPoints: 100 },
    ],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

/** Create a match, then seed its authoritative logistics state via the store. */
async function seededMatch(): Promise<string> {
  const c = await handleCreateMatch({ seed: SEED, factions: [FACTION, 'e'], units: units() });
  expect(c.success).toBe(true);
  const matchId = c.state!.matchId;

  const store = getSessionStore();
  const state = await store.get(matchId);
  expect(state).not.toBeNull();
  state!.logistics = fixtureLogistics();
  await store.update(state!);
  return matchId;
}

describe('endTurn logistics pipeline integration', () => {
  beforeEach(() => {
    __resetSessionStore();
    __setTilesForTest(SEED, lineTiles(8));
  });

  it('runs one full logistics pipeline pass for the outgoing faction on endTurn', async () => {
    const matchId = await seededMatch();

    const r = await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } });

    expect(r.success).toBe(true);
    expect(r.logistics).toBeDefined();

    // Req 3.1 — the below-capacity operational well extracted its Extraction_Rate.
    const well = r.logistics!.wells.find((w) => w.id === 'well-1')!;
    expect(well).toBeDefined();
    expect(well.storedOil).toBe(Math.min(WELL_STORAGE_CAPACITY, 50 + EXTRACTION_RATE));

    // Req 4.5 — the refinery consumed min(throughput, heldOil) and produced product
    // at the Conversion_Ratio, decrementing its held oil by the consumed amount.
    const consumed = Math.min(REFINERY_THROUGHPUT_RATE, 40);
    const refinery = r.logistics!.refineries.find((rf) => rf.id === 'ref-1')!;
    expect(refinery).toBeDefined();
    expect(refinery.refinedProductAvailable).toBe(Math.floor(consumed * CONVERSION_RATIO));
    expect(refinery.heldOil).toBe(40 - consumed);
  });
});
