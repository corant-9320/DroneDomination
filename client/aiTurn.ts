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
import { isTargetInRange, weaponRangeFromAttributes, RangeTile } from '../shared/rangeCheck.js';
import { AiPlaybackController } from './aiPlayback.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { getMovementMode, segmentCost } from '../shared/movementConstants.js';

// ---------------------------------------------------------------------------
// Callback types for visual feedback during AI turns
// ---------------------------------------------------------------------------

export interface AiTurnCallbacks {
  /** Highlight attacker and target on the map before the attack resolves. */
  highlightCombat(attackerId: string, targetId: string): void;
  /** Clear any combat highlight. */
  clearHighlight(): void;
  /**
   * Select the currently-acting AI unit so the detail/combat panels show its
   * hex and unit info (mirrors a player click before they move or attack).
   */
  selectActingUnit(unitId: string): void;
  /**
   * Show a combat preview (attacker vs target) in the panels before an attack
   * resolves, matching the player's hover-to-preview behaviour.
   */
  showCombatPreview(attackerId: string, targetId: string): void;
  /** Re-render the local map (after movement/attacks). */
  renderMap(): void;
  /** Play the attack animation (missile → explosion → smoke). */
  playAttackAnimation(
    attackerId: string,
    targetId: string,
    factionColor: string,
    damage: number,
    targetDestroyed: boolean,
    splashVictims?: Array<{ unitId: string; damage: number; destroyed: boolean }>,
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
// RangeTile adapter
// ---------------------------------------------------------------------------

/**
 * Adapt client TileData[] to the RangeTile[] interface expected by
 * shared/rangeCheck.ts so the AI can use the exact same range check as the
 * server before committing an attack.
 */
function toRangeTiles(tiles: TileData[]): RangeTile[] {
  return tiles.map((t) => ({
    pos: t.pos,
    boundary: t.b,
    neighbours: t.n,
    sides: t.s,
  }));
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

  // Build RangeTile adapter once — used for server-accurate range checks
  const rangeTiles = toRangeTiles(world.tiles);

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

    // If already in attack range, attack immediately.
    // Use BFS hops as a cheap pre-filter, then confirm with the exact
    // segment-distance check (same formula as the server) so we never fire
    // an attack the server will reject as "out of range".
    const inRangeNow =
      nearestDist <= attackRange &&
      nearestDist > 0 &&
      isTargetInRange(rangeTiles,
        { tileIndex: unit.tileIndex, segment: unit.segment, rangeAttack: unit.attributes.rangeAttack ?? 0, hasWeapon: attackRange > 0 },
        { tileIndex: nearestEnemy.tileIndex, segment: nearestEnemy.segment },
      );
    if (inRangeNow) {
      dbg.input.log(`AI ${unit.label} attacks ${nearestEnemy.label} (dist=${nearestDist})`);

      // Show the acting unit + combat preview in the panels, highlight, then wait
      callbacks.selectActingUnit(unit.id);
      callbacks.showCombatPreview(unit.id, nearestEnemy.id);
      callbacks.highlightCombat(unit.id, nearestEnemy.id);
      callbacks.renderMap();
      await playback.waitForNext();

      // Capture pre-attack health for damage calculation
      const targetHealthBefore = nearestEnemy.currentHealth;
      const updated = await combatPanel.resolveAttack(unit.id, nearestEnemy.id);
      if (updated) {
        // Calculate damage and destruction before syncing state
        const { units, combat } = updated;
        const newTarget = units.find((u) => u.id === nearestEnemy.id);
        const damage = newTarget
          ? targetHealthBefore - newTarget.currentHealth
          : targetHealthBefore;
        const targetDestroyed = newTarget ? newTarget.currentHealth <= 0 : true;
        const color = factionColor(world, unit.ownerId);

        // Build splash victim list from the ExplainedCombat splash array
        const splashVictims = combat.splash
          .filter((s) => s.victimId !== nearestEnemy.id)
          .map((s) => ({ unitId: s.victimId, damage: s.damage, destroyed: s.victimDestroyed }));

        // Play attack animation (missile → explosions → smoke)
        await callbacks.playAttackAnimation(unit.id, nearestEnemy.id, color, damage, targetDestroyed, splashVictims);

        world.units = units;
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

          // Select the acting unit so the panels show its hex/unit info,
          // then wait before the move so the player sees it about to act
          callbacks.selectActingUnit(unit.id);
          callbacks.renderMap();
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
          // Confirm with the exact segment-distance check after move so the
          // decision matches the server.  The unit is now at the end of movePath;
          // we need its new segment (arrival side of the last step).
          const movedUnit = world.units.find((u) => u.id === unit.id);
          const inRangeAfterMove =
            canStillAttack &&
            newDist > 0 &&
            newDist <= attackRange &&
            movedUnit != null &&
            isTargetInRange(rangeTiles,
              { tileIndex: movedUnit.tileIndex, segment: movedUnit.segment, rangeAttack: movedUnit.attributes.rangeAttack ?? 0, hasWeapon: attackRange > 0 },
              { tileIndex: nearestEnemy.tileIndex, segment: nearestEnemy.segment },
            );
          if (inRangeAfterMove) {
            // Re-check enemy is still alive
            const target = world.units.find(
              (u) => u.id === nearestEnemy!.id && u.currentHealth > 0,
            );
            if (target) {
              dbg.input.log(`AI ${unit.label} attacks after moving`);
              callbacks.selectActingUnit(unit.id);
              callbacks.showCombatPreview(unit.id, target.id);
              callbacks.highlightCombat(unit.id, target.id);
              callbacks.renderMap();
              await playback.waitForNext();

              const targetHpBefore = target.currentHealth;
              const updated2 = await combatPanel.resolveAttack(unit.id, target.id);
              if (updated2) {
                const { units: units2, combat: combat2 } = updated2;
                const newTgt = units2.find((u) => u.id === target.id);
                const dmg = newTgt ? targetHpBefore - newTgt.currentHealth : targetHpBefore;
                const destroyed = newTgt ? newTgt.currentHealth <= 0 : true;
                const clr = factionColor(world, unit.ownerId);

                const splashVictims2 = combat2.splash
                  .filter((s) => s.victimId !== target.id)
                  .map((s) => ({ unitId: s.victimId, damage: s.damage, destroyed: s.victimDestroyed }));

                await callbacks.playAttackAnimation(unit.id, target.id, clr, dmg, destroyed, splashVictims2);

                world.units = units2;
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
 * Uses segment-based cost model.
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
  let currentSegment = unit.segment;

  for (let i = 1; i < path.length; i++) {
    // Intra-hex traversal to departure segment
    const departureSeg = tiles[path[i - 1]].n.indexOf(path[i]);
    const departure = departureSeg >= 0 ? departureSeg : 0;
    const diff = Math.abs(currentSegment - departure);
    const pivotSteps = Math.min(diff, 6 - diff);
    const pivotStepCost = segmentCost(tiles[path[i - 1]], mode);
    if (pivotStepCost === Infinity) break;
    spent += pivotSteps * pivotStepCost;
    if (spent + reserve > totalMP) break;

    // Cross border
    const crossCost = segmentCost(tiles[path[i]], mode);
    if (crossCost === Infinity) break;
    spent += crossCost;
    if (spent + reserve > totalMP) break;

    // Arrival segment in the new hex
    const arrivalSeg = tiles[path[i]].n.indexOf(path[i - 1]);
    currentSegment = (arrivalSeg >= 0 ? arrivalSeg : 0) as UnitData['segment'];
    steps++;
  }
  return steps;
}

/** 
 * Effective attack range in BFS hops (conservative heuristic for AI targeting).
 * Uses the shared range formula so client and server agree.
 */
function getAttackRange(unit: UnitData): number {
  return weaponRangeFromAttributes(unit.attributes);
}
