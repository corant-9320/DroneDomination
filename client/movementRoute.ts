/**
 * movementRoute.ts — Route computation and MovePlan extraction (no canvas drawing).
 *
 * Exports:
 *   RouteHopZone                   — zone classification enum
 *   MovementRouteHop               — single hop in a route
 *   MovementCostRoute              — full route (start + hops)
 *   MovePlan                       — concrete executable move
 *   computeMovementCostRoute       — segment-level Dijkstra to a specific destination
 *   computeContextualAttackRoute   — smart attack routing (3 cases)
 *   computeMovementTowardTile      — route toward an out-of-range tile
 *   computeMovementRouteForDestination — unified route for preview + execution
 *   extractMovePlan                — reduce route → executable MovePlan
 */

import { WorldData, UnitData } from './worldData.js';
import {
  getMovementMode,
  segmentCost as sharedSegmentCost,
} from '../shared/movementConstants.js';
import {
  buildMovementOccupancy,
  encodeSeg,
  findSegmentPath,
  type SegGraphTile,
} from '../shared/segmentGraph.js';
import {
  isTargetInRange,
  hasWeapon,
  segmentDistance as sharedSegmentDistance,
  getRangeThreshold,
} from '../shared/rangeCheck.js';
import { facingFromTravel } from './facing.js';
import {
  getRangeTiles,
  MovementRangeResult,
  weaponRangeInTileHops,
} from './movementRange.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Zone classification for a route hop in the extended overlay.
 * - 'attackReady': movement that preserves ≥1 MP for an attack (green)
 * - 'moveOnly': max movement range, no MP left for attack (blue)
 * - 'weaponRange': beyond movement, within weapon range (red)
 */
export type RouteHopZone = 'attackReady' | 'moveOnly' | 'weaponRange';

/** A single hop in the movement cost route overlay. */
export interface MovementRouteHop {
  tileIndex: number;
  segment: number;
  hopCost: number;
  cumulativeCost: number;
  zone: RouteHopZone;
}

/** Full movement cost route to display as an overlay. */
export interface MovementCostRoute {
  startTile: number;
  startSegment: number;
  hops: MovementRouteHop[];
}

/** A concrete, executable move derived from a movement route. */
export interface MovePlan {
  destTile: number;
  destSegment: number;
  mpCost: number;
  /** New facing implied by the final step, or null for an intra-hex reposition. */
  facing: 0 | 1 | 2 | 3 | 4 | 5 | null;
}

// ─── Route computation ────────────────────────────────────────────────────────

/**
 * BFS outward from `originTile` and return the tile — among `reachable` tiles or
 * the unit's own `ownTile` — closest (fewest hops) to `originTile`, or -1 if none
 * is found within `maxBFS` hops.
 *
 * Shared by toward-routing and contextual attack routing (Case 3): both need the
 * nearest tile the unit can actually stand on, measured outward from a target the
 * unit cannot reach directly. The start node is eligible (checked at hop 0), and
 * ties at equal hop-distance resolve to BFS insertion order.
 */
function nearestReachableTile(
  tiles: { n: number[] }[],
  originTile: number,
  reachable: Map<number, number>,
  ownTile: number,
  maxBFS: number,
): number {
  const seen = new Map<number, number>();
  seen.set(originTile, 0);
  const queue: { idx: number; d: number }[] = [{ idx: originTile, d: 0 }];
  let head = 0;
  let best = -1;
  let bestD = Infinity;

  while (head < queue.length) {
    const { idx, d } = queue[head++];
    if (d >= maxBFS) continue;
    if ((reachable.has(idx) || idx === ownTile) && d < bestD) {
      bestD = d;
      best = idx;
    }
    for (const neighbour of tiles[idx].n) {
      if (seen.has(neighbour)) continue;
      seen.set(neighbour, d + 1);
      queue.push({ idx: neighbour, d: d + 1 });
    }
  }
  return best;
}

/**
 * Append straight-line weapon-range hops onto `hops`, stepping from `fromTile`
 * toward `destTile` by greatest dot-product (great-circle direction) for up to
 * `weaponRange` hops. Weapon fire flies over terrain and enemies, so steps are
 * not movement-cost-gated. Every appended hop carries `cumCost` (weapon hops add
 * no movement cost) and zone 'weaponRange'. Returns the last tile reached
 * (`fromTile` if no hop was taken).
 */
