/**
 * movementRange.ts — Pure movement-range computation (no canvas drawing).
 *
 * Exports:
 *   computeMovementRange   — Dijkstra flood fill → MovementRangeResult
 *   isInWeaponRange        — segment-distance check against a target
 *   weaponRangeInTileHops  — re-export from shared/rangeCheck
 *   MovementRangeResult    — result type
 */

import { WorldData, UnitData } from './worldData.js';
import {
  getMovementMode,
  segmentCost as sharedSegmentCost,
} from '../shared/movementConstants.js';
import {
  isTargetInRange,
  hasWeapon,
  weaponRangeFromAttributes,
  segmentDistance as sharedSegmentDistance,
  getRangeThreshold,
  type RangeTile,
} from '../shared/rangeCheck.js';

// ─── RangeTile adapter ────────────────────────────────────────────────────────

/**
 * Adapter: convert client tile array to the shape expected by shared rangeCheck.
 * Client tiles use `pos`, `b`, `n`, `s` — RangeTile expects `pos`, `boundary`, `neighbours`, `sides`.
 */
class RangeTileAdapter implements RangeTile {
  pos: [number, number, number];
  boundary: [number, number, number][];
  neighbours: number[];
  sides: number;
  constructor(tile: { pos: [number, number, number]; b: [number, number, number][]; n: number[]; s: number }) {
    this.pos = tile.pos;
    this.boundary = tile.b;
    this.neighbours = tile.n;
    this.sides = tile.s;
  }
}

let _rangeTileCache: WeakMap<object, RangeTile[]> = new WeakMap();

export function getRangeTiles(tiles: { pos: [number, number, number]; b: [number, number, number][]; n: number[]; s: number }[]): RangeTile[] {
  let cached = _rangeTileCache.get(tiles);
  if (cached) return cached;
  cached = tiles.map(t => new RangeTileAdapter(t));
  _rangeTileCache.set(tiles, cached);
  return cached;
}

/**
 * Compute tile-hop weapon range from unit attributes.
 * Re-exported for use by localMap.ts.
 * Delegates to shared/rangeCheck.ts — single source of truth.
 */
export { weaponRangeFromAttributes as weaponRangeInTileHops } from '../shared/rangeCheck.js';

/**
 * Check if a target is within weapon range using the shared segment-distance formula.
 * Same check the server uses — guarantees client and server always agree.
 */
export function isInWeaponRange(
  tiles: { pos: [number, number, number]; b: [number, number, number][]; n: number[]; s: number }[],
  attacker: { tileIndex: number; segment: number; attributes: { rangeAttack?: number; kinetic?: number; splashAttack?: number; antiAir?: number } },
  target: { tileIndex: number; segment: number },
): boolean {
  const rangeTiles = getRangeTiles(tiles);
  return isTargetInRange(rangeTiles, {
    tileIndex: attacker.tileIndex,
    segment: attacker.segment,
    rangeAttack: attacker.attributes.rangeAttack ?? 0,
    hasWeapon: hasWeapon(attacker.attributes),
  }, target);
}

/**
 * Build a set of segment keys occupied by enemy units.
 * Key encoding: tileIndex * 6 + segment.
 */
