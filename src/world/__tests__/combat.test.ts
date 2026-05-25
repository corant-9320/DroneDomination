import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAttackArc,
  getFacingModifier,
  getOrientationBonus,
  getDirectionBetweenAdjacentHexes,
  getApproachDirection,
  getAdjacentFriendlySupport,
  getEWDefense,
  getTerrainDefense,
  getDefencePower,
  isEncircled,
  clamp,
  calculateDamage,
  applyDamage,
  calculateDirectDamage,
  calculateSplashDamage,
  calculateSplashBonusOnTarget,
  SPLASH_SCALE,
  resolveAttack,
  resolveReactionFire,
  moveUnit,
  resolveSimultaneousAttacks,
  getCrossfireBonus,
  type AttackArc,
  type TargetOrientation,
} from '../combat.js';
import { Unit, HexSegment } from '../units.js';
import { Tile } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers — build a small hex grid for testing
// ---------------------------------------------------------------------------

/**
 * Create a minimal hex grid for testing.
 * Layout (7 tiles):
 *
 *       1
 *    2     3
 *       0       (centre)
 *    4     5
 *       6
 *
 * Tile 0 neighbours: [1, 2, 3, 4, 5, 6] (clockwise)
 */
function createTestGrid(): Tile[] {
  const pos = { x: 0, y: 0, z: 1 };
  const baseTile = {
    id: '',
    index: 0,
    sides: 6 as const,
    neighbours: [] as number[],
    position3d: pos,
    boundary: [],
    terrainType: 'plains' as const,
    elevationType: 'rolling' as const,
    forested: false,
  };

  const tiles: Tile[] = [];

  // Tile 0 — centre, neighbours are 1–6
  tiles.push({ ...baseTile, id: 't0', index: 0, neighbours: [1, 2, 3, 4, 5, 6] });

  // Tiles 1–6 — outer ring
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push({
      ...baseTile,
      id: `t${i}`,
      index: i,
      neighbours: [0, next, prev, 0, next, prev],
    });
  }

  return tiles;
}

/**
 * Create a simple linear grid for range testing.
 * Tiles 0-1-2-3-4-5, each adjacent only to its direct neighbors.
 */
function createLinearGrid(): Tile[] {
  const pos = { x: 0, y: 0, z: 1 };
  const baseTile = {
    id: '',
    index: 0,
    sides: 6 as const,
    neighbours: [] as number[],
    position3d: pos,
    boundary: [],
    terrainType: 'plains' as const,
    elevationType: 'rolling' as const,
    forested: false,
  };

  const tiles: Tile[] = [];
  for (let i = 0; i < 6; i++) {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < 5) neighbours.push(i + 1);
    while (neighbours.length < 6) neighbours.push(i);
    tiles.push({ ...baseTile, id: `t${i}`, index: i, neighbours });
  }
  return tiles;
}

