import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAttack,
  resolveReactionFire,
  resolveSimultaneousAttacks,
} from '../combat.js';
import { Tile } from '../types.js';
import { createTestGrid, createLinearGrid, makeUnit, makeCtx } from './combat.fixtures.js';

// Attack resolution: splash, range gate, simultaneous resolution, reaction
// fire, and resolveAttack integration. Pure formula/defence tests live in
// `combat.test.ts`.

describe('combat (resolution)', () => {
  let tiles: Tile[];
  beforeEach(() => { tiles = createTestGrid(); });

  const ctx = (
    units: Parameters<typeof makeCtx>[0],
    t: Tile[] = tiles,
    buildings: Parameters<typeof makeCtx>[2] = [],
  ) => makeCtx(units, t, buildings);

  // =========================================================================
  // Splash damage — behavioral
  // =========================================================================

  describe('splash damage', () => {
    it('splash chosen when multiple enemies in target hex', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 3;
      attacker.attributes.splashAttack = 3;

      const enemies = Array.from({ length: 4 }, (_, i) => {
        const e = makeUnit({ id: `e${i}`, ownerId: 'p2', tileIndex: 0, facing: 0 });
        e.attributes.armour = 0; e.currentHealth = 50;
        return e;
      });

      const result = resolveAttack('a', 'e0', ctx([attacker, ...enemies]));
      expect(result.wasValid).toBe(true);
      expect(result.chosenWeaponMode).toBe('splash');
      expect(result.splashEvents.length).toBe(4);
    });

    it('direct chosen when only one enemy in target hex', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 5;
      attacker.attributes.splashAttack = 5;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.currentHealth = 50;

      const result = resolveAttack('a', 't', ctx([attacker, target]));
      expect(result.wasValid).toBe(true);
      expect(result.chosenWeaponMode).toBe('direct');
    });

    it('splash only hits enemies in target hex, not adjacent', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.kinetic = 3;
      attacker.attributes.splashAttack = 3;
      attacker.attributes.rangeAttack = 5;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.currentHealth = 50;
      const bystander = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 1, facing: 0 });
      bystander.currentHealth = 50;

      const result = resolveAttack('a', 't', ctx([attacker, target, bystander]));
      expect(result.splashEvents.some((e) => e.victimId === 'b')).toBe(false);
    });

    it('splash does not hit friendlies', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 2;
      attacker.attributes.splashAttack = 5;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.currentHealth = 50;
      const friendly = makeUnit({ id: 'f', ownerId: 'p1', tileIndex: 0, facing: 0 });
      friendly.currentHealth = 50;

      const result = resolveAttack('a', 't', ctx([attacker, target, friendly]));
      expect(result.splashEvents.some((e) => e.victimId === 'f')).toBe(false);
    });

    it('splash always deals at least 1 per unit', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 1;
      attacker.attributes.splashAttack = 1;
      const t1 = makeUnit({ id: 't1', ownerId: 'p2', tileIndex: 0, facing: 0 });
      t1.attributes.armour = 5; t1.currentHealth = 50;
      const t2 = makeUnit({ id: 't2', ownerId: 'p2', tileIndex: 0, facing: 0 });
      t2.attributes.armour = 5; t2.currentHealth = 50;

      const result = resolveAttack('a', 't1', ctx([attacker, t1, t2]));
      for (const event of result.splashEvents) {
        expect(event.damage).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // =========================================================================
  // Range
  // =========================================================================

  describe('range', () => {
    it('allows attack within segment range', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 5;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 2, facing: 0 });
      target.currentHealth = 30;

      expect(resolveAttack('a', 't', ctx([attacker, target], linear)).wasValid).toBe(true);
    });

    it('rejects attack beyond segment range', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 2; attacker.attributes.kinetic = 0;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 3, facing: 0 });

      const result = resolveAttack('a', 't', ctx([attacker, target], linear));
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('range');
    });

    it('rangeAttack 0 reaches adjacent tile (base threshold 1.0 >= fallback distance 1.0)', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.kinetic = 2; attacker.attributes.rangeAttack = 0;

      const near = makeUnit({ id: 'n', ownerId: 'p2', tileIndex: 1, facing: 0 });
      near.currentHealth = 30;
      expect(resolveAttack('a', 'n', ctx([attacker, near], linear)).wasValid).toBe(true);
    });

    it('rangeAttack 2 reaches adjacent tile (threshold 2.0 > fallback distance 1.0)', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.kinetic = 2; attacker.attributes.rangeAttack = 2;

      const near = makeUnit({ id: 'n', ownerId: 'p2', tileIndex: 1, facing: 0 });
      near.currentHealth = 30;
      expect(resolveAttack('a', 'n', ctx([attacker, near], linear)).wasValid).toBe(true);

      const far = makeUnit({ id: 'f', ownerId: 'p2', tileIndex: 3, facing: 0 });
      expect(resolveAttack('a', 'f', ctx([attacker, far], linear)).wasValid).toBe(false);
    });
  });

  // =========================================================================
  // Simultaneous resolution
  // =========================================================================

  describe('simultaneous resolution', () => {
    it('both units can kill each other', () => {
      const a = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      a.attributes.kinetic = 5; a.currentHealth = 1;
      const b = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 0, facing: 0 });
      b.attributes.kinetic = 5; b.currentHealth = 1;

      resolveSimultaneousAttacks('a', 'b', ctx([a, b]));
      expect(a.currentHealth).toBe(0);
      expect(b.currentHealth).toBe(0);
    });
  });

  // =========================================================================
  // Reaction fire
  // =========================================================================

  describe('reaction fire', () => {
    it('triggers AA when drone moves through enemy antiAir tile', () => {
      const aa = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aa.attributes.antiAir = 3;
      const drone = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      drone.attributes.flightMovement = 3; drone.currentHealth = 50;

      const results = resolveReactionFire('m', [3, 1], ctx([aa, drone]));
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chosenWeaponMode).toBe('antiAir');
    });

    it('does not trigger for ground units', () => {
      const aa = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aa.attributes.antiAir = 3;
      const tank = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      tank.currentHealth = 50;

      expect(resolveReactionFire('m', [3, 1], ctx([aa, tank])).length).toBe(0);
    });

    it('fires at most once per AA unit per action', () => {
      const aa = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aa.attributes.antiAir = 2;
      const drone = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 4, facing: 0 });
      drone.attributes.flightMovement = 3; drone.currentHealth = 50;

      const results = resolveReactionFire('m', [4, 1, 2], ctx([aa, drone]));
      expect(results.filter((r) => r.attackerId === 'd').length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // resolveAttack integration
  // =========================================================================

  describe('resolveAttack', () => {
    it('rejects friendly fire', () => {
      const a = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      const t = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const result = resolveAttack('a', 't', ctx([a, t]));
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('friendly');
    });

    it('destroys unit when health reaches 0', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 5;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.currentHealth = 1;

      const result = resolveAttack('a', 't', ctx([attacker, target]));
      expect(result.destroyedUnitIds).toContain('t');
    });

    it('always deals at least 1 damage even with max defence', () => {
      tiles[0] = { ...tiles[0], forested: true };
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 1;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 5; target.currentHealth = 50;
      const ew = makeUnit({ id: 'ew', ownerId: 'p2', tileIndex: 0 });
      ew.attributes.defence = 5;

      const result = resolveAttack('a', 't', ctx([attacker, target, ew]));
      expect(result.directDamage).toBeGreaterThanOrEqual(1);
    });
  });
});
