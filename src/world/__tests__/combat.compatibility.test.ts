import { describe, expect, it, vi } from 'vitest';
import {
  previewAttack,
  resolveAttack,
  resolveReactionFire,
  resolveSimultaneousAttacks,
} from '../combat.js';
import { createTestGrid, makeBuilding, makeCtx, makeUnit } from './combat.fixtures.js';

describe('combat compatibility seams', () => {
  it('preview is read-only and consumes no randomness through the public facade', () => {
    const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1 });
    const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0 });
    attacker.attributes.splashAttack = 3;
    const ctx = makeCtx([attacker, target], createTestGrid());
    const before = structuredClone(ctx);
    const random = vi.spyOn(Math, 'random');

    previewAttack(attacker, target, ctx);

    expect(ctx).toEqual(before);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('consumes one RNG value per eligible enemy building in array order', () => {
    const attacker = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1 });
    attacker.attributes.kinetic = 0;
    attacker.attributes.splashAttack = 5;
    const target = makeUnit({ id: 't', ownerId: 'p2', tileIndex: 0 });
    const first = makeBuilding({
      id: 'first', ownerId: 'p2', tileIndex: 0,
      attributes: { kinetic: 1, rangeAttack: 1 },
    });
    const second = makeBuilding({
      id: 'second', ownerId: 'p2', tileIndex: 0,
      attributes: { defence: 1, repair: 1 },
    });
    const values = [0.9, 0.1];
    const rng = vi.fn(() => values.shift() ?? 0);

    const result = resolveAttack(
      'a', 't', makeCtx([attacker, target], createTestGrid(), [first, second]), rng,
    );

    expect(rng).toHaveBeenCalledTimes(2);
    expect(result.buildingDamage.map((event) => [event.buildingId, event.component])).toEqual([
      ['first', 'rangeAttack'],
      ['second', 'defence'],
    ]);
  });

  it('orders multiple reactors as units first, then buildings, preserving array order', () => {
    const firstUnit = makeUnit({ id: 'unit-1', ownerId: 'p2', tileIndex: 1 });
    const secondUnit = makeUnit({ id: 'unit-2', ownerId: 'p2', tileIndex: 1 });
    firstUnit.attributes.antiAir = 1;
    secondUnit.attributes.antiAir = 1;
    const tower = makeBuilding({
      id: 'tower', ownerId: 'p2', tileIndex: 1,
      attributes: { antiAir: 1 },
    });
    const drone = makeUnit({ id: 'drone', ownerId: 'p1', tileIndex: 3 });
    drone.attributes.flightMovement = 3;
    drone.currentHealth = 50;

    const results = resolveReactionFire(
      'drone', [3, 1],
      makeCtx([firstUnit, secondUnit, drone], createTestGrid(), [tower]),
    );

    expect(results.map((result) => result.attackerId)).toEqual(['unit-1', 'unit-2', 'tower']);
  });

  it('stops later reactions as soon as the moving drone is destroyed', () => {
    const lethal = makeUnit({ id: 'lethal', ownerId: 'p2', tileIndex: 1 });
    const later = makeUnit({ id: 'later', ownerId: 'p2', tileIndex: 1 });
    lethal.attributes.antiAir = 5;
    later.attributes.antiAir = 5;
    const drone = makeUnit({ id: 'drone', ownerId: 'p1', tileIndex: 3 });
    drone.attributes.flightMovement = 3;
    drone.currentHealth = 1;

    const results = resolveReactionFire(
      'drone', [3, 1], makeCtx([lethal, later, drone], createTestGrid()),
    );

    expect(results.map((result) => result.attackerId)).toEqual(['lethal']);
    expect(results[0].destroyedUnitIds).toEqual(['drone']);
  });

  it('returns simultaneous results in declaration order even when both attacks are lethal', () => {
    const a = makeUnit({ id: 'a', ownerId: 'p1', tileIndex: 1 });
    const b = makeUnit({ id: 'b', ownerId: 'p2', tileIndex: 0 });
    a.attributes.kinetic = 5;
    b.attributes.kinetic = 5;
    a.currentHealth = 1;
    b.currentHealth = 1;

    const results = resolveSimultaneousAttacks('a', 'b', makeCtx([a, b], createTestGrid()));

    expect(results.map((result) => [result.attackerId, result.targetId])).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect([a.currentHealth, b.currentHealth]).toEqual([0, 0]);
  });
});