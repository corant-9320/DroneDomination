/**
 * localMapTerrain.ts — Thin terrain-rendering orchestrator.
 * v6: explicitly erases same-elevation seams after polygon fills; intra-hex segment guides remain disabled.
 *
 * Extracted from LocalMapView (P1 refactor); the heavy draw passes were further
 * split out of this class into focused helpers so each concern can be edited in
 * isolation:
 *
 *   terrainContext.ts   — shared state + geometry/elevation/identity helpers
 *   terrainColor.ts     — pure hex/rgb/mix/hash colour utilities
 *   terrainWater.ts     — water boundary edges + connected-surface sheen
 *   terrainRelief.ts    — seam erasure, feathering, contour/peak/trough relief
 *   terrainFeatures.ts  — forest / vegetation icons
 *   terrainTextures.ts  — async terrain texture loader + tile mapping
 *
 * TerrainRenderer remains stateless w.r.t. game state: it holds only a canvas
 * context reference and the current view transform (via TerrainContext).
 */

import { WorldData, TileData } from './worldData.js';
import { baseTerrainColor, factionColor } from './colors.js';
import { FlatTile } from './localMapProjection.js';
import { TerrainContext } from './terrainContext.js';
import { TerrainWater } from './terrainWater.js';
import { TerrainRelief } from './terrainRelief.js';
import { TerrainFeatures } from './terrainFeatures.js';
import { TerrainTextures } from './terrainTextures.js';

// Re-exported so existing importers (`import { TerrainTextures } from
// './localMapTerrain.js'`) keep working after the split.
export { TerrainTextures } from './terrainTextures.js';

export class TerrainRenderer {
  private c: TerrainContext;
  private water: TerrainWater;
  private relief: TerrainRelief;
  private features: TerrainFeatures;

  constructor(ctx: CanvasRenderingContext2D, world: WorldData) {
    this.c = new TerrainContext(ctx, world);
    this.water = new TerrainWater(this.c);
    this.relief = new TerrainRelief(this.c);
    this.features = new TerrainFeatures(this.c);
  }

  /** Update the view transform to match the current LocalMapView state. */
  setViewTransform(
    scale: number,
    offsetX: number,
    offsetY: number,
    canvasRect: DOMRect,
  ): void {
    this.c.scale = scale;
    this.c.offsetX = offsetX;
    this.c.offsetY = offsetY;
    this.c.canvasRect = canvasRect;
  }

  /** Update world reference (called when world is replaced after combat). */
  setWorld(world: WorldData): void {
    this.c.world = world;
  }

  /** Provide loaded terrain textures (composited per tile in drawAllTiles). */
  setTextures(textures: TerrainTextures): void {
    this.c.textures = textures;
  }

  /** Whether a tile should be treated as open water for rendering. */
  isWaterTile(tile: TileData): boolean {
    return this.c.isWaterTile(tile);
  }

  // ─── Public draw entry point ────────────────────────────────────────────────

