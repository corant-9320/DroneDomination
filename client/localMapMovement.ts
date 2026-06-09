/**
 * localMapMovement.ts — Movement range computation and overlay rendering.
 *
 * Extracted from LocalMapView (P1 refactor).
 * All functions are stateless; they take all required data as parameters.
 */

import { WorldData, UnitData } from './worldData.js';
import { FlatTile } from './localMapProjection.js';
import {
  getMovementMode,
  segmentCost as sharedSegmentCost,
} from '../shared/movementConstants.js';
import {
  isTargetInRange,
  weaponRangeInTileHops as sharedWeaponRangeInTileHops,
  segmentDistance as sharedSegmentDistance,
  getRangeThreshold,
  type RangeTile,
} from '../shared/rangeCheck.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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

function getRangeTiles(tiles: { pos: [number, number, number]; b: [number, number, number][]; n: number[]; s: number }[]): RangeTile[] {
  let cached = _rangeTileCache.get(tiles);
  if (cached) return cached;
  cached = tiles.map(t => new RangeTileAdapter(t));
  _rangeTileCache.set(tiles, cached);
  return cached;
}

/**
 * Compute tile-hop weapon range from unit attributes.
 * Re-exported for use by localMap.ts.
 */
export function weaponRangeInTileHops(attributes: { rangeAttack?: number; kinetic?: number }): number {
  const rangeAttack = attributes.rangeAttack ?? 0;
  const meleeAttack = attributes.kinetic ?? 0;
  const hasWeapon = rangeAttack > 0 || meleeAttack > 0;
  return sharedWeaponRangeInTileHops(rangeAttack, hasWeapon);
}

/**
 * Check if a target is within weapon range using the shared segment-distance formula.
 * Same check the server uses — guarantees client and server always agree.
 */
export function isInWeaponRange(
  tiles: { pos: [number, number, number]; b: [number, number, number][]; n: number[]; s: number }[],
  attacker: { tileIndex: number; segment: number; attributes: { rangeAttack?: number; kinetic?: number; splashAttack?: number; antiAir?: number } },
  target: { tileIndex: number; segment: number },
): boolean {
  const rangeAttack = attacker.attributes.rangeAttack ?? 0;
  const kinetic = attacker.attributes.kinetic ?? 0;
  const splash = attacker.attributes.splashAttack ?? 0;
  const antiAir = attacker.attributes.antiAir ?? 0;
  const hasWeapon = kinetic > 0 || splash > 0 || antiAir > 0 || rangeAttack > 0;
  const rangeTiles = getRangeTiles(tiles);
  return isTargetInRange(rangeTiles, {
    tileIndex: attacker.tileIndex,
    segment: attacker.segment,
    rangeAttack,
    hasWeapon,
  }, target);
}

/**
 * Build a set of segment keys occupied by enemy units.
 * Key encoding: tileIndex * 6 + segment.
 */
function buildEnemySegmentSet(world: WorldData, ownerId: string): Set<number> {
  const set = new Set<number>();
  for (const u of world.units) {
    if (u.ownerId !== ownerId) {
      set.add(u.tileIndex * 6 + u.segment);
    }
  }
  return set;
}

export interface MovementRangeResult {
  /** Tiles reachable within full MP (keyed by tile index → MP cost to reach). */
  moveRangeTiles: Map<number, number>;
  /** Tiles reachable with ≥1 MP remaining (can still attack after moving here). */
  attackReadyTiles: Set<number>;
  /** Tiles within weapon range from attackReady hexes (outer attack radius). */
  weaponRangeTiles: Set<number>;
}

