import { describe, it, expect } from 'vitest';
import { handleAiTurn, handleBuildingTurn, type AiTurnRequest, type BuildingTurnRequest } from '../aiTurnApi.js';
import type { WireUnit, WireTile, WireBuilding } from '../combatApi.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

/**
 * Server-authority Phase 1 regression guard for the AI turn resolver. Confirms
 * the resolver returns a coherent event log: an attack when an enemy is already
 * in range, and nothing when there are no enemies.
 *
 * Uses a small synthetic line-of-hexes world (wire format, as the endpoint
 * receives it) so the test stays fast and deterministic.
 */

function attrs(p: Partial<UnitAttributes>): UnitAttributes {
  return {
    size: 5, kinetic: 0, armour: 0, defence: 0, splashAttack: 0, rangeAttack: 0,
    wheeledMovement: 0, limbMovement: 0, flightMovement: 0, repair: 0, antiAir: 0, ...p,
  };
}

function lineWireTiles(n: number): WireTile[] {
  const tiles: WireTile[] = [];
  for (let i = 0; i < n; i++) {
    const nb: number[] = [];
    if (i + 1 < n) nb.push(i + 1);
    if (i - 1 >= 0) nb.push(i - 1);
    tiles.push({ idx: i, s: 6, n: nb, t: 'plains', elev: 'flat', pos: [i * 0.1, 0, 1], b: [] });
  }
  return tiles;
}

function gun(id: string, owner: string, tile: number): WireUnit {
  return { id, label: id, ownerId: owner, tileIndex: tile, segment: 0, facing: 0, currentHealth: 50, attributes: attrs({ wheeledMovement: 2, kinetic: 3, rangeAttack: 5 }) };
}

describe('handleAiTurn', () => {
  it('produces an attack event when an enemy is in range', () => {
    const req: AiTurnRequest = {
      factionId: 'e',
      tiles: lineWireTiles(6),
      units: [gun('ai', 'e', 1), gun('player', 'p', 0)],
    };
    const res = handleAiTurn(req);
    expect(res.success).toBe(true);
    const attacks = res.events.filter((e) => e.kind === 'attack');
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    expect(attacks[0].targetId).toBe('player');
    // Real combat resolution ran: the attack landed observable damage
    // (any positive amount — not a pinned balance value).
    expect(attacks[0].damage).toBeGreaterThan(0);
    // The authoritative final snapshot reflects that damage: the target either
    // survives with reduced health or was destroyed and removed.
    const playerAfter = res.finalUnits.find((u) => u.id === 'player');
    expect(playerAfter === undefined || playerAfter.currentHealth < 50).toBe(true);
  });

  it('returns no events when the faction has no enemies', () => {
    const req: AiTurnRequest = {
      factionId: 'e',
      tiles: lineWireTiles(6),
      units: [gun('ai', 'e', 1)],
    };
    const res = handleAiTurn(req);
    expect(res.success).toBe(true);
    expect(res.events).toHaveLength(0);
  });
});

function turret(id: string, owner: string, tile: number, a: Partial<UnitAttributes> = {}): WireBuilding {
  return { id, ownerId: owner, tileIndex: tile, segment: 0, attributes: attrs({ kinetic: 4, rangeAttack: 5, ...a }) };
}

describe('handleBuildingTurn — automated building fire', () => {
  it('fires an armed building at an enemy unit in range', () => {
    const req: BuildingTurnRequest = {
      factionId: 'p',
      tiles: lineWireTiles(6),
      units: [gun('enemy', 'e', 1)],
      buildings: [turret('building_1', 'p', 0)],
    };
    const res = handleBuildingTurn(req);
    expect(res.success).toBe(true);
    expect(res.events.length).toBe(1);
    expect(res.events[0].kind).toBe('attack');
    expect(res.events[0].unitId).toBe('building_1');
    expect(res.events[0].targetId).toBe('enemy');
    expect(res.events[0].damage).toBeGreaterThan(0);
  });

  it('does not fire a building with no offensive attributes', () => {
    const req: BuildingTurnRequest = {
      factionId: 'p',
      tiles: lineWireTiles(6),
      units: [gun('enemy', 'e', 1)],
      buildings: [{ id: 'building_2', ownerId: 'p', tileIndex: 0, segment: 0, attributes: attrs({ defence: 4 }) }],
    };
    const res = handleBuildingTurn(req);
    expect(res.success).toBe(true);
    expect(res.events).toHaveLength(0);
  });

  it('does not fire a building at a friendly unit', () => {
    const req: BuildingTurnRequest = {
      factionId: 'p',
      tiles: lineWireTiles(6),
      units: [gun('friendly', 'p', 1)],
      buildings: [turret('building_3', 'p', 0)],
    };
    const res = handleBuildingTurn(req);
    expect(res.success).toBe(true);
    expect(res.events).toHaveLength(0);
  });

  it('does not fire when the only enemy is out of range', () => {
    const req: BuildingTurnRequest = {
      factionId: 'p',
      tiles: lineWireTiles(6),
      units: [gun('enemy', 'e', 5)],
      // rangeAttack 0 + kinetic only → adjacent range; enemy is 5 hops away.
      buildings: [turret('building_4', 'p', 0, { rangeAttack: 0 })],
    };
    const res = handleBuildingTurn(req);
    expect(res.success).toBe(true);
    expect(res.events).toHaveLength(0);
  });

  it('an antiAir-only building does not fire at a ground unit', () => {
    const req: BuildingTurnRequest = {
      factionId: 'p',
      tiles: lineWireTiles(6),
      units: [gun('groundEnemy', 'e', 1)],
      buildings: [{ id: 'building_5', ownerId: 'p', tileIndex: 0, segment: 0, attributes: attrs({ antiAir: 5, kinetic: 0 }) }],
    };
    const res = handleBuildingTurn(req);
    expect(res.success).toBe(true);
    expect(res.events).toHaveLength(0);
  });
});
