import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildUnitNameParts,
  SPEED_NAMES,
  TYPE_NAMES,
  ATTRIBUTE_NAMES,
} from '../unitNaming.js';
import type { UnitAttributes } from '../unitTypes.js';

// ---------------------------------------------------------------------------
// Helpers / generators
//
// buildUnitNameParts is a pure table-driven naming function. The properties
// below assert it is deterministic and collision-free, and they intentionally
// generate no-movement and out-of-range attribute profiles to exercise the
// fallback branches (movement `?? 'wheeledMovement'`, speed `?? 1`, descriptor
// `if (word)` guard).
// ---------------------------------------------------------------------------

const SPEED_WORDS = new Set(Object.values(SPEED_NAMES));
const TYPE_WORDS = new Set(Object.values(TYPE_NAMES));
const ALL_ATTRIBUTE_WORDS = new Set(
  Object.values(ATTRIBUTE_NAMES).flatMap((col) => Object.values(col)),
);
const MOVEMENT_KEYS = ['flightMovement', 'limbMovement', 'wheeledMovement'] as const;

// Levels span out-of-range values (incl. negatives and >5) to exercise clamps.
const arbLevel = fc.integer({ min: -2, max: 8 });
const optLevel = fc.option(arbLevel, { nil: undefined });

// An attribute profile where every field is optional — so some draws have no
// movement attribute at all, hitting the fallback paths.
const arbAttrs: fc.Arbitrary<UnitAttributes> = fc.record(
  {
    size: optLevel,
    kinetic: optLevel,
    armour: optLevel,
    defence: optLevel,
    splashAttack: optLevel,
    rangeAttack: optLevel,
    wheeledMovement: optLevel,
    limbMovement: optLevel,
    flightMovement: optLevel,
    repair: optLevel,
    antiAir: optLevel,
  },
  { requiredKeys: [] },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unitNaming.buildUnitNameParts', () => {
  it('Feature: unit-test-coverage, unitNaming: naming is deterministic (equal attrs -> equal parts)', () => {
    fc.assert(
      fc.property(arbAttrs, (attrs) => {
        const a = buildUnitNameParts(attrs);
        const b = buildUnitNameParts({ ...attrs });
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });

  it('Feature: unit-test-coverage, unitNaming: parts are always well-formed and collision-free', () => {
    fc.assert(
      fc.property(arbAttrs, (attrs) => {
        const parts = buildUnitNameParts(attrs);

        // Movement key is always one of the three known categories (fallback
        // to wheeled when no movement attribute is present).
        expect(MOVEMENT_KEYS).toContain(parts.movementKey as (typeof MOVEMENT_KEYS)[number]);

        // Speed and type words are always valid, non-empty table entries.
        expect(SPEED_WORDS.has(parts.speedWord)).toBe(true);
        expect(TYPE_WORDS.has(parts.typeWord)).toBe(true);

        // Descriptors: at most two, all valid words, and collision-free
        // (no duplicate descriptor word).
        expect(parts.descriptors.length).toBeLessThanOrEqual(2);
        for (const word of parts.descriptors) {
          expect(ALL_ATTRIBUTE_WORDS.has(word)).toBe(true);
        }
        const unique = new Set(parts.descriptors);
        expect(unique.size).toBe(parts.descriptors.length);
      }),
      { numRuns: 300 },
    );
  });

  it('Feature: unit-test-coverage, unitNaming: descriptor count matches positive non-movement attributes (capped at 2)', () => {
    const NAMING_KEYS: (keyof UnitAttributes)[] = [
      'kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair', 'antiAir',
    ];
    fc.assert(
      fc.property(arbAttrs, (attrs) => {
        const positives = NAMING_KEYS.filter((k) => (attrs[k] ?? 0) > 0).length;
        const expected = Math.min(positives, 2);
        expect(buildUnitNameParts(attrs).descriptors.length).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  // --- Example tests (specific, readable expectations) ---

  it('falls back to wheeled/Loitering/Tank when no movement attribute is present', () => {
    const parts = buildUnitNameParts({ kinetic: 3 });
    expect(parts.movementKey).toBe('wheeledMovement');
    expect(parts.speedWord).toBe(SPEED_NAMES[1]); // 'Loitering'
    expect(parts.typeWord).toBe(TYPE_NAMES.wheeledMovement); // 'Tank'
  });

  it('prefers flight movement (Drone) over wheeled when both are present', () => {
    const parts = buildUnitNameParts({ flightMovement: 4, wheeledMovement: 2 });
    expect(parts.movementKey).toBe('flightMovement');
    expect(parts.typeWord).toBe('Drone');
    expect(parts.speedWord).toBe(SPEED_NAMES[4]); // 'Runner'
  });

  it('picks the top two non-movement attributes as descriptors, ranked descending', () => {
    const parts = buildUnitNameParts({
      wheeledMovement: 1,
      kinetic: 5,
      armour: 2,
      repair: 4,
    });
    // kinetic(5) then repair(4) outrank armour(2)
    expect(parts.descriptors).toEqual([
      ATTRIBUTE_NAMES.kinetic[5], // 'Executioner'
      ATTRIBUTE_NAMES.repair[4], // 'Restorer'
    ]);
  });

  it('clamps an out-of-range movement speed into the [1,5] word table', () => {
    const parts = buildUnitNameParts({ wheeledMovement: 8 });
    expect(parts.speedWord).toBe(SPEED_NAMES[5]); // clamped to 'Sprinter'
  });
});
