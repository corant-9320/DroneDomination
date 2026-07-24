/**
 * localMapUnits.ts — Unit and combat-highlight rendering for the local map.
 *
 * Extracted from LocalMapView (P1 refactor).
 * All functions are stateless; they take all required data as parameters.
 *
 * ─── FACING CORRECTION ───────────────────────────────────────────────────────
 *
 * Unit facing is stored as an index (0–5) into the tile's neighbour array.
 * The 3D sprite renderer pre-renders 6 sprites assuming facing N is at
 * screen angle (N × 60°) from north. But on a Goldberg sphere, a tile's
 * neighbour[N] can be at ANY screen angle depending on where the tile sits.
 *
 * To fix this, getCorrectedFacing() computes the actual screen direction of
 * the unit's faced hex edge, then picks the pre-rendered sprite whose baked-in
 * direction best matches it. This avoids 2D canvas rotation which would break
 * the isometric 3D perspective.
 *
 * See also: .kiro/steering/ui-defaults.md § "Unit Facing & Rendering"
 */

import { WorldData, UnitData, TileData } from './worldData.js';
import { factionColor } from './colors.js';
import { drawUnitIcon } from './unitIcons.js';
import { getBuildingSprite } from './buildingRenderer.js';
import { getLogisticsSprite } from './logisticsSpriteRenderer.js';
import type { LogisticsModelKind } from './logisticsModel.js';
import { FlatTile } from './localMapProjection.js';
import { getMaxMovement as sharedGetMaxMovement } from '../shared/movementConstants.js';
import {
  HUB_STORAGE_CAPACITY,
  REFINERY_THROUGHPUT_RATE,
  WELL_STORAGE_CAPACITY,
} from '../shared/logisticsConstants.js';
import { decodeSeg, encodeSeg, segmentNeighbours, type SegGraphTile } from '../shared/segmentGraph.js';
import { spriteFacingForRender } from './facing.js';

// ─── Entity overlay visibility ────────────────────────────────────────────────

/** The N-key cycle: all overlays, labels only hidden, then a minimal map. */
export type EntityOverlayMode = 'all' | 'labelsHidden' | 'minimal';

let entityOverlayMode: EntityOverlayMode = 'all';
let showEntityNumbers = true;

/** Advance the N-key entity-overlay cycle and return the active mode. */
export function cycleEntityOverlayMode(): EntityOverlayMode {
  entityOverlayMode = entityOverlayMode === 'all'
    ? 'labelsHidden'
    : entityOverlayMode === 'labelsHidden'
      ? 'minimal'
      : 'all';
  showEntityNumbers = entityOverlayMode === 'all';
  return entityOverlayMode;
}

/** Whether unit and building #N labels are visible. */
export function getShowEntityNumbers(): boolean {
  return showEntityNumbers;
}

/** Whether unit health and movement bars are visible. */
export function getShowEntityStatusBars(): boolean {
  return entityOverlayMode !== 'minimal';
}

/** Whether selected unit and building rings are visible. */
export function getShowEntitySelectionRings(): boolean {
  return entityOverlayMode !== 'minimal';
}

/** Whether faction-colour circles beneath units are visible. */
export function getShowEntityUnitCircles(): boolean {
  return entityOverlayMode !== 'minimal';
}

// ─── Segment geometry helpers ─────────────────────────────────────────────────

/**
 * Get the centroid of a triangular segment within a hex or pentagon.
 * Segment i = triangle(centre, boundary[i], boundary[(i+1)%sides]).
 */