export function buildEnemySegmentSet(world: WorldData, ownerId: string): Set<number> {
  const set = new Set<number>();
  for (const u of world.units) {
    if (u.ownerId !== ownerId) {
      set.add(u.tileIndex * 6 + u.segment);
    }
  }
  return set;
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface MovementRangeResult {
  /** Tiles reachable within full MP (keyed by tile index → MP cost to reach). */
  moveRangeTiles: Map<number, number>;
  /** Tiles reachable with ≥1 MP remaining (can still attack after moving here). */
  attackReadyTiles: Set<number>;
  /** Tiles within weapon range from attackReady hexes (outer attack radius). */
  weaponRangeTiles: Set<number>;
  /**
   * Individual segments reachable this turn, encoded as tileIndex * 6 + segment.
   * attackReady = can reach with ≥1 MP left (green tint)
   * moveOnly    = reachable but no MP left for attack (blue tint)
   */
  reachableSegments: Map<number, 'attackReady' | 'moveOnly'>;
  /**
   * Segments within weapon range from the unit's CURRENT position (no movement).
   * Encoded as tileIndex * 6 + segment.
   */
  staticAttackSegments: Set<number>;
  /**
   * Segments within weapon range from ANY attack-ready position (after moving).
   * Encoded as tileIndex * 6 + segment. Superset of staticAttackSegments.
   */
  maxAttackSegments: Set<number>;
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute movement range zones for the given unit using Dijkstra flood fill.
 *
 * @param world        Current world data (for tiles)
 * @param unit         The unit whose range we are computing
 * @param remainingMP  Movement points remaining this turn
 * @returns Three zone sets: moveRangeTiles, attackReadyTiles, weaponRangeTiles
 */
export function computeMovementRange(
  world: WorldData,
  unit: UnitData,
  remainingMP: number,
): MovementRangeResult {
  const moveRangeTiles   = new Map<number, number>();
  const attackReadyTiles = new Set<number>();
  const weaponRangeTiles = new Set<number>();
  const reachableSegments = new Map<number, 'attackReady' | 'moveOnly'>();
  const staticAttackSegments = new Set<number>();
  const maxAttackSegments = new Set<number>();

  if (remainingMP <= 0) {
    return { moveRangeTiles, attackReadyTiles, weaponRangeTiles, reachableSegments, staticAttackSegments, maxAttackSegments };
  }

  const mode    = getMovementMode(unit.attributes);
  const startTile = unit.tileIndex;
  const startSegment = unit.segment;
  const tiles     = world.tiles;

  const enemySegments = buildEnemySegmentSet(world, unit.ownerId);

  const encode = (tile: number, seg: number) => tile * 6 + seg;
  const dist = new Map<number, number>();
  const startKey = encode(startTile, startSegment);
  dist.set(startKey, 0);

  const pq: { key: number; cost: number }[] = [{ key: startKey, cost: 0 }];

  while (pq.length > 0) {
    let minI = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].cost < pq[minI].cost) minI = i;
    }
    const { key: currentKey, cost: currentCost } = pq[minI];
    pq.splice(minI, 1);

    if (currentCost > (dist.get(currentKey) ?? Infinity)) continue;

    const currentTile = Math.floor(currentKey / 6);
    const currentSeg = currentKey % 6;
    const tile = tiles[currentTile];

    // Edge type 1: intra-hex pivot
    const intraStepCost = sharedSegmentCost(tile, mode);
    {
      for (let delta = -1; delta <= 1; delta += 2) {
        const adjSeg = ((currentSeg + delta) % 6 + 6) % 6;
        const adjKey = encode(currentTile, adjSeg);
        if (enemySegments.has(adjKey)) continue;
        const newCost = currentCost + intraStepCost;
        if (newCost > remainingMP) continue;
        const existing = dist.get(adjKey);
        if (existing === undefined || newCost < existing) {
          dist.set(adjKey, newCost);
          pq.push({ key: adjKey, cost: newCost });
        }
      }
    }

    // Edge type 2: cross hex border
    if (currentSeg < tile.n.length) {
      const neighbour = tile.n[currentSeg];
      const nTile = tiles[neighbour];
      const crossCost = sharedSegmentCost(nTile, mode, tile);
      if (crossCost !== Infinity) {
        const newCost = currentCost + crossCost;
        if (newCost <= remainingMP) {
          const arrivalSeg = nTile.n.indexOf(currentTile);
          const arrival = arrivalSeg >= 0 ? arrivalSeg : 0;
          const candidateSegs = [arrival, (arrival + 1) % 6, (arrival + 5) % 6];
          for (const cSeg of candidateSegs) {
            const nKey = encode(neighbour, cSeg);
            if (enemySegments.has(nKey)) continue;
            const existing = dist.get(nKey);
            if (existing === undefined || newCost < existing) {
              dist.set(nKey, newCost);
              pq.push({ key: nKey, cost: newCost });
            }
          }
        }
      }
    }
  }

  // Collapse segment-level costs to tile-level: cheapest segment per tile
  const tileBestCost = new Map<number, number>();
  for (const [key, cost] of dist) {
    const tileIdx = Math.floor(key / 6);
    const existing = tileBestCost.get(tileIdx);
    if (existing === undefined || cost < existing) {
      tileBestCost.set(tileIdx, cost);
    }
  }
  tileBestCost.delete(startTile);

  for (const [tileIdx, cost] of tileBestCost) {
    moveRangeTiles.set(tileIdx, cost);
  }
  for (const [tileIdx, cost] of tileBestCost) {
    if (remainingMP - cost >= 1) {
      attackReadyTiles.add(tileIdx);
    }
  }
  if (remainingMP >= 1) {
    attackReadyTiles.add(startTile);
  }

  // Weapon range: BFS outward from every attack-ready tile
  const weaponRange = weaponRangeFromAttributes(unit.attributes);

  if (weaponRange > 0) {
    for (const readyTile of attackReadyTiles) {
      const queue: { idx: number; d: number }[] = [{ idx: readyTile, d: 0 }];
      const visited = new Set<number>();
      visited.add(readyTile);
      let head = 0;

      while (head < queue.length) {
        const { idx, d } = queue[head++];
        if (d >= weaponRange) continue;
        for (const neighbour of tiles[idx].n) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          if (
            !moveRangeTiles.has(neighbour) &&
            !attackReadyTiles.has(neighbour) &&
            neighbour !== startTile
          ) {
            weaponRangeTiles.add(neighbour);
          }
          queue.push({ idx: neighbour, d: d + 1 });
        }
      }
    }
  }

  // Reachable segments
  for (const [key, cost] of dist) {
    if (key === startKey) continue;
    if (enemySegments.has(key)) continue;
    const zone: 'attackReady' | 'moveOnly' =
      remainingMP - cost >= 1 ? 'attackReady' : 'moveOnly';
    reachableSegments.set(key, zone);
  }

  // Attack-range segment sets
  const rangeTiles = getRangeTiles(tiles);
  const rangeAttack = unit.attributes.rangeAttack ?? 0;
  const hasWeapon = (unit.attributes.kinetic ?? 0) > 0
    || (unit.attributes.splashAttack ?? 0) > 0
    || (unit.attributes.antiAir ?? 0) > 0
    || rangeAttack > 0;

  if (hasWeapon) {
    const threshold = getRangeThreshold(rangeAttack);
    const weaponHops = weaponRangeFromAttributes(unit.attributes);
    const candidateTiles = new Set<number>();
    for (const arTile of attackReadyTiles) {
      candidateTiles.add(arTile);
      const bfsQ: { idx: number; d: number }[] = [{ idx: arTile, d: 0 }];
      let bHead = 0;
      const bVis = new Set<number>([arTile]);
      while (bHead < bfsQ.length) {
        const { idx, d } = bfsQ[bHead++];
        if (d >= weaponHops) continue;
        for (const nb of tiles[idx].n) {
          if (!bVis.has(nb)) { bVis.add(nb); candidateTiles.add(nb); bfsQ.push({ idx: nb, d: d + 1 }); }
        }
      }
    }

    for (const candTile of candidateTiles) {
      const candTileData = tiles[candTile];
      const sides = candTileData.s;
      for (let seg = 0; seg < sides; seg++) {
        const segKey = candTile * 6 + seg;
        const staticDist = sharedSegmentDistance(rangeTiles, startTile, startSegment, candTile, seg);
        if (staticDist <= threshold) {
          staticAttackSegments.add(segKey);
          maxAttackSegments.add(segKey);
          continue;
        }
        if (attackReadyTiles.has(candTile)) {
          maxAttackSegments.add(segKey);
          continue;
        }
        outer:
        for (const arTile of attackReadyTiles) {
          const arTileData = tiles[arTile];
          for (let arSeg = 0; arSeg < arTileData.s; arSeg++) {
            if (enemySegments.has(arTile * 6 + arSeg)) continue;
            const d = sharedSegmentDistance(rangeTiles, arTile, arSeg, candTile, seg);
            if (d <= threshold) {
              maxAttackSegments.add(segKey);
              break outer;
            }
          }
        }
      }
    }
  }

  return { moveRangeTiles, attackReadyTiles, weaponRangeTiles, reachableSegments, staticAttackSegments, maxAttackSegments };
}
