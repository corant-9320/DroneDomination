import { describe, it, expect } from 'vitest';
import { handleCombat, CombatRequest } from '../combatApi.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

/**
 * Regression guard for KI-2: the server combat endpoint must preserve tile
 * height through the wire format. Before the fix, `rebuildTiles` dropped
 * elevation data, so the elevation modifier was always 1.0 on the server path.
 * Elevation now drives the attack-RANGE multiplier (COMBAT_RULES §13); this
 * test confirms the wire layer still carries height so the breakdown's
 * `elevationMultiplier` (now a range multiplier) reflects it.
 */

const ATTRS: UnitAttributes = {
  size: 5,
  kinetic: 3,
  armour: 1,
  defence: 1,
  splashAttack: 0,
  rangeAttack: 3,
  wheeledMovement: 0,
  limbMovement: 2,
  flightMovement: 0,
  repair: 0,
  antiAir: 0,
};

/** Two adjacent ground tiles on a short arc (mirrors createLinearGrid geometry). */
function wireTiles(height0: number, height1: number) {
  const spacing = 0.15;
  const pos = (i: number): [number, number, number] => {
    const theta = (i - 0.5) * spacing;
    return [Math.sin(theta), 0, Math.cos(theta)];
  };
  return [
    { idx: 0, s: 6 as const, n: [1, 0, 0, 0, 0, 0], t: 'plains', h: height0, pos: pos(0), b: [] },
    { idx: 1, s: 6 as const, n: [0, 1, 1, 1, 1, 1], t: 'plains', h: height1, pos: pos(1), b: [] },
  ];
}

function previewRequest(height0: number, height1: number): CombatRequest {
  return {
    action: 'preview',
    attackerId: 'a',
    targetId: 'd',
    activeFaction: 'p1',
    units: [
      { id: 'a', label: 'A', ownerId: 'p1', tileIndex: 0, segment: 0, facing: 0, attributes: ATTRS, currentHealth: 50 },
      { id: 'd', label: 'D', ownerId: 'p2', tileIndex: 1, segment: 0, facing: 0, attributes: ATTRS, currentHealth: 50 },
    ],
    tiles: wireTiles(height0, height1),
  };
}

describe('server combat wire layer — elevation (KI-2)', () => {
  it('preserves elevation so uphill attackers gain a range multiplier', () => {
    const res = handleCombat(previewRequest(7, 1));
    expect(res.success).toBe(true);
    // Attacker on height 7 firing at height 1: delta +6 → range bonus.
    expect(res.combats[0].breakdown?.elevationMultiplier).toBeGreaterThan(1.0);
  });

  it('applies a range penalty when the attacker is downhill', () => {
    const res = handleCombat(previewRequest(1, 7));
    expect(res.success).toBe(true);
    expect(res.combats[0].breakdown?.elevationMultiplier).toBeLessThan(1.0);
  });

  it('has no elevation effect when both tiles share elevation', () => {
    const res = handleCombat(previewRequest(1, 1));
    expect(res.success).toBe(true);
    expect(res.combats[0].breakdown?.elevationMultiplier).toBe(1.0);
  });
});
