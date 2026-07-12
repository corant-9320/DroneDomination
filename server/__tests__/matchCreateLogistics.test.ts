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
} from '../../shared/logisticsConstants.js';

/**
 * `handleCreateMatch` must adopt a caller-supplied `logistics` network into
 * `MatchState.logistics` (making the seeded Oil Logistics System example network
 * authoritative rather than a client-render-only artifact — see
 * docs/architecture/known-issues.md "Seeded logistics network is client-render-only").
 *
 * These tests exercise the plumbing (CreateMatchRequest.logistics -> stored
 * MatchState.logistics -> per-turn economy), not the seeding algorithm itself
 * (covered by src/world/__tests__/logisticsSeededNetwork*.test.ts).
 */

const SEED = 8888;
const HOME_FACTION = 'home';
const ENEMY_FACTION = 'enemy';

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

function units(): WireUnit[] {
  return [
    { id: 'eng', label: 'eng', ownerId: HOME_FACTION, tileIndex: 1, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 2 }) },
  ];
}

/** A minimal but non-trivial seeded network, owned by the home faction. */
function seededNetworkFixture(): LogisticsState {
  return {
    wells: [
      { id: 'well-1', ownerId: HOME_FACTION, tileIndex: 2, segment: 0, storedOil: 10, hitPoints: 40, maxHitPoints: 40 },
    ],
    refineries: [
      { id: 'ref-1', ownerId: HOME_FACTION, tileIndex: 3, segments: [0, 1], heldOil: 0, refinedProductAvailable: 0, hitPoints: 40, maxHitPoints: 40 },
    ],
    routes: [],
    transports: [],
    hubs: [
      { id: 'hub-1', ownerId: HOME_FACTION, tileIndex: 4, segment: 0, buffer: 0, routeIds: [], hitPoints: 40, maxHitPoints: 40 },
    ],
    home: { [HOME_FACTION]: { factionId: HOME_FACTION, refinedProduct: 1000, oil: 0 } },
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

describe('handleCreateMatch — seeded logistics becomes authoritative', () => {
  beforeEach(() => {
    __resetSessionStore();
    __setTilesForTest(SEED, lineTiles(8));
  });

  it('adopts a caller-supplied logistics network into MatchState.logistics', async () => {
    const network = seededNetworkFixture();
    const c = await handleCreateMatch({
      seed: SEED,
      factions: [HOME_FACTION, ENEMY_FACTION],
      units: units(),
      logistics: network,
    });

    expect(c.success).toBe(true);
    expect(c.state!.logistics).toEqual(network);

    // Ownership: every seeded structure belongs to a faction id present in
    // MatchState.factions.
    const factionSet = new Set(c.state!.factions);
    for (const w of c.state!.logistics.wells) expect(factionSet.has(w.ownerId)).toBe(true);
    for (const r of c.state!.logistics.refineries) expect(factionSet.has(r.ownerId)).toBe(true);
    for (const h of c.state!.logistics.hubs) expect(factionSet.has(h.ownerId)).toBe(true);

    // Verify it's actually persisted in the store, not just echoed in the response.
    const stored = await getSessionStore().get(c.state!.matchId);
    expect(stored!.logistics).toEqual(network);
  });

  it('starts with an empty network when logistics is omitted (non-default seed, unchanged behavior)', async () => {
    const c = await handleCreateMatch({
      seed: SEED,
      factions: [HOME_FACTION, ENEMY_FACTION],
      units: units(),
    });

    expect(c.success).toBe(true);
    expect(c.state!.logistics).toEqual({
      wells: [], refineries: [], routes: [], transports: [], hubs: [],
      home: {}, tasks: [], clearedForests: [], bridges: [],
    });
  });

  it('runs the per-turn economy on the seeded network after creation (endTurn extracts oil)', async () => {
    const network = seededNetworkFixture();
    const c = await handleCreateMatch({
      seed: SEED,
      factions: [HOME_FACTION, ENEMY_FACTION],
      units: units(),
      logistics: network,
    });
    const matchId = c.state!.matchId;

    // Active faction is HOME_FACTION (index 0) on creation — ending its turn
    // resolves the logistics pipeline for HOME_FACTION's structures.
    const r = await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } });

    expect(r.success).toBe(true);
    expect(r.logistics).toBeDefined();
    const well = r.logistics!.wells.find((w) => w.id === 'well-1')!;
    expect(well.storedOil).toBe(Math.min(WELL_STORAGE_CAPACITY, 10 + EXTRACTION_RATE));
  });
});
