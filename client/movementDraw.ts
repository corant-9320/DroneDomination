/**
 * movementDraw.ts — All canvas drawing for movement/attack overlays.
 *
 * Exports:
 *   drawMovementRange      — zone boundary outlines (green/blue/red rings)
 *   drawZoneBoundary       — perimeter outline for a zone set
 *   drawTileOverlay        — solid fill for a single tile polygon
 *   drawReachableSegments  — green/blue triangle fills for reachable segments
 *   drawAttackRangeRings   — white/orange segment-perimeter attack rings
 *   drawMovementCostRoute  — dotted route line with cost labels
 */

import { WorldData } from './worldData.js';
import { FlatTile } from './localMapProjection.js';
import { MovementRangeResult } from './movementRange.js';
import { MovementCostRoute, RouteHopZone } from './movementRoute.js';

// ─── Movement range overlay ───────────────────────────────────────────────────

/**
 * Draw movement range as bounding lines around each zone:
 * - Green solid: attack-ready tiles (movement leaving ≥1 MP)
 * - Blue dashed: max movement range (all reachable tiles)
 * - Red dotted: max weapon range (outer attack radius)
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

  const attackReadySet = attackReadyTiles;
  const moveRangeSet   = new Set<number>(moveRangeTiles.keys());
  for (const t of attackReadySet) moveRangeSet.add(t);
  const allRangeSet = new Set<number>(moveRangeSet);
  for (const t of weaponRangeTiles) allRangeSet.add(t);

  drawZoneBoundary(ctx, world, allRangeSet, ftByTile, 'rgba(255, 80, 60, 0.9)', [4, 4], 2, wts);
  drawZoneBoundary(ctx, world, moveRangeSet, ftByTile, 'rgba(80, 160, 255, 0.9)', [8, 4], 2, wts);
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

/**
 * Draw shaded triangle overlays for every reachable segment.
 *
 * Green tint  (attackReady) — can reach with ≥1 MP left for an attack.
 * Blue tint   (moveOnly)    — reachable but no MP remains for an attack.
 *
 * Pentagon tiles (poly.length < 6) are skipped.
 */
