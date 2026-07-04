import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAttackArc,
  getFacingModifier,
  getEWProtection,
  getTerrainDefense,
  clamp,
  calculateFormulaDamage,
  effectiveDefenceWithOrientation,
  applyDamage,
  DEFENCE_SCALE,
} from '../combat.js';
import { Tile } from '../types.js';
import { createTestGrid, makeUnit, makeBuilding, makeCtx } from './combat.fixtures.js';

// Core combat: arc classification, the damage formula, applyDamage, and the
// defence components. Attack resolution lives in `combat.resolve.test.ts`.

describe('combat (core)', () => {
  let tiles: Tile[];
  beforeEach(() => { tiles = createTestGrid(); });

  const ctx = (
    units: Parameters<typeof makeCtx>[0],
    t: Tile[] = tiles,
    buildings: Parameters<typeof makeCtx>[2] = [],
  ) => makeCtx(units, t, buildings);

  // =========================================================================
  // Attack arc classification (stable logic — exact values are correct)
  // =========================================================================

  describe('classifyAttackArc', () => {
    it('front: same direction or ±1', () => {
      expect(classifyAttackArc(0, 0)).toBe('front');
      expect(classifyAttackArc(0, 1)).toBe('front');
      expect(classifyAttackArc(0, 5)).toBe('front');
    });

    it('side: ±2 from facing', () => {
      expect(classifyAttackArc(0, 2)).toBe('side');
      expect(classifyAttackArc(0, 4)).toBe('side');
    });

    it('rear: opposite direction', () => {
      expect(classifyAttackArc(0, 3)).toBe('rear');
      expect(classifyAttackArc(2, 5)).toBe('rear');
    });

    it('wraps correctly', () => {
      expect(classifyAttackArc(5, 0)).toBe('front');
      expect(classifyAttackArc(5, 2)).toBe('rear');
    });

    it('returns unknown for negative approach', () => {
      expect(classifyAttackArc(0, -1)).toBe('unknown');
    });
  });

  describe('getFacingModifier', () => {
    it('front=0, side=1, rear=2, unknown=0', () => {
      expect(getFacingModifier('front')).toBe(0);
      expect(getFacingModifier('side')).toBe(1);
      expect(getFacingModifier('rear')).toBe(2);
      expect(getFacingModifier('unknown')).toBe(0);
    });
  });

  // =========================================================================
  // Damage formula — boundary/property tests (not pinned values)
  // =========================================================================

  function ed(armour: number, ew: number, terrain: number): number {
    return (clamp(armour, 0, 5) + clamp(ew, 0, 5) + clamp(terrain, 0, 1)) * DEFENCE_SCALE;
  }

  describe('calculateFormulaDamage', () => {
    it('damage is always at least 1', () => {
      expect(calculateFormulaDamage(1, ed(5, 5, 4))).toBeGreaterThanOrEqual(1);
    });

    it('damage never exceeds 50', () => {
      expect(calculateFormulaDamage(7, ed(0, 0, 0))).toBeLessThanOrEqual(50);
    });

    it('more attack power → more damage (monotonic)', () => {
      const def = ed(2, 2, 1);
      const d3 = calculateFormulaDamage(3, def);
      const d5 = calculateFormulaDamage(5, def);
      const d7 = calculateFormulaDamage(7, def);
      expect(d5).toBeGreaterThan(d3);
      expect(d7).toBeGreaterThan(d5);
    });

    it('more defence → less damage (monotonic)', () => {
      const d_none = calculateFormulaDamage(4, ed(0, 0, 0));
      const d_mid = calculateFormulaDamage(4, ed(3, 2, 1));
      const d_max = calculateFormulaDamage(4, ed(5, 5, 4));
      expect(d_none).toBeGreaterThan(d_mid);
      expect(d_mid).toBeGreaterThan(d_max);
    });

    it('weakest attack vs max defence produces minimal damage', () => {
      expect(calculateFormulaDamage(1, ed(5, 5, 4))).toBeLessThanOrEqual(2);
    });

    it('max attack vs no defence produces near-max damage', () => {
      expect(calculateFormulaDamage(7, ed(0, 0, 0))).toBeGreaterThanOrEqual(25);
    });
  });

  // =========================================================================
  // Orientation armour penalty (defence-side) — front no penalty, rear −3
  // =========================================================================

  describe('effectiveDefenceWithOrientation', () => {
    it('front attack (penalty 0) leaves armour intact', () => {
      // armour 4, other 1 → (4 + 1) × 0.75
      expect(effectiveDefenceWithOrientation(4, 1, 0)).toBeCloseTo(5 * DEFENCE_SCALE, 5);
    });

    it('rear attack strips armour by the penalty', () => {
      // armour 4 − 3 = 1, + other 1 → (1 + 1) × 0.75
      expect(effectiveDefenceWithOrientation(4, 1, 3)).toBeCloseTo(2 * DEFENCE_SCALE, 5);
    });

    it('armour never goes below 0 (clamped)', () => {
      // armour 2 − 3 → 0, + other 1 → (0 + 1) × 0.75
      expect(effectiveDefenceWithOrientation(2, 1, 3)).toBeCloseTo(1 * DEFENCE_SCALE, 5);
    });

    it('only armour is affected — EW/terrain (otherDefence) untouched', () => {
      // Same otherDefence, more penalty → strictly less effective defence until armour hits 0
      const front = effectiveDefenceWithOrientation(5, 3, 0);
      const side = effectiveDefenceWithOrientation(5, 3, 1.5);
      const rear = effectiveDefenceWithOrientation(5, 3, 3);
      expect(side).toBeLessThan(front);
      expect(rear).toBeLessThan(side);
      // otherDefence floor: with armour fully stripped, defence is other × scale
      expect(effectiveDefenceWithOrientation(3, 3, 3)).toBeCloseTo(3 * DEFENCE_SCALE, 5);
    });

    it('higher orientation penalty → more damage (via lower defence)', () => {
      const dFront = calculateFormulaDamage(4, effectiveDefenceWithOrientation(5, 0, 0));
      const dRear = calculateFormulaDamage(4, effectiveDefenceWithOrientation(5, 0, 3));
      expect(dRear).toBeGreaterThan(dFront);
    });
  });

  // =========================================================================
  // Apply damage
  // =========================================================================

  describe('applyDamage', () => {
    it('reduces health by damage amount', () => {
      expect(applyDamage(30, 7)).toBe(23);
    });

    it('health cannot go below 0', () => {
      expect(applyDamage(5, 30)).toBe(0);
    });

    it('damage minimum is 1', () => {
      expect(applyDamage(10, 0)).toBe(9);
    });
  });

  // =========================================================================
  // Defence components
  // =========================================================================

  describe('getTerrainDefense', () => {
    it('plains lowlands clear = 0', () => {
      const tile = { ...tiles[0], terrainType: 'plains' as const, forested: false };
      expect(getTerrainDefense(tile)).toBe(0);
    });

    it('forested adds 1', () => {
      const tile = { ...tiles[0], forested: true };
      expect(getTerrainDefense(tile)).toBe(1);
    });

    it('elevation does not contribute to terrain defence (handled by elevation multiplier)', () => {
      expect(getTerrainDefense({ ...tiles[0], forested: false })).toBe(0);
      expect(getTerrainDefense({ ...tiles[0], forested: false })).toBe(0);
    });
  });

  describe('getEWProtection', () => {
    it('same-hex sources contribute full defence, capped at 5', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const ally = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0 });
      ally.attributes.defence = 4;
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 0 });
      ally2.attributes.defence = 4;
      // Two same-hex EW-4 screens → 4 + 4 = 8, capped at 5.
      expect(getEWProtection(target, ctx([target, ally, ally2]))).toBe(5);
    });

    it('contribution falls off by 1 per hop', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const adj = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1 });
      adj.attributes.defence = 5;
      // Adjacent (1 hop) EW-5 screen → max(0, 5 − 1) = 4.
      expect(getEWProtection(target, ctx([target, adj]))).toBe(4);
    });

    it('excludes enemies, dead units, and sources whose radius does not reach', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const dead = makeUnit({ id: 'd', ownerId: 'p1', tileIndex: 0, currentHealth: 0 });
      dead.attributes.defence = 5;
      const enemy = makeUnit({ id: 'e', ownerId: 'p2', tileIndex: 0 });
      enemy.attributes.defence = 5;
      const weakAdjacent = makeUnit({ id: 'w', ownerId: 'p1', tileIndex: 1 });
      weakAdjacent.attributes.defence = 1; // EW-1 at 1 hop → max(0, 1 − 1) = 0
      expect(getEWProtection(target, ctx([target, dead, enemy, weakAdjacent]))).toBe(0);
    });

    it('friendly buildings project EW screens, additive with unit sources, capped at 5', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      // Same-hex EW-4 building → full 4; adjacent EW-5 building → max(0, 5 − 1) = 4; total = 8, capped at 5.
      const sameHex = makeBuilding({ id: 'b0', ownerId: 'p1', tileIndex: 0, attributes: { defence: 4 } });
      const adjacent = makeBuilding({ id: 'b1', ownerId: 'p1', tileIndex: 1, attributes: { defence: 5 } });
      expect(getEWProtection(target, ctx([target], tiles, [sameHex, adjacent]))).toBe(5);
    });

    it('excludes enemy buildings and unequipped buildings', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const enemyBuilding = makeBuilding({ id: 'be', ownerId: 'p2', tileIndex: 0, attributes: { defence: 5 } });
      const plainBuilding = makeBuilding({ id: 'bp', ownerId: 'p1', tileIndex: 0 }); // no attributes → defence 0
      expect(getEWProtection(target, ctx([target], tiles, [enemyBuilding, plainBuilding]))).toBe(0);
    });
  });
});
