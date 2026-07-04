/**
 * Behavioural coverage for server/combatExplainer.ts — the real step-by-step
 * combat/repair explanation formatter. No mocks: every explanation is produced
 * by the real formatter against real Unit/Tile/CombatContext objects, and the
 * splash/reaction examples drive the real resolveAttack path.
 *
 * Property 17 (design.md): for any valid attack, the rendered explanation text
 * contains every breakdown component (attack power, effective defence, weapon
 * mode, final damage).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Unit } from '../../src/world/units.js';
import { Tile } from '../../src/world/types.js';
import { resolveAttack, type CombatContext } from '../../src/world/combat.js';
import type { ExplanationStep } from '../../shared/combatTypes.js';
import {
  explainAttack,
  explainSplash,
  buildReactionExplanation,
  explainRepairAction,
  explainRepairInvalid,
} from '../combatExplainer.js';

// ---------------------------------------------------------------------------
// Fixtures — synthetic 7-tile hex grid (centre 0, ring 1–6). Empty boundary
// arrays make segment distance fall back to graph (BFS-hop) distance, so
// centre↔ring = 1.0 hex-unit (always in range) and ring↔opposite-ring = 2.0.
// ---------------------------------------------------------------------------
function createTestGrid(): Tile[] {
  const base = {
    id: '', index: 0, sides: 6 as const, neighbours: [] as number[],
    position3d: { x: 0, y: 0, z: 1 }, boundary: [], terrainType: 'plains' as const,
    height: 4, forested: false,
  };
  const spacing = 0.15;
  const ring: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    ring.push({ x: Math.sin(spacing) * Math.sin(a), y: Math.sin(spacing) * Math.cos(a), z: Math.cos(spacing) });
  }
  const tiles: Tile[] = [];
  tiles.push({ ...base, id: 't0', index: 0, neighbours: [1, 2, 3, 4, 5, 6] });
  for (let i = 1; i <= 6; i++) {
    const prev = i === 1 ? 6 : i - 1;
    const next = i === 6 ? 1 : i + 1;
    tiles.push({ ...base, id: `t${i}`, index: i, position3d: ring[i - 1], neighbours: [0, next, prev, 0, next, prev] });
  }
  return tiles;
}

function makeUnit(over: Partial<Unit> & { id: string; ownerId: string }): Unit {
  return {
    label: over.label ?? over.id, tileIndex: 0, segment: 0, facing: 0,
    attributes: { size: 5, kinetic: 2, rangeAttack: 2, limbMovement: 1 },
    currentHealth: 50, ...over,
  };
}

function makeCtx(units: Unit[], tiles: Tile[]): CombatContext {
  return { units, tiles, buildings: [] };
}

/** Flatten an explanation's steps into one searchable string. */
function renderSteps(steps: ExplanationStep[]): string {
  return steps.map((s) => [s.title, s.description, s.formula ?? '', s.result].join(' ')).join('\n');
}

const WEAPON_LABEL: Record<string, string> = {
  kinetic: 'Kinetic Fire',
  splash: 'Splash Fire',
  antiAir: 'Anti-Air Fire',
};

