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
}