  /**
   * Draw all tile polygons (fills, overlays, contours, water, forest).
   * Call this once per render frame after clearing the canvas background.
   */
  drawAllTiles(
    flatTiles: FlatTile[],
    selectedTile: number,
    selectedSegment: number,
  ): void {
    const ctx = this.c.ctx;

    // Build a visible tile lookup once so terrain shading can compare each
    // triangle with the neighbouring hex across that edge.
    const ftByTile = new Map<number, FlatTile>();
    for (const ft of flatTiles) {
      ftByTile.set(ft.tileIndex, ft);
    }

    // Draw each tile as its actual boundary polygon
    for (const ft of flatTiles) {
      const tile = this.c.world.tiles[ft.tileIndex];
      let color = baseTerrainColor(tile);
      // Mountains are deliberately light grey rather than white so the
      // leading-edge contour highlights remain visible against them.
      // River hexes keep their water colour even on high ground.
      if (!tile.city && tile.rv === undefined && (tile.elevType === 'mountain' || tile.terrain === 'mountain')) {
        color = '#cfcfcf';
      }
      if (tile.city) {
        color = factionColor(this.c.world, tile.city);
      }

      // Draw boundary polygon fill.
      ctx.beginPath();
      for (let i = 0; i < ft.poly.length; i++) {
        const [sx, sy] = this.c.worldToScreen(ft.poly[i].x, ft.poly[i].y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      // Composite the terrain texture over the solid fill (cities keep their
      // hard faction colour). The solid fill remains a fallback until textures
      // finish loading.
      if (!tile.city) {
        this.fillTileTexture(ft, tile);
      }

      if (this.c.isWaterTile(tile)) {
        this.water.drawBoundaryEdges(ft, tile, ftByTile);
      }

      // v5: do not draw ordinary land hex outlines or intra-hex segment guides.
      // Height information now comes only from organic elevation relief between
      // different elevation levels. Same-height neighbours intentionally merge
      // into larger continuous landforms instead of reading as individual cells.

      // Draw tree icons in each corner of forested hexes
      if (tile.f && tile.s === 6) {
        this.features.drawForestCornerTrees(ft);
      }

      // Highlight selected segment (triangle overlay)
      if (ft.tileIndex === selectedTile && selectedSegment >= 0 && tile.s === 6) {
        this.drawSegmentHighlight(ft, selectedSegment);
      } else if (ft.tileIndex === selectedTile && selectedSegment < 0) {
        // No specific segment selected — outline the whole tile
        ctx.beginPath();
        for (let i = 0; i < ft.poly.length; i++) {
          const [sx, sy] = this.c.worldToScreen(ft.poly[i].x, ft.poly[i].y);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // City label
      if (tile.city) {
        const city = this.c.world.cities.find((c) => c.id === tile.city);
        if (city) {
          const [sx, sy] = this.c.worldToScreen(ft.cx, ft.cy);
          ctx.fillStyle = '#000';
          ctx.font = 'bold 10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(city.label, sx, sy);
        }
      }
    }

    // Same-elevation seam pass — after all tiles are filled.
    // Canvas anti-aliasing can leave hairline hex boundaries even when no
    // outline is stroked. Cover those internal same-height edges before the
    // relief passes so only real elevation transitions remain visible.
    this.relief.eraseSameElevationInternalEdges(ftByTile);

    // Water sheen pass — after all tiles are filled and internal water seams are hidden.
    this.water.drawSurfaceLighting(ftByTile);

    // Terrain relief passes
    this.relief.drawFeathering(ftByTile);
    this.relief.drawContourRelief(ftByTile);
  }

  // ─── Selection overlays ─────────────────────────────────────────────────────

  /**
   * Composite a tile's terrain texture, clipped to its hex polygon and scaled
   * to cover the polygon's screen-space bounding box. No-op until textures are
   * provided via {@link setTextures} and finished loading.
   */
  private fillTileTexture(ft: FlatTile, tile: TileData): void {
    const tex = this.c.textures;
    if (!tex || !tex.ready) return;
    const key = tex.keyForTile(tile);
    const img = key ? tex.get(key) : undefined;
    if (!img) return;

    // Expand the bounding box by 2px on each side so the image covers the
    // antialiased fringe at the polygon edge, preventing the base fill from
    // showing through as a seam.
    const expand = 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ft.poly) {
      const [sx, sy] = this.c.worldToScreen(p.x, p.y);
      if (sx < minX) minX = sx;
      if (sy < minY) minY = sy;
      if (sx > maxX) maxX = sx;
      if (sy > maxY) maxY = sy;
    }
    minX -= expand; minY -= expand; maxX += expand; maxY += expand;
    const w = maxX - minX;
    const h = maxY - minY;
    if (!(w > 0) || !(h > 0)) return;

    // Wash textures out: composite at reduced opacity so the solid biome fill
    // shows through and the artwork reads as a subtle overlay rather than a
    // strong, saturated surface.
    const TEXTURE_WASH_ALPHA = 0.45;

    const ctx = this.c.ctx;
    ctx.save();
    this.c.clipToTile(ft, expand);
    if (key === 'hillsPlains') {
      ctx.globalAlpha = TEXTURE_WASH_ALPHA * 0.8;
      ctx.drawImage(img, minX, minY, w, h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(232,206,120,0.30)';
      ctx.fillRect(minX, minY, w, h);
    } else {
      ctx.globalAlpha = TEXTURE_WASH_ALPHA;
      ctx.drawImage(img, minX, minY, w, h);
    }
    ctx.restore();
  }

  /**
   * Segment dividers are intentionally disabled in the organic terrain view.
   * Keeping this method as a no-op preserves compatibility with any callers
   * while ensuring intra-hex construction lines never compete with relief.
   */
  drawSegmentLines(_ft: FlatTile): void {
    return;
  }

  /**
   * Draw a highlighted triangle for a selected segment.
   * Segment i = triangle(centre, boundary[i], boundary[(i+1)%6]).
   */
  drawSegmentHighlight(ft: FlatTile, segment: number): void {
    if (ft.poly.length < 6) return;
    const ctx = this.c.ctx;
    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const [cx, cy]   = this.c.worldToScreen(ft.cx, ft.cy);
    const [sx0, sy0] = this.c.worldToScreen(v0.x, v0.y);
    const [sx1, sy1] = this.c.worldToScreen(v1.x, v1.y);

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.closePath();

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