// ─── Range computation ────────────────────────────────────────────────────────

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

  if (remainingMP <= 0) {
    return { moveRangeTiles, attackReadyTiles, weaponRangeTiles };
  }

  const mode    = getMovementMode(unit.attributes);

  const startTile = unit.tileIndex;
  const startSegment = unit.segment;
  const tiles     = world.tiles;

  // Build set of enemy-occupied segments (blocked for movement)
  const enemySegments = buildEnemySegmentSet(world, unit.ownerId);

  // Segment-aware Dijkstra: each node is (tileIndex, segment).
  // Key encoding: tileIndex * 6 + segment
  const encode = (tile: number, seg: number) => tile * 6 + seg;

  const dist = new Map<number, number>();
  const startKey = encode(startTile, startSegment);
  dist.set(startKey, 0);

  // Priority queue (simple array — fine for small local map radius)
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

    // Edge type 1: Move to adjacent segment within the same hex.
    // Intra-hex pivoting uses the same per-step cost as the unit's chassis
    // (segmentCost accounts for mode: drone=0.25, spider=0.50, tank=terrain-based).
    const intraStepCost = sharedSegmentCost(tile, mode);
    {
      for (let delta = -1; delta <= 1; delta += 2) {
        const adjSeg = ((currentSeg + delta) % 6 + 6) % 6;
        const adjKey = encode(currentTile, adjSeg);
        // Block enemy-occupied segments
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

    // Edge type 2: Cross hex border via current segment's facing edge.
    // Segment N faces toward neighbour N. Cost = segmentCost(neighbour tile, mode).
    if (currentSeg < tile.n.length) {
      const neighbour = tile.n[currentSeg];
      const nTile = tiles[neighbour];
      const crossCost = sharedSegmentCost(nTile, mode);
      if (crossCost !== Infinity) {
        const newCost = currentCost + crossCost;
        if (newCost <= remainingMP) {
          // Arrival segment in the neighbour: the segment facing back toward current tile
          const arrivalSeg = nTile.n.indexOf(currentTile);
          const arrival = arrivalSeg >= 0 ? arrivalSeg : 0;
          const nKey = encode(neighbour, arrival);
          // Block enemy-occupied segments
          if (!enemySegments.has(nKey)) {
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

  // Remove the start tile (unit is already there)
  tileBestCost.delete(startTile);

  // Populate moveRangeTiles
  for (const [tileIdx, cost] of tileBestCost) {
    moveRangeTiles.set(tileIdx, cost);
  }

  // Populate attackReadyTiles (reachable with ≥1 MP left for attack)
  for (const [tileIdx, cost] of tileBestCost) {
    if (remainingMP - cost >= 1) {
      attackReadyTiles.add(tileIdx);
    }
  }
  // Start tile is also attack-ready if unit still has MP
  if (remainingMP >= 1) {
    attackReadyTiles.add(startTile);
  }

  // Weapon range: BFS outward from every attack-ready tile
  const weaponRange = weaponRangeInTileHops(unit.attributes);

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
          // Weapon-range tiles are those outside the move/attack zones
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

  return { moveRangeTiles, attackReadyTiles, weaponRangeTiles };
}

// ─── Overlay rendering ────────────────────────────────────────────────────────

/**
 * Draw movement range as bounding lines around each zone:
 * - Green solid: attack-ready tiles (movement leaving ≥1 MP)
 * - Blue dashed: max movement range (all reachable tiles)
 * - Red dotted: max weapon range (outer attack radius)
 *
 * @param ctx              Canvas 2D context
 * @param flatTiles        Visible flat tile list
 * @param moveRangeTiles   From computeMovementRange
 * @param attackReadyTiles From computeMovementRange
 * @param weaponRangeTiles From computeMovementRange
 * @param wts              worldToScreen bound to current view params
 */
export function drawMovementRange(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  moveRangeTiles: Map<number, number>,
  attackReadyTiles: Set<number>,
  weaponRangeTiles: Set<number>,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (moveRangeTiles.size === 0 && weaponRangeTiles.size === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) {
    ftByTile.set(ft.tileIndex, ft);
  }

  // Build zone supersets for boundary computation
  const attackReadySet = attackReadyTiles;
  const moveRangeSet   = new Set<number>(moveRangeTiles.keys());
  for (const t of attackReadySet) moveRangeSet.add(t);
  const allRangeSet = new Set<number>(moveRangeSet);
  for (const t of weaponRangeTiles) allRangeSet.add(t);

  // Weapon range boundary (red dotted) — outermost
  drawZoneBoundary(ctx, world, allRangeSet, ftByTile, 'rgba(255, 80, 60, 0.9)', [4, 4], 2, wts);
  // Max movement boundary (blue dashed)
  drawZoneBoundary(ctx, world, moveRangeSet, ftByTile, 'rgba(80, 160, 255, 0.9)', [8, 4], 2, wts);
  // Attack-ready boundary (green solid) — innermost
  drawZoneBoundary(ctx, world, attackReadySet, ftByTile, 'rgba(80, 220, 120, 0.9)', [], 2.5, wts);
}

/**
 * Draw the boundary of a tile zone by outlining the perimeter hexes.
 * A tile is on the perimeter if any of its neighbours is outside the zone.
 */
export function drawZoneBoundary(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  zone: Set<number>,
  ftByTile: Map<number, FlatTile>,
  color: string,
  dash: number[],
  lineWidth: number,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (zone.size === 0) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (const tileIdx of zone) {
    const ft = ftByTile.get(tileIdx);
    if (!ft) continue;

    const tile = world.tiles[tileIdx];
    const onBoundary = tile.n.some((n: number) => !zone.has(n));
    if (!onBoundary) continue;

    for (let i = 0; i < ft.poly.length; i++) {
      const [sx, sy] = wts(ft.poly[i].x, ft.poly[i].y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * Draw a colored overlay on a tile polygon.
 */
export function drawTileOverlay(
  ctx: CanvasRenderingContext2D,
  ft: FlatTile,
  color: string,
  wts: (wx: number, wy: number) => [number, number],
): void {
  ctx.beginPath();
  for (let i = 0; i < ft.poly.length; i++) {
    const [sx, sy] = wts(ft.poly[i].x, ft.poly[i].y);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── Movement cost route overlay ──────────────────────────────────────────────

/**
 * Zone classification for a route hop in the extended overlay.
 * - 'attackReady': movement that preserves ≥1 MP for an attack (green)
 * - 'moveOnly': max movement range, no MP left for attack (blue)
 * - 'weaponRange': beyond movement, within weapon range (red)
 */
export type RouteHopZone = 'attackReady' | 'moveOnly' | 'weaponRange';

/**
 * A single hop in the movement cost route overlay.
 */
export interface MovementRouteHop {
  /** Tile index of this hop's destination. */
  tileIndex: number;
  /** Segment index at this hop. */
  segment: number;
  /** MP cost for this individual hop (from previous position to here). */
  hopCost: number;
  /** Cumulative MP spent to reach this hop. */
  cumulativeCost: number;
  /** Which zone this hop falls in (for coloring the overlay). */
  zone: RouteHopZone;
}

/**
 * Full movement cost route to display as an overlay.
 */
export interface MovementCostRoute {
  /** Starting tile and segment (the selected unit's current position). */
  startTile: number;
  startSegment: number;
  /** Ordered list of hops from start to destination. */
  hops: MovementRouteHop[];
}

/**
 * Compute the movement cost route from a selected unit to a destination segment.
 *
 * Uses segment-level Dijkstra where each segment has exactly 3 neighbours:
 *   - Two adjacent segments in the same hex (cost: 0.25 each)
 *   - One segment across the hex border (cost: hex entry cost for that terrain)
 *
 * The route traces the optimal segment-by-segment path, showing every
 * individual segment step the unit takes.
 *
 * @param world         Current world data
 * @param unit          The selected unit
 * @param destTile      Destination tile index
 * @param destSegment   Target segment at the destination tile
 * @param remainingMP   MP remaining for this unit
 * @returns The route, or null if unreachable
 */
export function computeMovementCostRoute(
  world: WorldData,
  unit: UnitData,
  _path: number[] | null,  // kept for API compat, not used
  destSegment: number,
  remainingMP: number,
  destTile?: number,
): MovementCostRoute | null {
  // Determine destination tile from _path (legacy) or destTile param
  const targetTile = destTile ?? (_path && _path.length >= 2 ? _path[_path.length - 1] : -1);
  if (targetTile < 0) return null;
  if (unit.tileIndex === targetTile && unit.segment === destSegment) return null;

  const mode = getMovementMode(unit.attributes);
  const tiles = world.tiles;

  // Build set of enemy-occupied segments (blocked for movement)
  const enemySegments = buildEnemySegmentSet(world, unit.ownerId);

  // Segment-level Dijkstra from (unit.tileIndex, unit.segment) to (targetTile, destSegment)
  const encode = (tile: number, seg: number) => tile * 6 + seg;
  const startKey = encode(unit.tileIndex, unit.segment);
  const goalKey = encode(targetTile, destSegment);

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();  // for path reconstruction
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
    if (currentKey === goalKey) break; // found optimal path

    const currentTile = Math.floor(currentKey / 6);
    const currentSeg = currentKey % 6;
    const tile = tiles[currentTile];

    // Edge type 1: adjacent segments within same hex (±1 mod 6)
    // Uses mode-aware segmentCost so spiders pay 0.50, drones 0.25, tanks terrain-based.
    const intraStepCost = sharedSegmentCost(tile, mode);
    if (intraStepCost !== Infinity) {
      for (let delta = -1; delta <= 1; delta += 2) {
        const adjSeg = ((currentSeg + delta) % 6 + 6) % 6;
        const adjKey = encode(currentTile, adjSeg);
        if (enemySegments.has(adjKey)) continue;
        const newCost = currentCost + intraStepCost;
        if (newCost > remainingMP) continue;

        const existing = dist.get(adjKey);
        if (existing === undefined || newCost < existing) {
          dist.set(adjKey, newCost);
          prev.set(adjKey, currentKey);
          pq.push({ key: adjKey, cost: newCost });
        }
      }
    }

    // Edge type 2: cross hex border via current segment's facing edge
    // Cost = segmentCost(neighbour tile, mode)
    if (currentSeg < tile.n.length) {
      const neighbour = tile.n[currentSeg];
      const nTile = tiles[neighbour];
      const crossCost = sharedSegmentCost(nTile, mode);
      if (crossCost !== Infinity) {
        const newCost = currentCost + crossCost;
        if (newCost <= remainingMP) {
          const arrivalSeg = nTile.n.indexOf(currentTile);
          const arrival = arrivalSeg >= 0 ? arrivalSeg : 0;
          const nKey = encode(neighbour, arrival);
          if (!enemySegments.has(nKey)) {
            const existing = dist.get(nKey);
            if (existing === undefined || newCost < existing) {
              dist.set(nKey, newCost);
              prev.set(nKey, currentKey);
              pq.push({ key: nKey, cost: newCost });
            }
          }
        }
      }
    }
  }

  // Check if destination was reached
  if (!dist.has(goalKey)) return null;

  // Reconstruct path from prev map
  const segPath: number[] = [];
  let step = goalKey;
  while (step !== startKey) {
    segPath.unshift(step);
    const p = prev.get(step);
    if (p === undefined) return null; // shouldn't happen
    step = p;
  }

  if (segPath.length === 0) return null;

  // Build hops from segment path — distinguish intra-hex vs cross-hex cost
  const hops: MovementRouteHop[] = [];
  let cumulative = 0;
  let prevHopKey = startKey;

  for (const key of segPath) {
    const tileIdx = Math.floor(key / 6);
    const prevTileIdx = Math.floor(prevHopKey / 6);
    const hopCost = sharedSegmentCost(tiles[tileIdx], mode);

    cumulative += hopCost;
    // Classify zone based on remaining MP after this hop
    const mpAfter = remainingMP - cumulative;
    let zone: RouteHopZone;
    if (mpAfter >= 1) {
      zone = 'attackReady';
    } else if (cumulative <= remainingMP) {
      zone = 'moveOnly';
    } else {
      zone = 'weaponRange';
    }
    hops.push({
      tileIndex: tileIdx,
      segment: key % 6,
      hopCost: Math.round(hopCost * 100) / 100,
      cumulativeCost: Math.round(cumulative * 100) / 100,
      zone,
    });
    prevHopKey = key;
  }

  return {
    startTile: unit.tileIndex,
    startSegment: unit.segment,
    hops,
  };
}

// ─── Extended route (movement + attack range) ─────────────────────────────────

/**
 * Compute the extended movement cost route that extends into weapon range.
 *
 * This finds the best path to a destination that may be beyond movement range
 * but within combined movement + weapon range. The route shows:
 * - Green hops: movement preserving ≥1 MP for attack
 * - Blue hops: max movement (no MP left for attack)
 * - Red hops: weapon range extension (BFS hops beyond last moveable tile)
 *
 * When the destination is beyond attack range, the route is clamped to
 * the furthest reachable point along the line toward the mouse.
 *
 * @param world         Current world data
 * @param unit          The selected unit
 * @param destTile      Target tile (may be in weapon range zone)
 * @param destSegment   Target segment
 * @param remainingMP   MP remaining
 * @param weaponRange   Unit's effective weapon range in tile hops
 * @returns Extended route or null if unreachable
 */
export function computeExtendedCostRoute(
  world: WorldData,
  unit: UnitData,
  destTile: number,
  destSegment: number,
  remainingMP: number,
  weaponRange: number,
): MovementCostRoute | null {
  if (unit.tileIndex === destTile && unit.segment === destSegment) return null;

  const mode = getMovementMode(unit.attributes);
  const tiles = world.tiles;
  const encode = (tile: number, seg: number) => tile * 6 + seg;
  const startKey = encode(unit.tileIndex, unit.segment);

  // Build set of enemy-occupied segments (blocked for movement)
  const enemySegments = buildEnemySegmentSet(world, unit.ownerId);

  // Phase 1: Full segment-level Dijkstra (capped at remainingMP) to find all reachable segments.
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
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

    // Edge type 1: intra-hex pivot — mode-aware cost (spider=0.50, drone=0.25, tank=terrain)
    const intraStepCost = sharedSegmentCost(tile, mode);
    for (let delta = -1; delta <= 1; delta += 2) {
      const adjSeg = ((currentSeg + delta) % 6 + 6) % 6;
      const adjKey = encode(currentTile, adjSeg);
      if (enemySegments.has(adjKey)) continue;
      const newCost = currentCost + intraStepCost;
      if (newCost > remainingMP) continue;

      const existing = dist.get(adjKey);
      if (existing === undefined || newCost < existing) {
        dist.set(adjKey, newCost);
        prev.set(adjKey, currentKey);
        pq.push({ key: adjKey, cost: newCost });
      }
    }

    // Edge type 2: cross hex border
    if (currentSeg < tile.n.length) {
      const neighbour = tile.n[currentSeg];
      const nTile = tiles[neighbour];
      const crossCost = sharedSegmentCost(nTile, mode);
      if (crossCost !== Infinity) {
        const newCost = currentCost + crossCost;
        if (newCost <= remainingMP) {
          const arrivalSeg = nTile.n.indexOf(currentTile);
          const arrival = arrivalSeg >= 0 ? arrivalSeg : 0;
          const nKey = encode(neighbour, arrival);
          if (!enemySegments.has(nKey)) {
            const existing = dist.get(nKey);
            if (existing === undefined || newCost < existing) {
              dist.set(nKey, newCost);
              prev.set(nKey, currentKey);
              pq.push({ key: nKey, cost: newCost });
            }
          }
        }
      }
    }
  }

  // If the destination tile is reachable within movement range (check any segment,
  // since the specific enemy segment may be blocked but the tile itself is adjacent),
  // build route to the best reachable segment of that tile, then append weapon hops.
  const goalKey = encode(destTile, destSegment);
  const destTileReachable = dist.has(goalKey) ||
    [...Array(6).keys()].some(s => dist.has(encode(destTile, s)));

  if (destTileReachable) {
    // Find the best (cheapest) reachable segment on destTile
    let bestGoalKey = goalKey;
    if (!dist.has(goalKey)) {
      let bestCost = Infinity;
      for (let s = 0; s < 6; s++) {
        const k = encode(destTile, s);
        const c = dist.get(k);
        if (c !== undefined && c < bestCost) { bestCost = c; bestGoalKey = k; }
      }
    }

    // Reconstruct path
    const segPath: number[] = [];
    let step = bestGoalKey;
    while (step !== startKey) {
      segPath.unshift(step);
      const p = prev.get(step);
      if (p === undefined) return null;
      step = p;
    }
    if (segPath.length === 0) return null;

    // Build movement hops with zone classification
    const hops: MovementRouteHop[] = [];
    let cumulative = 0;
    let prevHopKey2 = startKey;

    for (const key of segPath) {
      const tileIdx = Math.floor(key / 6);
      const hopCost = sharedSegmentCost(tiles[tileIdx], mode);
      cumulative += hopCost;
      const mpAfter = remainingMP - cumulative;
      const zone: RouteHopZone = mpAfter >= 1 ? 'attackReady' : 'moveOnly';
      hops.push({
        tileIndex: tileIdx,
        segment: key % 6,
        hopCost: Math.round(hopCost * 100) / 100,
        cumulativeCost: Math.round(cumulative * 100) / 100,
        zone,
      });
      prevHopKey2 = key;
    }

    // Append weapon range extension from the last attack-ready tile toward destTile.
    // Exclude intermediate movement tiles from skipSet but NOT destTile itself.
    const lastARTile = [...hops].reverse().find(h => h.zone === 'attackReady')?.tileIndex
      ?? unit.tileIndex;
    const skipSet = new Set(hops.map(h => h.tileIndex));
    skipSet.delete(destTile); // always allow the weapon hop to land on the enemy tile
    appendWeaponRangeHops(hops, tiles, lastARTile, destTile, destSegment, weaponRange, skipSet);

    return {
      startTile: unit.tileIndex,
      startSegment: unit.segment,
      hops,
    };
  }

  // Phase 2: Destination is beyond movement range.
  // Find the best reachable tile closest to destTile via tile-level BFS from destTile backward.
  // Then extend with BFS hops from that tile toward destTile up to weaponRange.

  // Tile-level BFS from destTile to find the nearest tile within moveRange
  const moveableTiles = new Map<number, number>(); // tileIdx → best segment cost
  for (const [key, cost] of dist) {
    const tIdx = Math.floor(key / 6);
    const existing = moveableTiles.get(tIdx);
    if (existing === undefined || cost < existing) {
      moveableTiles.set(tIdx, cost);
    }
  }

  // BFS from destTile outward, looking for the closest moveable tile within weaponRange hops.
  const bfsFromDest = new Map<number, number>(); // tileIdx → BFS distance from destTile
  bfsFromDest.set(destTile, 0);
  const bfsQueue: { idx: number; d: number }[] = [{ idx: destTile, d: 0 }];
  let bfsHead = 0;
  let bestMoveTile = -1;
  let bestMoveDistance = Infinity;
  let bestMoveCost = Infinity;

  while (bfsHead < bfsQueue.length) {
    const { idx, d } = bfsQueue[bfsHead++];
    if (d >= weaponRange) continue;

    // Check if this tile is moveable (within full movement range)
    if (moveableTiles.has(idx)) {
      const tileCost = moveableTiles.get(idx)!;

      // Track closest moveable tile to dest
      if (d < bestMoveDistance || (d === bestMoveDistance && tileCost < bestMoveCost)) {
        bestMoveTile = idx;
        bestMoveDistance = d;
        bestMoveCost = tileCost;
      }
    }

    for (const neighbour of tiles[idx].n) {
      if (bfsFromDest.has(neighbour)) continue;
      bfsFromDest.set(neighbour, d + 1);
      bfsQueue.push({ idx: neighbour, d: d + 1 });
    }
  }

  // Route to the closest moveable tile to show the full green+blue path.
  // Then extend red from the last attack-ready tile on that path.
  if (bestMoveTile < 0) return null; // No moveable tile can reach destTile within weapon range

  // Phase 3: Build the segment-level movement path to the closest moveable tile.
  // Find the best segment on that tile (cheapest)
  let bestSegKey = -1;
  let bestSegCost = Infinity;
  for (let seg = 0; seg < 6; seg++) {
    const key = encode(bestMoveTile, seg);
    const c = dist.get(key);
    if (c !== undefined && c < bestSegCost) {
      bestSegCost = c;
      bestSegKey = key;
    }
  }
  if (bestSegKey < 0) return null;

  // Reconstruct movement path
  const segPath: number[] = [];
  let step = bestSegKey;
  while (step !== startKey) {
    segPath.unshift(step);
    const p = prev.get(step);
    if (p === undefined) return null;
    step = p;
  }

  // Build movement hops with zone classification
  const hops: MovementRouteHop[] = [];
  let cumulative = 0;
  let prevHopKey3 = startKey;
  let lastAttackReadyTile = unit.tileIndex; // start tile is attack-ready if MP >= 1

  for (const key of segPath) {
    const tileIdx = Math.floor(key / 6);
    const prevTileIdx3 = Math.floor(prevHopKey3 / 6);
    const hopCost = sharedSegmentCost(tiles[tileIdx], mode);
    cumulative += hopCost;
    const mpAfter = remainingMP - cumulative;
    let zone: RouteHopZone;
    if (mpAfter >= 1) {
      zone = 'attackReady';
      lastAttackReadyTile = tileIdx;
    } else {
      zone = 'moveOnly';
    }
    hops.push({
      tileIndex: tileIdx,
      segment: key % 6,
      hopCost: Math.round(hopCost * 100) / 100,
      cumulativeCost: Math.round(cumulative * 100) / 100,
      zone,
    });
    prevHopKey3 = key;
  }

  // Phase 4: Extend with weapon range hops from the last attack-ready tile toward destTile.
  if (lastAttackReadyTile !== unit.tileIndex || remainingMP >= 1) {
    const moveTileSet = new Set<number>(segPath.map(k => Math.floor(k / 6)));
    moveTileSet.add(unit.tileIndex);
    moveTileSet.delete(destTile); // always allow the weapon hop to land on the enemy tile
    appendWeaponRangeHops(hops, tiles, lastAttackReadyTile, destTile, destSegment, weaponRange,
      moveTileSet);
  }

  return {
    startTile: unit.tileIndex,
    startSegment: unit.segment,
    hops,
  };
}

/**
 * Compute a contextual attack route based on the tactical situation:
 *
 * Case 1: Enemy within weapon range from current position → red line only (no movement)
 * Case 2: Enemy reachable this turn (move + fire) → minimum green to furthest
 *         firing position from enemy (max standoff) → red line to enemy
 * Case 3: Enemy out of range this turn → green + blue (full move) + red toward enemy (capped at weapon range, may stop short)
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
  const hasWeapon = (unit.attributes.kinetic ?? 0) > 0 ||
    (unit.attributes.splashAttack ?? 0) > 0 ||
    (unit.attributes.antiAir ?? 0) > 0 ||
    rangeAttack > 0;

  // ─── Case 1: Enemy already in weapon range from current position (no movement) ───
  // Use exact segment-distance check (same as server)
  const inRangeNow = isTargetInRange(rangeTiles, {
    tileIndex: unit.tileIndex,
    segment: unit.segment,
    rangeAttack,
    hasWeapon,
  }, { tileIndex: destTile, segment: destSegment });

  if (inRangeNow && remainingMP >= 1) {
    // Red line only — single weapon-range hop to destination
    const hops: MovementRouteHop[] = [{
      tileIndex: destTile,
      segment: destSegment,
      hopCost: 0,
      cumulativeCost: 0,
      zone: 'weaponRange',
    }];
    return {
      startTile: unit.tileIndex,
      startSegment: unit.segment,
      hops,
    };
  }

  // ─── Case 2: Enemy reachable this turn with move + fire ───
  // Find the attack-ready tile that is:
  //   - Within weapon range of the enemy (segment-distance check)
  //   - FURTHEST from the enemy (maximum standoff distance)
  // Among ties for furthest, pick the one with lowest movement cost.
  const attackReadyTiles = rangeResult.attackReadyTiles;
  let bestFireTile = -1;
  let bestFireSegment = 0;
  let bestFireDistToEnemy = -Infinity;
  let bestFireCost = Infinity;
  const threshold = getRangeThreshold(rangeAttack);

  for (const arTile of attackReadyTiles) {
    if (arTile === unit.tileIndex) continue; // Case 1 already handled current pos

    // For each attack-ready tile, check each segment to find one that's in range.
    // We want the segment that maximizes distance to enemy while still in range.
    for (let seg = 0; seg < tiles[arTile].s; seg++) {
      const dist = sharedSegmentDistance(rangeTiles, arTile, seg, destTile, destSegment);
      if (dist > threshold) continue; // out of range from this segment

      // This segment can hit the enemy. Prefer furthest from enemy (max standoff).
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
    // Build green movement path to the max-standoff firing position
    const route = computeMovementCostRoute(
      world, unit, null, bestFireSegment, remainingMP, bestFireTile,
    );
    if (route) {
      // Append a single red weapon-range hop to the enemy
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

  // ─── Case 3: Enemy out of range this turn ───
  // Green + blue path (full movement toward enemy), then red toward enemy capped at weapon range
  // Find the best reachable tile toward the enemy (closest to enemy by BFS)
  const moveRangeTiles = rangeResult.moveRangeTiles;
  let bestMoveTile = -1;
  let bestMoveDistToEnemy = Infinity;

  // BFS from enemy outward to find which moveable tiles are closest to it
  const bfsFromEnemy = new Map<number, number>();
  bfsFromEnemy.set(destTile, 0);
  const bfsQueue: { idx: number; d: number }[] = [{ idx: destTile, d: 0 }];
  let bfsHead = 0;
  // BFS radius: movement range + weapon range should be sufficient
  const maxBFS = 30;

  while (bfsHead < bfsQueue.length) {
    const { idx, d } = bfsQueue[bfsHead++];
    if (d >= maxBFS) continue;

    // Check if this is a moveable tile
    if (moveRangeTiles.has(idx) || idx === unit.tileIndex) {
      if (d < bestMoveDistToEnemy) {
        bestMoveDistToEnemy = d;
        bestMoveTile = idx;
      }
    }

    for (const neighbour of tiles[idx].n) {
      if (bfsFromEnemy.has(neighbour)) continue;
      bfsFromEnemy.set(neighbour, d + 1);
      bfsQueue.push({ idx: neighbour, d: d + 1 });
    }
  }

  if (bestMoveTile < 0) return null;

  // Build the movement path to the closest moveable tile toward enemy
  const movementRoute = computeMovementCostRoute(
    world, unit, null, 0, remainingMP, bestMoveTile,
  );
  if (!movementRoute) return null;

  // Append red line toward the enemy, capped at weapon range tile hops
  // The red hop just marks the destination direction — drawing will
  // handle it as a straight line (from our earlier fix)
  if (weaponRange > 0) {
    const cumCost = movementRoute.hops.length > 0
      ? movementRoute.hops[movementRoute.hops.length - 1].cumulativeCost
      : 0;
    // Walk toward enemy from bestMoveTile up to weaponRange hops
    const destPos = tiles[destTile].pos;
    let cur = bestMoveTile;
    const visited = new Set<number>([bestMoveTile]);

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
      movementRoute.hops.push({
        tileIndex: bestN,
        segment: bestN === destTile ? destSegment : 0,
        hopCost: 0,
        cumulativeCost: cumCost,
        zone: 'weaponRange',
      });
      cur = bestN;
      if (bestN === destTile) break;
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
  const moveRangeTiles = rangeResult.moveRangeTiles;

  // BFS from dest tile outward to find the closest reachable tile
  const bfsFromDest = new Map<number, number>();
  bfsFromDest.set(destTile, 0);
  const bfsQueue: { idx: number; d: number }[] = [{ idx: destTile, d: 0 }];
  let bfsHead = 0;
  let bestMoveTile = -1;
  let bestDist = Infinity;
  const maxBFS = 40;

  while (bfsHead < bfsQueue.length) {
    const { idx, d } = bfsQueue[bfsHead++];
    if (d >= maxBFS) continue;

    if (moveRangeTiles.has(idx) || idx === unit.tileIndex) {
      if (d < bestDist) {
        bestDist = d;
        bestMoveTile = idx;
      }
    }

    for (const neighbour of tiles[idx].n) {
      if (bfsFromDest.has(neighbour)) continue;
      bfsFromDest.set(neighbour, d + 1);
      bfsQueue.push({ idx: neighbour, d: d + 1 });
    }
  }

  if (bestMoveTile < 0 || bestMoveTile === unit.tileIndex) return null;

  return computeMovementCostRoute(world, unit, null, 0, remainingMP, bestMoveTile);
}

/**
 * Append red weapon-range hops from `sourceTile` toward `destTile`.
 * Uses 3D geometry to pick the straightest path: at each step picks the
 * neighbour whose position is closest to the great-circle line from source
 * to dest. This flies straight over enemies and terrain — weapon range is
 * line-of-sight, not a ground movement path.
 */
function appendWeaponRangeHops(
  hops: MovementRouteHop[],
  tiles: { n: number[]; pos: [number, number, number] }[],
  sourceTile: number,
  destTile: number,
  destSegment: number,
  weaponRange: number,
  _skipSet: Set<number>,  // unused — weapon fire flies over everything
): void {
  if (weaponRange <= 0 || sourceTile === destTile) return;

  const destPos = tiles[destTile].pos;

  // Walk greedily: at each step, pick the neighbour whose 3D position is
  // closest to destPos (dot product with dest direction = most aligned).
  let cur = sourceTile;
  const visited = new Set<number>([sourceTile]);

  for (let hop = 0; hop < weaponRange; hop++) {
    if (cur === destTile) break;

    // Pick neighbour with highest dot product toward destPos (closest angle)
    let bestN = -1;
    let bestDot = -Infinity;
    for (const n of tiles[cur].n) {
      if (visited.has(n) && n !== destTile) continue;
      const p = tiles[n].pos;
      // dot product of neighbour position with dest position (both on unit sphere)
      const dot = p[0] * destPos[0] + p[1] * destPos[1] + p[2] * destPos[2];
      if (dot > bestDot) { bestDot = dot; bestN = n; }
    }
    if (bestN < 0) break;

    visited.add(bestN);
    const cumCost = hops.length > 0 ? hops[hops.length - 1].cumulativeCost : 0;
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
}

/**
 * Tile-level BFS from `from` to `to`, max `maxDist` hops.
 * Returns the path (inclusive of both endpoints) or null.
 */
function tileBFS(
  tiles: { n: number[] }[],
  from: number,
  to: number,
  maxDist: number,
): number[] | null {
  if (from === to) return [from];
  const cameFrom = new Map<number, number>();
  cameFrom.set(from, -1);
  const queue: { idx: number; d: number }[] = [{ idx: from, d: 0 }];
  let head = 0;

  while (head < queue.length) {
    const { idx, d } = queue[head++];
    if (d >= maxDist) continue;
    for (const n of tiles[idx].n) {
      if (cameFrom.has(n)) continue;
      cameFrom.set(n, idx);
      if (n === to) {
        // Reconstruct
        const path: number[] = [];
        let s = to;
        while (s !== -1) {
          path.unshift(s);
          s = cameFrom.get(s)!;
        }
        return path;
      }
      queue.push({ idx: n, d: d + 1 });
    }
  }
  return null;
}

/**
 * Draw the movement cost route overlay: dotted line path with cost digits at each hop.
 *
 * Three-color zones:
 * - Green: movement that preserves ≥1 MP for attack (attackReady)
 * - Blue: movement range but no MP left for attack (moveOnly)
 * - Red: weapon/attack range beyond movement (weaponRange)
 *
 * @param ctx        Canvas 2D context
 * @param world      Current world data
 * @param flatTiles  Visible flat tile list
 * @param route      The computed route (null = nothing to draw)
 * @param wts        worldToScreen bound to current view params
 */
export function drawMovementCostRoute(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  route: MovementCostRoute | null,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (!route || route.hops.length === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  // Compute screen positions for start + each hop
  const points: Array<{ sx: number; sy: number; cost: string; zone: RouteHopZone }> = [];

  // Start position (unit's current segment)
  const startFt = ftByTile.get(route.startTile);
  if (!startFt) return;
  const startCentroid = getSegmentCentroidLocal(startFt, route.startSegment);
  if (!startCentroid) return;
  const [startSx, startSy] = wts(startCentroid.x, startCentroid.y);
  points.push({ sx: startSx, sy: startSy, cost: '', zone: 'attackReady' });

  // Each hop
  for (const hop of route.hops) {
    const ft = ftByTile.get(hop.tileIndex);
    if (!ft) break;
    const centroid = getSegmentCentroidLocal(ft, hop.segment);
    if (!centroid) break;
    const [sx, sy] = wts(centroid.x, centroid.y);
    points.push({ sx, sy, cost: hop.zone === 'weaponRange' ? '' : hop.hopCost.toFixed(2), zone: hop.zone });
  }

  if (points.length < 2) return;

  // Zone colors
  const ZONE_COLORS: Record<RouteHopZone, string> = {
    attackReady: 'rgba(80, 220, 120, 0.9)',   // green
    moveOnly: 'rgba(80, 160, 255, 0.9)',      // blue
    weaponRange: 'rgba(255, 80, 60, 0.9)',    // red
  };
  const ZONE_DASH: Record<RouteHopZone, number[]> = {
    attackReady: [6, 4],
    moveOnly: [8, 4],
    weaponRange: [4, 4],
  };

  ctx.save();

  // Draw segments colored by zone (draw line segment by segment)
  // For weapon-range (red) segments, draw a single straight line from
  // the last movement point to the final destination (line-of-sight).
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';

  // Find the index where weapon range starts
  let weaponStartIdx = points.length; // default: no weapon hops
  for (let i = 1; i < points.length; i++) {
    if (points[i].zone === 'weaponRange') {
      weaponStartIdx = i;
      break;
    }
  }

  // Draw movement segments (green/blue) normally
  for (let i = 1; i < weaponStartIdx; i++) {
    const from = points[i - 1];
    const to = points[i];
    ctx.beginPath();
    ctx.moveTo(from.sx, from.sy);
    ctx.lineTo(to.sx, to.sy);
    ctx.strokeStyle = ZONE_COLORS[to.zone];
    ctx.setLineDash(ZONE_DASH[to.zone]);
    ctx.stroke();
  }

  // Draw weapon-range as a single straight line from last movement point to final point
  // When the red section follows blue (moveOnly), make it faint — attack is next turn only
  if (weaponStartIdx < points.length) {
    const from = points[weaponStartIdx - 1];
    const to = points[points.length - 1];
    const precedingZone = points[weaponStartIdx - 1].zone;
    const isFaint = precedingZone === 'moveOnly';
    ctx.beginPath();
    ctx.moveTo(from.sx, from.sy);
    ctx.lineTo(to.sx, to.sy);
    ctx.strokeStyle = isFaint ? 'rgba(255, 80, 60, 0.3)' : ZONE_COLORS.weaponRange;
    ctx.setLineDash(ZONE_DASH.weaponRange);
    ctx.stroke();
  }

  // Draw arrowhead at the final point
  if (points.length >= 2) {
    const last = points[points.length - 1];
    // For weapon-range, use the straight-line angle from last movement point
    const prevPt = (last.zone === 'weaponRange' && weaponStartIdx > 0)
      ? points[weaponStartIdx - 1]
      : points[points.length - 2];
    const angle = Math.atan2(last.sy - prevPt.sy, last.sx - prevPt.sx);
    const headLen = 10;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(last.sx, last.sy);
    ctx.lineTo(last.sx - headLen * Math.cos(angle - 0.4), last.sy - headLen * Math.sin(angle - 0.4));
    ctx.moveTo(last.sx, last.sy);
    ctx.lineTo(last.sx - headLen * Math.cos(angle + 0.4), last.sy - headLen * Math.sin(angle + 0.4));
    // Faint arrowhead when red follows blue (next-turn attack)
    const arrowFaint = last.zone === 'weaponRange' && weaponStartIdx > 0 && points[weaponStartIdx - 1].zone === 'moveOnly';
    ctx.strokeStyle = arrowFaint ? 'rgba(255, 80, 60, 0.3)' : ZONE_COLORS[last.zone];
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Draw cost digits at each hop (skip start and weapon range hops which have no cost)
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 1; i < points.length; i++) {
    const { sx, sy, cost, zone } = points[i];
    if (!cost) continue;
    // Background pill
    const textWidth = ctx.measureText(cost).width;
    const pillW = textWidth + 6;
    const pillH = 14;
    const pillX = sx - pillW / 2;
    const pillY = sy - pillH / 2 - 12;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 3);
    ctx.fill();
    // Text colored by zone
    ctx.fillStyle = ZONE_COLORS[zone];
    ctx.fillText(cost, sx, sy - 12);
  }

  // Draw total cost at the end point (only for movement portion)
  const lastMovementHop = [...route.hops].reverse().find(h => h.zone !== 'weaponRange');
  if (lastMovementHop) {
    // Find the corresponding point
    let lastMoveIdx = -1;
    let runningIdx = 0;
    for (let i = 0; i < route.hops.length; i++) {
      runningIdx = i + 1; // +1 because points[0] is the start
      if (route.hops[i] === lastMovementHop) {
        lastMoveIdx = runningIdx;
        break;
      }
    }
    if (lastMoveIdx >= 0 && lastMoveIdx < points.length) {
      const lastPt = points[lastMoveIdx];
      const totalText = `Σ${lastMovementHop.cumulativeCost.toFixed(2)}`;
      const tw = ctx.measureText(totalText).width;
      const pw = tw + 8;
      const ph = 16;
      const px = lastPt.sx - pw / 2;
      const py = lastPt.sy + 8;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.beginPath();
      drawRoundedRect(ctx, px, py, pw, ph, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(totalText, lastPt.sx, lastPt.sy + 16);
    }
  }

  // If there are weapon range hops, draw a crosshair/target indicator at the final point
  const hasWeaponHops = route.hops.some(h => h.zone === 'weaponRange');
  if (hasWeaponHops) {
    const last = points[points.length - 1];
    ctx.setLineDash([]);
    ctx.strokeStyle = ZONE_COLORS.weaponRange;
    ctx.lineWidth = 1.5;
    // Crosshair circle
    ctx.beginPath();
    ctx.arc(last.sx, last.sy, 8, 0, Math.PI * 2);
    ctx.stroke();
    // Crosshair lines
    ctx.beginPath();
    ctx.moveTo(last.sx - 12, last.sy);
    ctx.lineTo(last.sx - 5, last.sy);
    ctx.moveTo(last.sx + 5, last.sy);
    ctx.lineTo(last.sx + 12, last.sy);
    ctx.moveTo(last.sx, last.sy - 12);
    ctx.lineTo(last.sx, last.sy - 5);
    ctx.moveTo(last.sx, last.sy + 5);
    ctx.lineTo(last.sx, last.sy + 12);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Get the 2D centroid of a segment triangle within a flat tile (client-side).
 * Same logic as getSegmentCentroid in localMapUnits.ts but exported for reuse.
 */
function getSegmentCentroidLocal(
  ft: FlatTile,
  segment: number,
): { x: number; y: number } | null {
  if (ft.poly.length < 6) return null;
  const v0 = ft.poly[segment % 6];
  const v1 = ft.poly[(segment + 1) % 6];
  return {
    x: (ft.cx + v0.x + v1.x) / 3,
    y: (ft.cy + v0.y + v1.y) / 3,
  };
}

/**
 * Draw a rounded rectangle path (compatible with all browsers).
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}
