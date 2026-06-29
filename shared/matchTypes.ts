/**
 * Authoritative match-session types (server-authority Phase 3).
 *
 * The server holds the authoritative state of a match between requests: unit
 * positions/health, per-unit turn budget (MP / acted / rotated), whose turn it
 * is, and a monotonically-increasing `version` for optimistic concurrency.
 *
 * Static tiles are NOT stored here — they are regenerated server-side from the
 * trusted `seed` (so a client cannot lie about terrain to legalise a move).
 * Only the mutable state travels/persists, which also keeps a stored item small
 * enough for a single DynamoDB item (≤ 400 KB).
 *
 * Shared so the client can mirror the state (its `TurnManager` becomes a cache
 * of this) once the player-action paths are wired to the session API.
 */

import type { WireUnit, WireBuilding } from './wireTypes.js';
import type { ExplainedCombat, ExplainedRepair } from './combatTypes.js';

/** Per-unit, per-turn budget the server enforces authoritatively. */
export interface UnitTurnState {
  /** Movement points remaining this turn. */
  mp: number;
  /** Whether the unit has used its once-per-turn action (attack/repair). */
  acted: boolean;
  /** Whether the unit has paid its once-per-turn rotation fee. */
  rotated: boolean;
}

/** The authoritative state of one match. */
export interface MatchState {
  /** Opaque match identifier. */
  matchId: string;
  /** World seed — tiles are regenerated from this, never trusted from clients. */
  seed: number;
  /** Turn order (faction/owner ids). Index 0 is the human player. */
  factions: string[];
  /** Index into `factions` whose turn it currently is. */
  activeFactionIndex: number;
  /** Turn number (increments when the order wraps back to faction 0). */
  turn: number;
  /** All living units. */
  units: WireUnit[];
  /** All buildings. */
  buildings: WireBuilding[];
  /** Per-unit turn budget keyed by unit id. */
  unitTurn: Record<string, UnitTurnState>;
  /** Optimistic-concurrency version. Incremented on every successful write. */
  version: number;
}

/** A player intent submitted for authoritative validation + application. */
export type Intent =
  | { kind: 'move'; unitId: string; path: number[] }
  | { kind: 'attack'; attackerId: string; targetId: string }
  | { kind: 'repair'; repairerId: string; targetId: string }
  | { kind: 'endTurn' };

/** Request to create a new authoritative match from a loaded scenario/save. */
export interface CreateMatchRequest {
  seed: number;
  factions: string[];
  units: WireUnit[];
  buildings?: WireBuilding[];
}

export interface CreateMatchResponse {
  success: boolean;
  error?: string;
  state?: MatchState;
}

/** Request to apply one intent to a match. */
export interface MatchIntentRequest {
  matchId: string;
  /** Version the client last saw; rejected with `conflict` if stale. Optional. */
  expectedVersion?: number;
  intent: Intent;
}

export interface MatchIntentResponse {
  success: boolean;
  error?: string;
  /** True when the request was rejected due to a stale `expectedVersion`. */
  conflict?: boolean;
  /** Updated authoritative state (present on success). */
  matchId?: string;
  version?: number;
  turn?: number;
  activeFaction?: string;
  units?: WireUnit[];
  buildings?: WireBuilding[];
  unitTurn?: Record<string, UnitTurnState>;
  /** Combat explanations produced by an attack intent. */
  combats?: ExplainedCombat[];
  /** Reaction-fire explanations produced by a (drone) move intent. */
  reactions?: ExplainedCombat[];
  /** Repair explanation produced by a repair intent. */
  repair?: ExplainedRepair;
}
