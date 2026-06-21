/**
 * Repair System — attribute-based healing on the hex grid.
 *
 * A unit with the `repair` attribute can restore health to a friendly unit
 * in the same hex, provided the repairer has movement points remaining.
 *
 * Formula:
 *   RepairRate = 2 + ((maxHealth - 10) / 20)
 *   RepairAmount = roundHalfUp(RP * RepairRate)
 *   NewHealth = min(maxHealth, currentHealth + RepairAmount)
 *
 * Where maxHealth is the target's maxHealth * HP_PER_POINT (10–50 range),
 * and RP is the repairer's `repair` attribute (1–5).
 */

import { Unit, HP_PER_POINT } from './units.js';
import { clamp } from './combat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round half-up (deterministic across platforms). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

// ---------------------------------------------------------------------------
// Core repair calculations
// ---------------------------------------------------------------------------

/**
 * Calculate the repair amount given RP and the target's maxHealth (in HP units).
 *
 * @param rp Repair Points (repairer's `repair` attribute), clamped to 1–5.
 * @param maxHealth Target's maximum health in HP units (maxHealth attr * HP_PER_POINT), clamped to 10–50.
 * @returns The amount of health to restore.
 */
export function calculateRepairAmount(rp: number, maxHealth: number): number {
  rp = clamp(rp, 1, 5);
  maxHealth = clamp(maxHealth, 10, 50);

  const repairRate = 2 + (maxHealth - 10) / 20;
  return roundHalfUp(rp * repairRate);
}

/**
 * Apply repair to a unit's current health, capped at maxHealth.
 *
 * @param currentHealth Target's current health in HP units.
 * @param maxHealth Target's maximum health in HP units, clamped to 10–50.
 * @param rp Repair Points (repairer's `repair` attribute), clamped to 1–5.
 * @returns The new health value after repair.
 */
export function applyRepair(currentHealth: number, maxHealth: number, rp: number): number {
  maxHealth = clamp(maxHealth, 10, 50);
  currentHealth = clamp(currentHealth, 0, maxHealth);
  rp = clamp(rp, 1, 5);

  const repairAmount = calculateRepairAmount(rp, maxHealth);
  return Math.min(maxHealth, currentHealth + repairAmount);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RepairValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Check whether a repair action is valid.
 *
 * Requirements:
 * - Repairer must have repair attribute >= 1
 * - Repairer must be alive (currentHealth > 0)
 * - Target must be alive (currentHealth > 0)
 * - Repairer and target must be on the same tile
 * - Repairer and target must be the same faction
 * - Target must not already be at full health
 * - Repairer cannot repair itself
 */
export function validateRepair(repairer: Unit, target: Unit): RepairValidation {
  if (repairer.id === target.id) {
    return { valid: false, reason: 'Cannot repair self' };
  }
  if ((repairer.attributes.repair ?? 0) < 1) {
    return { valid: false, reason: 'Unit has no repair capability' };
  }
  if (repairer.currentHealth <= 0) {
    return { valid: false, reason: 'Repairer is destroyed' };
  }
  if (target.currentHealth <= 0) {
    return { valid: false, reason: 'Target is destroyed' };
  }
  if (repairer.ownerId !== target.ownerId) {
    return { valid: false, reason: 'Cannot repair enemy units' };
  }
  if (repairer.tileIndex !== target.tileIndex) {
    return { valid: false, reason: 'Target must be in the same hex' };
  }

  const targetMaxHealth = (target.attributes.size ?? 1) * HP_PER_POINT;
  if (target.currentHealth >= targetMaxHealth) {
    return { valid: false, reason: 'Target is already at full health' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Repair result
// ---------------------------------------------------------------------------

export interface RepairResult {
  repairerId: string;
  targetId: string;
  wasValid: boolean;
  reasonInvalid?: string;
  repairAmount: number;
  targetHealthBefore: number;
  targetHealthAfter: number;
}

/**
 * Resolve a repair action. Mutates the target's currentHealth.
 */
export function resolveRepair(
  repairerId: string,
  targetId: string,
  allUnits: Unit[],
): RepairResult {
  const repairer = allUnits.find((u) => u.id === repairerId);
  const target = allUnits.find((u) => u.id === targetId);

  if (!repairer) {
    return { repairerId, targetId, wasValid: false, reasonInvalid: 'Repairer not found', repairAmount: 0, targetHealthBefore: 0, targetHealthAfter: 0 };
  }
  if (!target) {
    return { repairerId, targetId, wasValid: false, reasonInvalid: 'Target not found', repairAmount: 0, targetHealthBefore: 0, targetHealthAfter: 0 };
  }

  const validation = validateRepair(repairer, target);
  if (!validation.valid) {
    return { repairerId, targetId, wasValid: false, reasonInvalid: validation.reason, repairAmount: 0, targetHealthBefore: target.currentHealth, targetHealthAfter: target.currentHealth };
  }

  const rp = repairer.attributes.repair!;
  const maxHealth = (target.attributes.size ?? 1) * HP_PER_POINT;
  const healthBefore = target.currentHealth;
  const healthAfter = applyRepair(healthBefore, maxHealth, rp);
  const repairAmount = healthAfter - healthBefore;

  // Mutate target health
  target.currentHealth = healthAfter;

  return {
    repairerId,
    targetId,
    wasValid: true,
    repairAmount,
    targetHealthBefore: healthBefore,
    targetHealthAfter: healthAfter,
  };
}
