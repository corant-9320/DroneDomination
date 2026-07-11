import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  tickTask,
  isTaskComplete,
  completeTask,
} from '../logistics.js';
import type { EngineerTask } from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Generators — arbitrary EngineerTasks spanning and exceeding turnsRemaining
// bounds (0, small, and large values) so the clamp edge is exercised.
// ---------------------------------------------------------------------------

const arbKind = fc.constantFrom<EngineerTask['kind']>('well', 'clearForest', 'bridge');

// turnsRemaining covers 0, typical durations, and large values.
const arbTurnsRemaining = fc.integer({ min: 0, max: 1_000_000 });

const arbTask: fc.Arbitrary<EngineerTask> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  kind: arbKind,
  unitId: fc.string({ minLength: 1, maxLength: 8 }),
  tileIndex: fc.integer({ min: 0, max: 5000 }),
  segment: fc.integer({ min: 0, max: 5 }),
  turnsRemaining: arbTurnsRemaining,
  ownerId: fc.string({ minLength: 1, maxLength: 6 }),
});

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Feature: oil-logistics-system, Property 5: Task countdown never goes negative
// Validates: Requirements 2.7, 2.8, 9.4, 10.2, 10.3
// ---------------------------------------------------------------------------

describe('logistics engineer task countdown (Property 5)', () => {
  it('tickTask decrements by exactly 1 but never below 0', () => {
    fc.assert(
      fc.property(arbTask, (task) => {
        const ticked = tickTask(task);
        const expected = Math.max(0, task.turnsRemaining - 1);
        expect(ticked.turnsRemaining).toBe(expected);
        expect(ticked.turnsRemaining).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate the input task', () => {
    fc.assert(
      fc.property(arbTask, (task) => {
        const before = task.turnsRemaining;
        const snapshot = { ...task };
        tickTask(task);
        // Input's turnsRemaining is unchanged.
        expect(task.turnsRemaining).toBe(before);
        // Every field of the input is untouched.
        expect(task).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves every field other than turnsRemaining', () => {
    fc.assert(
      fc.property(arbTask, (task) => {
        const ticked = tickTask(task);
        expect(ticked.id).toBe(task.id);
        expect(ticked.kind).toBe(task.kind);
        expect(ticked.unitId).toBe(task.unitId);
        expect(ticked.tileIndex).toBe(task.tileIndex);
        expect(ticked.segment).toBe(task.segment);
        expect(ticked.ownerId).toBe(task.ownerId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('repeated application never yields a negative value and stabilizes at 0', () => {
    fc.assert(
      // Bound the starting value so we can tick past it deterministically.
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 8 }),
          kind: arbKind,
          unitId: fc.string({ minLength: 1, maxLength: 8 }),
          tileIndex: fc.integer({ min: 0, max: 5000 }),
          segment: fc.integer({ min: 0, max: 5 }),
          turnsRemaining: fc.integer({ min: 0, max: 30 }),
          ownerId: fc.string({ minLength: 1, maxLength: 6 }),
        }),
        (task) => {
          let current: EngineerTask = task;
          const start = task.turnsRemaining;
          // Tick more times than the starting countdown to reach and hold 0.
          for (let i = 0; i < start + 5; i++) {
            current = tickTask(current);
            expect(current.turnsRemaining).toBeGreaterThanOrEqual(0);
          }
          // Once fully ticked down, it stabilizes at exactly 0.
          expect(current.turnsRemaining).toBe(0);
          // Ticking a stabilized task keeps it at 0 (idempotent at the floor).
          expect(tickTask(current).turnsRemaining).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('isTaskComplete is true exactly when the countdown has reached 0', () => {
    fc.assert(
      fc.property(arbTask, (task) => {
        expect(isTaskComplete(task)).toBe(task.turnsRemaining <= 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('completeTask produces the correct transition for a finished task', () => {
    const wellInit = { id: 'well-1', maxHitPoints: 100 };
    fc.assert(
      fc.property(arbTask, (task) => {
        // A finished task is one whose countdown has reached 0 (reached via
        // repeated tickTask; see the stabilization property). tickTask on a
        // 0-countdown task is the fixed point, so complete from there.
        const current = tickTask({ ...task, turnsRemaining: 0 });
        expect(current.turnsRemaining).toBe(0);
        expect(isTaskComplete(current)).toBe(true);

        const completion = completeTask(current, wellInit);
        expect(completion.kind).toBe(current.kind);

        if (completion.kind === 'well') {
          // An operational well occupies exactly the task's segment, starts empty
          // and full-health, and belongs to the task owner (Req 2.8).
          expect(completion.well.ownerId).toBe(current.ownerId);
          expect(completion.well.tileIndex).toBe(current.tileIndex);
          expect(completion.well.segment).toBe(current.segment ?? 0);
          expect(completion.well.storedOil).toBe(0);
          expect(completion.well.hitPoints).toBe(wellInit.maxHitPoints);
          expect(completion.well.maxHitPoints).toBe(wellInit.maxHitPoints);
        } else {
          // clearForest / bridge transitions carry the affected tile (Req 9.4, 10.3).
          expect(completion.tileIndex).toBe(current.tileIndex);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
