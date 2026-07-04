/**
 * Shared wire types for combat API responses.
 *
 * Used by both server/combatApi.ts (produces) and client/combatPanel.ts (consumes).
 */

import type { WireBuilding } from './wireTypes.js';

/** One building component reduction reported back to the client (building-damage feature). */
export interface BuildingDamageReport {
  /** The affected building's id. */
  buildingId: string;
  /** The affected component (e.g. 'defence', 'kinetic'). */
  component: string;
  /** The component's value AFTER the reduction (clamped to ≥ 0). */
  newValue: number;
  /** True when the component reached 0 (reported as destroyed). */
  destroyed: boolean;
}

/** Step-by-step explanation entry. */
export interface ExplanationStep {
  /** Short title for this step (e.g. "Range Check"). */
  title: string;
  /** Human-readable description. */
  description: string;
  /** Formula shown to the player (e.g. "3 + 1 − 2 − 1 = 1"). */
  formula?: string;
  /** Result value (numeric or label). */
  result: string;
  /** Visual emphasis. */
  tone: 'positive' | 'negative' | 'neutral' | 'critical';
}

/** Splash explanation for one victim. */
export interface SplashExplanation {
  victimId: string;
  victimLabel: string;
  steps: ExplanationStep[];
  damage: number;
  victimDestroyed: boolean;
  victimHealthBefore: number;
  victimHealthAfter: number;
}

/** Full explained combat result for one attack. */
export interface ExplainedCombat {
  attackerId: string;
  attackerLabel: string;
  targetId: string;
  targetLabel: string;
  wasValid: boolean;
  reasonInvalid?: string;
  steps: ExplanationStep[];
  directDamage: number;
  targetHealthBefore: number;
  targetHealthAfter: number;
  targetDestroyed: boolean;
  splash: SplashExplanation[];
  destroyedUnitIds: string[];
  /**
   * Building component reductions caused by this attack (building-damage
   * feature). Present/empty unless the attack reached one or more enemy
   * buildings. The client renders these and rebuilds affected building models.
   */
  buildingDamage?: BuildingDamageReport[];
  /** Structured breakdown for the combat preview table. Present on preview responses. */
  breakdown?: CombatBreakdown;
}

/** Structured numbers for the combat preview table. */
export interface CombatBreakdown {
  inRange: boolean;
  distance: number;
  attackRange: number;
  weaponMode: 'kinetic' | 'splash' | 'antiAir' | 'none';
  /** Base weapon value before any modifiers. */
  baseWeapon: number;
  /** Chassis type label for display (e.g. 'Tank', 'Spider', 'Drone'). */
  chassisLabel: 'Tank' | 'Spider' | 'Drone';
  /** Chassis modifier (e.g. 1.0 tank, 0.75 spider, 0.5 drone). */
  chassisModifier: number;
  /** Range efficiency (0–1). */
  rangeEfficiency: number;
  /** Orientation armour penalty (−0 front, −1.5 side, −3 rear). Continuous 0–3, subtracted from defender armour. */
  orientationArmourPenalty: number;
  /** Human-readable orientation label (e.g. 'Front', 'Front Flank', 'Rear Flank', 'Rear'). */
  orientationLabel: string;
  /** @deprecated — always 0, kept for wire compatibility. Will be removed. */
  droneAttackPenalty: number;
  /** Attack total (after all attack modifiers). */
  attackTotal: number;
  /** Armour component of defence. */
  defArmour: number;
  /** EW component of defence (already scaled by weapon-mode multiplier). */
  defEW: number;
  /** Raw EW value before weapon-mode scaling. */
  defEWRaw: number;
  /** EW multiplier applied (0.5 kinetic, 0.75 splash, 1.0 AA). */
  defEWMultiplier: number;
  /** @deprecated Formation bonus removed 2026-06-21 — always 0. Retained for wire compatibility. */
  defFormation: number;
  /** Terrain component of defence. */
  defTerrain: number;
  /** Elevation range multiplier (0.50–1.50). 1.0 = same elevation or drone involved. Higher ground shoots farther. */
  elevationMultiplier: number;
  /** Damage absorbed by drone evasion (0 if target is not a drone, or antiAir mode). */
  droneEvasion: number;
  /** Total effective defence. */
  defTotal: number;
  /** Final damage dealt (0 if out of range). */
  netDamage: number;
  /** Human-readable best weapon mode summary (e.g. 'Direct Fire: 12'). */
  weaponSelectionLabel: string;
}

