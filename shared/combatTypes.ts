/**
 * Shared wire types for combat API responses.
 *
 * Used by both server/combat.ts (produces) and client/combatPanel.ts (consumes).
 */

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
  /** Orientation bonus (+0 front, +1 side, +2 rear). Now continuous 0–2. */
  orientationBonus: number;
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
  /** Formation component of defence. */
  defFormation: number;
  /** Terrain component of defence. */
  defTerrain: number;
  /** Elevation damage multiplier (0.70–1.30). 1.0 = same elevation or drone involved. */
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
