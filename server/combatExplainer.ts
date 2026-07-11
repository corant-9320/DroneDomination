/**
 * Combat explanation formatters — thin presentation layer over previewAttack.
 *
 * Pure functions — no HTTP handling, no state mutation.
 * Imported by server/combatApi.ts to attach explanations to API responses.
 *
 * These functions NEVER call computeDamage or re-derive combat intermediates.
 * They consume CombatPreview (the single source of truth from combat.ts) and
 * format it into the ExplainedCombat / CombatBreakdown wire shapes the client
 * expects.
 */

import { Unit } from '../src/world/units.js';
import type { Building } from '../src/world/types.js';
import {
  previewAttack,
  type CombatContext,
  type CombatResult,
  type CombatPreview,
  type WeaponMode,
} from '../src/world/combat.js';
import { calculateRepairAmount } from '../src/world/repair.js';
import { HP_PER_POINT } from '../src/world/units.js';
import type {
  ExplanationStep,
  SplashExplanation,
  ExplainedCombat,
  ExplainedRepair,
  CombatBreakdown,
} from '../shared/combatTypes.js';

// ---------------------------------------------------------------------------
// Private helpers — formatting only
// ---------------------------------------------------------------------------

function formatArcDetailed(angleDiffDeg: number): string {
  if (angleDiffDeg <= 40) return '🛡 Front';
  if (angleDiffDeg <= 80) return '🛡→ Front Flank';
  if (angleDiffDeg <= 100) return '→ Flank';
  if (angleDiffDeg <= 140) return '→🎯 Rear Flank';
  return '🎯 Rear';
}

const WEAPON_LABELS: Record<string, string> = {
  direct: 'Direct Fire',
  splash: 'Splash Fire',
  antiAir: 'Anti-Air Fire',
  none: '—',
};

// ---------------------------------------------------------------------------
// CombatPreview → CombatBreakdown (flat table data for the client)
// ---------------------------------------------------------------------------

function previewToBreakdown(p: CombatPreview): CombatBreakdown {
  const weaponMode: CombatBreakdown['weaponMode'] =
    p.chosenMode === 'direct' ? 'kinetic'
    : p.chosenMode === 'splash' ? 'splash'
    : p.chosenMode === 'antiAir' ? 'antiAir'
    : 'none';

  const weaponSelectionLabel = p.chosenMode !== 'none'
    ? `${WEAPON_LABELS[p.chosenMode]}: ${p.totalDamage}`
    : '—';

  return {
    inRange: p.inRange,
    distance: p.distance,
    attackRange: Math.round(p.effectiveRangeThreshold * 100) / 100,
    weaponMode,
    baseWeapon: p.baseWeapon,
    chassisLabel: p.chassisLabel,
    chassisModifier: p.chassisModifier,
    rangeEfficiency: Math.round(p.rangeEfficiency * 100) / 100,
    orientationArmourPenalty: p.orientationArmourPenalty,
    orientationLabel: p.orientationLabel,
    attackTotal: Math.round(p.attackTotal * 100) / 100,
    defArmour: p.defArmour,
    defEW: p.defEW,
    defEWRaw: p.defEWRaw,
    defEWMultiplier: p.defEWMultiplier,
    defTerrain: p.defTerrain,
    elevationMultiplier: Math.round(p.elevationRangeMultiplier * 100) / 100,
    droneEvasion: p.droneEvasion,
    defTotal: Math.round(p.effectiveDefence * 100) / 100,
    netDamage: p.primaryTargetDamage,
    weaponSelectionLabel,
  };
}

// ---------------------------------------------------------------------------
// CombatPreview → ExplainedCombat (step-by-step explanation + breakdown)
// ---------------------------------------------------------------------------

