import { describe, it, expect } from 'vitest';
import { handleAiTurn, type AiTurnRequest } from '../aiTurnApi.js';
import type { WireUnit, WireTile } from '../combatApi.js';
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
    // The final snapshot is authoritative and excludes any destroyed unit.
    expect(res.finalUnits.every((u) => u.currentHealth > 0)).toBe(true);
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