function appendStraightLineWeaponHops(
  hops: MovementRouteHop[],
  tiles: { n: number[]; pos: [number, number, number] }[],
  fromTile: number,
  destTile: number,
  destSegment: number,
  weaponRange: number,
  cumCost: number,
): number {
  const destPos = tiles[destTile].pos;
  let cur = fromTile;
  const visited = new Set<number>([fromTile]);

  for (let hop = 0; hop < weaponRange; hop++) {
    if (cur === destTile) break;

    let bestN = -1;
    let bestDot = -Infinity;
    for (const n of tiles[cur].n) {
      if (visited.has(n) && n !== destTile) continue;
      const p = tiles[n].pos;
      const dot = p[0] * destPos[0] + p[1] * destPos[1] + p[2] * destPos[2];
      if (dot > bestDot) { bestDot = dot; bestN = n; }
    }
    if (bestN < 0) break;

    visited.add(bestN);
    hops.push({
      tileIndex: bestN,
      segment: bestN === destTile ? destSegment : 0,
      hopCost: 0,
      cumulativeCost: cumCost,
      zone: 'weaponRange',
    });
    cur = bestN;
    if (bestN === destTile) break;
  }
  return cur;
}

/**
 * Compute the movement cost route from a selected unit to a destination segment.
 *
 * Uses segment-level Dijkstra where each segment has exactly 3 neighbours:
 *   - Two adjacent segments in the same hex (cost: 0.25 each)
 *   - One segment across the hex border (cost: hex entry cost for that terrain)
 *
 * @param world         Current world data
 * @param unit          The selected unit
 * @param _path         Legacy — unused, kept for API compat
 * @param destSegment   Target segment at the destination tile
 * @param remainingMP   MP remaining for this unit
 * @param destTile      Destination tile index
 * @returns The route, or null if unreachable
 */
export function computeMovementCostRoute(
  world: WorldData,
  unit: UnitData,
  _path: number[] | null,
  destSegment: number,
  remainingMP: number,
  destTile?: number,
): MovementCostRoute | null {
  const targetTile = destTile ?? (_path && _path.length >= 2 ? _path[_path.length - 1] : -1);
  const target = world.tiles[targetTile];
  if (!target || destSegment < 0 || destSegment >= target.s) return null;
  if (unit.tileIndex === targetTile && unit.segment === destSegment) return null;

  const mode = getMovementMode(unit.attributes);
  interface ClientSegTile extends SegGraphTile { original: (typeof world.tiles)[number] }
  const graphTiles: ClientSegTile[] = world.tiles.map((tile) => ({
    sides: tile.s,
    neighbours: tile.n,
    original: tile,
  }));
  const isOccupied = buildMovementOccupancy(world.units, world.buildings, {
    excludeUnitId: unit.id,
  });
  const result = findSegmentPath(
    graphTiles,
    { tileIndex: unit.tileIndex, segment: unit.segment },
    { tileIndex: targetTile, segment: destSegment },
    (tile, segment) => sharedSegmentCost(tile.original, segment, mode),
    isOccupied,
    remainingMP,
  );
  if (!result || result.path.length < 2) return null;

  const hops: MovementRouteHop[] = [];
  let cumulative = 0;
  for (const node of result.path.slice(1)) {
    const hopCost = sharedSegmentCost(world.tiles[node.tileIndex], node.segment, mode);
    cumulative += hopCost;
    const mpAfter = remainingMP - cumulative;
    const zone: RouteHopZone = mpAfter >= 1 ? 'attackReady' : 'moveOnly';
    hops.push({
      tileIndex: node.tileIndex,
      segment: node.segment,
      hopCost: Math.round(hopCost * 100) / 100,
      cumulativeCost: Math.round(cumulative * 100) / 100,
      zone,
    });
  }

  return {
    startTile: unit.tileIndex,
    startSegment: unit.segment,
    hops,
  };
}