export function drawReachableSegments(
  ctx: CanvasRenderingContext2D,
  flatTiles: FlatTile[],
  reachableSegments: Map<number, 'attackReady' | 'moveOnly'>,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (reachableSegments.size === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  ctx.save();

  for (const [key, zone] of reachableSegments) {
    const tileIdx = Math.floor(key / 6);
    const seg     = key % 6;
    const ft      = ftByTile.get(tileIdx);
    if (!ft || ft.poly.length < 6) continue;

    const v0 = ft.poly[seg % 6];
    const v1 = ft.poly[(seg + 1) % 6];
    const [cx, cy] = wts(ft.cx, ft.cy);
    const [ax, ay] = wts(v0.x, v0.y);
    const [bx, by] = wts(v1.x, v1.y);

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.closePath();

    ctx.fillStyle = zone === 'attackReady'
      ? 'rgba(80, 220, 120, 0.18)'
      : 'rgba(80, 160, 255, 0.18)';
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Draw two attack-range rings as segment-level perimeter outlines.
 *
 * - White/solid inner ring  — segments attackable from current position (no movement)
 * - Orange/dashed outer ring — segments attackable from any attack-ready position this turn
 *
 * Each segment triangle has three edges:
 *   - Two radial edges (shared with adjacent segments in the same tile)
 *   - One outer edge  (the tile boundary edge, shared with the facing neighbour's segment)
 */
export function drawAttackRangeRings(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  staticAttackSegments: Set<number>,
  maxAttackSegments: Set<number>,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (staticAttackSegments.size === 0 && maxAttackSegments.size === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  function drawRing(segSet: Set<number>, color: string, dash: number[], lineWidth: number): void {
    if (segSet.size === 0) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    for (const key of segSet) {
      const tileIdx = Math.floor(key / 6);
      const seg = key % 6;
      const ft = ftByTile.get(tileIdx);
      if (!ft || ft.poly.length < 6) continue;
      const tile = world.tiles[tileIdx];

      const [cx, cy] = wts(ft.cx, ft.cy);
      const v0 = ft.poly[seg % 6];
      const v1 = ft.poly[(seg + 1) % 6];
      const [ax, ay] = wts(v0.x, v0.y);
      const [bx, by] = wts(v1.x, v1.y);

      // Edge A: radial edge between seg-1 and seg (centre → poly[seg])
      const prevSeg = (seg + 5) % 6;
      const prevKey = tileIdx * 6 + prevSeg;
      if (!segSet.has(prevKey)) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax, ay);
      }

      // Edge B: radial edge between seg and seg+1 (centre → poly[seg+1])
      const nextSeg = (seg + 1) % 6;
      const nextKey = tileIdx * 6 + nextSeg;
      if (!segSet.has(nextKey)) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(bx, by);
      }

      // Edge C: outer edge poly[seg] → poly[seg+1]
      let outerNeighbourInSet = false;
      if (seg < tile.n.length) {
        const nbTileIdx = tile.n[seg];
        const nbTile = world.tiles[nbTileIdx];
        if (nbTile) {
          const arrSeg = nbTile.n.indexOf(tileIdx);
          if (arrSeg >= 0) {
            outerNeighbourInSet = segSet.has(nbTileIdx * 6 + arrSeg);
          }
        }
      }
      if (!outerNeighbourInSet) {
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  drawRing(maxAttackSegments,    'rgba(255, 160, 40, 0.85)',  [5, 3], 1.5);
  drawRing(staticAttackSegments, 'rgba(255, 255, 255, 0.90)', [],     2.0);
}

// ─── Movement cost route overlay ─────────────────────────────────────────────

/**
 * Get the 2D centroid of a segment triangle within a flat tile (client-side).
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

/**
 * Draw the movement cost route overlay: dotted line path with cost digits at each hop.
 *
 * Three-color zones:
 * - Green: movement that preserves ≥1 MP for attack (attackReady)
 * - Blue: movement range but no MP left for attack (moveOnly)
 * - Red: weapon/attack range beyond movement (weaponRange)
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

  const points: Array<{ sx: number; sy: number; cost: string; zone: RouteHopZone }> = [];

  const startFt = ftByTile.get(route.startTile);
  if (!startFt) return;
  const startCentroid = getSegmentCentroidLocal(startFt, route.startSegment);
  if (!startCentroid) return;
  const [startSx, startSy] = wts(startCentroid.x, startCentroid.y);
  points.push({ sx: startSx, sy: startSy, cost: '', zone: 'attackReady' });

  for (const hop of route.hops) {
    const ft = ftByTile.get(hop.tileIndex);
    if (!ft) break;
    const centroid = getSegmentCentroidLocal(ft, hop.segment);
    if (!centroid) break;
    const [sx, sy] = wts(centroid.x, centroid.y);
    points.push({ sx, sy, cost: hop.zone === 'weaponRange' ? '' : hop.hopCost.toFixed(2), zone: hop.zone });
  }

  if (points.length < 2) return;

  const ZONE_COLORS: Record<RouteHopZone, string> = {
    attackReady: 'rgba(80, 220, 120, 0.9)',
    moveOnly: 'rgba(80, 160, 255, 0.9)',
    weaponRange: 'rgba(255, 80, 60, 0.9)',
  };
  const ZONE_DASH: Record<RouteHopZone, number[]> = {
    attackReady: [6, 4],
    moveOnly: [8, 4],
    weaponRange: [4, 4],
  };

  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';

  let weaponStartIdx = points.length;
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

  // Draw weapon-range as a single straight line (line-of-sight)
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

  // Arrowhead at the final point
  if (points.length >= 2) {
    const last = points[points.length - 1];
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
    const arrowFaint = last.zone === 'weaponRange' && weaponStartIdx > 0 && points[weaponStartIdx - 1].zone === 'moveOnly';
    ctx.strokeStyle = arrowFaint ? 'rgba(255, 80, 60, 0.3)' : ZONE_COLORS[last.zone];
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Cost digits at each hop
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 1; i < points.length; i++) {
    const { sx, sy, cost, zone } = points[i];
    if (!cost) continue;
    const textWidth = ctx.measureText(cost).width;
    const pillW = textWidth + 6;
    const pillH = 14;
    const pillX = sx - pillW / 2;
    const pillY = sy - pillH / 2 - 12;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 3);
    ctx.fill();
    ctx.fillStyle = ZONE_COLORS[zone];
    ctx.fillText(cost, sx, sy - 12);
  }

  // Total cost at the end of the movement portion
  const lastMovementHop = [...route.hops].reverse().find(h => h.zone !== 'weaponRange');
  if (lastMovementHop) {
    let lastMoveIdx = -1;
    for (let i = 0; i < route.hops.length; i++) {
      if (route.hops[i] === lastMovementHop) {
        lastMoveIdx = i + 1; // +1 because points[0] is the start
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

  // Crosshair target indicator at the final point when weapon hops are present
  const hasWeaponHops = route.hops.some(h => h.zone === 'weaponRange');
  if (hasWeaponHops) {
    const last = points[points.length - 1];
    ctx.setLineDash([]);
    ctx.strokeStyle = ZONE_COLORS.weaponRange;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(last.sx, last.sy, 8, 0, Math.PI * 2);
    ctx.stroke();
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
