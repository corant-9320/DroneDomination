// Feature: oil-logistics-system, Property 24: Structures have positive HP; combat reduces HP and destroys at zero, dropping stored resources
/**
 * Property test for logistics structure combat and destruction consequences.
 *
 * Property 24: Structures have positive HP; combat reduces HP and destroys at zero,
 * dropping stored resources.
 * Validates: Requirements 12.4, 12.5, 12.6, 12.7, 12.8
 *
 * Covered:
 *   - a live structure has hitPoints > 0                                     (Req 12.4)
 *   - attackStructure reduces hitPoints (strictly, since applyDamage floors the
 *     applied damage at 1) and never drops below 0                           (Req 12.5)
 *   - destroyed === (resulting hitPoints <= 0); large damage (>= maxHitPoints)
 *     always destroys                                                        (Req 12.6)
 *   - dropWellResources / dropRefineryResources / dropHubResources zero the
 *     stored commodities and report the former amounts, conserving the total (Req 12.7)
 *   - markRoutesInoperable disables routes crossing a destroyed tile and returns
 *     their ids, leaving other routes operable                              (Req 12.8)
 *   - none of the above mutate their inputs.
 *
 * IMPORTANT (documented limitation): attackStructure delegates to the combat model's
 * applyDamage, which clamps HP into the [0, 50] domain, so live structures are
 * generated with maxHitPoints and hitPoints within [1, 50] to stay in-domain. No
 * pinned damage numbers are asserted — only monotonicity and the zero-HP threshold.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  attackStructure,
  dropWellResources,
  dropRefineryResources,
  dropHubResources,
  markRoutesInoperable,
} from '../logistics/combatIntegration.js';
import type { HpStructure } from '../logistics/combatIntegration.js';
import type {
  DistributionHub,
  LogisticsRoute,
  OilWell,
  Refinery,
} from '../../../shared/logisticsTypes.js';

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A live HpStructure kept inside the combat model's [1, 50] HP domain: a positive
// maxHitPoints in [1, 50] and current hitPoints in [1, maxHitPoints] (Req 12.4).
const arbLiveStructure: fc.Arbitrary<HpStructure> = fc
  .integer({ min: 1, max: 50 })
  .chain((maxHitPoints) =>
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      kind: fc.constantFrom('well', 'refinery', 'hub', 'road', 'bridge') as fc.Arbitrary<
        HpStructure['kind']
      >,
      ownerId: fc.string({ minLength: 1, maxLength: 6 }),
      tileIndex: fc.nat({ max: 500 }),
      hitPoints: fc.integer({ min: 1, max: maxHitPoints }),
      maxHitPoints: fc.constant(maxHitPoints),
    }),
  );

// Damage spanning the flat-to-lethal range: 0 (applyDamage floors it to 1) up to
// well beyond any structure's HP so the destruction threshold is exercised.
const arbDamage: fc.Arbitrary<number> = fc.integer({ min: 0, max: 100 });

const arbWell: fc.Arbitrary<OilWell> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  ownerId: fc.string({ minLength: 1, maxLength: 6 }),
  tileIndex: fc.nat({ max: 500 }),
  segment: fc.nat({ max: 5 }),
  storedOil: fc.nat({ max: 100 }),
  hitPoints: fc.integer({ min: 0, max: 50 }),
  maxHitPoints: fc.integer({ min: 1, max: 50 }),
});

const arbRefinery: fc.Arbitrary<Refinery> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  ownerId: fc.string({ minLength: 1, maxLength: 6 }),
  tileIndex: fc.nat({ max: 500 }),
  segments: fc.uniqueArray(fc.nat({ max: 5 }), { minLength: 1, maxLength: 6 }),
  heldOil: fc.nat({ max: 1000 }),
  refinedProductAvailable: fc.nat({ max: 1000 }),
  hitPoints: fc.integer({ min: 0, max: 50 }),
  maxHitPoints: fc.integer({ min: 1, max: 50 }),
});

const arbHub: fc.Arbitrary<DistributionHub> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  ownerId: fc.string({ minLength: 1, maxLength: 6 }),
  tileIndex: fc.nat({ max: 500 }),
  segment: fc.nat({ max: 5 }),
  buffer: fc.nat({ max: 500 }),
  routeIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }),
  hitPoints: fc.integer({ min: 0, max: 50 }),
  maxHitPoints: fc.integer({ min: 1, max: 50 }),
});

const arbRoute: fc.Arbitrary<LogisticsRoute> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  ownerId: fc.string({ minLength: 1, maxLength: 6 }),
  fromStructureId: fc.string({ minLength: 1, maxLength: 6 }),
  toStructureId: fc.string({ minLength: 1, maxLength: 6 }),
  segments: fc.array(fc.integer({ min: 0, max: 20 }), { maxLength: 8 }),
  capacity: fc.integer({ min: 100, max: 1000 }),
  tier: fc.constantFrom('road', 'highway') as fc.Arbitrary<LogisticsRoute['tier']>,
  travelTime: fc.integer({ min: 1, max: 10 }),
  operable: fc.boolean(),
});

// A distinct-id route array so `affectedRouteIds` membership checks are unambiguous.
const arbRoutes: fc.Arbitrary<LogisticsRoute[]> = fc
  .uniqueArray(arbRoute, { selector: (r) => r.id, maxLength: 8 })
  .map((rs) => rs);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------------------
// attackStructure — HP reduction, floor at 0, destruction threshold (Req 12.4–12.6)
// ---------------------------------------------------------------------------

describe('attackStructure (Property 24: reduces HP, destroys at zero)', () => {
  it('a live structure has positive hitPoints (Req 12.4)', () => {
    fc.assert(
      fc.property(arbLiveStructure, (struct) => {
        expect(struct.hitPoints).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('strictly reduces hitPoints and never below 0 (Req 12.5)', () => {
    fc.assert(
      fc.property(arbLiveStructure, arbDamage, (struct, damage) => {
        const { struct: next } = attackStructure(struct, damage);
        // applyDamage floors applied damage at 1, so a live structure always loses HP.
        expect(next.hitPoints).toBeLessThan(struct.hitPoints);
        expect(next.hitPoints).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('destroyed iff resulting hitPoints <= 0 (Req 12.6)', () => {
    fc.assert(
      fc.property(arbLiveStructure, arbDamage, (struct, damage) => {
        const { struct: next, destroyed } = attackStructure(struct, damage);
        expect(destroyed).toBe(next.hitPoints <= 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('large damage (>= maxHitPoints) always destroys (Req 12.6)', () => {
    fc.assert(
      fc.property(arbLiveStructure, fc.nat({ max: 50 }), (struct, extra) => {
        const damage = struct.maxHitPoints + extra; // >= maxHitPoints >= hitPoints
        const { struct: next, destroyed } = attackStructure(struct, damage);
        expect(next.hitPoints).toBe(0);
        expect(destroyed).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate its input structure', () => {
    fc.assert(
      fc.property(arbLiveStructure, arbDamage, (struct, damage) => {
        const before = clone(struct);
        attackStructure(struct, damage);
        expect(struct).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Destruction drops — zero stored commodities, report + conserve them (Req 12.7)
// ---------------------------------------------------------------------------

describe('destruction resource drops (Property 24: dropped === former stored)', () => {
  it('dropWellResources zeroes storedOil and reports it (Req 12.7)', () => {
    fc.assert(
      fc.property(arbWell, (well) => {
        const before = clone(well);
        const { well: next, dropped } = dropWellResources(well);
        expect(next.storedOil).toBe(0);
        expect(dropped.oil).toBe(before.storedOil);
        expect(dropped.combined).toBe(before.storedOil);
        expect(well).toEqual(before); // no mutation
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('dropRefineryResources zeroes both pools and conserves the total (Req 12.7)', () => {
    fc.assert(
      fc.property(arbRefinery, (refinery) => {
        const before = clone(refinery);
        const { refinery: next, dropped } = dropRefineryResources(refinery);
        expect(next.heldOil).toBe(0);
        expect(next.refinedProductAvailable).toBe(0);
        expect(dropped.oil).toBe(before.heldOil);
        expect(dropped.product).toBe(before.refinedProductAvailable);
        expect(dropped.combined).toBe(before.heldOil + before.refinedProductAvailable);
        expect(refinery).toEqual(before); // no mutation
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('dropHubResources zeroes the buffer and reports it as combined (Req 12.7)', () => {
    fc.assert(
      fc.property(arbHub, (hub) => {
        const before = clone(hub);
        const { hub: next, dropped } = dropHubResources(hub);
        expect(next.buffer).toBe(0);
        expect(dropped.combined).toBe(before.buffer);
        expect(hub).toEqual(before); // no mutation
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// markRoutesInoperable — disable routes crossing a destroyed tile (Req 12.8)
// ---------------------------------------------------------------------------

describe('markRoutesInoperable (Property 24: destroyed segment disables its routes)', () => {
  it('disables exactly the routes crossing the destroyed tile, leaving others operable (Req 12.8)', () => {
    fc.assert(
      fc.property(arbRoutes, fc.integer({ min: 0, max: 20 }), (routes, destroyedTileIndex) => {
        const before = clone(routes);
        const { routes: next, affectedRouteIds } = markRoutesInoperable(
          routes,
          destroyedTileIndex,
        );

        const affected = new Set(affectedRouteIds);
        for (let i = 0; i < before.length; i++) {
          const original = before[i];
          const updated = next.find((r) => r.id === original.id)!;
          const crosses = original.segments.some(
            (key) => Math.floor(key / 6) === destroyedTileIndex,
          );
          if (crosses) {
            // Every route using the destroyed segment is reported and left inoperable.
            expect(affected.has(original.id)).toBe(true);
            expect(updated.operable).toBe(false);
          } else {
            // Untouched routes keep their prior operability and are not reported.
            expect(affected.has(original.id)).toBe(false);
            expect(updated.operable).toBe(original.operable);
          }
        }

        // affectedRouteIds contains only ids of routes that actually cross the tile.
        for (const id of affectedRouteIds) {
          const src = before.find((r) => r.id === id)!;
          expect(src.segments.some(
            (key) => Math.floor(key / 6) === destroyedTileIndex,
          )).toBe(true);
        }

        expect(routes).toEqual(before); // no mutation of the input array/routes
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
