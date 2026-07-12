/**
 * Server-authoritative AI turn resolver (Phase 1 of the server-authority
 * roadmap — see DECISIONS.md 2026-06-29).
 *
 * Resolves an entire AI faction's turn in one request. The decision logic
 * (target selection, pathfinding, range checks) was previously duplicated on
 * the client in `client/aiTurn.ts`; it now lives here next to the authoritative
 * combat resolution in `src/world/combat.ts`, so the client can no longer
 * fabricate AI outcomes and the whole turn ships/rebuilds the world only once.
 *
 * Framework-agnostic — takes a plain object, returns one. The handler stays a
 * pure snapshot-in / result-out function: it holds no session state. Each AI
 * unit is assumed to begin its turn with full movement (mirroring the previous
 * client behaviour), so no per-unit MP needs to travel over the wire.
 *
 * ── Output ───────────────────────────────────────────────────────────────────
 * An ordered `AiActionEvent[]`, each carrying the post-action world snapshot so
 * the client playback bar can step / rewind / skip without recomputing.
 */

import { Tile } from '../src/world/types.js';
import { Unit, HexSegment } from '../src/world/units.js';
import {
  isDrone,
  resolveAttack,
  resolveReactionFire,
  type CombatContext,
} from '../src/world/combat.js';
import { explainAttack, explainSplash, buildReactionExplanation } from './combatExplainer.js';
import type {
  AiActionEvent,
  AiTurnResponse,
  AiSplashVictim,
} from '../shared/combatTypes.js';
import {
  rebuildTiles,
  rebuildUnits,
  rebuildBuildings,
  toWireUnit,
  toWireBuilding,
  type WireUnit,
  type WireTile,
  type WireBuilding,
} from './combatApi.js';
import {
  isTargetInRange,
  weaponRangeFromAttributes,
  type RangeTile,
} from '../shared/rangeCheck.js';
import { graphDistance, findPath as sharedFindPath, type PathTile } from '../shared/pathfinding.js';
import { getMovementMode, segmentCost } from '../shared/movementConstants.js';
import {
  farthestAffordablePrefix,
  type SegGraphTile,
} from '../shared/segmentGraph.js';

// ---------------------------------------------------------------------------
// Request type
// ---------------------------------------------------------------------------

export interface AiTurnRequest {
  /** The AI faction whose turn to resolve. */
  factionId: string;
  /** All units currently on the board. */
  units: WireUnit[];
  /** Tile adjacency + geometry data (same payload as /api/combat). */
  tiles: WireTile[];
  /** Buildings on the board. */
  buildings?: WireBuilding[];
}

/** Request for /api/building-turn: auto-fire all of one faction's buildings. */
export interface BuildingTurnRequest {
  factionId: string;
  units: WireUnit[];
  tiles: WireTile[];
  buildings?: WireBuilding[];
}

// ---------------------------------------------------------------------------
// Tile adapters (server Tile → shared minimal interfaces)
// ---------------------------------------------------------------------------

function toPathTiles(tiles: Tile[]): PathTile[] {
  return tiles.map((t) => ({
    neighbours: t.neighbours,
    pos: [t.position3d.x, t.position3d.y, t.position3d.z] as [number, number, number],
  }));
}

function toRangeTiles(tiles: Tile[]): RangeTile[] {
  return tiles.map((t) => ({
    pos: [t.position3d.x, t.position3d.y, t.position3d.z] as [number, number, number],
    boundary: t.boundary.map((v) => [v.x, v.y, v.z] as [number, number, number]),
    neighbours: t.neighbours,
    sides: t.sides,
  }));
}

// ---------------------------------------------------------------------------
// Movement helpers (ported from client/aiTurn.ts)
// ---------------------------------------------------------------------------

/** Best movement budget across all movement types. */
function getMovement(unit: Unit): number {
  const a = unit.attributes;
  return Math.max(a.wheeledMovement ?? 0, a.limbMovement ?? 0, a.flightMovement ?? 0);
}

/** Effective attack range in BFS hops (cheap targeting heuristic). */
function getAttackRange(unit: Unit): number {
  return weaponRangeFromAttributes(unit.attributes);
}

/** BFS distance via shared pathfinding. */
function bfsDistance(pathTiles: PathTile[], from: number, to: number): number {
  return graphDistance(pathTiles, from, to);
}

/**
 * BFS shortest path avoiding occupied tiles (except the destination).
 * Mirrors client/aiTurn.ts findPath.
 */
function findPath(
  pathTiles: PathTile[],
  from: number,
  to: number,
  occupiedTiles: Set<number>,
): number[] | null {
  const idxMap = new Map<object, number>();
  for (let i = 0; i < pathTiles.length; i++) idxMap.set(pathTiles[i], i);

  return sharedFindPath(pathTiles, from, to, (tile) => {
    const idx = idxMap.get(tile);
    if (idx === undefined) return 1;
    if (idx === to) return 1;
    if (occupiedTiles.has(idx)) return Infinity;
    return 1;
  });
}

