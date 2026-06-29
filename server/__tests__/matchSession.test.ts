import { describe, it, expect, beforeEach } from 'vitest';
import { handleCreateMatch, handleMatchIntent, __setTilesForTest } from '../matchApi.js';
import { __resetSessionStore } from '../sessionStore.js';
import type { WireUnit } from '../combatApi.js';
import type { Tile } from '../../src/world/types.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

/**
 * Server-authority Phase 3 regression guard. Exercises the authoritative
 * match-session API end to end (through the mocked DynamoDB store), proving the
 * anti-cheat rules: a client cannot move twice / overspend MP, teleport, act
 * twice, or act out of turn, and stale writes are rejected.
 *
 * A small synthetic line-of-tiles world is injected so the test doesn't pay the
 * multi-second `generateWorld(seed)` cost.
 */

const SEED = 4242;

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
      boundary: [], terrainType: 'plains', elevationType: 'flat', height: 1, forested: false,
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

/** mover: 1 MP wheeled unit at tile 5; gun: range-5 attacker at tile 2; foe: enemy at tile 3. */
function units(): WireUnit[] {
  return [
    { id: 'mover', label: 'mover', ownerId: 'p', tileIndex: 5, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 1 }) },
    { id: 'gun', label: 'gun', ownerId: 'p', tileIndex: 2, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 2, kinetic: 3, rangeAttack: 5 }) },
    { id: 'foe', label: 'foe', ownerId: 'e', tileIndex: 3, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 2 }) },
  ];
}

async function freshMatch() {
  const c = await handleCreateMatch({ seed: SEED, factions: ['p', 'e'], units: units() });
  expect(c.success).toBe(true);
  return c.state!.matchId;
}

describe('match session authority', () => {
  beforeEach(() => {
    __resetSessionStore();
    __setTilesForTest(SEED, lineTiles(12));
  });

  it('creates a match with a fresh per-unit turn budget', async () => {
    const c = await handleCreateMatch({ seed: SEED, factions: ['p', 'e'], units: units() });
    expect(c.success).toBe(true);
    expect(c.state!.version).toBe(1);
    expect(c.state!.unitTurn['mover'].mp).toBe(1);
    expect(c.state!.unitTurn['gun'].acted).toBe(false);
  });

  it('accepts a legal one-step move and decrements MP', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({ matchId, intent: { kind: 'move', unitId: 'mover', path: [5, 6] } });
    expect(r.success).toBe(true);
    expect(r.unitTurn!['mover'].mp).toBeLessThan(1);
    expect(r.unitTurn!['mover'].mp).toBeGreaterThanOrEqual(0);
  });

  it('rejects a move that exceeds the unit\'s remaining MP', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({ matchId, intent: { kind: 'move', unitId: 'mover', path: [5, 6, 7, 8, 9, 10, 11] } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/movement points/i);
  });

  it('rejects a non-contiguous (teleport) path', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({ matchId, intent: { kind: 'move', unitId: 'mover', path: [5, 0] } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/contiguous/i);
  });

  it('rejects acting with another faction\'s unit', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({ matchId, intent: { kind: 'move', unitId: 'foe', path: [3, 4] } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/faction|your unit/i);
  });

  it('enforces the once-per-turn action gate', async () => {
    const matchId = await freshMatch();
    const first = await handleMatchIntent({ matchId, intent: { kind: 'attack', attackerId: 'gun', targetId: 'foe' } });
    expect(first.success).toBe(true);
    expect(first.unitTurn!['gun'].acted).toBe(true);
    const second = await handleMatchIntent({ matchId, intent: { kind: 'attack', attackerId: 'gun', targetId: 'foe' } });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already acted/i);
  });

  it('cycles factions and bumps the turn number on endTurn', async () => {
    const matchId = await freshMatch();
    const a = await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } });
    expect(a.activeFaction).toBe('e');
    expect(a.turn).toBe(1);
    const b = await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } });
    expect(b.activeFaction).toBe('p');
    expect(b.turn).toBe(2);
  });

  it('resets the incoming faction\'s budget after its units acted', async () => {
    const matchId = await freshMatch();
    await handleMatchIntent({ matchId, intent: { kind: 'attack', attackerId: 'gun', targetId: 'foe' } });
    await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } }); // → 'e'
    const back = await handleMatchIntent({ matchId, intent: { kind: 'endTurn' } }); // → 'p'
    expect(back.unitTurn!['gun'].acted).toBe(false);
    expect(back.unitTurn!['gun'].mp).toBe(2);
  });

  it('rejects a stale expectedVersion as a conflict', async () => {
    const matchId = await freshMatch();
    const r = await handleMatchIntent({ matchId, expectedVersion: 999, intent: { kind: 'endTurn' } });
    expect(r.success).toBe(false);
    expect(r.conflict).toBe(true);
  });

  it('returns "match not found" for an unknown match id', async () => {
    const r = await handleMatchIntent({ matchId: 'nope', intent: { kind: 'endTurn' } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