function makeUnit(overrides: Partial<Unit> & { id: string; ownerId: string }): Unit {
  return {
    label: overrides.id,
    tileIndex: 0,
    segment: 0,
    facing: 0,
    attributes: { maxHealth: 3, attack: 2, limbMovement: 1 },
    currentHealth: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('combat', () => {
  let tiles: Tile[];

  beforeEach(() => {
    tiles = createTestGrid();
  });

  // =========================================================================
  // Utility: clamp
  // =========================================================================

  describe('clamp', () => {
    it('clamps below minimum', () => {
      expect(clamp(-5, 0, 10)).toBe(0);
    });

    it('clamps above maximum', () => {
      expect(clamp(15, 0, 10)).toBe(10);
    });

    it('passes through values in range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
    });
  });

  // =========================================================================
  // Orientation bonus
  // =========================================================================

  describe('getOrientationBonus', () => {
    it('front returns 0', () => {
      expect(getOrientationBonus('front')).toBe(0);
    });

    it('side returns 1', () => {
      expect(getOrientationBonus('side')).toBe(1);
    });

    it('rear returns 2', () => {
      expect(getOrientationBonus('rear')).toBe(2);
    });

    it('invalid orientation defaults to 0', () => {
      expect(getOrientationBonus('invalid')).toBe(0);
    });
  });

  // =========================================================================
  // Attack arc classification
  // =========================================================================

  describe('classifyAttackArc', () => {
    it('classifies front attack (same direction as facing)', () => {
      expect(classifyAttackArc(0, 0)).toBe('front');
      expect(classifyAttackArc(3, 3)).toBe('front');
    });

    it('classifies front attacks (±1 from facing)', () => {
      // In the new model, frontSide is merged into front
      expect(classifyAttackArc(0, 1)).toBe('front');
      expect(classifyAttackArc(0, 5)).toBe('front');
      expect(classifyAttackArc(3, 4)).toBe('front');
      expect(classifyAttackArc(3, 2)).toBe('front');
    });

    it('classifies side attacks (±2 from facing)', () => {
      expect(classifyAttackArc(0, 2)).toBe('side');
      expect(classifyAttackArc(0, 4)).toBe('side');
    });

    it('classifies rear attack (opposite direction)', () => {
      expect(classifyAttackArc(0, 3)).toBe('rear');
      expect(classifyAttackArc(2, 5)).toBe('rear');
    });

    it('wraps around correctly for high facing values', () => {
      expect(classifyAttackArc(5, 0)).toBe('front'); // 0 - 5 = -5 → mod6 = 1 → front
      expect(classifyAttackArc(5, 2)).toBe('rear');  // 2 - 5 = -3 → mod6 = 3 → rear
    });

    it('returns unknown for negative approach direction', () => {
      expect(classifyAttackArc(0, -1)).toBe('unknown');
    });
  });

  describe('getFacingModifier', () => {
    it('front attack applies +0 bonus', () => {
      expect(getFacingModifier('front')).toBe(0);
    });

    it('side attack applies +1 bonus', () => {
      expect(getFacingModifier('side')).toBe(1);
    });

    it('rear attack applies +2 bonus', () => {
      expect(getFacingModifier('rear')).toBe(2);
    });

    it('unknown defaults to 0', () => {
      expect(getFacingModifier('unknown')).toBe(0);
    });
  });

  // =========================================================================
  // Damage formula — spec examples from Section 7
  // =========================================================================

  describe('calculateDamage', () => {
    it('weakest attack vs strongest defence = 1', () => {
      // attack=1, front, armour=5, EW=5, formation=2, terrain=4
      const damage = calculateDamage(1, 'front', 5, 5, 2, 4);
      expect(damage).toBe(1);
    });

    it('strongest attack vs weakest defence = 30', () => {
      // attack=5, rear, armour=0, EW=0, formation=0, terrain=0
      const damage = calculateDamage(5, 'rear', 0, 0, 0, 0);
      expect(damage).toBe(30);
    });

    it('attack=5, front, no defence = 30', () => {
      const damage = calculateDamage(5, 'front', 0, 0, 0, 0);
      expect(damage).toBe(30);
    });

    it('attack=1, side, max defence = 2', () => {
      // AP=2, DefPower=16, ED=12
      // Damage = round(1 + 29*4/(4+144)) = round(1 + 116/148) = round(1.784) = 2
      const damage = calculateDamage(1, 'side', 5, 5, 2, 4);
      expect(damage).toBe(2);
    });

    it('attack=1, rear, max defence = 3', () => {
      // AP=3, DefPower=16, ED=12
      // Damage = round(1 + 29*9/(9+144)) = round(1 + 261/153) = round(2.706) = 3
      const damage = calculateDamage(1, 'rear', 5, 5, 2, 4);
      expect(damage).toBe(3);
    });

    it('attack=3, front, DefPower=8 → 7', () => {
      // AP=3, DefPower=8, ED=6
      // Damage = round(1 + 29*9/(9+36)) = round(1 + 261/45) = round(6.8) = 7
      const damage = calculateDamage(3, 'front', 3, 3, 1, 1);
      expect(damage).toBe(7);
    });

    it('attack=3, side, DefPower=8 → 10', () => {
      // AP=4, DefPower=8, ED=6
      // Damage = round(1 + 29*16/(16+36)) = round(1 + 464/52) = round(9.923) = 10
      const damage = calculateDamage(3, 'side', 3, 3, 1, 1);
      expect(damage).toBe(10);
    });

    it('attack=3, rear, DefPower=8 → 13', () => {
      // AP=5, DefPower=8, ED=6
      // Damage = round(1 + 29*25/(25+36)) = round(1 + 725/61) = round(12.885) = 13
      const damage = calculateDamage(3, 'rear', 3, 3, 1, 1);
      expect(damage).toBe(13);
    });

    it('attack=5, front, DefPower=8 → 13', () => {
      // AP=5, DefPower=8, ED=6
      const damage = calculateDamage(5, 'front', 3, 3, 1, 1);
      expect(damage).toBe(13);
    });

    it('attack=5, side, DefPower=8 → 16', () => {
      // AP=6, DefPower=8, ED=6
      // Damage = round(1 + 29*36/(36+36)) = round(1 + 1044/72) = round(15.5) = 16
      const damage = calculateDamage(5, 'side', 3, 3, 1, 1);
      expect(damage).toBe(16);
    });

    it('attack=5, rear, DefPower=8 → 18', () => {
      // AP=7, DefPower=8, ED=6
      // Damage = round(1 + 29*49/(49+36)) = round(1 + 1421/85) = round(17.718) = 18
      const damage = calculateDamage(5, 'rear', 3, 3, 1, 1);
      expect(damage).toBe(18);
    });

    it('clamps attack below 1 to 1', () => {
      const damage = calculateDamage(0, 'front', 0, 0, 0, 0);
      // Clamped to attack=1, AP=1, ED=0, damage=30
      expect(damage).toBe(30);
    });

    it('damage is always at least 1', () => {
      // Even with maximum defence
      const damage = calculateDamage(1, 'front', 5, 5, 2, 4);
      expect(damage).toBeGreaterThanOrEqual(1);
    });

    it('damage never exceeds 30', () => {
      const damage = calculateDamage(5, 'rear', 0, 0, 0, 0);
      expect(damage).toBeLessThanOrEqual(30);
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

    it('health is clamped to 50 max', () => {
      expect(applyDamage(50, 1)).toBe(49);
    });

    it('damage minimum is 1', () => {
      expect(applyDamage(10, 0)).toBe(9);
    });

    it('allows combined damage above 30 (direct + splash bonus)', () => {
      // 36 = 30 direct + 6 splash bonus
      expect(applyDamage(50, 36)).toBe(14);
    });
  });

  // =========================================================================
  // Terrain defence
  // =========================================================================

  describe('getTerrainDefense', () => {
    it('plains flat clear = 0', () => {
      const tile = { ...tiles[0], terrainType: 'plains' as const, elevationType: 'flat' as const, forested: false };
      expect(getTerrainDefense(tile)).toBe(0);
    });

    it('plains flat forested = 1', () => {
      const tile = { ...tiles[0], terrainType: 'plains' as const, elevationType: 'flat' as const, forested: true };
      expect(getTerrainDefense(tile)).toBe(1);
    });

    it('hills elevation = 1', () => {
      const tile = { ...tiles[0], elevationType: 'hills' as const, forested: false };
      expect(getTerrainDefense(tile)).toBe(1);
    });

    it('hills elevation forested = 2', () => {
      const tile = { ...tiles[0], elevationType: 'hills' as const, forested: true };
      expect(getTerrainDefense(tile)).toBe(2);
    });

    it('mountain elevation = 3', () => {
      const tile = { ...tiles[0], elevationType: 'mountain' as const, forested: false };
      expect(getTerrainDefense(tile)).toBe(3);
    });

    it('ocean = 0', () => {
      const tile = { ...tiles[0], terrainType: 'ocean' as const, forested: false };
      expect(getTerrainDefense(tile)).toBe(0);
    });
  });

  // =========================================================================
  // EW Defence (same-hex sum, capped at 5)
  // =========================================================================

  describe('getEWDefense', () => {
    it('sums defence from same-hex friendly units', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const ally1 = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0 });
      ally1.attributes.defence = 3;
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 0 });
      ally2.attributes.defence = 2;

      expect(getEWDefense(target, [target, ally1, ally2])).toBe(5);
    });

    it('caps at 5', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const ally1 = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0 });
      ally1.attributes.defence = 4;
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 0 });
      ally2.attributes.defence = 4;

      expect(getEWDefense(target, [target, ally1, ally2])).toBe(5);
    });

    it('excludes units on different tiles', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const farAlly = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1 });
      farAlly.attributes.defence = 5;

      expect(getEWDefense(target, [target, farAlly])).toBe(0);
    });

    it('excludes destroyed units', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const deadAlly = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0, currentHealth: 0 });
      deadAlly.attributes.defence = 5;

      expect(getEWDefense(target, [target, deadAlly])).toBe(0);
    });

    it('excludes enemy units', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const enemy = makeUnit({ id: 'e1', ownerId: 'p2', tileIndex: 0 });
      enemy.attributes.defence = 5;

      expect(getEWDefense(target, [target, enemy])).toBe(0);
    });
  });

  // =========================================================================
  // Defence Power
  // =========================================================================

  describe('getDefencePower', () => {
    it('sums all defence components', () => {
      // Target on a forested flat tile with armour, ally EW in same hex, and formation
      tiles[0] = { ...tiles[0], forested: true };
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      target.attributes.armour = 3;
      target.attributes.defence = 2; // target's own defence is EW for others, not itself

      const ewAlly = makeUnit({ id: 'ew', ownerId: 'p1', tileIndex: 0 });
      ewAlly.attributes.defence = 4;

      const formAlly = makeUnit({ id: 'f', ownerId: 'p1', tileIndex: 1 });

      const allUnits = [target, ewAlly, formAlly];
      const dp = getDefencePower(target, allUnits, tiles);

      expect(dp.armour).toBe(3);
      expect(dp.ew).toBe(4); // ewAlly's defence (target's own EW doesn't count for itself)
      expect(dp.defensiveFormation).toBe(2); // ewAlly (same hex) + formAlly (adjacent)
      expect(dp.terrain).toBe(1); // forested
      expect(dp.total).toBe(10);
    });

    it('returns max possible values correctly', () => {
      tiles[0] = { ...tiles[0], elevationType: 'mountain' };
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      target.attributes.armour = 5;

      const ew1 = makeUnit({ id: 'e1', ownerId: 'p1', tileIndex: 0 });
      ew1.attributes.defence = 3;
      const ew2 = makeUnit({ id: 'e2', ownerId: 'p1', tileIndex: 0 });
      ew2.attributes.defence = 3;

      const f1 = makeUnit({ id: 'f1', ownerId: 'p1', tileIndex: 1 });

      const allUnits = [target, ew1, ew2, f1];
      const dp = getDefencePower(target, allUnits, tiles);

      expect(dp.armour).toBe(5);
      expect(dp.ew).toBe(5); // 3+3=6, capped at 5
      expect(dp.defensiveFormation).toBe(2); // ew1 + ew2 same hex, capped at 2
      expect(dp.terrain).toBe(3); // mountain
      expect(dp.total).toBe(15);
    });
  });

  // =========================================================================
  // Formation support
  // =========================================================================

  describe('formation support', () => {
    it('adjacent friendly units provide +1 each, max +2', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const ally1 = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1 });
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 2 });
      const ally3 = makeUnit({ id: 'a3', ownerId: 'p1', tileIndex: 3 });

      const allUnits = [target, ally1, ally2, ally3];
      expect(getAdjacentFriendlySupport(target, allUnits, tiles)).toBe(2); // capped
    });

    it('returns 0 with no nearby friendlies', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const enemy = makeUnit({ id: 'e', ownerId: 'p2', tileIndex: 1 });
      expect(getAdjacentFriendlySupport(target, [target, enemy], tiles)).toBe(0);
    });

    it('destroyed units do not provide support', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const ally = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1, currentHealth: 0 });
      expect(getAdjacentFriendlySupport(target, [target, ally], tiles)).toBe(0);
    });

    it('same-hex units contribute to formation support', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, segment: 0 });
      const ally = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0, segment: 1 });
      expect(getAdjacentFriendlySupport(target, [target, ally], tiles)).toBe(1);
    });
  });

  // =========================================================================
  // Splash damage
  // =========================================================================

  describe('splash damage', () => {
    it('adds 20% splash bonus to primary target', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 5;
      attacker.attributes.splashAttack = 5;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);

      // attack=5, front (approach dir 0, facing 0 → front), no defence
      // Direct damage = 30, splash bonus = round(30 * 0.2) = 6
      // Total = 36... but applyDamage clamps damage input to [1,30]
      // Actually totalDirectDamage = 30 + 6 = 36 is passed to applyDamage
      // applyDamage clamps damage to [1,30] → capped at 30
      // Let's verify: the CombatResult.directDamage should be 36
      expect(result.directDamage).toBe(36);
      // But health is: applyDamage(50, 36) → damage clamped to 30 → 50-30=20
      // Wait — applyDamage clamps to [1,30]. Let me check...
      // Actually we need to update applyDamage to allow >30 for combined splash
      expect(result.wasValid).toBe(true);
    });

    it('deals 20% splash to adjacent enemies', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 3;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const bystander = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 1, facing: 0 });
      bystander.attributes.armour = 0;
      bystander.currentHealth = 50;

      const allUnits = [attacker, target, bystander];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.splashEvents.length).toBeGreaterThan(0);

      // Splash on bystander: splashAttack=3, front, no defence
      // Full formula = 30 (no defence), 20% = round(30*0.2) = 6
      const splashOnBystander = result.splashEvents.find((e) => e.victimId === 'b');
      expect(splashOnBystander).toBeDefined();
      expect(splashOnBystander!.damage).toBe(6);
    });

    it('splash on adjacents is reduced by victim defence', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 2;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.currentHealth = 50;

      // Bystander with armour
      const bystander = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 1, facing: 0 });
      bystander.attributes.armour = 3;
      bystander.currentHealth = 50;

      const allUnits = [attacker, target, bystander];
      const result = resolveAttack('a', 't', allUnits, tiles);

      // splash=2, front, armour=3, formation=1 (target adjacent)
      // DefPower = 3+0+1+0 = 4, ED = 4*0.75 = 3
      // AP=2, AP²=4, ED²=9
      // fullDamage = round(1 + 29*4/(4+9)) = round(1+116/13) = round(9.923) = 10
      // splash = round(10 * 0.2) = 2
      const splashOnBystander = result.splashEvents.find((e) => e.victimId === 'b');
      expect(splashOnBystander).toBeDefined();
      expect(splashOnBystander!.damage).toBe(2);
    });

    it('splash always deals at least 1 damage', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 1;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.currentHealth = 50;

      // Heavily armoured bystander on a mountain elevation
      tiles[1] = { ...tiles[1], elevationType: 'mountain' };
      const bystander = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 1, facing: 0 });
      bystander.attributes.armour = 5;
      bystander.currentHealth = 50;

      const allUnits = [attacker, target, bystander];
      const result = resolveAttack('a', 't', allUnits, tiles);

      const splashOnBystander = result.splashEvents.find((e) => e.victimId === 'b');
      expect(splashOnBystander).toBeDefined();
      expect(splashOnBystander!.damage).toBeGreaterThanOrEqual(1);
    });

    it('splash affects friendly units adjacent to primary target', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 3;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const friendly = makeUnit({ id: 'f', ownerId: 'p1', tileIndex: 1, facing: 0 });
      friendly.attributes.armour = 0;
      friendly.currentHealth = 50;

      const allUnits = [attacker, target, friendly];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.splashEvents.some((e) => e.victimId === 'f')).toBe(true);
    });
  });

  // =========================================================================
  // Range
  // =========================================================================

  describe('range', () => {
    it('allows attack within range (graph distance)', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 3;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 3, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 30;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, linear);
      expect(result.wasValid).toBe(true);
    });

    it('rejects attack beyond range', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 2;
      attacker.attributes.attack = 0;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 3, facing: 0 });

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, linear);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('range');
    });

    it('melee attack (attack > 0, range 0) works at distance 1', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 2;
      attacker.attributes.rangeAttack = 0;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.currentHealth = 30;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);
      expect(result.wasValid).toBe(true);
    });

    it('melee attack fails at distance > 1', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.attack = 2;
      attacker.attributes.rangeAttack = 0;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 2, facing: 0 });

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, linear);
      expect(result.wasValid).toBe(false);
    });
  });

  // =========================================================================
  // Simultaneous resolution
  // =========================================================================

  describe('simultaneous resolution', () => {
    it('resolves both attacks simultaneously — both can kill each other', () => {
      const unitA = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      unitA.attributes.attack = 5;
      unitA.attributes.armour = 0;
      unitA.currentHealth = 1;

      const unitB = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 0, facing: 0 });
      unitB.attributes.attack = 5;
      unitB.attributes.armour = 0;
      unitB.currentHealth = 1;

      const allUnits = [unitA, unitB];
      const results = resolveSimultaneousAttacks('a', 'b', allUnits, tiles);

      expect(results.length).toBe(2);
      // Both should be destroyed (damage ≥ 1 always)
      expect(unitA.currentHealth).toBe(0);
      expect(unitB.currentHealth).toBe(0);
    });
  });

  // =========================================================================
  // Reaction fire
  // =========================================================================

  describe('reaction fire', () => {
    it('triggers from front arc when enemy is in range', () => {
      const defender = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 0, facing: 0 });
      defender.attributes.attack = 3;
      defender.attributes.rangeAttack = 1;

      const mover = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      mover.currentHealth = 50;

      const allUnits = [defender, mover];
      const simplePath = [3, 1]; // move from 3 to 1 (direction 0 from tile 0 = front)
      const results = resolveReactionFire('m', simplePath, allUnits, tiles);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].attackerId).toBe('d');
      expect(results[0].targetId).toBe('m');
    });

    it('does not trigger more than once per unit per turn', () => {
      const defender = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 0, facing: 0 });
      defender.attributes.attack = 2;
      defender.attributes.rangeAttack = 2;

      const mover = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 4, facing: 0 });
      mover.currentHealth = 50;

      const allUnits = [defender, mover];
      const path = [4, 1, 2];

      const results = resolveReactionFire('m', path, allUnits, tiles);
      const defenderShots = results.filter((r) => r.attackerId === 'd');
      expect(defenderShots.length).toBeLessThanOrEqual(1);
    });

    it('does not trigger from non-front arc', () => {
      // Defender facing 0 (toward tile 1). Mover enters tile 4 (rear)
      const defender = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 0, facing: 0 });
      defender.attributes.attack = 3;
      defender.attributes.rangeAttack = 1;

      const mover = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 6, facing: 0 });
      mover.currentHealth = 50;

      const allUnits = [defender, mover];
      const path = [6, 4];
      const results = resolveReactionFire('m', path, allUnits, tiles);
      expect(results.length).toBe(0);
    });
  });

  // =========================================================================
  // Movement & facing
  // =========================================================================

  describe('movement and facing', () => {
    it('updates facing after movement', () => {
      const unit = makeUnit({ id: 'u', ownerId: 'p1', tileIndex: 0, facing: 0 });
      moveUnit(unit, 3, tiles);
      expect(unit.facing).toBe(2); // direction from 0 to 3 is index 2
      expect(unit.tileIndex).toBe(3);
    });

    it('facing remains unchanged if unit does not move', () => {
      const unit = makeUnit({ id: 'u', ownerId: 'p1', tileIndex: 0, facing: 4 });
      moveUnit(unit, 0, tiles);
      expect(unit.facing).toBe(4);
    });
  });

  // =========================================================================
  // Encirclement (informational, no longer affects damage)
  // =========================================================================

  describe('encirclement', () => {
    it('unit is encircled with 3+ enemy directions', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const e1 = makeUnit({ id: 'e1', ownerId: 'p2', tileIndex: 1 });
      const e2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 3 });
      const e3 = makeUnit({ id: 'e3', ownerId: 'p2', tileIndex: 5 });

      expect(isEncircled(target, [target, e1, e2, e3], tiles)).toBe(true);
    });

    it('unit is not encircled with fewer than 3 enemy directions', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0 });
      const e1 = makeUnit({ id: 'e1', ownerId: 'p2', tileIndex: 1 });
      const e2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 3 });

      expect(isEncircled(target, [target, e1, e2], tiles)).toBe(false);
    });
  });

  // =========================================================================
  // Full attack resolution
  // =========================================================================

  describe('resolveAttack', () => {
    it('returns invalid for out-of-range attack', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 1;
      attacker.attributes.attack = 0;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 3, facing: 0 });

      const result = resolveAttack('a', 't', [attacker, target], linear);
      expect(result.wasValid).toBe(false);
    });

    it('returns invalid for friendly fire', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });

      const result = resolveAttack('a', 't', [attacker, target], tiles);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('friendly');
    });

    it('destroys unit when health reaches 0', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 5;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      // Attacker at tile 1 approaches from direction 0. Target faces 3 (rear).
      // diff = (0-3+6)%6 = 3 → rear → +2 bonus
      // AP = 5+2 = 7, no defence, damage = 30
      target.attributes.armour = 0;
      target.currentHealth = 1;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.destroyedUnitIds).toContain('t');
      expect(target.currentHealth).toBe(0);
    });

    it('always deals at least 1 damage', () => {
      tiles[0] = { ...tiles[0], elevationType: 'mountain' };
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 1;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 5;
      target.currentHealth = 50;

      // Add EW allies in same hex
      const ew1 = makeUnit({ id: 'ew1', ownerId: 'p2', tileIndex: 0 });
      ew1.attributes.defence = 5;
      const ew2 = makeUnit({ id: 'ew2', ownerId: 'p2', tileIndex: 0 });
      ew2.attributes.defence = 5;

      const allUnits = [attacker, target, ew1, ew2];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.directDamage).toBeGreaterThanOrEqual(1);
    });

    it('correctly reports combat result fields', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 3;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 1;
      target.currentHealth = 50;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.attackerId).toBe('a');
      expect(result.targetId).toBe('t');
      expect(result.targetArmour).toBe(1);
      expect(typeof result.facingModifier).toBe('number');
      expect(typeof result.targetEffectiveDefense).toBe('number');
      expect(typeof result.directDamage).toBe('number');
      expect(result.directDamage).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Crossfire
  // =========================================================================

  describe('crossfire', () => {
    it('grants +1 when 2+ attackers from side/rear', () => {
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });

      // Tile 0 neighbours: [1,2,3,4,5,6]
      // facing 0 → direction 0,1,5 = front; direction 2,4 = side; direction 3 = rear
      const attackerA = makeUnit({ id: 'aA', ownerId: 'p1', tileIndex: 3, facing: 0 }); // side (dir 2)
      const attackerB = makeUnit({ id: 'aB', ownerId: 'p1', tileIndex: 4, facing: 0 }); // rear (dir 3)

      const bonus = getCrossfireBonus(attackerA, target, [attackerA, attackerB], tiles);
      expect(bonus).toBe(1);
    });

    it('does not grant crossfire from front arc', () => {
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      const attackerFront = makeUnit({ id: 'af', ownerId: 'p1', tileIndex: 1, facing: 0 }); // front
      const attackerSide = makeUnit({ id: 'as', ownerId: 'p1', tileIndex: 3, facing: 0 }); // side

      const bonus = getCrossfireBonus(attackerFront, target, [attackerFront, attackerSide], tiles);
      expect(bonus).toBe(0);
    });
  });
});