function previewToExplained(p: CombatPreview): ExplainedCombat {
  if (!p.wasValid) {
    return {
      attackerId: p.attackerId,
      attackerLabel: p.attackerLabel,
      targetId: p.targetId,
      targetLabel: p.targetLabel,
      wasValid: false,
      reasonInvalid: p.reasonInvalid,
      steps: [{
        title: '❌ Invalid Attack',
        description: p.reasonInvalid ?? 'Unknown reason',
        result: 'Attack cannot proceed',
        tone: 'negative',
      }],
      directDamage: 0,
      targetHealthBefore: p.targetHealthBefore,
      targetHealthAfter: p.targetHealthAfter,
      targetDestroyed: false,
      splash: [],
      destroyedUnitIds: [],
    };
  }

  const steps: ExplanationStep[] = [];

  // Step 1: Range
  const elevPct = Math.round((p.elevationRangeMultiplier - 1) * 100);
  const elevNote = p.elevationRangeMultiplier !== 1
    ? ` Elevation ${elevPct > 0 ? '+' : ''}${elevPct}% range → ${p.effectiveRangeThreshold.toFixed(2)}.`
    : '';

  steps.push({
    title: '📏 Range Check',
    description: `Segment distance: ${p.distance.toFixed(2)}. Range threshold: ${p.baseRangeThreshold.toFixed(2)}.${elevNote}`,
    result: p.inRange ? '✓ In range' : '✗ Out of range',
    tone: p.inRange ? 'positive' : 'negative',
  });

  // Step 2: Orientation
  steps.push({
    title: '🧭 Orientation',
    description: `Bearing difference: ${p.angleDiffDeg}°. Arc: ${p.arc}.`,
    result: `${formatArcDetailed(p.angleDiffDeg)} → armour penalty −${p.orientationArmourPenalty.toFixed(1)}`,
    tone: p.orientationArmourPenalty > 0.3 ? 'positive' : 'neutral',
  });

  // Step 3: Defence
  steps.push({
    title: '🛡 Defence Power',
    description: `Armour(${p.defArmour}) − orientation(${p.orientationArmourPenalty.toFixed(1)}) + EW(${p.defEWRaw.toFixed(2)}) + Terrain(${p.defTerrain}). EffectiveDefence = ${p.effectiveDefence.toFixed(2)}.`,
    result: `EffectiveDefence = ${p.effectiveDefence.toFixed(2)}`,
    tone: p.effectiveDefence > 0 ? 'negative' : 'neutral',
  });

  // Step 4: Chassis
  steps.push({
    title: '⚙ Chassis Modifier',
    description: `${p.attackerLabel} is ${p.chassisLabel} chassis.`,
    result: `×${p.chassisModifier}`,
    tone: p.chassisModifier < 1 ? 'negative' : 'neutral',
  });

  // Step 5: Weapon Selection
  const optionLabels = p.weaponOptions.map((o) => `${WEAPON_LABELS[o.mode]}: ${o.score}`).join('; ');
  steps.push({
    title: '🎯 Weapon Selection',
    description: `Evaluated: ${optionLabels}.`,
    result: p.chosenMode !== 'none'
      ? `Best: ${WEAPON_LABELS[p.chosenMode]}: ${p.totalDamage}`
      : 'No valid weapon modes',
    tone: 'neutral',
  });

  // Step 6: Damage detail
  if (p.chosenMode !== 'none') {
    const dmgTitle = p.chosenMode === 'direct' ? '💥 Kinetic Fire'
      : p.chosenMode === 'splash' ? '💣 Splash Fire'
      : '🚀 Anti-Air Fire';
    const dmgDesc = `Base weapon: ${p.baseWeapon}. Range efficiency: ${p.rangeEfficiency.toFixed(2)}. AttackPower = ${p.baseWeapon} × ${p.chassisModifier} × ${p.rangeEfficiency.toFixed(2)} = ${p.attackTotal.toFixed(2)}.${p.droneEvasion > 0 ? ` Drone evasion: −${p.droneEvasion}.` : ''}`;
    steps.push({
      title: dmgTitle,
      description: dmgDesc,
      result: `${p.primaryTargetDamage} damage`,
      tone: p.primaryTargetDamage >= 15 ? 'critical' : p.primaryTargetDamage >= 5 ? 'positive' : 'neutral',
    });
  }

  // Step 7: Health outcome
  steps.push({
    title: p.targetDestroyed ? '☠ Target Destroyed' : '❤ Health Update',
    description: `${p.targetLabel}: ${p.targetHealthBefore}/${p.targetMaxHp} HP → ${p.targetHealthAfter}/${p.targetMaxHp} HP.`,
    result: p.targetDestroyed
      ? `${p.targetLabel} is destroyed!`
      : `${p.targetHealthAfter}/${p.targetMaxHp} HP remaining`,
    tone: p.targetDestroyed ? 'critical' : (p.primaryTargetDamage > 0 ? 'negative' : 'neutral'),
  });

  // Splash explanations from preview data
  const splash: SplashExplanation[] = p.splashVictims.map((v) => ({
    victimId: v.unitId,
    victimLabel: v.unitLabel,
    steps: [{
      title: '💣 Splash Fire',
      description: `${v.unitLabel} in target hex.`,
      result: v.destroyed
        ? `${v.damage} damage — ${v.unitLabel} destroyed!`
        : `${v.damage} damage → ${v.healthAfter}/${v.maxHp} HP`,
      tone: v.destroyed ? 'critical' as const : 'negative' as const,
    }],
    damage: v.damage,
    victimDestroyed: v.destroyed,
    victimHealthBefore: v.healthBefore,
    victimHealthAfter: v.healthAfter,
  }));

  return {
    attackerId: p.attackerId,
    attackerLabel: p.attackerLabel,
    targetId: p.targetId,
    targetLabel: p.targetLabel,
    wasValid: p.inRange,
    reasonInvalid: !p.inRange ? 'Out of range' : undefined,
    steps,
    directDamage: p.inRange ? p.totalDamage : 0,
    targetHealthBefore: p.targetHealthBefore,
    targetHealthAfter: p.targetHealthAfter,
    targetDestroyed: p.targetDestroyed,
    splash,
    destroyedUnitIds: [],
    breakdown: previewToBreakdown(p),
  };
}

