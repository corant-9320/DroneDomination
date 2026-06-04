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
  hexEntryCost as sharedHexEntryCost,
  getMaxMovement as sharedGetMaxMovement,
} from '../shared/movementConstants.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  const totalMP = sharedGetMaxMovement(unit.attributes);
  const alreadySpent  = totalMP - remainingMP;
  // If unit already moved (spent > 0), first-hex rule no longer applies
  const hexesMoved = alreadySpent > 0 ? 1 : 0;

  const startTile = unit.tileIndex;
  const tiles     = world.tiles;

  // Dijkstra flood fill from the unit's current tile
  const dist = new Map<number, number>();
  dist.set(startTile, 0);

  // Priority queue (simple array sorted by cost — fine for small BFS radius)
  const pq: { idx: number; cost: number }[] = [{ idx: startTile, cost: 0 }];

  while (pq.length > 0) {
    let minI = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].cost < pq[minI].cost) minI = i;
    }
    const { idx: current, cost: currentCost } = pq[minI];
    pq.splice(minI, 1);

    if (currentCost > (dist.get(current) ?? Infinity)) continue;

    for (const neighbour of tiles[current].n) {
      const nTile = tiles[neighbour];
      // isFirstHex: no spend yet AND no prior movement this turn
      const hopsFromStart = currentCost === 0 && hexesMoved === 0;
      const entryCost = sharedHexEntryCost(nTile, mode, hopsFromStart);
      if (entryCost === Infinity) continue;

      const newCost = currentCost + entryCost;
      if (newCost > remainingMP) continue;

      const existingCost = dist.get(neighbour);
      if (existingCost === undefined || newCost < existingCost) {
        dist.set(neighbour, newCost);
        pq.push({ idx: neighbour, cost: newCost });
      }
    }
  }

  // Remove the start tile (unit is already there)
  dist.delete(startTile);

  // Populate moveRangeTiles
  for (const [tileIdx, cost] of dist) {
    moveRangeTiles.set(tileIdx, cost);
  }

  // Populate attackReadyTiles (reachable with ≥1 MP left for attack)
  for (const [tileIdx, cost] of dist) {
    if (remainingMP - cost >= 1) {
      attackReadyTiles.add(tileIdx);
    }
  }
  // Start tile is also attack-ready if unit still has MP
  if (remainingMP >= 1) {
    attackReadyTiles.add(startTile);
  }

  // Weapon range: BFS outward from every attack-ready tile
  const rangeAttack  = unit.attributes.rangeAttack ?? 0;
  const meleeAttack  = unit.attributes.kinetic ?? 0;
  const weaponRange  = Math.max(rangeAttack, meleeAttack > 0 ? 1 : 0);

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
