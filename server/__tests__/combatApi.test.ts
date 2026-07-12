import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  handleCombat,
  rebuildTiles,
  rebuildUnits,
  type CombatRequest,
  type WireUnit,
  type WireTile,
} from '../combatApi.js';
import {
  resolveAttack,
  evaluateWeaponOptions,
  calculateOrientationArmourPenalty,
  isDrone,
  type CombatContext,
} from '../../src/world/combat.js';
import { effectiveCombatDistance } from '../../src/world/segmentGeometry.js';
import { mulberry32 } from '../../src/world/rng.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

/**
 * Feature: unit-test-coverage — behavioural coverage for server/combatApi.ts.
 *
 * Exercises the REAL combat orchestration against constructed worlds: real
 * Tile/Unit objects (via combatApi's own rebuildTiles/rebuildUnits wire
 * helpers) and the real resolveAttack selection logic — no code-under-test
 * mocks. Randomness is controlled exclusively through src/world/rng.ts
 * (mulberry32), the only seam combat resolution exposes.
 *
 * Weapon-mode scoring/selection constants are derived from COMBAT_RULES.md:
 *   §7  drone incoming multipliers (Direct 0.33 ≤ Splash 0.50 ≤ Anti-Air 1.00)
 *   §10 "the highest-scoring mode is chosen", tie-break #1 "Anti-Air preferred
 *        if target is a drone".
 *
 * Geometry note: tiles are built with EMPTY boundary data, so segmentDistance
 * falls back to integer graph distance (segment_geometry.ts fallback contract).
 * Two adjacent tiles therefore sit at distance 1.0 — always in range, with
 * range efficiency 1.0 — keeping weapon scores deterministic.
 */

// --- Fixtures ---------------------------------------------------------------

function baseAttrs(p: Partial<UnitAttributes> = {}): UnitAttributes {
  return {
    size: 5,
    kinetic: 0,
    armour: 0,
    defence: 0,
    splashAttack: 0,
    rangeAttack: 0,
    wheeledMovement: 0,
    limbMovement: 0,
    flightMovement: 0,
    repair: 0,
    antiAir: 0,
    ...p,
  };
}

/** Two adjacent hexes; empty boundary → graph-distance fallback (segDist = 1). */
function adjacentTiles(elev0 = 'lowlands', elev1 = 'lowlands'): WireTile[] {
  return [
    { idx: 0, s: 6, n: [1, 0, 0, 0, 0, 0], t: 'plains', elev: elev0, pos: [0, 0, 1], b: [] },
    {
      idx: 1,
      s: 6,
      n: [0, 1, 1, 1, 1, 1],
      t: 'plains',
      elev: elev1,
      pos: [Math.sin(0.15), 0, Math.cos(0.15)],
      b: [],
    },
  ];
}

function wu(id: string, ownerId: string, tileIndex: number, attributes: UnitAttributes, hp: number, segment = 0): WireUnit {
  return { id, label: id.toUpperCase(), ownerId, tileIndex, segment, facing: 0, attributes, currentHealth: hp };
}

function buildCtx(attackerAttrs: UnitAttributes, targetAttrs: UnitAttributes): CombatContext {
  const tiles = rebuildTiles(adjacentTiles());
  const units = rebuildUnits([
    wu('atk', 'p1', 0, attackerAttrs, attackerAttrs.size * 10),
    wu('def', 'p2', 1, targetAttrs, targetAttrs.size * 10),
  ]);
  return { units, tiles, buildings: [] };
}

// --- Property 18 ------------------------------------------------------------

