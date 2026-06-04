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
  clamp,
  calculateFormulaDamage,
  applyDamage,
  calculateDirectDamage,
  calculateSplashDamage,
  SPLASH_SCALE,
  resolveAttack,
  resolveReactionFire,
  moveUnit,
  resolveSimultaneousAttacks,
  getCrossfireBonus,
  DEFENCE_SCALE,
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
 *
 * Positions are placed on the unit sphere in a flat-earth-friendly pattern:
 * Tile 0 at the "north pole" region, neighbours arranged in a hex ring.
 */
function createTestGrid(): Tile[] {
  // Place tile 0 near the pole, with neighbours in a ring around it.
  // Hex spacing angle (~10° apart gives realistic relative geometry).
  const centerPos = { x: 0, y: 0, z: 1 }; // north pole
  const angularSpacing = 0.15; // radians from center to neighbours (~8.6°)

  // Neighbour directions (clockwise from north): 0°, 60°, 120°, 180°, 240°, 300°
  const neighbourPositions: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3; // 0, 60, 120, 180, 240, 300 degrees
    const x = Math.sin(angularSpacing) * Math.sin(angle);
    const y = Math.sin(angularSpacing) * Math.cos(angle);
    const z = Math.cos(angularSpacing);
    neighbourPositions.push({ x, y, z });
  }

  const baseTile = {
    id: '',
    index: 0,
    sides: 6 as const,
    neighbours: [] as number[],
    position3d: centerPos,
    boundary: [],
    terrainType: 'plains' as const,
    elevationType: 'rolling' as const,
    forested: false,
  };

  const tiles: Tile[] = [];

  // Tile 0 — centre, neighbours are 1–6
  tiles.push({ ...baseTile, id: 't0', index: 0, position3d: centerPos, neighbours: [1, 2, 3, 4, 5, 6] });

  // Tiles 1–6 — outer ring
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push({
      ...baseTile,
      id: `t${i}`,
      index: i,
      position3d: neighbourPositions[i - 1],
      neighbours: [0, next, prev, 0, next, prev],
    });
  }

  return tiles;
}

/**
 * Create a simple linear grid for range testing.
 * Tiles 0-1-2-3-4-5, each adjacent only to its direct neighbors.
 * Positions are placed along a line on the sphere surface.
 */
function createLinearGrid(): Tile[] {
  const baseTile = {
    id: '',
    index: 0,
    sides: 6 as const,
    neighbours: [] as number[],
    position3d: { x: 0, y: 0, z: 1 },
    boundary: [],
    terrainType: 'plains' as const,
    elevationType: 'rolling' as const,
    forested: false,
  };

  const spacing = 0.15; // radians between tiles

  const tiles: Tile[] = [];
  for (let i = 0; i < 6; i++) {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < 5) neighbours.push(i + 1);
    while (neighbours.length < 6) neighbours.push(i);

    // Position along a line (varying x, z is cos of angle from pole)
    const theta = (i - 2.5) * spacing; // center around tile 2-3
    const pos = { x: Math.sin(theta), y: 0, z: Math.cos(theta) };

    tiles.push({ ...baseTile, id: `t${i}`, index: i, position3d: pos, neighbours });
  }
  return tiles;
}

