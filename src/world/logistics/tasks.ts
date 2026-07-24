/**
 * Engineer task lifecycle — Oil Logistics System.
 *
 * Pure functions covering an EngineerTask's life: duration, countdown, completion
 * transitions (well / cleared forest / bridge), and interruption. No Three.js, no
 * network, no mutation of inputs — every function returns new values.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 *
 * ── Task 2.1 scope (this section): Engineer task lifecycle ──
 *   - engineerTaskDuration  Req 2.6, 9.3, 10.1
 *   - tickTask              Req 2.7, 9.4, 10.2
 *   - task completion       Req 2.8, 10.3 (well / cleared forest / bridged tile)
 *   - task interruption     Req 9.5, 10.7 (cancel, discard progress)
 */

import { ENGINEER_TASK_BASE } from '../../../shared/logisticsConstants.js';
import type { EngineerTask, OilWell } from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Engineer task durations (Req 2.6, 9.3, 10.1)
// ---------------------------------------------------------------------------

/**
 * The required duration, in turns, of an engineer construction task (well drilling,
 * forest clearing, or bridge building) driven by an Engineer_Unit of the given
 * `engineer` attribute value.
 *
 * Duration = ENGINEER_TASK_BASE - engineer, yielding the inclusive range 1 turn
 * (engineer 5) to 5 turns (engineer 1). The `engineer === 0` case (which produces
 * ENGINEER_TASK_BASE) never reaches here in practice: an engineer value of 0 is
 * rejected up front by the placement validators (Req 2.2, 9.6, 10.6), not by this
 * pure duration helper.
 *
 * @param engineer The constructing unit's `engineer` attribute value.
 * @returns The whole-turn task duration.
 */
export function engineerTaskDuration(engineer: number): number {
  return ENGINEER_TASK_BASE - engineer;
}

// ---------------------------------------------------------------------------
// Task countdown (Req 2.7, 9.4, 10.2)
// ---------------------------------------------------------------------------

/**
 * Advance an in-progress engineer task by one turn: decrement its remaining
 * duration by one, clamped to a minimum of zero. Pure — returns a new task and
 * never mutates the input (Req 2.7, 9.4, 10.2/10.3).
 *
 * @param task The in-progress task.
 * @returns A new task with `turnsRemaining` decremented and clamped to `>= 0`.
 */
export function tickTask(task: EngineerTask): EngineerTask {
  return { ...task, turnsRemaining: Math.max(0, task.turnsRemaining - 1) };
}

/**
 * Whether a task has finished its countdown and is ready to complete
 * (`turnsRemaining === 0`).
 */
export function isTaskComplete(task: EngineerTask): boolean {
  return task.turnsRemaining <= 0;
}

// ---------------------------------------------------------------------------
// Task completion transitions (Req 2.8, 9.4, 10.3)
// ---------------------------------------------------------------------------

/**
 * The concrete effect produced when an engineer task reaches `turnsRemaining === 0`:
 *   - `well`        → an operational Oil_Well occupying exactly one segment (Req 2.8)
 *   - `clearForest` → the tile index reclassified as a traversable non-forest
 *                     tile (added to `LogisticsState.clearedForests`) (Req 9.4)
 *   - `bridge`      → the tile index now crossable by a Road (added to
 *                     `LogisticsState.bridges`) (Req 10.3)
 *   - `road`        → one road segment now built (added to
 *                     `LogisticsState.standaloneRoadSegments`)
 *
 * These are descriptions of the transition; the orchestrator applies them to
 * `LogisticsState`. Keeping them as data (rather than mutating state here) preserves
 * the engine's purity.
 */
export type TaskCompletion =
  | { kind: 'well'; well: OilWell }
  | { kind: 'clearForest'; tileIndex: number }
  | { kind: 'bridge'; tileIndex: number }
  | { kind: 'road'; tileIndex: number; segment: number };

/**
 * Caller-supplied initialisation for a completed Oil_Well. The `id` and hit points
 * are provided by the caller (the orchestrator) rather than pinned in the pure
 * engine, so no balance value lives here. The completed well starts empty
 * (`storedOil === 0`) and full-health.
 */