describe('Feature: unit-test-coverage, Property 18: weapon-mode selection chooses the highest-scoring mode, preferring Anti-Air against drones (COMBAT_RULES §10)', () => {
  const arbWeapon = fc.integer({ min: 0, max: 5 });
  const arbSize = fc.integer({ min: 1, max: 5 });
  const arbSeed = fc.integer({ min: 1, max: 2 ** 31 - 1 });

  it('resolves with the maximum-scoring weapon mode, and Anti-Air whenever it ties the max against a drone', () => {
    fc.assert(
      fc.property(
        arbSize,
        arbSize,
        arbWeapon, // kinetic (forced ≥1 so a Direct option always exists)
        arbWeapon, // splash
        arbWeapon, // antiAir
        arbWeapon, // target armour
        arbWeapon, // target defence (EW)
        fc.boolean(), // target is a drone?
        arbSeed,
        (atkSize, defSize, kinetic, splash, antiAir, armour, defence, targetDrone, seed) => {
          const attackerAttrs = baseAttrs({
            size: atkSize,
            kinetic: Math.max(1, kinetic),
            splashAttack: splash,
            antiAir,
            wheeledMovement: 1,
            rangeAttack: 2,
          });
          const targetAttrs = baseAttrs({
            size: defSize,
            armour,
            defence,
            wheeledMovement: targetDrone ? 0 : 1,
            flightMovement: targetDrone ? 1 : 0,
          });

          const ctx = buildCtx(attackerAttrs, targetAttrs);
          const atk = ctx.units[0];
          const def = ctx.units[1];

          // Re-derive the option scores exactly as resolveAttack does internally
          // (read-only — captured BEFORE resolveAttack mutates health).
          const dist = effectiveCombatDistance(ctx.tiles, atk, def);
          const oap = calculateOrientationArmourPenalty(ctx.tiles, atk.tileIndex, def.tileIndex, def.facing, atk.segment, def.segment);
          const options = evaluateWeaponOptions(atk, def, ctx, dist, oap);
          expect(options.length).toBeGreaterThan(0);
          const maxScore = Math.max(...options.map((o) => o.score));

          const result = resolveAttack('atk', 'def', ctx, mulberry32(seed));
          expect(result.wasValid).toBe(true);
          expect(result.chosenWeaponMode).toBeDefined();

          // §10: the highest-scoring mode is chosen.
          const chosen = options.find((o) => o.mode === result.chosenWeaponMode);
          expect(chosen).toBeDefined();
          expect(chosen!.score).toBe(maxScore);

          // §10 tie-break #1: Anti-Air preferred when the target is a drone.
          if (isDrone(def)) {
            const aa = options.find((o) => o.mode === 'antiAir');
            if (aa && aa.score === maxScore) {
              expect(result.chosenWeaponMode).toBe('antiAir');
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

// --- Post-attack health invariants ------------------------------------------

describe('combatApi — post-attack health invariants', () => {
  function attackReq(targetHp: number, kinetic = 4): CombatRequest {
    return {
      action: 'attack',
      attackerId: 'atk',
      targetId: 'def',
      activeFaction: 'p1',
      units: [
        wu('atk', 'p1', 0, baseAttrs({ kinetic, wheeledMovement: 1, rangeAttack: 2 }), 50),
        wu('def', 'p2', 1, baseAttrs({ armour: 1, wheeledMovement: 1 }), targetHp),
      ],
      tiles: adjacentTiles(),
    };
  }

  it('decrements target health by exactly the dealt damage and never below zero', () => {
    const res = handleCombat(attackReq(50));
    expect(res.success).toBe(true);
    const c = res.combats[0];
    expect(c.directDamage).toBeGreaterThanOrEqual(1); // MIN_DAMAGE (§6/§10)
    expect(c.targetHealthAfter).toBe(c.targetHealthBefore - c.directDamage);
    expect(c.targetHealthAfter).toBeGreaterThanOrEqual(0);
    expect(c.targetHealthAfter).toBeLessThanOrEqual(50);
  });

  it('removes a destroyed target from updatedUnits and reports it destroyed', () => {
    const res = handleCombat(attackReq(1, 5));
    expect(res.success).toBe(true);
    expect(res.combats[0].targetDestroyed).toBe(true);
    expect(res.combats[0].destroyedUnitIds).toContain('def');
    expect(res.updatedUnits.find((u) => u.id === 'def')).toBeUndefined();
    expect(res.updatedUnits.find((u) => u.id === 'atk')).toBeDefined();
  });
});

// --- End-to-end wiring ------------------------------------------------------

describe('combatApi — end-to-end wiring', () => {
  it('preview returns a breakdown without mutating any unit', () => {
    const req: CombatRequest = {
      action: 'preview',
      attackerId: 'atk',
      targetId: 'def',
      activeFaction: 'p1',
      units: [
        wu('atk', 'p1', 0, baseAttrs({ kinetic: 3, wheeledMovement: 1, rangeAttack: 2 }), 50),
        wu('def', 'p2', 1, baseAttrs({ armour: 1, wheeledMovement: 1 }), 50),
      ],
      tiles: adjacentTiles(),
    };
    const res = handleCombat(req);
    expect(res.success).toBe(true);
    expect(res.updatedUnits).toEqual([]); // preview never mutates
    expect(res.combats[0].breakdown).toBeDefined();
  });

  it('walks a ground unit along its path and updates facing', () => {
    const res = handleCombat({
      action: 'move',
      unitId: 'mover',
      activeFaction: 'p1',
      path: [0, 1],
      units: [wu('mover', 'p1', 0, baseAttrs({ wheeledMovement: 5 }), 50)],
      tiles: adjacentTiles(),
    });
    expect(res.success).toBe(true);
    const moved = res.updatedUnits.find((u) => u.id === 'mover')!;
    expect(moved.tileIndex).toBe(1);
    expect(moved.facing).toBe(0); // tiles[0].neighbours.indexOf(1) === 0
  });

  it('triggers Anti-Air reaction fire when a drone overflies an enemy AA unit (§16)', () => {
    const res = handleCombat({
      action: 'move',
      unitId: 'drone',
      activeFaction: 'p1',
      path: [0, 1],
      units: [
        wu('drone', 'p1', 0, baseAttrs({ flightMovement: 5 }), 50),
        // Segment 1 (not 0): tile1's only cross-hex entry from tile0 is segment
        // 0 (adjacentTiles' fixture pads unused neighbour slots as self-loops),
        // so occupying segment 0 would seal tile1 off entirely under B2-B4
        // occupancy gating. Reaction fire is tile-based (not segment-based),
        // so the AA unit still reacts once the drone lands anywhere on tile1.
        wu('aa', 'p2', 1, baseAttrs({ antiAir: 5, wheeledMovement: 1 }), 50, 1),
      ],
      tiles: adjacentTiles(),
    });
    expect(res.success).toBe(true);
    expect(res.reactions.length).toBeGreaterThanOrEqual(1);
  });

  it('triggers Anti-Air reaction fire from an enemy building with antiAir when a drone overflies (§16)', () => {
    const res = handleCombat({
      action: 'move',
      unitId: 'drone',
      activeFaction: 'p1',
      path: [0, 1],
      units: [
        wu('drone', 'p1', 0, baseAttrs({ flightMovement: 5, size: 3 }), 30),
      ],
      tiles: adjacentTiles(),
      buildings: [
        { id: 'tower', ownerId: 'p2', tileIndex: 1, segment: 0, attributes: { size: 3, antiAir: 4, kinetic: 0, splashAttack: 0, rangeAttack: 0, armour: 0, defence: 0, wheeledMovement: 0, limbMovement: 0, flightMovement: 0, repair: 0 } },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.reactions.length).toBeGreaterThanOrEqual(1);
    expect(res.reactions[0].attackerId).toBe('tower');
    expect(res.reactions[0].directDamage).toBeGreaterThan(0);
  });

  it('building AA reaction fire does not trigger for a friendly drone', () => {
    const res = handleCombat({
      action: 'move',
      unitId: 'drone',
      activeFaction: 'p1',
      path: [0, 1],
      units: [
        wu('drone', 'p1', 0, baseAttrs({ flightMovement: 5, size: 3 }), 30),
      ],
      tiles: adjacentTiles(),
      buildings: [
        { id: 'tower', ownerId: 'p1', tileIndex: 1, segment: 0, attributes: { size: 3, antiAir: 4, kinetic: 0, splashAttack: 0, rangeAttack: 0, armour: 0, defence: 0, wheeledMovement: 0, limbMovement: 0, flightMovement: 0, repair: 0 } },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.reactions.length).toBe(0);
  });

  it('heals a damaged friendly unit, capped at max health', () => {
    const res = handleCombat({
      action: 'repair',
      repairerId: 'medic',
      repairTargetId: 'hurt',
      activeFaction: 'p1',
      units: [
        wu('medic', 'p1', 0, baseAttrs({ repair: 5, wheeledMovement: 1 }), 50),
        wu('hurt', 'p1', 1, baseAttrs({ wheeledMovement: 1 }), 10),
      ],
      tiles: adjacentTiles(),
    });
    expect(res.success).toBe(true);
    expect(res.repair).toBeDefined();
    const healed = res.updatedUnits.find((u) => u.id === 'hurt')!;
    expect(healed.currentHealth).toBeGreaterThanOrEqual(10);
    expect(healed.currentHealth).toBeLessThanOrEqual(50);
  });

  it('rejects an unknown action', () => {
    const res = handleCombat({ action: 'bogus' as unknown as CombatRequest['action'], activeFaction: 'p1', units: [], tiles: [] });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Unknown action');
  });

  it('rejects an attack declared by the inactive faction', () => {
    const res = handleCombat({
      action: 'attack',
      attackerId: 'atk',
      targetId: 'def',
      activeFaction: 'p2', // p1 owns the attacker — not their turn
      units: [
        wu('atk', 'p1', 0, baseAttrs({ kinetic: 3, wheeledMovement: 1, rangeAttack: 2 }), 50),
        wu('def', 'p2', 1, baseAttrs({ wheeledMovement: 1 }), 50),
      ],
      tiles: adjacentTiles(),
    });
    expect(res.success).toBe(false);
  });
});