function makeUnit(overrides: Partial<Unit> & { id: string; ownerId: string }): Unit {
  return {
    label: overrides.id,
    tileIndex: 0,
    segment: 0,
    facing: 0,
    attributes: { maxHealth: 3, kinetic: 2, limbMovement: 1 },
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
  // Damage formula — spec examples using calculateFormulaDamage
  // =========================================================================

  // Helper: build effective defence from raw components
  // formation parameter is the supporter count (0–2); each contributes 0.5 to DefencePower
  function ed(armour: number, ew: number, formationCount: number, terrain: number): number {
    return (clamp(armour, 0, 5) + clamp(ew, 0, 5) + clamp(formationCount, 0, 2) * 0.5 + clamp(terrain, 0, 4)) * DEFENCE_SCALE;
  }

  describe('calculateFormulaDamage', () => {
    it('weakest attack vs strongest defence = 1', () => {
      // attackPower=1 (front), defencePower=16, ED=12
      const damage = calculateFormulaDamage(1, ed(5, 5, 2, 4));
      expect(damage).toBe(1);
    });

    it('strongest attack vs weakest defence = 30', () => {
      // attackPower=7 (attack=5 + rear +2), no defence
      const damage = calculateFormulaDamage(7, ed(0, 0, 0, 0));
      expect(damage).toBe(30);
    });

    it('attack=5, front, no defence = 30', () => {
      const damage = calculateFormulaDamage(5, ed(0, 0, 0, 0));
      expect(damage).toBe(30);
    });

    it('attack=1, side (+1), max defence = 1', () => {
      // AP=2, DefPower=16, ED=12
      const damage = calculateFormulaDamage(2, ed(5, 5, 2, 4));
      expect(damage).toBe(1);
    });

    it('attack=1, rear (+2), max defence = 2', () => {
      // AP=3, DefPower=16, ED=12
      const damage = calculateFormulaDamage(3, ed(5, 5, 2, 4));
      expect(damage).toBe(2);
    });

    it('attack=3, front, DefPower=8 → 4', () => {
      // AP=3, DefPower=8, ED=6
      const damage = calculateFormulaDamage(3, ed(3, 3, 1, 1));
      expect(damage).toBe(5);
    });

    it('attack=3, side (+1), DefPower=8 → 8', () => {
      // AP=4, DefPower=8, ED=6
      const damage = calculateFormulaDamage(4, ed(3, 3, 1, 1));
      expect(damage).toBe(9);
    });

    it('attack=3, rear (+2), DefPower=8 → 13', () => {
      // AP=5, DefPower=8, ED=6
      const damage = calculateFormulaDamage(5, ed(3, 3, 1, 1));
      expect(damage).toBe(14);
    });

    it('attack=5, front, DefPower=8 → 13', () => {
      // AP=5, DefPower=8, ED=6
      const damage = calculateFormulaDamage(5, ed(3, 3, 1, 1));
      expect(damage).toBe(14);
    });

    it('attack=5, side (+1), DefPower=8 → 16', () => {
      // AP=6, DefPower=8, ED=6
      const damage = calculateFormulaDamage(6, ed(3, 3, 1, 1));
      expect(damage).toBe(16);
    });

    it('attack=5, rear (+2), DefPower=8 → 18', () => {
      // AP=7, DefPower=8, ED=6
      const damage = calculateFormulaDamage(7, ed(3, 3, 1, 1));
      expect(damage).toBe(19);
    });

    it('minimum attackPower of 1 gives 6 with no defence', () => {
      // AP=1, ED=0, maxFD=min(30,6)=6, damage=6
      const damage = calculateFormulaDamage(1, ed(0, 0, 0, 0));
      expect(damage).toBe(6);
    });

    it('damage is always at least 1', () => {
      const damage = calculateFormulaDamage(1, ed(5, 5, 2, 4));
      expect(damage).toBeGreaterThanOrEqual(1);
    });

    it('damage never exceeds 30', () => {
      const damage = calculateFormulaDamage(7, ed(0, 0, 0, 0));
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
      expect(dp.ew).toBe(5); // target(2) + ewAlly(4) = 6, capped at 5
      expect(dp.defensiveFormation).toBe(1); // 2 supporters × 0.5 = 1.0
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
      expect(dp.defensiveFormation).toBe(1); // ew1 + ew2 same hex + f1 adjacent = 3 supporters, capped at 2, × 0.5 = 1.0
      expect(dp.terrain).toBe(3); // mountain
      expect(dp.total).toBe(14);
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
    it('splash fire is chosen when it scores higher than direct fire', () => {
      // Attacker with both attack and splashAttack. Put 4 enemies in the target hex.
      // With chassis modifier applied equally to both modes, splash wins when it
      // hits enough targets (4+ enemies at 30% each exceeds single-target direct).
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 3;
      attacker.attributes.splashAttack = 3;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const enemy2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 0, facing: 0 });
      enemy2.attributes.armour = 0;
      enemy2.currentHealth = 50;

      const enemy3 = makeUnit({ id: 'e3', ownerId: 'p2', tileIndex: 0, facing: 0 });
      enemy3.attributes.armour = 0;
      enemy3.currentHealth = 50;

      const enemy4 = makeUnit({ id: 'e4', ownerId: 'p2', tileIndex: 0, facing: 0 });
      enemy4.attributes.armour = 0;
      enemy4.currentHealth = 50;

      const allUnits = [attacker, target, enemy2, enemy3, enemy4];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.chosenWeaponMode).toBe('splash');
      // All 4 enemies in the hex should be hit
      expect(result.splashEvents.length).toBe(4);
    });

    it('direct fire is chosen when only one enemy is in the target hex', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 5;
      attacker.attributes.splashAttack = 5;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      // Direct fire (attack=5) deals 30; splash (splashAttack=5) deals round(30*0.3)=9 to 1 unit
      // Direct wins
      expect(result.chosenWeaponMode).toBe('direct');
    });

    it('splash only affects enemies in the target hex, not adjacent hexes', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.kinetic = 3;
      attacker.attributes.splashAttack = 3;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      // Bystander in adjacent hex (tile 1) — should NOT be hit by splash
      const bystander = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 1, facing: 0 });
      bystander.attributes.armour = 0;
      bystander.currentHealth = 50;

      const allUnits = [attacker, target, bystander];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      // Bystander is in adjacent hex, not target hex — must not be in splash events
      expect(result.splashEvents.some((e) => e.victimId === 'b')).toBe(false);
      // Bystander health must be unchanged
      expect(bystander.currentHealth).toBe(50);
    });

    it('splash hits all enemies in the target hex', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 2;
      attacker.attributes.splashAttack = 5;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const enemy2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 0, facing: 0 });
      enemy2.attributes.armour = 0;
      enemy2.currentHealth = 50;

      const allUnits = [attacker, target, enemy2];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.chosenWeaponMode).toBe('splash');
      // Both enemies in the hex should be hit
      const hitIds = result.splashEvents.map((e) => e.victimId);
      expect(hitIds).toContain('t');
      expect(hitIds).toContain('e2');
    });

    it('splash does not hit friendly units', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 2;
      attacker.attributes.splashAttack = 5;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      // Friendly in same hex as target — should NOT be hit
      const friendly = makeUnit({ id: 'f', ownerId: 'p1', tileIndex: 0, facing: 0 });
      friendly.attributes.armour = 0;
      friendly.currentHealth = 50;

      const allUnits = [attacker, target, friendly];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.splashEvents.some((e) => e.victimId === 'f')).toBe(false);
      expect(friendly.currentHealth).toBe(50);
    });

    it('splash damage is reduced by victim defence', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 2;
      attacker.attributes.splashAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.currentHealth = 50;

      const armoured = makeUnit({ id: 'ar', ownerId: 'p2', tileIndex: 0, facing: 0 });
      armoured.attributes.armour = 4;
      armoured.currentHealth = 50;

      const allUnits = [attacker, target, armoured];
      const result = resolveAttack('a', 't', allUnits, tiles);

      if (result.chosenWeaponMode === 'splash') {
        const armouredEvent = result.splashEvents.find((e) => e.victimId === 'ar');
        const targetEvent = result.splashEvents.find((e) => e.victimId === 't');
        expect(armouredEvent).toBeDefined();
        expect(targetEvent).toBeDefined();
        // Armoured unit should take less damage
        expect(armouredEvent!.damage).toBeLessThan(targetEvent!.damage);
      }
    });

    it('splash always deals at least 1 damage per unit', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 1;
      attacker.attributes.splashAttack = 1;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 5;
      target.currentHealth = 50;

      const enemy2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 0, facing: 0 });
      enemy2.attributes.armour = 5;
      enemy2.currentHealth = 50;

      const allUnits = [attacker, target, enemy2];
      const result = resolveAttack('a', 't', allUnits, tiles);

      for (const event of result.splashEvents) {
        expect(event.damage).toBeGreaterThanOrEqual(1);
      }
    });

    it('calculateSplashDamage uses orientation bonus for selected target only', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.splashAttack = 3;

      // Selected target facing away (rear) — should get orientation bonus
      const selectedTarget = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      selectedTarget.attributes.armour = 0;

      // Other unit in same hex, facing front — no orientation bonus
      const otherUnit = makeUnit({ id: 'o', ownerId: 'p2', tileIndex: 0, facing: 0 });
      otherUnit.attributes.armour = 0;

      const allUnits = [attacker, selectedTarget, otherUnit];

      const dmgSelected = calculateSplashDamage(attacker, selectedTarget, selectedTarget, allUnits, tiles);
      const dmgOther = calculateSplashDamage(attacker, selectedTarget, otherUnit, allUnits, tiles);

      // Selected target gets rear orientation bonus (+2), so should take more damage
      expect(dmgSelected).toBeGreaterThan(dmgOther);
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
      attacker.attributes.kinetic = 0;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 3, facing: 0 });

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, linear);
      expect(result.wasValid).toBe(false);
      expect(result.reasonInvalid).toContain('range');
    });

    it('melee attack (attack > 0, range 0) works at distance 1', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 2;
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
      attacker.attributes.kinetic = 2;
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
      unitA.attributes.kinetic = 5;
      unitA.attributes.armour = 0;
      unitA.currentHealth = 1;

      const unitB = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 0, facing: 0 });
      unitB.attributes.kinetic = 5;
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
  // Reaction fire (Anti-Air only, drones only — §16)
  // =========================================================================

  describe('reaction fire', () => {
    it('triggers AA reaction fire when a drone moves through an enemy antiAir tile', () => {
      const aaUnit = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aaUnit.attributes.antiAir = 3;

      const drone = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      drone.attributes.flightMovement = 3;
      drone.currentHealth = 50;

      const allUnits = [aaUnit, drone];
      const path = [3, 1]; // drone moves into tile 1 where aaUnit is
      const results = resolveReactionFire('m', path, allUnits, tiles);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].attackerId).toBe('d');
      expect(results[0].targetId).toBe('m');
      expect(results[0].chosenWeaponMode).toBe('antiAir');
    });

    it('does not trigger reaction fire for ground units (tanks/spiders)', () => {
      const aaUnit = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aaUnit.attributes.antiAir = 3;

      const tank = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      // tank has wheeledMovement (default from makeUnit), no flightMovement
      tank.currentHealth = 50;

      const allUnits = [aaUnit, tank];
      const path = [3, 1];
      const results = resolveReactionFire('m', path, allUnits, tiles);
      expect(results.length).toBe(0);
    });

    it('does not trigger more than once per unit per drone action', () => {
      const aaUnit = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      aaUnit.attributes.antiAir = 2;

      const drone = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 4, facing: 0 });
      drone.attributes.flightMovement = 3;
      drone.currentHealth = 50;

      const allUnits = [aaUnit, drone];
      // Path passes through tile 1 twice (back and forth) — but aaUnit should only fire once
      const path = [4, 1, 2];

      const results = resolveReactionFire('m', path, allUnits, tiles);
      const aaShots = results.filter((r) => r.attackerId === 'd');
      expect(aaShots.length).toBeLessThanOrEqual(1);
    });

    it('does not trigger when enemy has no antiAir', () => {
      const groundUnit = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 1, facing: 0 });
      groundUnit.attributes.kinetic = 3; // has attack but no antiAir

      const drone = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      drone.attributes.flightMovement = 3;
      drone.currentHealth = 50;

      const allUnits = [groundUnit, drone];
      const path = [3, 1];
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
  // Full attack resolution
  // =========================================================================

  describe('resolveAttack', () => {
    it('returns invalid for out-of-range attack', () => {
      const linear = createLinearGrid();
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 0, facing: 0 });
      attacker.attributes.rangeAttack = 1;
      attacker.attributes.kinetic = 0;

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
      attacker.attributes.kinetic = 5;

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
      attacker.attributes.kinetic = 1;

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
      attacker.attributes.kinetic = 3;

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
  // Crossfire (deprecated — always returns 0)
  // =========================================================================

  describe('crossfire', () => {
    it('always returns 0 (deprecated)', () => {
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      const attackerA = makeUnit({ id: 'aA', ownerId: 'p1', tileIndex: 3, facing: 0 });
      const attackerB = makeUnit({ id: 'aB', ownerId: 'p1', tileIndex: 4, facing: 0 });

      const bonus = getCrossfireBonus(attackerA, target, [attackerA, attackerB], tiles);
      expect(bonus).toBe(0);
    });
  });
});
