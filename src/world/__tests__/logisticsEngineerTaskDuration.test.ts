// Feature: oil-logistics-system, Property 4: Engineer task duration is 6 - engineer
/**
 * Property test for the engineer task duration helper (`engineerTaskDuration`).
 *
 * Property 4: Engineer task duration is `6 − engineer`.
 * Validates: Requirements 2.6, 9.3, 10.1
 *
 * For any integer engineer attribute in the inclusive range 1..5, the duration is
 * exactly `ENGINEER_TASK_BASE - engineer` and lies in the inclusive range 1..5
 * turns (engineer 5 → 1 turn, engineer 1 → 5 turns). ENGINEER_TASK_BASE is a
 * specification constant and may be asserted exactly.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { engineerTaskDuration } from '../logistics.js';
import { ENGINEER_TASK_BASE } from '../../../shared/logisticsConstants.js';

describe('engineerTaskDuration (Property 4: duration is 6 - engineer)', () => {
  it('equals ENGINEER_TASK_BASE - engineer and stays within 1..5 for engineer 1..5', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (engineer) => {
        const duration = engineerTaskDuration(engineer);
        // Exact specification formula (Req 2.6, 9.3, 10.1).
        expect(duration).toBe(ENGINEER_TASK_BASE - engineer);
        // Result lies in the inclusive range 1..5 turns.
        expect(duration).toBeGreaterThanOrEqual(1);
        expect(duration).toBeLessThanOrEqual(5);
      }),
      { numRuns: 200 },
    );
  });
});
