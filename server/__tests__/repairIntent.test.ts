import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateMatch, handleMatchIntent, __setTilesForTest } from '../matchApi.js';
import { __resetSessionStore } from '../sessionStore.js';
import { HP_PER_POINT } from '../../src/world/units.js';
import type { WireUnit } from '../combatApi.js';
import type { Tile } from '../../src/world/types.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

/**
 * Smoke coverage for the `repair` intent applier in `server/matchApi.ts`.
 *
 * Every other match intent (move / attack / attackBuilding / endTurn) is guarded
 * by matchSession.test.ts, but the repair applier had no server-side test at all:
 * `src/world/repair.ts` was covered as a pure function while the intent wrapper
 * around it (ownership check, per-turn action gate, MP spend, ExplainedRepair
 * payload, persisted health) was not. This file closes that gap cheaply so the
 * always-on fast gate covers the whole intent surface.
 *
 * No pinned formula values: repair magnitude is asserted as "increased" and
 * "capped at max health", never as a specific number.
 */

const SEED = 5150;

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

const MAX_HEALTH = 5 * HP_PER_POINT; // every unit below has size 5

/** medic + a wounded ally + a wounded enemy, all stacked on tile 3. */
function units(): WireUnit[] {
  return [
    { id: 'medic', label: 'medic', ownerId: 'p', tileIndex: 3, segment: 0, facing: 0, currentHealth: MAX_HEALTH, attributes: attrs({ wheeledMovement: 2, repair: 3 }) },
    { id: 'hurt', label: 'hurt', ownerId: 'p', tileIndex: 3, segment: 1, facing: 0, currentHealth: 10, attributes: attrs({ wheeledMovement: 2 }) },
    { id: 'healthy', label: 'healthy', ownerId: 'p', tileIndex: 3, segment: 2, facing: 0, currentHealth: MAX_HEALTH, attributes: attrs({ wheeledMovement: 2 }) },
    { id: 'foe', label: 'foe', ownerId: 'e', tileIndex: 3, segment: 3, facing: 0, currentHealth: 10, attributes: attrs({ wheeledMovement: 2 }) },
  ];
}

async function freshMatch(): Promise<string> {
  const c = await handleCreateMatch({ seed: SEED, factions: ['p', 'e'], units: units() });
  expect(c.success).toBe(true);
  return c.state!.matchId;
}

function healthOf(units: WireUnit[] | undefined, id: string): number {
  const u = units?.find((unit) => unit.id === id);
  expect(u, `unit ${id} missing from response`).toBeDefined();
  return u!.currentHealth;
}

describe('repair intent applier', () => {
  beforeEach(() => {
    __resetSessionStore();
    __setTilesForTest(SEED, lineTiles(8));
  });

  it('heals a damaged ally in the same hex and spends the repairer\'s turn', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'hurt' },
    });

    expect(r.success).toBe(true);
    expect(healthOf(r.units, 'hurt')).toBeGreaterThan(10);
    expect(healthOf(r.units, 'hurt')).toBeLessThanOrEqual(MAX_HEALTH);
    expect(r.unitTurn!['medic'].acted).toBe(true);
    expect(r.unitTurn!['medic'].mp).toBeLessThan(2);
  });

  it('reports the repair in the explained payload consistently with the new health', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'hurt' },
    });

    expect(r.success).toBe(true);
    expect(r.repair).toBeDefined();
    expect(r.repair!.repairAmount).toBeGreaterThan(0);
    expect(r.repair!.targetHealthBefore + r.repair!.repairAmount).toBe(r.repair!.targetHealthAfter);
    expect(r.repair!.targetHealthAfter).toBe(healthOf(r.units, 'hurt'));
  });

  it('persists the healed health across intents', async () => {
    const matchId = await freshMatch();
    const first = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'hurt' },
    });
    expect(first.success).toBe(true);
    const healed = healthOf(first.units, 'hurt');

    const after = await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } });
    expect(after.success).toBe(true);
    expect(healthOf(after.units, 'hurt')).toBe(healed);
  });

  it('enforces the once-per-turn action gate on the repairer', async () => {
    const matchId = await freshMatch();
    await handleMatchIntent({ matchId, intent: { kind: 'repair', repairerId: 'medic', targetId: 'hurt' } });
    const second = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'hurt' },
    });

    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already acted/i);
  });

  it('rejects repairing an enemy unit', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'foe' },
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/enemy/i);
  });

  it('rejects repairing a unit that is already at full health', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'healthy' },
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/full health/i);
  });

  it('rejects a repair driven by another faction\'s unit', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'foe', targetId: 'hurt' },
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/faction|your unit/i);
  });

  it('rejects an unknown repairer or target id', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({
      matchId,
      intent: { kind: 'repair', repairerId: 'medic', targetId: 'ghost' },
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