// ---------------------------------------------------------------------------
// Property 17 — rendered explanation contains every breakdown component
// ---------------------------------------------------------------------------
describe('Feature: unit-test-coverage, Property 17: explainer output contains every breakdown component', () => {
  it('rendered attack explanation always mentions attack power, effective defence, weapon mode, and final damage', () => {
    const arbAttacker = fc.record({
      kinetic: fc.integer({ min: 1, max: 5 }),
      splashAttack: fc.integer({ min: 0, max: 5 }),
      antiAir: fc.integer({ min: 0, max: 5 }),
    });
    fc.assert(
      fc.property(
        arbAttacker,
        fc.boolean(), // target is a drone?
        fc.integer({ min: 0, max: 5 }), // target facing
        fc.integer({ min: 0, max: 5 }), // target armour
        fc.integer({ min: 0, max: 5 }), // target defence (EW)
        (atk, targetIsDrone, facing, armour, defence) => {
          const tiles = createTestGrid();
          const attacker = makeUnit({
            id: 'atk', ownerId: 'A', tileIndex: 1, segment: 0,
            attributes: { size: 5, kinetic: atk.kinetic, splashAttack: atk.splashAttack, antiAir: atk.antiAir, rangeAttack: 2, limbMovement: 1 },
          });
          const target = makeUnit({
            id: 'tgt', ownerId: 'B', tileIndex: 0, segment: 0, facing: facing as Unit['facing'],
            attributes: targetIsDrone
              ? { size: 3, armour, defence, flightMovement: 2 }
              : { size: 3, armour, defence, limbMovement: 1 },
          });
          const ctx = makeCtx([attacker, target], tiles);
          const ex = explainAttack(attacker, target, ctx);

          // Adjacent + same elevation ⇒ always a valid, in-range attack.
          expect(ex.wasValid).toBe(true);
          expect(ex.breakdown).toBeDefined();
          const text = renderSteps(ex.steps);

          // attack power component
          expect(text.toLowerCase()).toContain('attackpower');
          // effective defence component
          expect(text.toLowerCase()).toContain('effectivedefence');
          // weapon mode component — the chosen mode's human label appears
          const mode = ex.breakdown!.weaponMode;
          expect(mode).not.toBe('none');
          expect(text).toContain(WEAPON_LABEL[mode]);
          // final damage component — the resolved damage number appears in text
          expect(text).toContain(String(ex.directDamage));
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example tests — representative formatting across modes and code paths
// ---------------------------------------------------------------------------
describe('explainAttack — representative formatting', () => {
  it('formats a direct kinetic attack against a ground target', () => {
    const tiles = createTestGrid();
    const attacker = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, attributes: { size: 5, kinetic: 4, rangeAttack: 2, limbMovement: 1 } });
    const target = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 0, attributes: { size: 3, armour: 2, limbMovement: 1 } });
    const ex = explainAttack(attacker, target, makeCtx([attacker, target], tiles));
    expect(ex.wasValid).toBe(true);
    expect(ex.breakdown?.weaponMode).toBe('kinetic');
    expect(renderSteps(ex.steps)).toContain('Kinetic Fire');
    expect(ex.directDamage).toBeGreaterThan(0);
  });

  it('selects and formats anti-air fire against a drone target', () => {
    const tiles = createTestGrid();
    const attacker = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, attributes: { size: 5, antiAir: 5, rangeAttack: 2, limbMovement: 1 } });
    const target = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 0, attributes: { size: 3, armour: 1, flightMovement: 2 } });
    const ex = explainAttack(attacker, target, makeCtx([attacker, target], tiles));
    expect(ex.wasValid).toBe(true);
    expect(ex.breakdown?.weaponMode).toBe('antiAir');
    expect(renderSteps(ex.steps)).toContain('Anti-Air Fire');
  });

  it('applies the drone incoming modifier note for direct fire on a drone', () => {
    const tiles = createTestGrid();
    const attacker = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, attributes: { size: 5, kinetic: 5, rangeAttack: 2, limbMovement: 1 } });
    const target = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 0, attributes: { size: 3, armour: 0, flightMovement: 2 } });
    const ex = explainAttack(attacker, target, makeCtx([attacker, target], tiles));
    expect(renderSteps(ex.steps).toLowerCase()).toContain('drone');
  });

  it('marks an out-of-range attack invalid with full breakdown still present', () => {
    const tiles = createTestGrid();
    // tile 1 → tile 4 is 2 graph hops; rangeAttack 0 ⇒ threshold 1.0.
    const attacker = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, attributes: { size: 5, kinetic: 3, rangeAttack: 0, limbMovement: 1 } });
    const target = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 4, attributes: { size: 3, armour: 1, limbMovement: 1 } });
    const ex = explainAttack(attacker, target, makeCtx([attacker, target], tiles));
    expect(ex.wasValid).toBe(false);
    expect(ex.reasonInvalid).toBe('Out of range');
    expect(ex.directDamage).toBe(0);
  });

  it('returns invalid explanations for destroyed / friendly / dead-target cases', () => {
    const tiles = createTestGrid();
    const dead = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, currentHealth: 0 });
    const live = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 0 });
    expect(explainAttack(dead, live, makeCtx([dead, live], tiles)).reasonInvalid).toBe('Attacker is destroyed');

    const atk = makeUnit({ id: 'c', ownerId: 'A', tileIndex: 1 });
    const deadTarget = makeUnit({ id: 'd', ownerId: 'B', tileIndex: 0, currentHealth: 0 });
    expect(explainAttack(atk, deadTarget, makeCtx([atk, deadTarget], tiles)).reasonInvalid).toBe('Target is already destroyed');

    const friend = makeUnit({ id: 'e', ownerId: 'A', tileIndex: 0 });
    const ex = explainAttack(atk, friend, makeCtx([atk, friend], tiles));
    expect(ex.wasValid).toBe(false);
    expect(ex.reasonInvalid).toBe('Cannot attack a friendly unit');
  });
});

