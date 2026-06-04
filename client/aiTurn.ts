/**
 * AI Turn — simple placeholder logic for enemy factions.
 *
 * Strategy: each unit advances toward the nearest competitor unit
 * and attacks whenever in range.
 *
 * All moves/attacks go through the same server endpoint as the player
 * (via CombatPanel) so the rules stay consistent.
 *
 * The AiPlaybackController gates each action so the player can follow
 * along in Play mode, or step through manually in Paused mode.
 */

import { WorldData, UnitData, TileData } from './worldData.js';
import { CombatPanel } from './combatPanel.js';
import { AiPlaybackController } from './aiPlayback.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { getMovementMode, hexEntryCost } from '../shared/movementConstants.js';

// ---------------------------------------------------------------------------
// Callback types for visual feedback during AI turns
// ---------------------------------------------------------------------------

export interface AiTurnCallbacks {
  /** Highlight attacker and target on the map before the attack resolves. */
  highlightCombat(attackerId: string, targetId: string): void;
  /** Clear any combat highlight. */
  clearHighlight(): void;
  /** Re-render the local map (after movement/attacks). */
  renderMap(): void;
  /** Play the attack animation (missile → explosion → smoke). */
  playAttackAnimation(
    attackerId: string,
    targetId: string,
    factionColor: string,
    damage: number,
    targetDestroyed: boolean,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Lightweight client-side pathfinding (BFS on tile neighbours)
// ---------------------------------------------------------------------------

/** BFS distance between two tiles. Returns -1 if unreachable. */
function bfsDistance(tiles: TileData[], from: number, to: number): number {
  if (from === to) return 0;
  const visited = new Set<number>();
  const queue: [number, number][] = [[from, 0]];
  visited.add(from);

  let head = 0;
  while (head < queue.length) {
    const [current, dist] = queue[head++];
    for (const nb of tiles[current].n) {
      if (nb === to) return dist + 1;
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([nb, dist + 1]);
      }
    }
  }
  return -1;
}

/**
 * BFS shortest path from `from` to `to`. Returns tile index array
 * including both endpoints, or null if unreachable.
 * Avoids tiles occupied by other units (except the destination).
 */
function findPath(
  tiles: TileData[],
  from: number,
  to: number,
  occupiedTiles: Set<number>,
): number[] | null {
  if (from === to) return [from];

  const visited = new Set<number>();
  const parent = new Map<number, number>();
  const queue: number[] = [from];
  visited.add(from);

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const nb of tiles[current].n) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      parent.set(nb, current);

      if (nb === to) {
        // Reconstruct path
        const path: number[] = [nb];
        let step = nb;
        while (parent.has(step)) {
          step = parent.get(step)!;
          path.unshift(step);
        }
        return path;
      }

