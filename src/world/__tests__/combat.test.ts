import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAttackArc,
  getFacingModifier,
  getDirectionBetweenAdjacentHexes,
  getApproachDirection,
  getAdjacentFriendlySupport,
  getBestNearbyDefense,
  getEffectiveDefense,
  isEncircled,
  calculateDirectDamage,
  calculateSplashDamage,
  resolveAttack,
  resolveReactionFire,
  moveUnit,
  resolveSimultaneousAttacks,
  getCrossfireBonus,
  type AttackArc,
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
 * Each outer tile has tile 0 as a neighbour plus two adjacent outer tiles.
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
    elevation: 0,
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
      neighbours: [0, prev, next, 7 + i, 8 + i, 9 + i], // padded to 6 for hex shape
    });
  }

  // Fix outer tile neighbours to only reference real tiles (0-6)
  // Each outer tile: adjacent to centre (0) and two sibling outer tiles
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles[i].neighbours = [0, prev, next, prev, next, 0];
  }

  // Cleaner adjacency: outer tiles know centre and their cyclic siblings
  // Direction 0 = towards centre
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles[i].neighbours = [0, next, prev, 0, next, prev];
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
    elevation: 0,
  };

  const tiles: Tile[] = [];
  for (let i = 0; i < 6; i++) {
    const neighbours: number[] = [];
    if (i > 0) neighbours.push(i - 1);
    if (i < 5) neighbours.push(i + 1);
    // Pad to 6 neighbours for hex consistency (self-loops are ignored by combat)
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
    currentHealth: 3,
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
  // Facing & attack arc
  // =========================================================================

  describe('classifyAttackArc', () => {
    it('classifies front attack (same direction as facing)', () => {
      expect(classifyAttackArc(0, 0)).toBe('front');
      expect(classifyAttackArc(3, 3)).toBe('front');
    });

    it('classifies front-side attacks (±1 from facing)', () => {
      expect(classifyAttackArc(0, 1)).toBe('frontSide');
      expect(classifyAttackArc(0, 5)).toBe('frontSide');
      expect(classifyAttackArc(3, 4)).toBe('frontSide');
      expect(classifyAttackArc(3, 2)).toBe('frontSide');
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
      expect(classifyAttackArc(5, 0)).toBe('frontSide'); // 0 - 5 = -5 → mod6 = 1
      expect(classifyAttackArc(5, 2)).toBe('rear');      // 2 - 5 = -3 → mod6 = 3
    });

    it('returns unknown for negative approach direction', () => {
      expect(classifyAttackArc(0, -1)).toBe('unknown');
    });
  });

  describe('getFacingModifier', () => {
    it('front attack applies -1 damage', () => {
      expect(getFacingModifier('front')).toBe(-1);
    });

    it('front-side attack applies 0 damage modifier', () => {
      expect(getFacingModifier('frontSide')).toBe(0);
    });

    it('side attack applies +1 damage', () => {
      expect(getFacingModifier('side')).toBe(1);
    });

    it('rear attack applies +2 damage', () => {
      expect(getFacingModifier('rear')).toBe(2);
    });

    it('unknown defaults to 0', () => {
      expect(getFacingModifier('unknown')).toBe(0);
    });
  });

  // =========================================================================
  // Armour
  // =========================================================================

  describe('armour reduces damage', () => {
    it('armour subtracts from raw damage', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 3;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 2;
      target.attributes.defence = 0;

      const allUnits = [attacker, target];
      // Attacker at tile 1, target at tile 0
      // Approach from target(0) toward attacker(1): direction 0 in tile 0's neighbours
      // Target facing 0, approach direction 0 → front → -1 modifier
      // rawDamage = 3 + (-1) = 2, minus armour 2 = 0
      const { damage } = calculateDirectDamage(attacker, target, allUnits, tiles);
      expect(damage).toBe(0);
    });

    it('armour cannot make damage negative', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 1;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 5;
      target.attributes.defence = 0;

      const allUnits = [attacker, target];
      const { damage } = calculateDirectDamage(attacker, target, allUnits, tiles);
      expect(damage).toBe(0);
    });
  });

  // =========================================================================
  // Effective defense
  // =========================================================================

  describe('effective defense reduces damage', () => {
    it('defense reduces damage by floor(effectiveDefense / 2)', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 4;

      // Target facing towards tile 1 (direction 0), attacker at tile 2 (direction 1 in tile 0's neighbours)
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 0;
      target.attributes.defence = 3;

      const allUnits = [attacker, target];
      const effDef = getEffectiveDefense(target, allUnits, tiles);
      expect(effDef).toBe(3); // own 3, no nearby friends

      // floor(3 / 2) = 1 defense reduction
      // Approach direction from tile 0 toward tile 2: index 1 in neighbours
      // target facing 0, approach 1 → frontSide → 0 modifier
      // rawDamage = 4 + 0 = 4, minus armour 0, minus defReduction 1 = 3
      const { damage } = calculateDirectDamage(attacker, target, allUnits, tiles);
      expect(damage).toBe(3);
    });

    it('effectiveDefense is clamped to max 7', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      target.attributes.defence = 5;

      // Ally with high defence nearby
      const ally1 = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1, facing: 0 });
      ally1.attributes.defence = 5;
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 2, facing: 0 });
      const ally3 = makeUnit({ id: 'a3', ownerId: 'p1', tileIndex: 3, facing: 0 });

      // formation support from ally1, ally2, ally3 → capped at +2
      // ownDefense 5 + bestNearby 5 + formation 2 = 12 → clamped to 7
      const allUnits = [target, ally1, ally2, ally3];
      const effDef = getEffectiveDefense(target, allUnits, tiles);
      expect(effDef).toBe(7);
    });
  });

  // =========================================================================
  // Formation support
  // =========================================================================

  describe('formation support', () => {
    it('adjacent friendly units provide +1 each, max +2', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const ally1 = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1, facing: 0 });
      const ally2 = makeUnit({ id: 'a2', ownerId: 'p1', tileIndex: 2, facing: 0 });
      const ally3 = makeUnit({ id: 'a3', ownerId: 'p1', tileIndex: 3, facing: 0 });

      const allUnits = [target, ally1, ally2, ally3];
      expect(getAdjacentFriendlySupport(target, allUnits, tiles)).toBe(2); // capped
    });

    it('returns 0 with no nearby friendlies', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const enemy = makeUnit({ id: 'e', ownerId: 'p2', tileIndex: 1, facing: 0 });
      expect(getAdjacentFriendlySupport(target, [target, enemy], tiles)).toBe(0);
    });

    it('destroyed units do not provide support', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const ally = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 1, facing: 0 });
      ally.currentHealth = 0;
      expect(getAdjacentFriendlySupport(target, [target, ally], tiles)).toBe(0);
    });

    it('same-hex units contribute to formation support', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, segment: 0, facing: 0 });
      const ally = makeUnit({ id: 'a1', ownerId: 'p1', tileIndex: 0, segment: 1, facing: 0 });
      expect(getAdjacentFriendlySupport(target, [target, ally], tiles)).toBe(1);
    });
  });

  // =========================================================================
  // Nearby defense aura
  // =========================================================================

  describe('nearby defense aura', () => {
    it('uses the best nearby friendly defense value', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      target.attributes.defence = 1;

      const ewDrone = makeUnit({ id: 'ew', ownerId: 'p1', tileIndex: 1, facing: 0 });
      ewDrone.attributes.defence = 5;

      const weakAlly = makeUnit({ id: 'wa', ownerId: 'p1', tileIndex: 2, facing: 0 });
      weakAlly.attributes.defence = 2;

      const allUnits = [target, ewDrone, weakAlly];
      expect(getBestNearbyDefense(target, allUnits, tiles)).toBe(5);
    });

    it('destroyed units do not provide defense aura', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const ewDrone = makeUnit({ id: 'ew', ownerId: 'p1', tileIndex: 1, facing: 0 });
      ewDrone.attributes.defence = 5;
      ewDrone.currentHealth = 0;

      expect(getBestNearbyDefense(target, [target, ewDrone], tiles)).toBe(0);
    });

    it('enemy units do not contribute to defense aura', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const enemyEw = makeUnit({ id: 'ee', ownerId: 'p2', tileIndex: 1, facing: 0 });
      enemyEw.attributes.defence = 5;

      expect(getBestNearbyDefense(target, [target, enemyEw], tiles)).toBe(0);
    });
  });

  // =========================================================================
  // Splash damage
  // =========================================================================

  describe('splash damage', () => {
    it('damages adjacent units after primary attack', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 2;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.attributes.armour = 0;
      target.attributes.defence = 0;
      target.currentHealth = 5;

      // Bystander adjacent to target
      const bystander = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 1, facing: 0 });
      bystander.attributes.armour = 0;
      bystander.attributes.defence = 0;
      bystander.currentHealth = 5;

      const allUnits = [attacker, target, bystander];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.splashEvents.length).toBeGreaterThan(0);
      expect(result.splashEvents.some((e) => e.victimId === 'b')).toBe(true);
    });

    it('splash affects friendly units adjacent to primary target', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 3;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.attributes.armour = 0;
      target.attributes.defence = 0;
      target.currentHealth = 5;

      // Friendly unit adjacent to target
      const friendly = makeUnit({ id: 'f', ownerId: 'p1', tileIndex: 1, facing: 0 });
      friendly.attributes.armour = 0;
      friendly.attributes.defence = 0;
      friendly.currentHealth = 5;

      const allUnits = [attacker, target, friendly];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.splashEvents.some((e) => e.victimId === 'f')).toBe(true);
    });

    it('splash damage is reduced by victim armour and defense', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 2, facing: 0 });
      attacker.attributes.attack = 3;
      attacker.attributes.splashAttack = 3;
      attacker.attributes.rangeAttack = 2;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 3 });
      target.attributes.armour = 0;
      target.attributes.defence = 0;
      target.currentHealth = 5;

      // Armoured bystander
      const armoured = makeUnit({ id: 'ab', ownerId: 'p2', tileIndex: 1, facing: 0 });
      armoured.attributes.armour = 4; // floor(4/2) = 2 reduction
      armoured.attributes.defence = 2; // effective def = 2, floor(2/2) = 1 reduction
      armoured.currentHealth = 5;

      const allUnits = [attacker, target, armoured];
      const result = resolveAttack('a', 't', allUnits, tiles);

      // splash = 3 - floor(4/2) - floor(2/2) = 3 - 2 - 1 = 0
      const splashOnArmoured = result.splashEvents.find((e) => e.victimId === 'ab');
      expect(splashOnArmoured?.damage ?? 0).toBe(0);
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
      target.attributes.defence = 0;

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
      target.attributes.armour = 0;
      target.attributes.defence = 0;

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
      unitA.attributes.defence = 0;
      unitA.currentHealth = 1;

      const unitB = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 0, facing: 0 });
      unitB.attributes.attack = 5;
      unitB.attributes.armour = 0;
      unitB.attributes.defence = 0;
      unitB.currentHealth = 1;

      const allUnits = [unitA, unitB];
      const results = resolveSimultaneousAttacks('a', 'b', allUnits, tiles);

      // Both should deal damage (simultaneous)
      expect(results.length).toBe(2);
      // Both destroyed
      expect(unitA.currentHealth).toBe(0);
      expect(unitB.currentHealth).toBe(0);
    });
  });

  // =========================================================================
  // Reaction fire
  // =========================================================================

  describe('reaction fire', () => {
    it('triggers from front arc when enemy is in range', () => {
      // Enemy at tile 0 facing direction 0 (toward tile 1)
      const defender = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 0, facing: 0 });
      defender.attributes.attack = 3;
      defender.attributes.rangeAttack = 1;
      defender.attributes.armour = 0;
      defender.attributes.defence = 0;

      // Moving unit starts at tile 3 and moves to tile 1 (enters defender's front arc)
      const mover = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 3, facing: 0 });
      mover.attributes.armour = 0;
      mover.attributes.defence = 0;
      mover.currentHealth = 5;

      const allUnits = [defender, mover];

      const simplePath = [3, 1]; // move from 3 to 1
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
      mover.attributes.armour = 0;
      mover.attributes.defence = 0;
      mover.currentHealth = 5;

      const allUnits = [defender, mover];
      // Path passes through two hexes in defender's range
      const path = [4, 1, 2]; // enter tile 1, then tile 2

      const results = resolveReactionFire('m', path, allUnits, tiles);
      // Should only fire once (first trigger at tile 1 if in front arc)
      const defenderShots = results.filter((r) => r.attackerId === 'd');
      expect(defenderShots.length).toBeLessThanOrEqual(1);
    });

    it('does not trigger from non-front arc', () => {
      // Defender facing 0 (toward tile 1). Mover enters tile 4 (direction 3 from centre = rear)
      const defender = makeUnit({ id: 'd', ownerId: 'p2', tileIndex: 0, facing: 0 });
      defender.attributes.attack = 3;
      defender.attributes.rangeAttack = 1;

      const mover = makeUnit({ id: 'm', ownerId: 'p1', tileIndex: 6, facing: 0 });
      mover.currentHealth = 5;

      const allUnits = [defender, mover];
      // Mover enters tile 4 — direction index 3 in tile 0's neighbours
      // classifyAttackArc(0, 3) = 'rear' → NOT front arc, no reaction
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
      // Move from tile 0 to tile 3 (direction index 2 in tile 0's neighbours)
      moveUnit(unit, 3, tiles);
      // Direction from tile 0 toward tile 3: index of 3 in tiles[0].neighbours = 2
      expect(unit.facing).toBe(2);
      expect(unit.tileIndex).toBe(3);
    });

    it('facing remains unchanged if unit does not move', () => {
      const unit = makeUnit({ id: 'u', ownerId: 'p1', tileIndex: 0, facing: 4 });
      moveUnit(unit, 0, tiles); // move to same tile
      expect(unit.facing).toBe(4);
    });
  });

  // =========================================================================
  // Encirclement
  // =========================================================================

  describe('encirclement', () => {
    it('unit is encircled with 3+ enemy directions', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const e1 = makeUnit({ id: 'e1', ownerId: 'p2', tileIndex: 1, facing: 0 });
      const e2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 3, facing: 0 });
      const e3 = makeUnit({ id: 'e3', ownerId: 'p2', tileIndex: 5, facing: 0 });

      expect(isEncircled(target, [target, e1, e2, e3], tiles)).toBe(true);
    });

    it('unit is not encircled with fewer than 3 enemy directions', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      const e1 = makeUnit({ id: 'e1', ownerId: 'p2', tileIndex: 1, facing: 0 });
      const e2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 3, facing: 0 });

      expect(isEncircled(target, [target, e1, e2], tiles)).toBe(false);
    });

    it('encirclement reduces effective defense by 1', () => {
      const target = makeUnit({ id: 't', ownerId: 'p1', tileIndex: 0, facing: 0 });
      target.attributes.defence = 2;

      const e1 = makeUnit({ id: 'e1', ownerId: 'p2', tileIndex: 1, facing: 0 });
      const e2 = makeUnit({ id: 'e2', ownerId: 'p2', tileIndex: 3, facing: 0 });
      const e3 = makeUnit({ id: 'e3', ownerId: 'p2', tileIndex: 5, facing: 0 });

      const allUnits = [target, e1, e2, e3];
      // ownDefense = 2, no allies nearby, formation = 0, encircled → -1
      // effectiveDefense = 2 - 1 = 1
      expect(getEffectiveDefense(target, allUnits, tiles)).toBe(1);
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
      // Attacker at tile 1, target at tile 0 facing 3 (away from attacker)
      // Approach: from tile 0 toward tile 1 = direction 0
      // Target facing 3, approach 0: diff = (0-3+6)%6 = 3 → rear → +2
      target.attributes.armour = 0;
      target.attributes.defence = 0;
      target.currentHealth = 1;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.destroyedUnitIds).toContain('t');
      expect(target.currentHealth).toBe(0);
    });

    it('correctly reports combat result fields', () => {
      const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.attack = 3;

      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      target.attributes.armour = 1;
      target.attributes.defence = 2;
      target.currentHealth = 5;

      const allUnits = [attacker, target];
      const result = resolveAttack('a', 't', allUnits, tiles);

      expect(result.wasValid).toBe(true);
      expect(result.attackerId).toBe('a');
      expect(result.targetId).toBe('t');
      expect(result.targetArmour).toBe(1);
      expect(typeof result.facingModifier).toBe('number');
      expect(typeof result.targetEffectiveDefense).toBe('number');
      expect(typeof result.directDamage).toBe('number');
    });
  });

  // =========================================================================
  // Crossfire
  // =========================================================================

  describe('crossfire', () => {
    it('grants +1 when 2+ attackers from side/rear', () => {
      // Target at tile 0 facing 0
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });

      // Attackers from side and rear arcs
      // Tile 0 neighbours: [1,2,3,4,5,6]
      // facing 0, so:
      //   direction 0 (tile 1) = front
      //   direction 2 (tile 3) = side
      //   direction 3 (tile 4) = rear
      //   direction 4 (tile 5) = side
      const attackerA = makeUnit({ id: 'aA', ownerId: 'p1', tileIndex: 3, facing: 0 }); // side
      const attackerB = makeUnit({ id: 'aB', ownerId: 'p1', tileIndex: 4, facing: 0 }); // rear

      const bonus = getCrossfireBonus(attackerA, target, [attackerA, attackerB], tiles);
      expect(bonus).toBe(1);
    });

    it('does not grant crossfire from front arc', () => {
      const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0, facing: 0 });
      const attackerFront = makeUnit({ id: 'af', ownerId: 'p1', tileIndex: 1, facing: 0 }); // front
      const attackerSide = makeUnit({ id: 'as', ownerId: 'p1', tileIndex: 3, facing: 0 }); // side

      const bonus = getCrossfireBonus(attackerFront, target, [attackerFront, attackerSide], tiles);
      expect(bonus).toBe(0); // front attacker doesn't qualify
    });
  });
});