// ---------------------------------------------------------------------------
// Public API — consumed by combatApi.ts, matchApi.ts, aiTurnApi.ts
// ---------------------------------------------------------------------------

/**
 * Build a full ExplainedCombat for an attack (preview or log).
 * Delegates to previewAttack (single source of truth) and formats.
 */
export function explainAttack(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
): ExplainedCombat {
  const preview = previewAttack(attacker, target, ctx);
  return previewToExplained(preview);
}

/**
 * Build splash explanations from a resolved CombatResult.
 * Post-resolution: uses actual health values from mutated units.
 */
export function explainSplash(
  attacker: Unit,
  primaryTarget: Unit,
  result: CombatResult,
  ctx: CombatContext,
): SplashExplanation[] {
  if (result.chosenWeaponMode !== 'splash' || result.splashEvents.length === 0) return [];

  const { units: allUnits } = ctx;
  const explanations: SplashExplanation[] = [];

  for (const event of result.splashEvents) {
    const victim = allUnits.find((u) => u.id === event.victimId);
    if (!victim) continue;
    // Skip the primary target (it's shown in the main attack steps)
    if (victim.id === primaryTarget.id) continue;

    const maxHp = (victim.attributes.size ?? 1) * HP_PER_POINT;
    const healthBefore = victim.currentHealth + event.damage;

    explanations.push({
      victimId: victim.id,
      victimLabel: victim.label,
      steps: [{
        title: '💣 Splash Fire',
        description: `${victim.label} in target hex.`,
        result: event.victimDestroyed
          ? `${event.damage} damage — ${victim.label} destroyed!`
          : `${event.damage} damage → ${victim.currentHealth}/${maxHp} HP`,
        tone: event.victimDestroyed ? 'critical' : 'negative',
      }],
      damage: event.damage,
      victimDestroyed: event.victimDestroyed,
      victimHealthBefore: healthBefore,
      victimHealthAfter: victim.currentHealth,
    });
  }

  return explanations;
}

/**
 * Build an ExplainedCombat for anti-air reaction fire.
 * Reaction fire uses a simplified format (no full breakdown table).
 * Reactor may be a Unit or a Building (buildings have no `label` — falls back to `id`).
 */