/**
 * Adapter: exposes SegGraphTile shape for the server Tile type so the shared
 * segmentGraph primitives work without any type divergence.
 */
interface ServerSegGraphTile extends SegGraphTile {
  original: Tile;
}

function toServerSegGraphTiles(tiles: Tile[]): ServerSegGraphTile[] {
  return tiles.map((t) => ({ sides: t.sides, neighbours: t.neighbours, original: t }));
}

/**
 * How many steps along a path the unit can afford, reserving 1 MP for an
 * attack when wantAttack is true. Segment-based, occupancy-gated (B5).
 * Uses farthestAffordablePrefix from shared/segmentGraph.ts to mirror the
 * client/aiTurn.ts logic on the same shared primitive.
 */
function affordableSteps(tiles: Tile[], path: number[], unit: Unit, wantAttack: boolean): number {
  const totalMP = getMovement(unit);
  const mode = getMovementMode(unit.attributes);
  const reserve = wantAttack ? 1 : 0;
  const segGraphTiles = toServerSegGraphTiles(tiles);

  const r = farthestAffordablePrefix(
    segGraphTiles,
    { tileIndex: unit.tileIndex, segment: unit.segment },
    path,
    (tile, segment) => segmentCost(tile.original, segment, mode),
    (_t, _s) => false, // tile-level occupied set handles gross avoidance; segment-level here
    totalMP - reserve,
  );
  return r.tileCount - 1;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function aliveWireUnits(ctx: CombatContext): WireUnit[] {
  return ctx.units.filter((u) => u.currentHealth > 0).map(toWireUnit);
}

// ---------------------------------------------------------------------------
// Attack resolution → event
// ---------------------------------------------------------------------------

/**
 * Resolve one attack (attacker → target) and produce the AiActionEvent for it.
 * Mirrors server/combatApi.ts handleAttack: explain before, resolve, patch
 * after-state into the explanation.
 */
function resolveAttackEvent(
  attacker: Unit,
  target: Unit,
  ctx: CombatContext,
): AiActionEvent<WireUnit> {
  const targetHealthBefore = target.currentHealth;

  const explained = explainAttack(attacker, target, ctx);
  const result = resolveAttack(attacker.id, target.id, ctx);

  explained.targetHealthAfter = target.currentHealth;
  explained.targetDestroyed = target.currentHealth <= 0;
  explained.destroyedUnitIds = result.destroyedUnitIds;
  explained.splash = explainSplash(attacker, target, result, ctx);
  explained.buildingDamage = result.buildingDamage.map((ev) => ({
    buildingId: ev.buildingId,
    component: ev.component,
    newValue: ev.newValue,
    destroyed: ev.destroyed,
  }));

  const splashVictims: AiSplashVictim[] = explained.splash
    .filter((s) => s.victimId !== target.id)
    .map((s) => ({ unitId: s.victimId, damage: s.damage, destroyed: s.victimDestroyed }));

  const buildingsChanged = result.buildingDamage.length > 0;

  return {
    kind: 'attack',
    unitId: attacker.id,
    factionId: attacker.ownerId,
    targetId: target.id,
    damage: targetHealthBefore - target.currentHealth,
    targetDestroyed: target.currentHealth <= 0,
    splashVictims,
    combats: [explained],
    reactions: [],
    buildingDamage: explained.buildingDamage,
    units: aliveWireUnits(ctx),
    buildings: buildingsChanged ? ctx.buildings.map(toWireBuilding) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Move resolution → event
// ---------------------------------------------------------------------------

/**
 * Walk a unit along a path. Ground units update position/facing with no
 * reaction fire; drones trigger Anti-Air reaction fire along the path (§16),
 * exactly as server/combatApi.ts handleMove does.
 */
function resolveMoveEvent(
  mover: Unit,
  path: number[],
  ctx: CombatContext,
): AiActionEvent<WireUnit> {
  const fromTile = mover.tileIndex;
  const fromSegment = mover.segment as number;
  const { tiles } = ctx;

  const reactions: AiActionEvent<WireUnit>['reactions'] = [];

  if (isDrone(mover)) {
    const reactionResults = resolveReactionFire(mover.id, path, ctx);
    for (const r of reactionResults) {
      const reactor = ctx.units.find((u) => u.id === r.attackerId)
        ?? ctx.buildings.find((b) => b.id === r.attackerId);
      const drone = ctx.units.find((u) => u.id === r.targetId);
      reactions.push(buildReactionExplanation(r, reactor, drone));
    }
  } else {
    for (let i = 1; i < path.length; i++) {
      const prevHex = path[i - 1];
      const currentHex = path[i];
      mover.tileIndex = currentHex;
      const dir = tiles[prevHex].neighbours.indexOf(currentHex);
      if (dir !== -1) mover.facing = dir as HexSegment;
    }
  }

  return {
    kind: 'move',
    unitId: mover.id,
    factionId: mover.ownerId,
    fromTile,
    fromSegment,
    path,
    combats: [],
    reactions,
    units: aliveWireUnits(ctx),
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Resolve a full AI faction turn. Returns an ordered event log plus the final
 * authoritative world state.
 */
export function handleAiTurn(req: AiTurnRequest): AiTurnResponse<WireUnit> {
  const { factionId } = req;
  console.log('[DD][ai-turn] resolving faction=%s', factionId);

  const ctx: CombatContext = {
    units: rebuildUnits(req.units),
    tiles: rebuildTiles(req.tiles),
    buildings: rebuildBuildings(req.buildings ?? []),
  };

  const pathTiles = toPathTiles(ctx.tiles);
  const rangeTiles = toRangeTiles(ctx.tiles);

  const events: AiActionEvent<WireUnit>[] = [];

  const aliveUnits = ctx.units.filter((u) => u.ownerId === factionId && u.currentHealth > 0);
  const enemiesExist = ctx.units.some((u) => u.ownerId !== factionId && u.currentHealth > 0);

  if (aliveUnits.length === 0 || !enemiesExist) {
    return { success: true, events: [], finalUnits: aliveWireUnits(ctx), finalBuildings: ctx.buildings.map(toWireBuilding) };
  }

  // Occupied-tile set for pathfinding avoidance.
  const occupiedTiles = new Set<number>();
  for (const u of ctx.units) {
    if (u.currentHealth > 0) occupiedTiles.add(u.tileIndex);
  }

  for (const unit of aliveUnits) {
    if (unit.currentHealth <= 0) continue;

    const currentEnemies = ctx.units.filter((u) => u.ownerId !== factionId && u.currentHealth > 0);
    if (currentEnemies.length === 0) break;

    // Nearest enemy by BFS distance.
    let nearestEnemy: Unit | null = null;
    let nearestDist = Infinity;
    for (const enemy of currentEnemies) {
      const dist = bfsDistance(pathTiles, unit.tileIndex, enemy.tileIndex);
      if (dist >= 0 && dist < nearestDist) {
        nearestDist = dist;
        nearestEnemy = enemy;
      }
    }
    if (!nearestEnemy) continue;

    const movement = getMovement(unit);
    const attackRange = getAttackRange(unit);

    // Already in range → attack immediately.
    const inRangeNow =
      nearestDist <= attackRange &&
      nearestDist > 0 &&
      isTargetInRange(
        rangeTiles,
        { tileIndex: unit.tileIndex, segment: unit.segment, rangeAttack: unit.attributes.rangeAttack ?? 0, hasWeapon: attackRange > 0 },
        { tileIndex: nearestEnemy.tileIndex, segment: nearestEnemy.segment },
      );

    if (inRangeNow) {
      events.push(resolveAttackEvent(unit, nearestEnemy, ctx));
      continue;
    }

    // Otherwise move toward the nearest enemy.
    if (movement > 0 && nearestDist > 1) {
      occupiedTiles.delete(unit.tileIndex);

      const path = findPath(pathTiles, unit.tileIndex, nearestEnemy.tileIndex, occupiedTiles);

      if (path && path.length > 1) {
        const stepsWithAttack = affordableSteps(ctx.tiles, path, unit, true);
        const maxSteps = Math.min(
          path.length - 2,
          stepsWithAttack > 0 ? stepsWithAttack : affordableSteps(ctx.tiles, path, unit, false),
        );
        const movePath = path.slice(0, maxSteps + 1);

        if (movePath.length >= 2) {
          events.push(resolveMoveEvent(unit, movePath, ctx));
          occupiedTiles.add(movePath[movePath.length - 1]);

          // After moving, attack if now in range and an attack step was reserved.
          const newDist = bfsDistance(pathTiles, movePath[movePath.length - 1], nearestEnemy.tileIndex);
          const canStillAttack = movePath.length - 1 <= stepsWithAttack;
          const inRangeAfterMove =
            canStillAttack &&
            newDist > 0 &&
            newDist <= attackRange &&
            unit.currentHealth > 0 &&
            isTargetInRange(
              rangeTiles,
              { tileIndex: unit.tileIndex, segment: unit.segment, rangeAttack: unit.attributes.rangeAttack ?? 0, hasWeapon: attackRange > 0 },
              { tileIndex: nearestEnemy.tileIndex, segment: nearestEnemy.segment },
            );

          if (inRangeAfterMove) {
            const target = ctx.units.find((u) => u.id === nearestEnemy!.id && u.currentHealth > 0);
            if (target) {
              events.push(resolveAttackEvent(unit, target, ctx));
            }
          }
        } else {
          occupiedTiles.add(unit.tileIndex);
        }
      } else {
        occupiedTiles.add(unit.tileIndex);
      }
    }
  }

  return {
    success: true,
    events,
    finalUnits: aliveWireUnits(ctx),
    finalBuildings: ctx.buildings.map(toWireBuilding),
  };
}

// ---------------------------------------------------------------------------
// Building auto-fire turn (all factions, including the player's)
// ---------------------------------------------------------------------------

/**
 * Auto-fire all buildings belonging to `factionId` that have a weapon and a
 * valid enemy target in range. Returns an ordered event log identical in shape
 * to handleAiTurn events so the client can replay them through the same
 * playback bar.
 *
 * Each building fires at most once per call (one shot per turn). Targeting:
 * nearest enemy unit by BFS distance that is within the building's segment
 * range threshold. If multiple enemies tie for nearest, the first one wins.
 *
 * Buildings are static — they never move. The synthetic attacker pattern
 * mirrors matchApi.ts applyBuildingAttackUnitIntent.
 */
export function handleBuildingTurn(req: BuildingTurnRequest): AiTurnResponse<WireUnit> {
  const { factionId } = req;
  console.log('[DD][building-turn] resolving faction=%s', factionId);

  const ctx: CombatContext = {
    units: rebuildUnits(req.units),
    tiles: rebuildTiles(req.tiles),
    buildings: rebuildBuildings(req.buildings ?? []),
  };

  const rangeTiles = toRangeTiles(ctx.tiles);
  const pathTiles = toPathTiles(ctx.tiles);

  const events: AiActionEvent<WireUnit>[] = [];

  // Only buildings belonging to this faction that have at least one offensive attribute.
  const ownBuildings = ctx.buildings.filter(
    (b) => b.ownerId === factionId && hasWeaponAttributes(b.attributes),
  );

  if (ownBuildings.length === 0) {
    return { success: true, events: [], finalUnits: aliveWireUnits(ctx), finalBuildings: ctx.buildings.map(toWireBuilding) };
  }

  for (const building of ownBuildings) {
    // Find all living enemy units.
    const enemies = ctx.units.filter((u) => u.ownerId !== factionId && u.currentHealth > 0);
    if (enemies.length === 0) break;

    // Synthetic attacker mirroring applyBuildingAttackUnitIntent in matchApi.ts.
    const attrs = building.attributes ?? {};
    const syntheticAttacker: Unit = {
      id: building.id,
      label: `Building #${building.id.replace(/^building_/, '')}`,
      ownerId: building.ownerId,
      tileIndex: building.tileIndex,
      segment: building.segment as HexSegment,
      facing: building.segment as HexSegment,
      attributes: { ...attrs, size: (attrs.size ?? 1) },
      currentHealth: ((attrs.size ?? 1) as number) * 10,
    };

    const attackRange = weaponRangeFromAttributes(syntheticAttacker.attributes);

    // Pick the nearest enemy in range.
    let target: Unit | null = null;
    let nearestDist = Infinity;
    for (const enemy of enemies) {
      const dist = bfsDistance(pathTiles, building.tileIndex, enemy.tileIndex);
      if (dist < nearestDist && dist <= attackRange && isTargetInRange(
        rangeTiles,
        { tileIndex: building.tileIndex, segment: building.segment, rangeAttack: attrs.rangeAttack ?? 0, hasWeapon: true },
        { tileIndex: enemy.tileIndex, segment: enemy.segment },
      )) {
        nearestDist = dist;
        target = enemy;
      }
    }
    if (!target) continue;

    // Inject synthetic attacker so resolveAttack can find it.
    ctx.units.push(syntheticAttacker);

    // Skip invalid attacks (e.g. an antiAir-only building facing a ground unit).
    const preview = explainAttack(syntheticAttacker, target, ctx);
    if (!preview.wasValid) {
      ctx.units.pop();
      continue;
    }

    const event = resolveAttackEvent(syntheticAttacker, target, ctx);
    ctx.units.pop();

    events.push(event);
  }

  return {
    success: true,
    events,
    finalUnits: aliveWireUnits(ctx),
    finalBuildings: ctx.buildings.map(toWireBuilding),
  };
}

/** Returns true if the building's attributes include at least one offensive stat. */
function hasWeaponAttributes(attrs: import('../../shared/unitTypes.js').UnitAttributes | undefined): boolean {
  if (!attrs) return false;
  return (attrs.kinetic ?? 0) > 0 || (attrs.splashAttack ?? 0) > 0 || (attrs.antiAir ?? 0) > 0;
}
