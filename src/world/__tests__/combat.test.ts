import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAttackArc,
  getFacingModifier,
  getOrientationBonus,
  getAdjacentFriendlySupport,
  getEWDefense,
  getTerrainDefense,
  getDefencePower,
  clamp,
  calculateFormulaDamage,
  applyDamage,
  calculateSplashDamage,
  SPLASH_SCALE,
  resolveAttack,
  resolveReactionFire,
  moveUnit,
  resolveSimultaneousAttacks,
  getCrossfireBonus,
  DEFENCE_SCALE,
} from '../combat.js';
import { Unit, HexSegment } from '../units.js';
import { Tile } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestGrid(): Tile[] {
  const centerPos = { x: 0, y: 0, z: 1 };
  const angularSpacing = 0.15;

  const neighbourPositions: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    neighbourPositions.push({
      x: Math.sin(angularSpacing) * Math.sin(angle),
      y: Math.sin(angularSpacing) * Math.cos(angle),
      z: Math.cos(angularSpacing),
    });
  }

  const baseTile = {
    id: '', index: 0, sides: 6 as const, neighbours: [] as number[],
    position3d: centerPos, boundary: [], terrainType: 'plains' as const,
    elevationType: 'rolling' as const, forested: false,
  };

  const tiles: Tile[] = [];
  tiles.push({ ...baseTile, id: 't0', index: 0, position3d: centerPos, neighbours: [1, 2, 3, 4, 5, 6] });
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push({ ...baseTile, id: `t${i}`, index: i, position3d: neighbourPositions[i - 1], neighbours: [0, next, prev, 0, next, prev] });
  }
  return tiles;
}

function createLinearGrid(): Tile[] {
  const baseTile = {
    id: '', index: 0, sides: 6 as const, neighbours: [] as number[],
    position3d: { x: 0, y: 0, z: 1 }, boundary: [],
    terrainType: 'plains' as const, elevationType: 'rolling' as const, forested: false,
  };
  const spacing = 0.15;
  const tiles: Tile[] = [];
  for (let i = 0; i < 6; i++) {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < 5) neighbours.push(i + 1);
    while (neighbours.length < 6) neighbours.push(i);
    const theta = (i - 2.5) * spacing;
    tiles.push({ ...baseTile, id: `t${i}`, index: i, position3d: { x: Math.sin(theta), y: 0, z: Math.cos(theta) }, neighbours });
  }
  return tiles;
}

