/**
 * TurnManager — owns all turn-level game state for the client.
 *
 * Extracted from client/localMap.ts (movement/action tracking) and
 * client/main.ts (faction cycling, turn counter).
 *
 * This is pure game logic with no rendering concerns.
 */

import { WorldData, UnitData } from './worldData.js';
import { dbg } from './debug.js';
import { getMaxMovement as sharedGetMaxMovement } from '../shared/movementConstants.js';

export class TurnManager {
  /** Index into the factions array for the currently active faction. */
  activeFactionIndex: number;

  /** Current turn number (starts at 1). */
  turnNumber: number;

  /** Remaining movement points per unit this turn (keyed by unit id). */
  movementPoints: Map<string, number> = new Map();

  /** Units that have already used their action this turn (attack or repair). */
  actedUnits: Set<string> = new Set();

  /** Units the player has put to sleep this turn (suppresses "are you sure?" check). */
  sleepingUnits: Set<string> = new Set();

  /** Units currently selected for movement (by unit id). */
  selectedUnits: Set<string> = new Set();

  private world: WorldData;
  private factions: string[];
  private playerFaction: string;

  constructor(world: WorldData) {
    this.world = world;
    this.factions = world.cities.map((c) => c.id);
    this.playerFaction = world.cities.find((c) => c.isPlayerHome)?.id ?? this.factions[0];

    let startIndex = this.factions.indexOf(this.playerFaction);
    if (startIndex < 0) startIndex = 0;
    this.activeFactionIndex = startIndex;

    this.turnNumber = 1;
    this.resetMovementPoints();
  }

  // ─── Faction helpers ────────────────────────────────────────────────────

  /** Returns the ownerId of the currently active faction. */
  getActiveFaction(): string {
    return this.factions[this.activeFactionIndex];
  }

  /** Returns the player's faction id. */
  getPlayerFaction(): string {
    return this.playerFaction;
  }

  /** Returns all faction ids in order. */
  getFactions(): string[] {
    return this.factions;
  }

  /** Whether it is currently the player's turn. */
  isPlayerTurn(): boolean {
    return this.getActiveFaction() === this.playerFaction;
  }

  // ─── Movement point helpers ─────────────────────────────────────────────

  /** Initialise MP for all units from their attributes. */
  resetMovementPoints(): void {
    this.movementPoints.clear();
    this.actedUnits.clear();
    this.sleepingUnits.clear();
    for (const unit of this.world.units) {
      this.movementPoints.set(unit.id, this.getMaxMovement(unit));
    }
    dbg.localMap.log('TurnManager: movement points reset for', this.world.units.length, 'units');
  }

  /** Get the maximum movement points for a unit (best of its movement attributes). */
  private getMaxMovement(unit: UnitData): number {
    return sharedGetMaxMovement(unit.attributes);
  }

  /** Get the remaining movement points for a unit. */
  getMovementPoints(unitId: string): number {
    return this.movementPoints.get(unitId) ?? 0;
  }

  /** Whether a unit still has movement points remaining. */
  canMove(unitId: string): boolean {
    return this.getMovementPoints(unitId) > 0;
  }

  /** Whether a unit can still take an action (attack or repair) this turn. */
  canAct(unitId: string): boolean {
    return !this.actedUnits.has(unitId) && this.getMovementPoints(unitId) >= 1;
  }

  /** Deduct MP spent by a move. */
  recordMove(unitId: string, mpSpent: number): void {
    const current = this.getMovementPoints(unitId);
    this.movementPoints.set(unitId, Math.max(0, current - mpSpent));
  }

  /** Record that a unit has used its action this turn and drain its MP. */
  recordAction(unitId: string): void {
    this.actedUnits.add(unitId);
    this.movementPoints.set(unitId, 0);
  }

  // ─── Sleep helpers ──────────────────────────────────────────────────────

  /** Put a unit to sleep (it won't trigger the "are you sure?" check). */
  sleepUnit(unitId: string): void {
    this.sleepingUnits.add(unitId);
  }

  /** Wake a unit (undo sleep). */
  wakeUnit(unitId: string): void {
    this.sleepingUnits.delete(unitId);
  }

  /** Whether a unit is sleeping. */
  isSleeping(unitId: string): boolean {
    return this.sleepingUnits.has(unitId);
  }

  /**
   * Returns player units that still have MP >= 1 remaining and are NOT sleeping.
   * Used by the "are you sure?" confirmation check.
   */
  getUnmovedAwakeUnits(): UnitData[] {
    const playerFaction = this.getPlayerFaction();
    return this.world.units.filter((u) =>
      u.ownerId === playerFaction &&
      (this.movementPoints.get(u.id) ?? 0) >= 1 &&
      !this.sleepingUnits.has(u.id)
    );
  }

  // ─── Turn advancement ───────────────────────────────────────────────────

  /**
   * End the current turn: reset MP, actedUnits, selectedUnits; advance faction.
   * Call this once all AI factions have completed their turns and the player
   * faction is restored.
   */
  endTurn(): void {
    dbg.localMap.log('TurnManager: endTurn — resetting state for new player turn');
    this.selectedUnits.clear();
    this.resetMovementPoints();
  }

  // ─── World sync ─────────────────────────────────────────────────────────

  /**
   * Call after combat mutates units (e.g. after resolveAttack returns updated
   * units and world.units is replaced).  Re-initialises MP for any new units
   * and removes entries for destroyed ones.
   */
  onWorldUpdated(world: WorldData): void {
    this.world = world;
    // Add MP entries for any units that don't have one yet (newly spawned).
    for (const unit of world.units) {
      if (!this.movementPoints.has(unit.id)) {
        this.movementPoints.set(unit.id, this.getMaxMovement(unit));
      }
    }
    // Remove stale entries for destroyed units.
    const liveIds = new Set(world.units.map((u) => u.id));
    for (const id of this.movementPoints.keys()) {
      if (!liveIds.has(id)) this.movementPoints.delete(id);
    }
    for (const id of this.actedUnits) {
      if (!liveIds.has(id)) this.actedUnits.delete(id);
    }
  }
}