export function buildReactionExplanation(
  result: CombatResult,
  reactor: Unit | Building | undefined,
  drone: Unit | undefined,
): ExplainedCombat {
  if (!reactor || !drone) {
    return {
      attackerId: result.attackerId,
      attackerLabel: result.attackerId,
      targetId: result.targetId,
      targetLabel: result.targetId,
      wasValid: result.wasValid,
      steps: [],
      directDamage: result.directDamage,
      targetHealthBefore: 0,
      targetHealthAfter: 0,
      targetDestroyed: result.destroyedUnitIds.includes(result.targetId),
      splash: [],
      destroyedUnitIds: result.destroyedUnitIds,
    };
  }

  const healthAfter = drone.currentHealth;
  const healthBefore = healthAfter + result.directDamage;
  const destroyed = result.destroyedUnitIds.includes(drone.id);
  const maxHpDrone = (drone.attributes.size ?? 1) * HP_PER_POINT;
  // Buildings have no `label` — fall back to id for display.
  const reactorLabel = 'label' in reactor ? (reactor as Unit).label : reactor.id;

  const steps: ExplanationStep[] = [
    {
      title: '🚀 Anti-Air Reaction Fire',
      description: `${reactorLabel} fires at drone ${drone.label} as it enters the tile.`,
      result: `${result.directDamage} damage`,
      tone: 'neutral',
    },
    {
      title: destroyed ? '☠ Drone Destroyed' : '❤ Drone Health Update',
      description: `${drone.label}: ${healthBefore}/${maxHpDrone} HP → ${healthAfter}/${maxHpDrone} HP.`,
      result: destroyed ? `${drone.label} is destroyed!` : `${healthAfter}/${maxHpDrone} HP remaining`,
      tone: destroyed ? 'critical' : 'negative',
    },
  ];

  return {
    attackerId: reactor.id,
    attackerLabel: reactorLabel,
    targetId: drone.id,
    targetLabel: drone.label,
    wasValid: true,
    steps,
    directDamage: result.directDamage,
    targetHealthBefore: healthBefore,
    targetHealthAfter: healthAfter,
    targetDestroyed: destroyed,
    splash: [],
    destroyedUnitIds: result.destroyedUnitIds,
  };
}

// ---------------------------------------------------------------------------
// Repair explanations
// ---------------------------------------------------------------------------

export function explainRepairAction(repairer: Unit, target: Unit): ExplainedRepair {
  const rp = repairer.attributes.repair ?? 0;
  const maxHealth = (target.attributes.size ?? 1) * HP_PER_POINT;
  const repairAmount = calculateRepairAmount(rp, maxHealth);
  const repairRate = 2 + (Math.max(10, Math.min(50, maxHealth)) - 10) / 20;

  const steps: ExplanationStep[] = [
    {
      title: '🔧 Repair Capability',
      description: `${repairer.label} has Repair ${rp}. Target ${target.label} has MaxHealth ${maxHealth}.`,
      result: `RP = ${rp}`,
      tone: 'neutral',
    },
    {
      title: '⚙ Repair Rate',
      description: `RepairRate = ${repairRate.toFixed(2)} HP per RP.`,
      result: `${repairRate.toFixed(2)} HP/RP`,
      tone: 'neutral',
    },
    {
      title: '💚 Repair Amount',
      description: `RepairAmount = round(${rp} × ${repairRate.toFixed(2)}) = ${repairAmount}.`,
      result: `+${repairAmount} HP`,
      tone: 'positive',
    },
    {
      title: '❤ Health Update',
      description: `${target.label}: ${target.currentHealth}/${maxHealth} → ${Math.min(maxHealth, target.currentHealth + repairAmount)}/${maxHealth} HP.`,
      result: `${Math.min(maxHealth, target.currentHealth + repairAmount)}/${maxHealth} HP`,
      tone: 'positive',
    },
  ];

  return {
    repairerId: repairer.id,
    repairerLabel: repairer.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: true,
    steps,
    repairAmount,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: target.currentHealth, // updated after resolve
  };
}

export function explainRepairInvalid(repairer: Unit, target: Unit, reason: string): ExplainedRepair {
  return {
    repairerId: repairer.id,
    repairerLabel: repairer.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: false,
    reasonInvalid: reason,
    steps: [{
      title: '❌ Invalid Repair',
      description: reason,
      result: 'Repair cannot proceed',
      tone: 'negative',
    }],
    repairAmount: 0,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: target.currentHealth,
  };
}