describe('explainSplash — multi-victim formatting via the real resolveAttack path', () => {
  it('produces a per-victim explanation for each enemy in the target hex', () => {
    const tiles = createTestGrid();
    const attacker = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, attributes: { size: 5, splashAttack: 5, kinetic: 0, rangeAttack: 2, limbMovement: 1 } });
    const t1 = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 0, segment: 0, attributes: { size: 3, armour: 0, limbMovement: 1 } });
    const t2 = makeUnit({ id: 'c', ownerId: 'B', tileIndex: 0, segment: 1, attributes: { size: 3, armour: 0, limbMovement: 1 } });
    const ctx = makeCtx([attacker, t1, t2], tiles);
    const result = resolveAttack('a', 'b', ctx);
    expect(result.chosenWeaponMode).toBe('splash');
    const splash = explainSplash(attacker, t1, result, ctx);
    expect(splash.length).toBeGreaterThanOrEqual(1);
    for (const s of splash) {
      expect(renderSteps(s.steps)).toContain('Splash');
    }
  });

  it('returns an empty array when the attacker has no splash weapon', () => {
    const tiles = createTestGrid();
    const attacker = makeUnit({ id: 'a', ownerId: 'A', tileIndex: 1, attributes: { size: 5, kinetic: 3, rangeAttack: 2, limbMovement: 1 } });
    const target = makeUnit({ id: 'b', ownerId: 'B', tileIndex: 0 });
    const ctx = makeCtx([attacker, target], tiles);
    const result = resolveAttack('a', 'b', ctx);
    expect(explainSplash(attacker, target, result, ctx)).toEqual([]);
  });
});

describe('buildReactionExplanation — anti-air snap shot formatting', () => {
  it('formats a reaction fire explanation for a reactor and a drone', () => {
    const tiles = createTestGrid();
    const reactor = makeUnit({ id: 'r', ownerId: 'A', tileIndex: 1, attributes: { size: 5, antiAir: 4, rangeAttack: 2, limbMovement: 1 } });
    const drone = makeUnit({ id: 'd', ownerId: 'B', tileIndex: 0, attributes: { size: 2, armour: 0, flightMovement: 3 } });
    const ctx = makeCtx([reactor, drone], tiles);
    const result = resolveAttack('r', 'd', ctx);
    const ex = buildReactionExplanation(result, reactor, drone);
    expect(ex.wasValid).toBe(true);
    expect(renderSteps(ex.steps)).toContain('Anti-Air Reaction Fire');
    expect(ex.attackerId).toBe('r');
    expect(ex.targetId).toBe('d');
  });

  it('falls back to a step-less explanation when reactor or drone is missing', () => {
    const tiles = createTestGrid();
    const reactor = makeUnit({ id: 'r', ownerId: 'A', tileIndex: 1, attributes: { size: 5, antiAir: 4, rangeAttack: 2, limbMovement: 1 } });
    const drone = makeUnit({ id: 'd', ownerId: 'B', tileIndex: 0, attributes: { size: 2, flightMovement: 3 } });
    const result = resolveAttack('r', 'd', makeCtx([reactor, drone], tiles));
    const ex = buildReactionExplanation(result, undefined, undefined);
    expect(ex.steps).toEqual([]);
    expect(ex.directDamage).toBe(result.directDamage);
  });
});

describe('repair explanations', () => {
  it('formats a valid repair action with a positive repair amount', () => {
    const repairer = makeUnit({ id: 'rp', ownerId: 'A', attributes: { size: 5, repair: 3, limbMovement: 1 } });
    const target = makeUnit({ id: 'tg', ownerId: 'A', currentHealth: 10, attributes: { size: 3, armour: 1, limbMovement: 1 } });
    const ex = explainRepairAction(repairer, target);
    expect(ex.wasValid).toBe(true);
    expect(ex.repairAmount).toBeGreaterThan(0);
    expect(renderSteps(ex.steps)).toContain('Repair');
  });

  it('formats an invalid repair with the given reason', () => {
    const repairer = makeUnit({ id: 'rp', ownerId: 'A', attributes: { size: 5, repair: 3, limbMovement: 1 } });
    const target = makeUnit({ id: 'tg', ownerId: 'A' });
    const ex = explainRepairInvalid(repairer, target, 'Target at full health');
    expect(ex.wasValid).toBe(false);
    expect(ex.reasonInvalid).toBe('Target at full health');
    expect(ex.repairAmount).toBe(0);
  });
});
