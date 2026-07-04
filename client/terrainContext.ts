/**
 * terrainContext.ts — Shared state + geometry/elevation/identity helpers for
 * the terrain draw passes.
 *
 * Extracted from TerrainRenderer (P1 refactor). The water/relief/feature
 * helper classes all hold a reference to a single TerrainContext so they can
 * share the canvas context, world data, current view transform, and the
 * cross-cutting helpers (worldToScreen, neighbour lookup, elevation, …)
 * without each re-deriving them.
 */

import { WorldData, TileData } from './worldData.js';
import { baseTerrainColor, factionColor } from './colors.js';
import { FlatTile } from './localMapProjection.js';
import { TerrainTextures } from './terrainTextures.js';
import { tileHeight, HEIGHT_LEVELS } from '../shared/movementConstants.js';

export class TerrainContext {
  ctx: CanvasRenderingContext2D;
  world: WorldData;

  // Current view transform — set by LocalMapView before each render pass
  scale: number = 1;
  offsetX: number = 0;
  offsetY: number = 0;
  canvasRect: DOMRect = new DOMRect();

  // Terrain textures (loaded asynchronously; composited per tile by the renderer).
  textures: TerrainTextures | null = null;

  constructor(ctx: CanvasRenderingContext2D, world: WorldData) {
    this.ctx = ctx;
    this.world = world;
  }

  // ─── Coordinate helper (mirrors LocalMapView.worldToScreen) ────────────────

  worldToScreen(wx: number, wy: number): [number, number] {
    const w = this.canvasRect.width;
    const h = this.canvasRect.height;
    const baseScale = Math.min(w, h) * 3.5;
    const sx = w / 2 + wx * baseScale * this.scale + this.offsetX;
    const sy = h / 2 + -wy * baseScale * this.scale + this.offsetY;
    return [sx, sy];
  }

  // ─── Tile identity helpers ──────────────────────────────────────────────────

  /** Whether a tile should be treated as open water for rendering. */
  isWaterTile(tile: TileData): boolean {
    if (tile.bridge) return false;          // a bridge deck is dry crossing
    if (tile.rv !== undefined) return true; // river hexes are whole-hex water
    const terrain = String(tile.terrain ?? '').toLowerCase();
    return (
      terrain === 'ocean' ||
      terrain === 'water' ||
      terrain === 'lake'
    );
  }

  /** Base colour for feathering only; cities keep their hard faction fill. */
  terrainFillColor(tile: TileData): string {
    if (tile.city) return factionColor(this.world, tile.city);
    if ((tile.h ?? 0) >= 9) return '#cfcfcf';
    return baseTerrainColor(tile);
  }

  // ─── Elevation helpers ──────────────────────────────────────────────────────

  /** Convert terrain/elevation labels into a small continuous height scale. */
  elevationHeight(tile: TileData): number {
    // Open ocean/lake sit at the fixed sea-level relief. River hexes are water
    // too, but they descend the valley toward the sea — honour their per-tile
    // height so they don't all flatten to sea level.
    if (this.isWaterTile(tile) && tile.rv === undefined) return -0.25;
    // Map the 0–11 discrete height onto the legacy 0→1 relief scale.
    return this.height12(tile) / (HEIGHT_LEVELS - 1);
  }

  /**
   * Discrete terrain height 0–11 for a tile (band fallback when absent).
   * The authoritative scalar behind cliff-shadow strength and the contour
   * relief height drop.
   */
  height12(tile: TileData): number {
    return tileHeight(tile);
  }

  /** Convert terrain height into discrete contour levels for rendering. */
  elevationLevel(tile: TileData): number {
    const terrain = tile.terrain;
    if (terrain === 'ocean' && tile.rv === undefined) return -1;
    const h = tileHeight(tile);
    if (h >= 9) return 3;
    if (h >= 6) return 2;
    if (h >= 3) return 1;
    return 0;
  }

  /** True when this tile sits on the outer edge of an elevation threshold. */
  isContourBandTile(tileIdx: number, level: number): boolean {
    const tile = this.world.tiles[tileIdx];
    if (!tile || this.elevationLevel(tile) < level) return false;
    return tile.n.some((nIdx: number) => this.elevationLevel(this.world.tiles[nIdx]) < level);
  }

  // ─── Neighbour / geometry helpers ──────────────────────────────────────────

  /**
   * Find the neighbour that lies across a particular polygon edge.
   * Chooses the visible neighbour whose projected centre is most aligned with
   * the edge's outward direction. Falls back to tile.n[segment] if needed.
   */
  neighbourAcrossSegment(
    tile: TileData,
    ft: FlatTile,
    segment: number,
    ftByTile: Map<number, FlatTile>,
  ): TileData | null {
    if (!tile.n || tile.n.length === 0 || ft.poly.length < 6) return null;

    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const midX = (v0.x + v1.x) / 2;
    const midY = (v0.y + v1.y) / 2;
    const outX = midX - ft.cx;
    const outY = midY - ft.cy;
    const outLen = Math.sqrt(outX * outX + outY * outY);
    if (outLen < 1e-8) return null;
    const normX = outX / outLen;
    const normY = outY / outLen;

    let bestIdx = tile.n[segment % tile.n.length];
    let bestDot = -Infinity;

    for (const nIdx of tile.n) {
      const nft = ftByTile.get(nIdx);
      if (!nft) continue;

      const dx = nft.cx - ft.cx;
      const dy = nft.cy - ft.cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-8) continue;

      const dot = (dx / len) * normX + (dy / len) * normY;
      if (dot > bestDot) {
        bestDot = dot;
        bestIdx = nIdx;
      }
    }

    return this.world.tiles[bestIdx] ?? null;
  }

  /** Average screen-space radius for a visible hex. */
  screenHexRadius(ft: FlatTile): number {
    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    let radius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      radius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
    }
    return radius / Math.max(1, ft.poly.length);
  }

  /** Return the index of a tile object. Used only for renderer-side neighbour lookup. */
  tileIndexOf(tile: TileData): number {
    return this.world.tiles.indexOf(tile);
  }

  // ─── Path helpers ────────────────────────────────────────────────────────────

  /** Clip subsequent drawing to a tile polygon in screen space, optionally expanded outward. */
  clipToTile(ft: FlatTile, expandPx: number = 0): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (expandPx > 0) {
      const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
      for (let i = 0; i < ft.poly.length; i++) {
        const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
        const dx = sx - csx, dy = sy - csy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ex = sx + (dx / len) * expandPx;
        const ey = sy + (dy / len) * expandPx;
        if (i === 0) ctx.moveTo(ex, ey);
        else ctx.lineTo(ex, ey);
      }
    } else {
      for (let i = 0; i < ft.poly.length; i++) {
        const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
    }
    ctx.closePath();
    ctx.clip();
  }

  /** Screen-space polygon path for clipping/filling. */
  traceTilePath(ft: FlatTile): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < ft.poly.length; i++) {
      const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
  }
}
