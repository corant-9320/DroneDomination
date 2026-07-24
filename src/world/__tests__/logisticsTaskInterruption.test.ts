// Feature: oil-logistics-system, Property 25: Engineer task interruption discards progress
/**
 * Property test for engineer task interruption (`interruptTask`).
 *
 * Property 25: Engineer task interruption discards progress.
 * Validates: Requirements 9.5, 10.7
 *
 * For any array of EngineerTasks and any taskId, `interruptTask(tasks, taskId)`:
 *   - returns a task array that no longer contains a task with that id,
 *   - preserves every other task unchanged (same reference, same fields),
 *   - applies NO partial effect — it only removes the task (no well created, no
 *     forest cleared, no bridge added; the function returns just the filtered
 *     task array),
 *   - never mutates the input array, and
 *   - when the taskId is absent, returns a new array with the same contents.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { interruptTask } from '../logistics/tasks.js';
import type { EngineerTask } from '../../../shared/logisticsTypes.js';

// A generator constrained to the EngineerTask input space: ids drawn from a small
// pool so a generated taskId frequently collides with (removes) an existing task,
// while still exercising the absent-id path.
const arbTask: fc.Arbitrary<EngineerTask> = fc.record({
  id: fc.constantFrom('t0', 't1', 't2', 't3', 't4', 't5'),
  kind: fc.constantFrom<EngineerTask['kind']>('well', 'clearForest', 'bridge'),
  unitId: fc.string(),
  tileIndex: fc.integer({ min: 0, max: 500 }),
  segment: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
  turnsRemaining: fc.integer({ min: 0, max: 5 }),
  ownerId: fc.string(),
});

const arbTasks = fc.array(arbTask, { maxLength: 12 });
// taskId is sometimes one of the pool ids (present) and sometimes a miss.
const arbTaskId = fc.constantFrom('t0', 't1', 't2', 't3', 't4', 't5', 'absent-id');

describe('interruptTask (Property 25: interruption discards progress)', () => {
  it('removes the task, leaves others unchanged, applies no partial effect, and does not mutate', () => {
    fc.assert(
      fc.property(arbTasks, arbTaskId, (tasks, taskId) => {
        // Snapshot the input to detect mutation (Req 9.5, 10.7 — pure cancel).
        const before = tasks.map((t) => ({ ...t }));

        const result = interruptTask(tasks, taskId);

        // The result never contains a task with the interrupted id.
        expect(result.some((t) => t.id === taskId)).toBe(false);

        // Every other task is preserved unchanged (same reference identity), so no
        // partial effect is applied — the function only filters, it does not create
        // a well, clear a forest, or add a bridge.
        const expected = tasks.filter((t) => t.id !== taskId);
        expect(result).toEqual(expected);
        expect(result.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(result[i]).toBe(expected[i]); // untouched task objects
        }

        // Input array is never mutated (new array returned).
        expect(result).not.toBe(tasks);
        expect(tasks).toEqual(before);

        // When the id is absent, the result has the same contents as the input.
        if (!tasks.some((t) => t.id === taskId)) {
          expect(result).toEqual(tasks);
          expect(result).not.toBe(tasks);
        }
      }),
      { numRuns: 200 },
    );
  });
});