export function getSegmentCentroid(
  ft: FlatTile,
  segment: number,
): { x: number; y: number } | null {
  const sides = ft.poly.length;
  if (sides < 3 || segment < 0 || segment >= sides) return null;
  const v0 = ft.poly[segment];
  const v1 = ft.poly[(segment + 1) % sides];
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

// ─── Facing correction ────────────────────────────────────────────────────────
//
// The NeighbourFacing → SpriteFacing conversion lives in facing.ts
// (`spriteFacingForRender`). See that module for the full explanation of why
// the stored neighbour-index facing must be re-projected to a screen sprite.

// ─── Unit drawing ─────────────────────────────────────────────────────────────

/**
 * Draw unit markers in their segment triangles using composite icons.
 * Each unit faces its own `facing` direction (0–5 segment angle).
 *
 * The sprite for each facing is pre-rendered assuming a fixed screen mapping
 * (facing 0 = up). To account for the actual tile geometry on the sphere,
 * we compute the correction angle from the tile's neighbour positions and
 * apply it as a canvas rotation when drawing.
 *
 * @param ctx            Canvas 2D context
 * @param world          Current world data
 * @param flatTiles      Visible flat tile list
 * @param selectedUnits  Set of selected unit ids
 * @param movementPoints Map of unit id → remaining MP
 * @param hiddenUnits    Set of unit ids to skip (e.g. mid-animation)
 * @param wts            worldToScreen bound to current view params
 * @param actedUnits     Units that have used their once-per-turn action (attack/
 *                       repair/bridge) this turn. Their unit number is drawn in
 *                       red. Also used for enemy units that have acted during
 *                       the AI turn. Move exhaustion alone does NOT turn the
 *                       number red — the health bar reflects remaining movement.
 * @param moveAnims      Optional map of unit id → in-flight glide state
 *                       (origin/destination tile+segment and eased progress).
 *                       When present for a unit, its sprite is drawn at the
 *                       interpolated origin→destination point, re-projected with
 *                       the current view transform so the glide survives a map
 *                       recentre mid-animation.
 */
export function drawUnits(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  selectedUnits: Set<string>,
  movementPoints: Map<string, number>,
  hiddenUnits: Set<string>,
  wts: (wx: number, wy: number) => [number, number],
  actedUnits: Set<string> = new Set(),
  moveAnims: Map<
    string,
    { fromTile: number; fromSeg: number; toTile: number; toSeg: number; progress: number }
  > = new Map(),
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
    // During a move glide, re-project the interpolated origin→destination point
    // using the *current* transform so the sprite tracks any mid-glide recentre
    // and lands exactly on the destination centroid (no overshoot/snap-back).
    const anim = moveAnims.get(unit.id);
    let sx: number;
    let sy: number;
    if (anim) {
      const ftFrom = ftByTile.get(anim.fromTile);
      const ftTo = ftByTile.get(anim.toTile);
      const cFrom = ftFrom ? getSegmentCentroid(ftFrom, anim.fromSeg) : null;
      const cTo = ftTo ? getSegmentCentroid(ftTo, anim.toSeg) : null;
      if (cFrom && cTo) {
        const wx = cFrom.x + (cTo.x - cFrom.x) * anim.progress;
        const wy = cFrom.y + (cTo.y - cFrom.y) * anim.progress;
        [sx, sy] = wts(wx, wy);
      } else {
        [sx, sy] = wts(segPos.x, segPos.y);
      }
    } else {
      [sx, sy] = wts(segPos.x, segPos.y);
    }

    const size  = getSegmentIconSize(ft, unit.segment, wts);
    const color = factionColor(world, unit.ownerId);

    // Compute the correction angle between the renderer's assumed facing
    // direction and the actual screen-space direction toward the faced neighbour.
    const correctedFacing = spriteFacingForRender(unit.facing, ft, wts);

    const currentMP = movementPoints.get(unit.id) ?? 0;
    const maxMP     = sharedGetMaxMovement(unit.attributes);

    drawUnitIcon(
      ctx,
      unit,
      sx,
      sy,
      size,
      color,
      correctedFacing,
      currentMP,
      maxMP,
      getShowEntityStatusBars(),
    );

    // Unit number label — same id suffix as the detail panel (#N)
    // Rendered in red when the unit has already used its move/action this turn
    // (no MP left, or marked as acted — e.g. an enemy unit during the AI turn).
    if (showEntityNumbers) {
      const idSuffix = unit.id.replace(/^unit_/, '');
      const fontSize = Math.max(6, size * 0.75);
      const labelX = sx + size * 0.5;
      const labelY = sy + size * 0.9 + fontSize;
      const showRed = actedUnits.has(unit.id);
      ctx.save();
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(`#${idSuffix}`, labelX + 1, labelY + 1);
      ctx.fillStyle = showRed ? 'rgba(255,80,80,0.95)' : 'rgba(220,220,220,0.85)';
      ctx.fillText(`#${idSuffix}`, labelX, labelY);
      ctx.restore();
    }
  }
}