/** Response from the combat endpoint. Generic over the unit wire shape. */
export interface CombatResponse<U = unknown> {
  success: boolean;
  error?: string;
  /** Primary combat explanations (one per attack resolved). */
  combats: ExplainedCombat[];
  /** Reaction fire explanations triggered during movement. */
  reactions: ExplainedCombat[];
  /** Updated units array (with new health/facing/position values). */
  updatedUnits: U[];
  /**
   * Updated buildings array (with post-damage component values). Present when
   * an attack degraded one or more buildings so the client can sync and
   * re-render them (building-damage feature). Omitted when no building changed.
   */
  updatedBuildings?: WireBuilding[];
  /** Repair explanation (only present for repair actions). */
  repair?: ExplainedRepair;
}

/** Full explained repair result for one repair action. */
export interface ExplainedRepair {
  repairerId: string;
  repairerLabel: string;
  targetId: string;
  targetLabel: string;
  wasValid: boolean;
  reasonInvalid?: string;
  steps: ExplanationStep[];
  repairAmount: number;
  targetHealthBefore: number;
  targetHealthAfter: number;
}

// ─── Server-authoritative AI turn (Phase 1) ─────────────────────────────────
//
// `/api/ai-turn` resolves an entire AI faction's turn server-side and returns
// an ordered list of actions. Each event carries the post-action world snapshot
// so the client playback bar can step/rewind/skip without recomputing anything.

/** One splash victim summary attached to an attack event (for animation). */
export interface AiSplashVictim {
  unitId: string;
  damage: number;
  destroyed: boolean;
}

/**
 * A single resolved AI action plus the authoritative world snapshot that
 * results from it. The client replays these in order; "skip to end" simply
 * jumps to the final event's snapshot.
 */
export interface AiActionEvent<U = unknown> {
  kind: 'move' | 'attack';
  /** The acting unit. */
  unitId: string;
  /** Owning faction of the acting unit. */
  factionId: string;

  // ── move ──
  /** Tile the unit started this step from (move events). */
  fromTile?: number;
  /** Segment the unit started this step from (move events). */
  fromSegment?: number;
  /** Tile-index path walked (move events). */
  path?: number[];

  // ── attack ──
  /** Target unit id (attack events). */
  targetId?: string;
  /** Direct damage dealt to the primary target (attack events). */
  damage?: number;
  /** Whether the primary target was destroyed (attack events). */
  targetDestroyed?: boolean;
  /** Splash victims other than the primary target (attack events). */
  splashVictims?: AiSplashVictim[];

  /** Combat-log explanations produced by this action (attacks). */
  combats: ExplainedCombat[];
  /** Reaction-fire explanations produced by this action (drone moves). */
  reactions: ExplainedCombat[];
  /** Building component reductions caused by this action, if any. */
  buildingDamage?: BuildingDamageReport[];

  /** Authoritative units array AFTER this action (destroyed units removed). */
  units: U[];
  /** Authoritative buildings array AFTER this action, if any changed. */
  buildings?: WireBuilding[];
}

/** Response from `/api/ai-turn` — the full resolved turn for one faction. */
export interface AiTurnResponse<U = unknown> {
  success: boolean;
  error?: string;
  /** Ordered actions taken by the faction this turn. */
  events: AiActionEvent<U>[];
  /** Final authoritative units after the whole turn (destroyed units removed). */
  finalUnits: U[];
  /** Final authoritative buildings after the whole turn. */
  finalBuildings?: WireBuilding[];
}
