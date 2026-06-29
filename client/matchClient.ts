/**
 * Client handle to the server-authoritative match session (server-authority
 * Phase 3 — see DECISIONS.md 2026-06-29).
 *
 * Owns the current `matchId` + `version`, creates the session, submits player
 * intents, and reconciles the authoritative response back into the client
 * `world` + `TurnManager`. In an authoritative setup the server's reply is the
 * source of truth: the client adopts the returned unit state and per-unit turn
 * budget rather than computing them locally.
 *
 * Wiring status: this establishes + holds the session for the live game. The
 * per-action routing (move/attack/repair/endTurn through `submit`) is being
 * brought online incrementally — see DECISIONS.md for the remaining steps.
 */

import type { WorldData, UnitData, BuildingData } from './worldData.js';
import type { TurnManager } from './turnManager.js';
import type { CreateMatchResponse, MatchIntentResponse, Intent } from '../shared/matchTypes.js';
import { dbg } from './debug.js';

export class MatchClient {
  private matchId: string | null = null;
  private version = 0;
  private creating: Promise<boolean> | null = null;

  /** Whether an authoritative session is established. */
  get active(): boolean {
    return this.matchId !== null;
  }

  get currentMatchId(): string | null {
    return this.matchId;
  }

  /**
   * Create (or recreate) the authoritative session from the current world.
   * Idempotent while a create is in flight. Returns true on success.
   */
  create(world: WorldData, factions: string[]): Promise<boolean> {
    this.creating = (async () => {
      const payload = {
        seed: world.seed,
        factions,
        units: world.units,
        buildings: world.buildings,
      };
      try {
        const resp = await fetch('/api/match/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = (await resp.json()) as CreateMatchResponse;
        if (!data.success || !data.state) {
          dbg.input.error('Match create failed:', data.error);
          return false;
        }
        this.matchId = data.state.matchId;
        this.version = data.state.version;
        dbg.input.log('Authoritative match created:', this.matchId);
        return true;
      } catch (err) {
        dbg.input.error('Match create error:', err);
        return false;
      }
    })();
    return this.creating;
  }

  /** Resolve once the in-flight create (if any) has settled. */
  async ready(): Promise<void> {
    if (this.creating) await this.creating;
  }

  /**
   * Submit a player intent for authoritative validation. Returns the response
   * (with the updated authoritative state) or null on a transport error.
   * Updates the tracked version on success.
   */
  async submit(intent: Intent): Promise<MatchIntentResponse | null> {
    if (!this.matchId) {
      dbg.input.error('submit() with no active match');
      return null;
    }
    try {
      const resp = await fetch('/api/match/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: this.matchId, expectedVersion: this.version, intent }),
      });
      const data = (await resp.json()) as MatchIntentResponse;
      if (data.success && data.version != null) this.version = data.version;
      else if (!data.success) dbg.input.log('Intent rejected by server:', data.error);
      return data;
    } catch (err) {
      dbg.input.error('Match intent error:', err);
      return null;
    }
  }

  /**
   * Adopt an authoritative intent response into the client world + TurnManager.
   * The server is the source of truth: units/buildings are replaced and the
   * per-unit turn budget (MP / acted / rotated) is rebuilt from `unitTurn`.
   */
  reconcile(resp: MatchIntentResponse, world: WorldData, turnManager: TurnManager): void {
    if (!resp.success) return;
    if (resp.units) world.units = resp.units as UnitData[];
    if (resp.buildings) world.buildings = resp.buildings as BuildingData[];
    if (resp.unitTurn) {
      turnManager.movementPoints.clear();
      turnManager.actedUnits.clear();
      turnManager.rotatedUnits.clear();
      for (const [id, ts] of Object.entries(resp.unitTurn)) {
        turnManager.movementPoints.set(id, ts.mp);
        if (ts.acted) turnManager.actedUnits.add(id);
        if (ts.rotated) turnManager.rotatedUnits.add(id);
      }
    }
    turnManager.onWorldUpdated(world);
  }
}
