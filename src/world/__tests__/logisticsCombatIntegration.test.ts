/**
 * Feature: oil-logistics-system, Task 8.3 — integration test for combat through
 * the REAL CombatContext / computeDamage pipeline.
 *
 * Validates: Requirements 8.5 (transports resolve via the existing unit combat
 * model) and 12.5 (structures take damage via the same computeDamage/applyDamage
 * pipeline used for units).
 *
 * Per the design (§4): logistics structures gain an HP pool and are attacked by
 * running the real `computeDamage(...)` with the structure's attributes + tile to
 * produce a damage number, which `attackStructure(struct, damage)` then applies
 * via the combat model's own `applyDamage`. Transports are modelled as ordinary
 * `Unit`s injected into `CombatContext.units`, so they resolve through the real
 * `resolveAttack` path with no new code.
 *
 * NO pinned damage magnitudes are asserted — only HP monotonicity, the [0, cap]
 * bounds, and the destruction threshold (HP reaches 0 ⇒ destroyed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computeDamage, resolveAttack, type CombatContext } from '../combat.js';
import { attackStructure, type HpStructure } from '../logistics.js';
import { Tile } from '../types.js';
import { createTestGrid, makeUnit, makeCtx } from './combat.fixtures.js';

describe('logistics combat integration (real CombatContext pipeline)', () => {
  let tiles: Tile[];
  beforeEach(() => {
    tiles = createTestGrid();
  });

  // =========================================================================
  // Scenario 1 — Structure attacked via computeDamage + attackStructure
  // =========================================================================
  describe('structure damage via the real computeDamage pipeline (Req 12.5)', () => {
    /**
     * Run the real damage formula against the structure's attributes+tile, then
     * apply the resulting number through attackStructure (which uses the combat
     * model's applyDamage). Returns the damage the pipeline produced.
     */
    const computeStructureDamage = (struct: HpStructure): number => {
      const { finalDamage } = computeDamage({
        mode: 'direct',
        attackerChassis: 'tank',
        baseWeaponValue: 4, // a real attacker weapon value (1–5); not a pinned result
        orientationArmourPenalty: 0,
        distance: 1,
        armour: struct.attributes?.armour ?? 0,
        defenceOther: 0,
        targetIsDrone: false,
      });
      return finalDamage;
    };

    const makeStructure = (): HpStructure => ({
      id: 'well-1',
      kind: 'well',
      ownerId: 'p2',
      tileIndex: 0,
      segment: 0,
      hitPoints: 40,
      maxHitPoints: 40,
      attributes: { size: 5, armour: 1 },
    });

    it('applying computed damage monotonically reduces HP and never goes below 0', () => {
      let struct = makeStructure();
      let prevHp = struct.hitPoints;

      for (let i = 0; i < 5 && struct.hitPoints > 0; i++) {
        const damage = computeStructureDamage(struct);
        const result = attackStructure(struct, damage);
        struct = result.struct;

        // Monotonic: HP never increases.
        expect(struct.hitPoints).toBeLessThanOrEqual(prevHp);
        // While alive, a real hit (damage ≥ 1) strictly reduces HP.
        expect(struct.hitPoints).toBeLessThan(prevHp);
        // Never below zero.
        expect(struct.hitPoints).toBeGreaterThanOrEqual(0);
        prevHp = struct.hitPoints;
      }
    });

    it('repeated attacks eventually drive HP to 0 and report destroyed', () => {
      let struct = makeStructure();
      let destroyed = false;

      // Guard the loop generously; termination is guaranteed since applyDamage
      // enforces a minimum of 1 damage per hit.
      for (let i = 0; i < 100 && !destroyed; i++) {
        const damage = computeStructureDamage(struct);
        const result = attackStructure(struct, damage);
        struct = result.struct;
        destroyed = result.destroyed;
      }

      expect(struct.hitPoints).toBe(0);
      expect(destroyed).toBe(true);
    });

    it('destruction threshold: destroyed is true exactly when HP reaches 0', () => {
      // One-hit-kill setup: a structure with a single hit point.
      const struct: HpStructure = { ...makeStructure(), hitPoints: 1, maxHitPoints: 1 };
      const damage = computeStructureDamage(struct);
      const result = attackStructure(struct, damage);

      expect(result.struct.hitPoints).toBe(0);
      expect(result.destroyed).toBe(true);
    });
  });

  // =========================================================================
  // Scenario 2 — Transport-as-Unit attacked via the real resolveAttack path
  // =========================================================================
  describe('transport modelled as a Unit in CombatContext.units (Req 8.5)', () => {
    /**
     * A Transportation_Unit is just an ordinary Unit (it has size/armour/defence
     * and movement) that also carries cargo + a route assignment. Here we inject
     * the transport-backing unit into CombatContext.units and attack it with the
     * REAL resolveAttack, which mutates the unit's currentHealth in place.
     */
    const makeAttacker = () => {
      const attacker = makeUnit({ id: 'atk', ownerId: 'p1', tileIndex: 1, facing: 0 });
      attacker.attributes.kinetic = 4; // real weapon; magnitude not asserted
      return attacker;
    };

    const makeTransportUnit = () => {
      // Transport-backing unit: wheeled chassis, some armour, full health.
      const transport = makeUnit({ id: 'transport-backing', ownerId: 'p2', tileIndex: 0, facing: 0 });
      transport.attributes = { size: 4, armour: 1, wheeledMovement: 2 };
      transport.currentHealth = 40;
      return transport;
    };

    it('attacking the transport unit monotonically reduces its health, never below 0', () => {
      const attacker = makeAttacker();
      const transport = makeTransportUnit();
      const ctx: CombatContext = makeCtx([attacker, transport], tiles);

      let prevHealth = transport.currentHealth;
      for (let i = 0; i < 5 && transport.currentHealth > 0; i++) {
        const result = resolveAttack('atk', 'transport-backing', ctx);
        expect(result.wasValid).toBe(true);

        // Monotonic decrease while alive; clamped at 0.
        expect(transport.currentHealth).toBeLessThan(prevHealth);
        expect(transport.currentHealth).toBeGreaterThanOrEqual(0);
        prevHealth = transport.currentHealth;
      }
    });

    it('repeated attacks destroy the transport (health hits 0 → destruction threshold)', () => {
      const attacker = makeAttacker();
      const transport = makeTransportUnit();
      const ctx: CombatContext = makeCtx([attacker, transport], tiles);

      let destroyed = false;
      for (let i = 0; i < 100 && transport.currentHealth > 0; i++) {
        const result = resolveAttack('atk', 'transport-backing', ctx);
        if (result.destroyedUnitIds.includes('transport-backing')) destroyed = true;
      }

      expect(transport.currentHealth).toBe(0);
      expect(destroyed).toBe(true);
    });
  });
});