function makeUnit(overrides: Partial<Unit> & { id: string; ownerId: string }): Unit {
  return {
    label: overrides.id, tileIndex: 0, segment: 0, facing: 0,
    attributes: { maxHealth: 3, kinetic: 2, rangeAttack: 2, limbMovement: 1 },
    currentHealth: 30, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('combat', () => {
  let tiles: Tile[];
  beforeEach(() => { tiles = createTestGrid(); });

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

  function ed(armour: number, ew: number, formationCount: number, terrain: number): number {
    return (clamp(armour, 0, 5) + clamp(ew, 0, 5) + clamp(formationCount, 0, 2) * 0.5 + clamp(terrain, 0, 1)) * DEFENCE_SCALE;
  }

  describe('calculateFormulaDamage', () => {
    it('damage is always at least 1', () => {
      expect(calculateFormulaDamage(1, ed(5, 5, 2, 4))).toBeGreaterThanOrEqual(1);
    });

    it('damage never exceeds 30', () => {
      expect(calculateFormulaDamage(7, ed(0, 0, 0, 0))).toBeLessThanOrEqual(30);
    });

    it('more attack power → more damage (monotonic)', () => {
      const def = ed(2, 2, 1, 1);
      const d3 = calculateFormulaDamage(3, def);
      const d5 = calculateFormulaDamage(5, def);
      const d7 = calculateFormulaDamage(7, def);
      expect(d5).toBeGreaterThan(d3);
      expect(d7).toBeGreaterThan(d5);
    });

    it('more defence → less damage (monotonic)', () => {
      const d_none = calculateFormulaDamage(4, ed(0, 0, 0, 0));
      const d_mid = calculateFormulaDamage(4, ed(3, 2, 1, 1));
      const d_max = calculateFormulaDamage(4, ed(5, 5, 2, 4));
      expect(d_none).toBeGreaterThan(d_mid);
      expect(d_mid).toBeGreaterThan(d_max);
    });

    it('weakest attack vs max defence produces minimal damage', () => {
      expect(calculateFormulaDamage(1, ed(5, 5, 2, 4))).toBeLessThanOrEqual(2);
    });

    it('max attack vs no defence produces near-max damage', () => {
      expect(calculateFormulaDamage(7, ed(0, 0, 0, 0))).toBeGreaterThanOrEqual(25);
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
    it('plains flat clear = 0', () => {
      const tile = { ...tiles[0], terrainType: 'plains' as const, elevationType: 'flat' as const, forested: false };
      expect(getTerrainDefense(tile)).toBe(0);
    });

    it('forested adds 1', () => {
      const tile = { ...tiles[0], elevationType: 'flat' as const, forested: true };
      expect(getTerrainDefense(tile)).toBe(1);
    });

    it('elevation does not contribute to terrain defence (handled by elevation multiplier)', () => {
      expect(getTerrainDefense({ ...tiles[0], elevationType: 'hills' as const, forested: false })).toBe(0);
      expect(getTerrainDefense({ ...tiles[0], elevationType: 'mountain' as const, forested: false })).toBe(0);
    });
  });

  describe('getEWDefense', () => {
    it('sums same-hex friendly defence, capped at 5', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const ally = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0 });
      ally.attributes.defence = 4;
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 0 });
      ally2.attributes.defence = 4;
      expect(getEWDefense(target, [target, ally, ally2])).toBe(5);
    });

    it('excludes different tiles, dead units, enemies', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const far = makeUnit({ id: 'f', ownerId: 'p1', tileIndex: 1 }); far.attributes.defence = 5;
      const dead = makeUnit({ id: 'd', ownerId: 'p1', tileIndex: 0, currentHealth: 0 }); dead.attributes.defence = 5;
      const enemy = makeUnit({ id: 'e', ownerId: 'p2', tileIndex: 0 }); enemy.attributes.defence = 5;
      expect(getEWDefense(target, [target, far, dead, enemy])).toBe(0);
    });
  });

  describe('getAdjacentFriendlySupport', () => {
    it('counts adjacent friendlies, capped at 2', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const a1 = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1 });
      const a2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 2 });
      const a3 = makeUnit({ id: 'a3', ownerId: 'p1', tileIndex: 3 });
      expect(getAdjacentFriendlySupport(target, [target, a1, a2, a3], tiles)).toBe(2);
    });

    it('excludes dead units and enemies', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const dead = makeUnit({ id: 'd', ownerId: 'p1', tileIndex: 1, currentHealth: 0 });
      const enemy = makeUnit({ id: 'e', ownerId: 'p2', tileIndex: 2 });
      expect(getAdjacentFriendlySupport(target, [target, dead, enemy], tiles)).toBe(0);
    });
  });

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

      const result = resolveAttack('a', 'e0', [attacker, ...enemies], tiles);
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

      const result = resolveAttack('a', 't', [attacker, target], tiles);
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

      const result = resolveAttack('a', 't', [attacker, target, bystander], tiles);
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

      const result = resolveAttack('a', 't', [attacker, target, friendly], tiles);
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

      const result = resolveAttack('a', 't1', [attacker, t1, t2], tiles);
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

      expect(resolveAttack('a', 't', [attacker, target], linear).wasValid).toBe(true);
    });

    it('rejects attack beyond segment range', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 2; attacker.attributes.kinetic = 0;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 3, facing: 0 });

      const result = resolveAttack('a', 't', [attacker, target], linear);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('range');
    });

    it('rangeAttack 0 cannot reach adjacent tile (fallback distance 1.0 > 0.25 threshold)', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.kinetic = 2; attacker.attributes.rangeAttack = 0;

      const near = makeUnit({ id: 'n', ownerId: 'p2', tileIndex: 1, facing: 0 });
      near.currentHealth = 30;
      expect(resolveAttack('a', 'n', [attacker, near], linear).wasValid).toBe(false);
    });

    it('rangeAttack 2 reaches adjacent tile (threshold 1.25 > fallback distance 1.0)', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.kinetic = 2; attacker.attributes.rangeAttack = 2;

      const near = makeUnit({ id: 'n', ownerId: 'p2', tileIndex: 1, facing: 0 });
      near.currentHealth = 30;
      expect(resolveAttack('a', 'n', [attacker, near], linear).wasValid).toBe(true);

      const far = makeUnit({ id: 'f', ownerId: 'p2', tileIndex: 3, facing: 0 });
      expect(resolveAttack('a', 'f', [attacker, far], linear).wasValid).toBe(false);
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

      resolveSimultaneousAttacks('a', 'b', [a, b], tiles);
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

      const results = resolveReactionFire('m', [3, 1], [aa, drone], tiles);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chosenWeaponMode).toBe('antiAir');
    });

    it('does not trigger for ground units', () => {
      const aa = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aa.attributes.antiAir = 3;
      const tank = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      tank.currentHealth = 50;

      expect(resolveReactionFire('m', [3, 1], [aa, tank], tiles).length).toBe(0);
    });

    it('fires at most once per AA unit per action', () => {
      const aa = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aa.attributes.antiAir = 2;
      const drone = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 4, facing: 0 });
      drone.attributes.flightMovement = 3; drone.currentHealth = 50;

      const results = resolveReactionFire('m', [4, 1, 2], [aa, drone], tiles);
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
      const result = resolveAttack('a', 't', [a, t], tiles);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('friendly');
    });

    it('destroys unit when health reaches 0', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 5;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.currentHealth = 1;

      const result = resolveAttack('a', 't', [attacker, target], tiles);
      expect(result.destroyedUnitIds).toContain('t');
    });

    it('always deals at least 1 damage even with max defence', () => {
      tiles[0] = { ...tiles[0], elevationType: 'mountain', forested: true };
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 1;
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 5; target.currentHealth = 50;
      const ew = makeUnit({ id: 'ew', ownerId: 'p2', tileIndex: 0 });
      ew.attributes.defence = 5;

      const result = resolveAttack('a', 't', [attacker, target, ew], tiles);
      expect(result.directDamage).toBeGreaterThanOrEqual(1);
    });
  });
});