/** Choose the cheapest actually reachable segment on a target tile. */
function computeCheapestRouteToTile(
  world: WorldData,
  unit: UnitData,
  targetTile: number,
  remainingMP: number,
): MovementCostRoute | null {
  const tile = world.tiles[targetTile];
  if (!tile) return null;

  let best: MovementCostRoute | null = null;
  let bestCost = Infinity;
  for (let segment = 0; segment < tile.s; segment++) {
    const route = computeMovementCostRoute(
      world,
      unit,
      null,
      segment,
      remainingMP,
      targetTile,
    );
    if (!route) continue;
    const cost = route.hops[route.hops.length - 1]?.cumulativeCost ?? 0;
    if (cost < bestCost) {
      best = route;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Compute a contextual attack route based on the tactical situation:
 *
 * Case 1: Enemy within weapon range from current position → red line only (no movement)
 * Case 2: Enemy reachable this turn (move + fire) → minimum green to furthest
 *         firing position from enemy (max standoff) → red line to enemy
 * Case 3: Enemy out of range this turn → green + blue (full move) + red toward enemy (capped at weapon range)
 */
export function computeContextualAttackRoute(
  world: WorldData,
  unit: UnitData,
  destTile: number,
  destSegment: number,
  remainingMP: number,
  weaponRange: number,
  rangeResult: MovementRangeResult,
): MovementCostRoute | null {
  const tiles = world.tiles;
  const rangeTiles = getRangeTiles(tiles);
  const rangeAttack = unit.attributes.rangeAttack ?? 0;
  const hasWpn = hasWeapon(unit.attributes);

  // Case 1: Enemy already in weapon range from current position (no movement)
  const inRangeNow = isTargetInRange(rangeTiles, {
    tileIndex: unit.tileIndex,
    segment: unit.segment,
    rangeAttack,
    hasWeapon: hasWpn,
  }, { tileIndex: destTile, segment: destSegment });

  if (inRangeNow && remainingMP >= 1) {
    const hops: MovementRouteHop[] = [{
      tileIndex: destTile,
      segment: destSegment,
      hopCost: 0,
      cumulativeCost: 0,
      zone: 'weaponRange',
    }];
    return { startTile: unit.tileIndex, startSegment: unit.segment, hops };
  }

  // Case 2: Enemy reachable this turn with move + fire
  const attackReadyTiles = rangeResult.attackReadyTiles;
  let bestFireTile = -1;
  let bestFireSegment = 0;
  let bestFireDistToEnemy = -Infinity;
  let bestFireCost = Infinity;
  const threshold = getRangeThreshold(rangeAttack);

  for (const arTile of attackReadyTiles) {
    if (arTile === unit.tileIndex) continue;

    for (let seg = 0; seg < tiles[arTile].s; seg++) {
      if (!rangeResult.reachableSegments.has(encodeSeg(arTile, seg))) continue;
      const dist = sharedSegmentDistance(rangeTiles, arTile, seg, destTile, destSegment);
      if (dist > threshold) continue;

      const cost = rangeResult.moveRangeTiles.get(arTile) ?? 0;
      if (dist > bestFireDistToEnemy || (dist === bestFireDistToEnemy && cost < bestFireCost)) {
        bestFireDistToEnemy = dist;
        bestFireCost = cost;
        bestFireTile = arTile;
        bestFireSegment = seg;
      }
    }
  }

  if (bestFireTile >= 0) {
    const route = computeMovementCostRoute(
      world, unit, null, bestFireSegment, remainingMP, bestFireTile,
    );
    if (route) {
      route.hops.push({
        tileIndex: destTile,
        segment: destSegment,
        hopCost: 0,
        cumulativeCost: route.hops.length > 0 ? route.hops[route.hops.length - 1].cumulativeCost : 0,
        zone: 'weaponRange',
      });
      return route;
    }
  }

  // Case 3: Enemy out of range this turn — route to the nearest tile the unit
  // can stand on, measured outward from the enemy (maxBFS = 30).
  const moveRangeTiles = rangeResult.moveRangeTiles;
  const bestMoveTile = nearestReachableTile(tiles, destTile, moveRangeTiles, unit.tileIndex, 30);

  if (bestMoveTile < 0) return null;

  const movementRoute = computeCheapestRouteToTile(
    world, unit, bestMoveTile, remainingMP,
  );
  if (!movementRoute) return null;

  if (weaponRange > 0) {
    const cumCost = movementRoute.hops.length > 0
      ? movementRoute.hops[movementRoute.hops.length - 1].cumulativeCost
      : 0;
    const cur = appendStraightLineWeaponHops(
      movementRoute.hops, tiles, bestMoveTile, destTile, destSegment, weaponRange, cumCost,
    );

    if (cur !== destTile) {
      const endSegment = 0;
      const endDist = sharedSegmentDistance(rangeTiles, cur, endSegment, destTile, destSegment);
      if (endDist > threshold) {
        while (movementRoute.hops.length > 0 &&
               movementRoute.hops[movementRoute.hops.length - 1].zone === 'weaponRange') {
          movementRoute.hops.pop();
        }
      }
    }
  }

  return movementRoute;
}

/**
 * Compute a movement path toward a tile that is out of movement range.
 * Shows green/blue path to the furthest reachable tile in the direction of the target.
 */
export function computeMovementTowardTile(
  world: WorldData,
  unit: UnitData,
  destTile: number,
  remainingMP: number,
  rangeResult: MovementRangeResult,
): MovementCostRoute | null {
  const tiles = world.tiles;

  // Route to the nearest tile the unit can stand on, measured outward from the
  // (out-of-range) destination (maxBFS = 40).
  const bestMoveTile = nearestReachableTile(
    tiles, destTile, rangeResult.moveRangeTiles, unit.tileIndex, 40,
  );

  if (bestMoveTile < 0 || bestMoveTile === unit.tileIndex) return null;

  return computeCheapestRouteToTile(world, unit, bestMoveTile, remainingMP);
}

/**
 * Compute the movement route to a destination tile using the SAME computation
 * that draws the on-screen movement line. Single source of truth for "where
 * does the unit go" — both preview overlay and right-click execution call this.
 *
 * - Destination within movement range → cheapest segment-Dijkstra route to it.
 * - Destination out of range → route to the furthest reachable tile toward it.
 *
 * Returns only the movement portion (no weapon-range hops).
 */
export function computeMovementRouteForDestination(
  world: WorldData,
  unit: UnitData,
  destTile: number,
  destSegment: number,
  remainingMP: number,
  rangeResult: MovementRangeResult,
): MovementCostRoute | null {
  if (
    rangeResult.moveRangeTiles.has(destTile) ||
    rangeResult.attackReadyTiles.has(destTile)
  ) {
    return computeMovementCostRoute(world, unit, null, destSegment, remainingMP, destTile);
  }
  return computeMovementTowardTile(world, unit, destTile, remainingMP, rangeResult);
}

/**
 * Reduce a movement route to a concrete {@link MovePlan}: its final movement
 * hop (weapon-range hops are ignored), the MP spent to get there, and the
 * facing implied by the last step.
 *
 * Returns null when the route contains no movement hops (nothing to do).
 */
export function extractMovePlan(
  route: MovementCostRoute | null,
  tiles: { n: number[]; pos: [number, number, number] }[],
): MovePlan | null {
  if (!route) return null;
  const moveHops = route.hops.filter((h) => h.zone !== 'weaponRange');
  if (moveHops.length === 0) return null;

  const last = moveHops[moveHops.length - 1];

  let prevTile = route.startTile;
  for (let i = moveHops.length - 1; i >= 0; i--) {
    if (moveHops[i].tileIndex !== last.tileIndex) {
      prevTile = moveHops[i].tileIndex;
      break;
    }
  }

  const facing: 0 | 1 | 2 | 3 | 4 | 5 | null =
    last.tileIndex !== prevTile
      ? facingFromTravel(prevTile, last.tileIndex, tiles)
      : null;

  return {
    destTile: last.tileIndex,
    destSegment: last.segment,
    mpCost: last.cumulativeCost,
    facing,
  };
}

/**
 * Reduce a movement route to the contiguous tile-index path it walks (start
 * tile followed by each distinct tile crossed). Weapon-range hops are ignored.
 * Returns a 1-element array (or empty) for a pure intra-hex reposition.
 * Used to send a move to the authoritative session (`/api/match/intent`).
 */
export function extractMovePath(route: MovementCostRoute | null): number[] {
  if (!route) return [];
  const moveHops = route.hops.filter((h) => h.zone !== 'weaponRange');
  const path: number[] = [route.startTile];
  for (const h of moveHops) {
    if (path[path.length - 1] !== h.tileIndex) path.push(h.tileIndex);
  }
  return path;
}