export interface WellCompletionInit {
  id: string;
  maxHitPoints: number;
}

/**
 * Produce the operational Oil_Well described by a finished `well` task (Req 2.8).
 * Pure: reads only the task and the caller-supplied init; the well occupies exactly
 * the one segment the task targeted and belongs to the task's owner.
 *
 * @param task A `well` task at `turnsRemaining === 0`.
 * @param init The new well's id and hit-point pool (supplied by the caller).
 * @returns A new, operational Oil_Well.
 */
export function completeWellTask(task: EngineerTask, init: WellCompletionInit): OilWell {
  return {
    id: init.id,
    ownerId: task.ownerId,
    tileIndex: task.tileIndex,
    segment: task.segment ?? 0,
    storedOil: 0,
    hitPoints: init.maxHitPoints,
    maxHitPoints: init.maxHitPoints,
  };
}

/**
 * The tile index reclassified as a traversable non-forest tile by a finished
 * `clearForest` task (Req 9.4). The orchestrator adds this to
 * `LogisticsState.clearedForests`.
 */
export function completeClearForestTask(task: EngineerTask): number {
  return task.tileIndex;
}

/**
 * The tile index made crossable by a completed Bridge from a finished `bridge`
 * task (Req 10.3). The orchestrator adds this to `LogisticsState.bridges`.
 */
export function completeBridgeTask(task: EngineerTask): number {
  return task.tileIndex;
}

/**
 * The single road segment built by a finished `road` task. The orchestrator adds
 * the encoded segment key to `LogisticsState.standaloneRoadSegments`.
 *
 * A completed road segment is deliberately a traversable overlay, not a
 * `LogisticsRoute`: it has no endpoints, capacity, or transport assignment. A
 * chain of them is what `findExistingRoadPath` walks when connecting two owned
 * structures, so engineers build connectivity segment by segment.
 */
export function completeRoadTask(task: EngineerTask): { tileIndex: number; segment: number } {
  return { tileIndex: task.tileIndex, segment: task.segment ?? 0 };
}

/**
 * Dispatch a finished task to its completion transition (Req 2.8, 9.4, 10.3). The
 * caller must supply `wellInit` for a `well` task (the new well's id + hit points,
 * kept out of the pure engine so no balance value is pinned).
 *
 * @param task A task at `turnsRemaining === 0`.
 * @param wellInit Required only when `task.kind === 'well'`.
 * @returns The completion transition to apply to `LogisticsState`.
 */
export function completeTask(task: EngineerTask, wellInit?: WellCompletionInit): TaskCompletion {
  switch (task.kind) {
    case 'well': {
      if (!wellInit) {
        throw new Error('completeTask: a well task requires wellInit (id + maxHitPoints)');
      }
      return { kind: 'well', well: completeWellTask(task, wellInit) };
    }
    case 'clearForest':
      return { kind: 'clearForest', tileIndex: completeClearForestTask(task) };
    case 'bridge':
      return { kind: 'bridge', tileIndex: completeBridgeTask(task) };
    case 'road': {
      const { tileIndex, segment } = completeRoadTask(task);
      return { kind: 'road', tileIndex, segment };
    }
  }
}

// ---------------------------------------------------------------------------
// Task interruption (Req 9.5, 10.7)
// ---------------------------------------------------------------------------

/**
 * Cancel an in-progress engineer task and discard all accumulated progress
 * (Req 9.5, 10.7). Pure: returns a new task list with the identified task removed
 * and applies **no** partial effect — no forest is cleared, no bridge is completed,
 * no well is created. If the task id is not present, the list is returned unchanged
 * (a new array).
 *
 * @param tasks The current in-progress tasks.
 * @param taskId The id of the task to interrupt.
 * @returns A new task array with the task removed; progress is dropped.
 */
export function interruptTask(tasks: readonly EngineerTask[], taskId: string): EngineerTask[] {
  return tasks.filter((t) => t.id !== taskId);
}