/**
 * Draw selection rings for selected units. Call this after terrain and units
 * are drawn to avoid clipping issues on slopes.
 *
 * @param ctx           Canvas 2D context
 * @param world         Current world data
 * @param flatTiles     Visible flat tile list
 * @param selectedUnits Set of selected unit ids
 * @param wts           worldToScreen bound to current view params
 * @param moveAnims     Optional map of unit id → in-flight glide state
 */
export function drawUnitSelectionRings(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  selectedUnits: Set<string>,
  wts: (wx: number, wy: number) => [number, number],
  moveAnims: Map<
    string,
    { fromTile: number; fromSeg: number; toTile: number; toSeg: number; progress: number }
  > = new Map(),
): void {
  if (!getShowEntitySelectionRings() || selectedUnits.size === 0) return;

  const units = world.units;
  if (!units || units.length === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) {
    ftByTile.set(ft.tileIndex, ft);
  }

  for (const unit of units) {
    if (!selectedUnits.has(unit.id)) continue;

    const ft = ftByTile.get(unit.tileIndex);
    if (!ft) continue;
    const tile = world.tiles[unit.tileIndex];
    if (tile.s !== 6) continue;

    const segPos = getSegmentCentroid(ft, unit.segment);
    if (!segPos) continue;

    // Handle move animations same as drawUnits
    const anim = moveAnims.get(unit.id);
    let sx: number;
    let sy: number;
    if (anim) {
      const ftFrom = ftByTile.get(anim.fromTile);
      const ftTo = ftByTile.get(anim.toTile);
      const cFrom = ftFrom ? getSegmentCentroid(ftFrom, anim.fromSeg) : null;
      const cTo = ftTo ? getSegmentCentroid(ftTo, anim.toSeg) : null;
      if (cFrom && cTo) {
        const wx = cFrom.x + (cTo.x - cFrom.x) * anim.progress;
        const wy = cFrom.y + (cTo.y - cFrom.y) * anim.progress;
        [sx, sy] = wts(wx, wy);
      } else {
        [sx, sy] = wts(segPos.x, segPos.y);
      }
    } else {
      [sx, sy] = wts(segPos.x, segPos.y);
    }

    const size = getSegmentIconSize(ft, unit.segment, wts);

    // Draw the selection ring unclipped
    ctx.beginPath();
    ctx.arc(sx, sy, size * 1.8, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ─── Building drawing ─────────────────────────────────────────────────────────

/**
 * Draw a selection ring around a player-owned building that has been selected
 * by left-click. Uses the same ring style as unit selection rings so the two
 * feel consistent.
 *
 * @param selectedBuildingId  The id of the currently selected building, or null.
 */
export function drawBuildingSelectionRing(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  selectedBuildingId: string | null,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (!getShowEntitySelectionRings() || !selectedBuildingId) return;

  const building = world.buildings.find((b) => b.id === selectedBuildingId);
  if (!building) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  const ft = ftByTile.get(building.tileIndex);
  if (!ft) return;
  const tile = world.tiles[building.tileIndex];
  if (tile.s !== 6) return;

  const segPos = getSegmentCentroid(ft, building.segment);
  if (!segPos) return;

  const [sx, sy] = wts(segPos.x, segPos.y);
  const size = getSegmentIconSize(ft, building.segment, wts);

  // Outer selection ring — slightly larger than the unit ring (buildings are
  // larger on-screen because they fill the whole segment).
  ctx.beginPath();
  ctx.arc(sx, sy, size * 2.2, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffe066';  // gold — distinct from the white unit ring
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Draw buildings in their segment triangles. A building is rendered from its
 * cached 3D model sprite (a faction-tinted block, optionally equipped). While
 * the sprite is still rendering we fall back to a simple "block with a roof"
 * vector shape so the structure is always visible.
 */
export function drawBuildings(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  wts: (wx: number, wy: number) => [number, number],
): void {
  const buildings = world.buildings;
  if (!buildings || buildings.length === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  for (const b of buildings) {
    const ft = ftByTile.get(b.tileIndex);
    if (!ft) continue;
    const segPos = getSegmentCentroid(ft, b.segment);
    if (!segPos) continue;

    const [sx, sy] = wts(segPos.x, segPos.y);
    const size = getSegmentIconSize(ft, b.segment, wts);
    const color = factionColor(world, b.ownerId);

    const sprite = getBuildingSprite(b, color);
    if (sprite) {
      // Same sprite-to-screen scale as units (see unitIcons.ts) for a
      // consistent footprint within the segment triangle.
      const spriteSize = size * 7.058;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sprite, sx - spriteSize / 2, sy - spriteSize / 2, spriteSize, spriteSize);
      ctx.restore();
      // Fall through to draw the label below.
    } else {
      // Fallback: vector block + roof while the sprite renders.
      const w = size * 1.3;
      const h = size * 1.1;
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(sx - w / 2, sy - h / 2, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.moveTo(sx - w / 2, sy - h / 2);
      ctx.lineTo(sx, sy - h);
      ctx.lineTo(sx + w / 2, sy - h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Building number label — same format as unit labels (#N id suffix).
    if (showEntityNumbers) {
      const idSuffix = b.id.replace(/^building_/, '');
      const fontSize = Math.max(6, size * 0.75);
      const labelX = sx + size * 0.5;
      const labelY = sy + size * 0.9 + fontSize;
      ctx.save();
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(`#${idSuffix}`, labelX + 1, labelY + 1);
      ctx.fillStyle = 'rgba(220,220,220,0.85)';
      ctx.fillText(`#${idSuffix}`, labelX, labelY);
      ctx.restore();
    }
  }
}

/**
 * Draw the Oil Logistics network on the local (zoomed-in) map: oil-deposit
 * markers, route polylines (roads thin, highways thicker/brighter with a centre
 * dash), and faction-tinted structure badges (⛏ well, R refinery, H hub). This
 * is the tactical-scale counterpart to the globe overlay markers — it reads the
 * same `world.logistics` payload and the tiles' `resourceType`. Drawn beneath
 * the mobile units (called between buildings and units in `LocalMapView.render`).
 */
interface StandaloneRoadTopology {
  connections: Array<[fromKey: number, toKey: number]>;
  isolatedKeys: number[];
}

/**
 * Return the built road-to-road links permitted by canonical segment traversal.
 * A standalone road joins only its three adjacent segment nodes, never a tile
 * centre or an arbitrary road in the same/adjacent tile.
 */
function getStandaloneRoadTopology(
  roadKeys: readonly number[],
  tiles: readonly SegGraphTile[],
): StandaloneRoadTopology {
  const roadSet = new Set(roadKeys.filter((key) => {
    const { tileIndex, segment } = decodeSeg(key);
    return Number.isInteger(key) && tileIndex >= 0 && segment >= 0 && segment < (tiles[tileIndex]?.sides ?? 0);
  }));
  const connections: Array<[number, number]> = [];
  const connectedKeys = new Set<number>();

  for (const key of roadSet) {
    const { tileIndex, segment } = decodeSeg(key);
    for (const neighbour of segmentNeighbours(tiles, tileIndex, segment)) {
      const neighbourKey = encodeSeg(neighbour.tileIndex, neighbour.segment);
      if (!roadSet.has(neighbourKey) || key >= neighbourKey) continue;
      connections.push([key, neighbourKey]);
      connectedKeys.add(key);
      connectedKeys.add(neighbourKey);
    }
  }

  return {
    connections,
    isolatedKeys: [...roadSet].filter((key) => !connectedKeys.has(key)),
  };
}

/**
 * Draw the oil hex id (tile index) beneath an oil-infrastructure icon
 * (deposit ring, well, refinery, storage hub), in the same visual style as
 * unit/building #N labels (white/amber text, drop-shadow, no background).
 * This plain tile-index number is what the shuttle-transport destination
 * picker shows and what the player uses to identify oil hexes at a glance —
 * distinct from the internal entity id hash.
 */
function drawOilHexNumber(ctx: CanvasRenderingContext2D, sx: number, sy: number, size: number, tileIndex: number): void {
  if (!getShowEntityNumbers()) return;
  const fontSize = Math.max(6, size * 0.75);
  const labelY = sy + size * 0.9 + fontSize;
  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(`#${tileIndex}`, sx + 1, labelY + 1);
  ctx.fillStyle = 'rgba(244,208,63,0.95)'; // amber — matches the oil-deposit ring colour
  ctx.fillText(`#${tileIndex}`, sx, labelY);
  ctx.restore();
}

export function drawLogistics(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  wts: (wx: number, wy: number) => [number, number],
): void {
  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  const logistics = world.logistics;
  if (logistics) {
    const claimedOilTiles = new Set<number>([
      ...logistics.wells.map((well) => well.tileIndex),
      ...logistics.refineries.map((refinery) => refinery.tileIndex),
      ...logistics.hubs.map((hub) => hub.tileIndex),
    ]);
    ctx.save();
    ctx.fillStyle = 'rgba(43, 46, 50, 0.72)';
    ctx.strokeStyle = 'rgba(18, 20, 22, 0.9)';
    ctx.lineWidth = 1.5;
    for (const ft of flatTiles) {
      if (!claimedOilTiles.has(ft.tileIndex) || ft.poly.length === 0) continue;
      const [firstX, firstY] = wts(ft.poly[0].x, ft.poly[0].y);
      ctx.beginPath();
      ctx.moveTo(firstX, firstY);
      for (let i = 1; i < ft.poly.length; i++) {
        const [x, y] = wts(ft.poly[i].x, ft.poly[i].y);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Oil deposits (visible pre-drill) — amber ring at the tile centre ──
  for (const ft of flatTiles) {
    const tile = world.tiles[ft.tileIndex] as TileData | undefined;
    if (!tile || tile.resourceType !== 'oil') continue;
    const [sx, sy] = wts(ft.cx, ft.cy);
    const r = Math.max(3, getSegmentIconSize(ft, 0, wts) * 0.5);
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(18,13,6,0.85)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f4d03f';
    ctx.stroke();
    ctx.restore();
    drawOilHexNumber(ctx, sx, sy, r, ft.tileIndex);
  }

  if (!logistics) return;

  // ── Route polylines through their occupied segment centres ──
  const drawRoute = (segments: number[], color: string, width: number, dashed: boolean): void => {
    const pts: Array<[number, number]> = [];
    for (const key of segments) {
      const tileIndex = Math.floor(key / 6);
      const segment = key % 6;
      const ft = ftByTile.get(tileIndex);
      if (!ft) continue;
      const centroid = getSegmentCentroid(ft, segment);
      if (centroid) pts.push(wts(centroid.x, centroid.y));
    }
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([width * 2, width * 1.5]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  };
  for (const route of logistics.routes ?? []) {
    const inoperable = route.operable === false;
    if (route.tier === 'highway') {
      drawRoute(route.segments, inoperable ? 'rgba(255,120,120,0.7)' : '#3a3a42', 8, false);
      drawRoute(route.segments, inoperable ? 'rgba(255,120,120,0.9)' : '#ffd24a', 2, true); // centre line
    } else {
      drawRoute(route.segments, inoperable ? 'rgba(255,120,120,0.7)' : '#4a4a52', 5, false);
    }
  }

  // ── Standalone development roads: segment-centre topology network ──────
  const roadTopology = getStandaloneRoadTopology(
    logistics.standaloneRoadSegments ?? [],
    world.tiles.map((tile) => ({ sides: tile.s, neighbours: tile.n })),
  );
  const drawStandaloneRoad = (
    fromKey: number,
    toKey: number,
  ): void => {
    const from = decodeSeg(fromKey);
    const to = decodeSeg(toKey);
    const fromTile = ftByTile.get(from.tileIndex);
    const toTile = ftByTile.get(to.tileIndex);
    const fromCentroid = fromTile ? getSegmentCentroid(fromTile, from.segment) : null;
    const toCentroid = toTile ? getSegmentCentroid(toTile, to.segment) : null;
    if (!fromTile || !toTile || !fromCentroid || !toCentroid) return;

    const [fromX, fromY] = wts(fromCentroid.x, fromCentroid.y);
    const [toX, toY] = wts(toCentroid.x, toCentroid.y);
    const width = Math.max(
      3,
      ((getSegmentIconSize(fromTile, from.segment, wts) + getSegmentIconSize(toTile, to.segment, wts)) / 2) * 0.75,
    );
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#4a4a52';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    ctx.strokeStyle = '#d6b34d';
    ctx.lineWidth = Math.max(1, width * 0.18);
    ctx.setLineDash([width * 0.7, width * 0.45]);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    ctx.restore();
  };
  for (const [fromKey, toKey] of roadTopology.connections) {
    drawStandaloneRoad(fromKey, toKey);
  }

  // An unconnected built segment remains visible as a small roundabout until
  // construction reaches one of its canonical segment neighbours.
  for (const key of roadTopology.isolatedKeys) {
    const { tileIndex, segment } = decodeSeg(key);
    const ft = ftByTile.get(tileIndex);
    const centroid = ft ? getSegmentCentroid(ft, segment) : null;
    if (!ft || !centroid) continue;

    const [x, y] = wts(centroid.x, centroid.y);
    const width = Math.max(3, getSegmentIconSize(ft, segment, wts) * 0.75);
    const radius = Math.max(width * 0.9, getSegmentIconSize(ft, segment, wts) * 0.5);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#4a4a52';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#d6b34d';
    ctx.lineWidth = Math.max(1, width * 0.18);
    ctx.setLineDash([width * 0.7, width * 0.45]);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Draw a compact cargo/storage meter above a logistics entity. */
  const drawFillMeter = (sx: number, sy: number, size: number, stored: number, capacity: number): void => {
    if (!getShowEntityStatusBars() || capacity <= 0) return;
    const width = Math.max(14, size * 2.1);
    const height = Math.max(2, size * 0.18);
    const x = sx - width / 2;
    const y = sy - size * 1.45;
    const ratio = Math.max(0, Math.min(1, stored / capacity));
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = ratio >= 1 ? '#f2c94c' : '#61d36b';
    ctx.fillRect(x, y, width * ratio, height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 0.75;
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
  };

  // ── Structures: real 3D-model sprite, with a glyph badge fallback ──
  // Each structure prefers its baked sprite (logisticsSpriteRenderer.ts); while
  // that sprite is still rendering we draw the faction-tinted glyph badge so the
  // structure is always visible.
  const drawStructure = (
    tileIndex: number,
    segment: number | null,
    ownerId: string,
    kind: LogisticsModelKind,
    glyph: string,
    stored: number,
    capacity: number,
    segmentCount = 1,
  ): void => {
    const ft = ftByTile.get(tileIndex);
    if (!ft) return;
    const pos = segment == null ? { x: ft.cx, y: ft.cy } : getSegmentCentroid(ft, segment);
    if (!pos) return;
    const [sx, sy] = wts(pos.x, pos.y);
    const size = getSegmentIconSize(ft, segment ?? 0, wts);
    const color = factionColor(world, ownerId);

    const sprite = getLogisticsSprite(kind, color, segmentCount);
    if (sprite) {
      // Same sprite-to-screen scale as buildings/units for a consistent footprint.
      const spriteSize = size * 7.058;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sprite, sx - spriteSize / 2, sy - spriteSize / 2, spriteSize, spriteSize);
      ctx.restore();
      drawFillMeter(sx, sy, size, stored, capacity);
      drawOilHexNumber(ctx, sx, sy, size, tileIndex);
      return;
    }

    // Fallback: faction-tinted glyph badge while the sprite renders.
    const r = Math.max(6, size * 0.9);
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(8, r * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, sx, sy);
    ctx.restore();
    drawFillMeter(sx, sy, size, stored, capacity);
    drawOilHexNumber(ctx, sx, sy, size, tileIndex);
  };
  for (const refinery of logistics.refineries ?? []) {
    // Refinery ownership is a collection of explicit segment footprints. Draw
    // each footprint where it is built so the map and God Mode targets agree.
    for (const segment of refinery.segments ?? []) {
      drawStructure(
        refinery.tileIndex,
        segment,
        refinery.ownerId,
        'refinery',
        'R',
        refinery.heldOil,
        Math.max(1, refinery.segments.length * REFINERY_THROUGHPUT_RATE),
        refinery.segments.length,
      );
    }
  }
  for (const hub of logistics.hubs ?? []) {
    drawStructure(hub.tileIndex, hub.segment, hub.ownerId, 'hub', 'H', hub.buffer, HUB_STORAGE_CAPACITY);
  }
  for (const well of logistics.wells ?? []) {
    drawStructure(well.tileIndex, well.segment, well.ownerId, 'well', '⛏', well.storedOil, WELL_STORAGE_CAPACITY);
  }

  // ── Transports: compact route-position marker with the same fill meter ──
  // Shuttle transports (shuttleMode) walk their own fixed shuttlePath and have
  // no meaningful LogisticsRoute; ordinary cargo transports position along
  // their assigned route via the turn-countdown progress.
  const routeById = new Map(logistics.routes.map((route) => [route.id, route]));
  for (const transport of logistics.transports ?? []) {
    let tileIndex: number;
    let segment: number;
    if (transport.shuttleMode) {
      const path = transport.shuttlePath ?? [];
      if (path.length === 0) continue;
      const idx = Math.max(0, Math.min(path.length - 1, transport.shuttlePosition ?? 0));
      ({ tileIndex, segment } = decodeSeg(path[idx]));
    } else {
      const route = routeById.get(transport.routeId);
      if (!route || route.segments.length === 0) continue;
      const travelTime = Math.max(1, route.travelTime);
      const progress = transport.inTransit
        ? Math.max(0, Math.min(1, (travelTime - transport.turnsRemaining) / travelTime))
        : 0;
      const routeIndex = Math.round(progress * (route.segments.length - 1));
      ({ tileIndex, segment } = decodeSeg(route.segments[routeIndex]));
    }
    const ft = ftByTile.get(tileIndex);
    const pos = ft ? getSegmentCentroid(ft, segment) : null;
    if (!ft || !pos) continue;
    const [sx, sy] = wts(pos.x, pos.y);
    const size = getSegmentIconSize(ft, segment, wts);
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(4, size * 0.55), 0, Math.PI * 2);
    ctx.fillStyle = factionColor(world, transport.ownerId);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(7, size * 0.8)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('T', sx, sy);
    ctx.restore();
    drawFillMeter(sx, sy, size, transport.cargo, transport.cargoCapacity);
  }
}

/**
 * Draw planned (not-yet-built) buildings as translucent grey "ghost" blocks so
 * the player can see their City Design overlaid on the map. Drawn beneath the
 * solid real buildings. Any planned segment that coincides with a real building
 * is skipped (the real one wins).
 */
export function drawPlannedBuildings(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  wts: (wx: number, wy: number) => [number, number],
): void {
  const planned = world.plannedBuildings;
  if (!planned || planned.length === 0) return;

  const actual = new Set(world.buildings.map((b) => `${b.tileIndex}:${b.segment}`));
  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  for (const b of planned) {
    if (actual.has(`${b.tileIndex}:${b.segment}`)) continue;
    const ft = ftByTile.get(b.tileIndex);
    if (!ft) continue;
    const segPos = getSegmentCentroid(ft, b.segment);
    if (!segPos) continue;

    const [sx, sy] = wts(segPos.x, segPos.y);
    const size = getSegmentIconSize(ft, b.segment, wts);
    const w = size * 1.3;
    const h = size * 1.1;

    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = 'rgba(180,180,180,0.6)';
    ctx.strokeStyle = 'rgba(230,230,230,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.rect(sx - w / 2, sy - h / 2, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - w / 2, sy - h / 2);
    ctx.lineTo(sx, sy - h);
    ctx.lineTo(sx + w / 2, sy - h / 2);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
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

// ─── Move highlight drawing ───────────────────────────────────────────────────
/**
 * Draw a movement indicator for an enemy move: a hollow circle at the origin
 * segment (where the unit started) and a dashed arrow line to the unit's
 * current position. Mirrors drawCombatHighlight but uses an amber palette so
 * a plain move is visually distinct from an attack (red attacker / cyan target).
 *
 * @param ctx        Canvas 2D context
 * @param world      Current world data
 * @param flatTiles  Visible flat tile list
 * @param unitId     Unit id that moved (or null if none)
 * @param fromTile   Tile index the unit started on (or null if none)
 * @param fromSeg    Segment the unit started on
 * @param wts        worldToScreen bound to current view params
 */
export function drawMoveHighlight(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  unitId: string | null,
  fromTile: number | null,
  fromSeg: number,
  wts: (wx: number, wy: number) => [number, number],
): void {
  if (!unitId || fromTile == null) return;

  const unit = world.units.find((u) => u.id === unitId);
  if (!unit) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  const ftFrom = ftByTile.get(fromTile);
  const ftTo   = ftByTile.get(unit.tileIndex);
  if (!ftFrom || !ftTo) return;

  const segFrom = getSegmentCentroid(ftFrom, fromSeg);
  const segTo   = getSegmentCentroid(ftTo, unit.segment);
  if (!segFrom || !segTo) return;

  const [fx, fy] = wts(segFrom.x, segFrom.y);
  const [tx, ty] = wts(segTo.x, segTo.y);
  const sizeFrom = getSegmentIconSize(ftFrom, fromSeg, wts);

  // Skip degenerate (no real displacement) indicators.
  const dx = tx - fx;
  const dy = ty - fy;
  if (dx * dx + dy * dy < 4) return;

  const AMBER = '#ffb347';

  ctx.save();

  // Origin ring — where the unit moved from
  ctx.beginPath();
  ctx.arc(fx, fy, sizeFrom * 2.0, 0, Math.PI * 2);
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();

  // Origin dot at the exact start point
  ctx.beginPath();
  ctx.arc(fx, fy, 3, 0, Math.PI * 2);
  ctx.setLineDash([]);
  ctx.fillStyle = AMBER;
  ctx.fill();

  // Dashed travel line from origin to current position
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(tx, ty);
  ctx.strokeStyle = 'rgba(255, 179, 71, 0.7)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.stroke();

  // Arrowhead at the destination end
  const angle   = Math.atan2(ty - fy, tx - fx);
  const headLen = 12;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - headLen * Math.cos(angle - 0.4), ty - headLen * Math.sin(angle - 0.4));
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - headLen * Math.cos(angle + 0.4), ty - headLen * Math.sin(angle + 0.4));
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.restore();
}