      // Don't pathfind through occupied tiles (but allow destination)
      if (!occupiedTiles.has(nb)) {
        queue.push(nb);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI turn execution
// ---------------------------------------------------------------------------

/**
 * Execute a single AI faction's turn.
 * Moves units toward nearest enemies and attacks when in range.
 * Uses the playback controller to pace actions visually.
 */
export async function executeAiTurn(
  world: WorldData,
  factionId: string,
  combatPanel: CombatPanel,
  playback: AiPlaybackController,
  callbacks: AiTurnCallbacks,
): Promise<void> {
  const aliveUnits = world.units.filter(
    (u) => u.ownerId === factionId && u.currentHealth > 0,
  );
  const enemies = world.units.filter(
    (u) => u.ownerId !== factionId && u.currentHealth > 0,
  );

  if (aliveUnits.length === 0 || enemies.length === 0) return;

  // Set the combat panel's active faction so server accepts AI actions
  combatPanel.setActiveFaction(factionId);

  // Build a set of occupied tile indices (for pathfinding avoidance)
  const occupiedTiles = new Set<number>();
  for (const u of world.units) {
    if (u.currentHealth > 0) occupiedTiles.add(u.tileIndex);
  }

  for (const unit of aliveUnits) {
    // Skip dead units (may have died from splash during this turn)
    if (unit.currentHealth <= 0) continue;

    // Refresh enemy list (some may have been destroyed this turn)
    const currentEnemies = world.units.filter(
      (u) => u.ownerId !== factionId && u.currentHealth > 0,
    );
    if (currentEnemies.length === 0) break;

    // Find nearest enemy by BFS distance
    let nearestEnemy: UnitData | null = null;
    let nearestDist = Infinity;

    for (const enemy of currentEnemies) {
      const dist = bfsDistance(world.tiles, unit.tileIndex, enemy.tileIndex);
      if (dist >= 0 && dist < nearestDist) {
        nearestDist = dist;
        nearestEnemy = enemy;
      }
    }

    if (!nearestEnemy) continue;

    // Determine unit's movement budget and attack range
    const movement = getMovement(unit);
    const attackRange = getAttackRange(unit);

    // If already in attack range, attack immediately
    if (nearestDist <= attackRange && nearestDist > 0) {
      dbg.input.log(`AI ${unit.label} attacks ${nearestEnemy.label} (dist=${nearestDist})`);

      // Highlight and wait for player to acknowledge
      callbacks.highlightCombat(unit.id, nearestEnemy.id);
      callbacks.renderMap();
      await playback.waitForNext();

      // Capture pre-attack health for damage calculation
      const targetHealthBefore = nearestEnemy.currentHealth;
      const updated = await combatPanel.resolveAttack(unit.id, nearestEnemy.id);
      if (updated) {
        // Calculate damage and destruction before syncing state
        const newTarget = updated.find((u) => u.id === nearestEnemy.id);
        const damage = newTarget
          ? targetHealthBefore - newTarget.currentHealth
          : targetHealthBefore;
        const targetDestroyed = newTarget ? newTarget.currentHealth <= 0 : true;
        const color = factionColor(world, unit.ownerId);

        // Play attack animation (missile → explosion → smoke)
        await callbacks.playAttackAnimation(unit.id, nearestEnemy.id, color, damage, targetDestroyed);

        world.units = updated;
      }
      callbacks.clearHighlight();
      callbacks.renderMap();
      playback.recordSnapshot();
      continue;
    }

    // Move toward nearest enemy
    if (movement > 0 && nearestDist > 1) {
      // Remove our own tile from occupied so we can path out of it
      occupiedTiles.delete(unit.tileIndex);

      const path = findPath(world.tiles, unit.tileIndex, nearestEnemy.tileIndex, occupiedTiles);

      if (path && path.length > 1) {
        // Calculate affordable steps considering terrain costs, reserving 1 MP for attack
        const stepsWithAttack = affordableSteps(world.tiles, path, unit, true);
        // Don't step onto the enemy's tile
        const maxSteps = Math.min(path.length - 2, stepsWithAttack > 0 ? stepsWithAttack : affordableSteps(world.tiles, path, unit, false));
        const movePath = path.slice(0, maxSteps + 1); // include start tile

        if (movePath.length >= 2) {
          dbg.input.log(
            `AI ${unit.label} moves ${movePath.length - 1} steps toward ${nearestEnemy.label}`,
          );

          // Wait before move so player sees the unit about to act
          await playback.waitForNext();

          const updated = await combatPanel.resolveMove(unit.id, movePath);
          if (updated) {
            world.units = updated;
            // Update occupied tiles
            occupiedTiles.add(movePath[movePath.length - 1]);
          }
          callbacks.renderMap();
          playback.recordSnapshot();

          // After moving, check if now in attack range AND we have MP remaining for attack
          const newDist = bfsDistance(
            world.tiles,
            movePath[movePath.length - 1],
            nearestEnemy.tileIndex,
          );
          // Can attack if we moved stepsWithAttack steps (reserved 1 MP)
          const canStillAttack = (movePath.length - 1) <= stepsWithAttack;
          if (canStillAttack && newDist > 0 && newDist <= attackRange) {
            // Re-check enemy is still alive
            const target = world.units.find(
              (u) => u.id === nearestEnemy!.id && u.currentHealth > 0,
            );
            if (target) {
              dbg.input.log(`AI ${unit.label} attacks after moving`);
              callbacks.highlightCombat(unit.id, target.id);
              callbacks.renderMap();
              await playback.waitForNext();

              const targetHpBefore = target.currentHealth;
              const updated2 = await combatPanel.resolveAttack(unit.id, target.id);
              if (updated2) {
                const newTgt = updated2.find((u) => u.id === target.id);
                const dmg = newTgt ? targetHpBefore - newTgt.currentHealth : targetHpBefore;
                const destroyed = newTgt ? newTgt.currentHealth <= 0 : true;
                const clr = factionColor(world, unit.ownerId);

                await callbacks.playAttackAnimation(unit.id, target.id, clr, dmg, destroyed);

                world.units = updated2;
              }
              callbacks.clearHighlight();
              callbacks.renderMap();
              playback.recordSnapshot();
            }
          }
        } else {
          // Can't move meaningfully, re-add to occupied
          occupiedTiles.add(unit.tileIndex);
        }
      } else {
        // No path found, re-add to occupied
        occupiedTiles.add(unit.tileIndex);
      }
    }
  }

  callbacks.clearHighlight();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best movement budget across all movement types. */
function getMovement(unit: UnitData): number {
  const a = unit.attributes;
  return Math.max(
    a.wheeledMovement ?? 0,
    a.limbMovement ?? 0,
    a.flightMovement ?? 0,
  );
}

/**
 * Compute how many steps along a path the unit can afford, reserving
 * 1 MP for attack if wantAttack is true.
 */
function affordableSteps(
  tiles: TileData[],
  path: number[],
  unit: UnitData,
  wantAttack: boolean,
): number {
  const totalMP = getMovement(unit);
  const mode = getMovementMode(unit.attributes);
  const reserve = wantAttack ? 1 : 0;
  let spent = 0;
  let steps = 0;

  for (let i = 1; i < path.length; i++) {
    const isFirst = (i - 1) === 0;
    const cost = hexEntryCost(tiles[path[i]], mode, isFirst);
    if (cost === Infinity) break;
    spent += cost;
    if (spent + reserve > totalMP) break;
    steps++;
  }
  return steps;
}

/** Effective attack range (ranged or melee). */
function getAttackRange(unit: UnitData): number {
  const range = unit.attributes.rangeAttack ?? 0;
  const melee = unit.attributes.kinetic ?? 0;
  return Math.max(range, melee > 0 ? 1 : 0);
}
