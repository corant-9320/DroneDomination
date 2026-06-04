/**
 * localMapUnits.ts — Unit and combat-highlight rendering for the local map.
 *
 * Extracted from LocalMapView (P1 refactor).
 * All functions are stateless; they take all required data as parameters.
 */

import { WorldData, UnitData } from './worldData.js';
import { factionColor } from './colors.js';
import { drawUnitIcon, segmentAngle } from './unitIcons.js';
import { FlatTile } from './localMapProjection.js';
import { getMaxMovement as sharedGetMaxMovement } from '../shared/movementConstants.js';

// ─── Segment geometry helpers ─────────────────────────────────────────────────

/**
 * Get the centroid of a triangular segment within a hex.
 * Segment i = triangle(centre, boundary[i], boundary[(i+1)%6]).
 * Returns null if the tile has fewer than 6 polygon vertices.
 */
export function getSegmentCentroid(
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
 * Compute the icon base-size for a segment triangle so the drawn unit
 * fills ~90% of the triangle at every zoom level.
 *
 * Returns a `size` value (half-width of body rectangle in drawUnitIcon).
 *
 * @param wts  worldToScreen bound to current view params
 */
export function getSegmentIconSize(
  ft: FlatTile,
  segment: number,
  wts: (wx: number, wy: number) => [number, number],
): number {
  if (ft.poly.length < 6) return 8;

  const [cx, cy] = wts(ft.cx, ft.cy);
  const v0 = ft.poly[segment % 6];
  const v1 = ft.poly[(segment + 1) % 6];
  const [ax, ay] = wts(v0.x, v0.y);
  const [bx, by] = wts(v1.x, v1.y);

  // Centroid in screen space (where the icon is drawn)
  const px = (cx + ax + bx) / 3;
  const py = (cy + ay + by) / 3;

  // Distance from centroid to each of the three edges (inradius)
  const d1 = pointToEdgeDist(px, py, cx, cy, ax, ay);
  const d2 = pointToEdgeDist(px, py, ax, ay, bx, by);
  const d3 = pointToEdgeDist(px, py, bx, by, cx, cy);
  const inradius = Math.min(d1, d2, d3);

  // size * 1.75 is the largest radius used (tank sprite), so
  // size = inradius * 0.5 keeps the sprite at ~87% of the triangle edge.
  return Math.max(4, inradius * 0.5);
}

/** Perpendicular distance from point (px,py) to the line through (x1,y1)-(x2,y2). */
function pointToEdgeDist(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return 0;
  return Math.abs((px - x1) * dy - (py - y1) * dx) / len;
}

// ─── Unit drawing ─────────────────────────────────────────────────────────────

/**
 * Draw unit markers in their segment triangles using composite icons.
 * Each unit faces its own `facing` direction (0–5 segment angle).
 *
 * @param ctx            Canvas 2D context
 * @param world          Current world data
 * @param flatTiles      Visible flat tile list
 * @param selectedUnits  Set of selected unit ids
 * @param movementPoints Map of unit id → remaining MP
 * @param hiddenUnits    Set of unit ids to skip (e.g. mid-animation)
 * @param wts            worldToScreen bound to current view params
 */
export function drawUnits(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  selectedUnits: Set<string>,
  movementPoints: Map<string, number>,
  hiddenUnits: Set<string>,
  wts: (wx: number, wy: number) => [number, number],
): void {
  const units = world.units;
  if (!units || units.length === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) {
    ftByTile.set(ft.tileIndex, ft);
  }

  for (const unit of units) {
    if (hiddenUnits.has(unit.id)) continue;
    const ft = ftByTile.get(unit.tileIndex);
    if (!ft) continue;
    const tile = world.tiles[unit.tileIndex];
    if (tile.s !== 6) continue;

    const segPos = getSegmentCentroid(ft, unit.segment);
    if (!segPos) continue;
    const [sx, sy] = wts(segPos.x, segPos.y);

    const size  = getSegmentIconSize(ft, unit.segment, wts);
    const color = factionColor(world, unit.ownerId);

    const facingAngle = segmentAngle(unit.facing);

    const currentMP = movementPoints.get(unit.id) ?? 0;
    const maxMP     = sharedGetMaxMovement(unit.attributes);

    drawUnitIcon(ctx, unit, sx, sy, size, color, facingAngle, currentMP, maxMP);

    // Selection ring for selected units
    if (selectedUnits.has(unit.id)) {
      ctx.beginPath();
      ctx.arc(sx, sy, size * 1.8, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ─── Combat highlight drawing ─────────────────────────────────────────────────

/**
 * Draw pulsing rings on the attacker (red) and target (cyan) plus an
 * arrow line between them during AI combat actions.
 *
 * @param ctx              Canvas 2D context
 * @param world            Current world data
 * @param flatTiles        Visible flat tile list
 * @param attackerId       Unit id of attacker (or null if none)
 * @param targetId         Unit id of target (or null if none)
 * @param wts              worldToScreen bound to current view params
 */
export function drawCombatHighlight(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  attackerId: string | null,
  targetId: string | null,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (!attackerId || !targetId) return;

  const attacker = world.units.find((u) => u.id === attackerId);
  const target   = world.units.find((u) => u.id === targetId);
  if (!attacker || !target) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  const ftA = ftByTile.get(attacker.tileIndex);
  const ftT = ftByTile.get(target.tileIndex);
  if (!ftA || !ftT) return;

  const segA = getSegmentCentroid(ftA, attacker.segment);
  const segT = getSegmentCentroid(ftT, target.segment);
  if (!segA || !segT) return;

  const [ax, ay] = wts(segA.x, segA.y);
  const [tx, ty] = wts(segT.x, segT.y);
  const sizeA = getSegmentIconSize(ftA, attacker.segment, wts);
  const sizeT = getSegmentIconSize(ftT, target.segment, wts);

  ctx.save();

  // Attacker ring — pulsing red
  ctx.beginPath();
  ctx.arc(ax, ay, sizeA * 2.2, 0, Math.PI * 2);
  ctx.strokeStyle = '#f44';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);
  ctx.stroke();

  // Target ring — pulsing cyan
  ctx.beginPath();
  ctx.arc(tx, ty, sizeT * 2.2, 0, Math.PI * 2);
  ctx.strokeStyle = '#4cf';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Arrow line from attacker to target
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(tx, ty);
  ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.stroke();

  // Arrowhead at target end
  const angle   = Math.atan2(ty - ay, tx - ax);
  const headLen = 12;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - headLen * Math.cos(angle - 0.4), ty - headLen * Math.sin(angle - 0.4));
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - headLen * Math.cos(angle + 0.4), ty - headLen * Math.sin(angle + 0.4));
  ctx.strokeStyle = '#f66';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.restore();
}
