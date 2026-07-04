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
      if (!tile.city && tile.rv === undefined && (tile.h ?? 0) >= 9) {
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
      // finish loading. City hexes instead get a road texture painted onto
      // every open (building-free) street segment.
      if (!tile.city) {
        this.fillTileTexture(ft, tile);
      } else {
        this.drawCityRoads(ft, tile);
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
    const key = tex.keyForTile(tile, this.c.world);
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
   * Paint the road/street surface on a city hex. Every segment that is NOT
   * occupied by a building is an open street.
   *
   * Road flow: the texture runs **parallel to the outer edge** of each segment
   * (edge = poly[s] → poly[(s+1)%6]). Image y=0 sits exactly on the outer edge
   * (shared boundary with the neighbour), image y=imgH reaches the hex centre.
   * Image x maps across the edge at the same pixel-per-world-unit scale so that
   * both sides of a shared boundary use the same pixels — no gap or overlap.
   *
   * A fully-open hex draws six strips that together form a small inner hexagon.
   */
  private drawCityRoads(ft: FlatTile, tile: TileData): void {
    if (tile.s !== 6 || ft.poly.length < 6) return;
    const tex = this.c.textures;
    if (!tex || !tex.ready) return;
    const img = tex.get('road');
    if (!img || img.width < 1 || img.height < 1) return;

    const occupied = new Set<number>();
    for (const b of this.c.world.buildings) {
      if (b.tileIndex === ft.tileIndex) occupied.add(b.segment);
    }
    if (occupied.size >= 6) return;

    const ctx = this.c.ctx;
    const [cx, cy] = this.c.worldToScreen(ft.cx, ft.cy);
    const ROAD_ALPHA = 0.9;

    for (let s = 0; s < 6; s++) {
      if (occupied.has(s)) continue;

      const v0 = ft.poly[s];
      const v1 = ft.poly[(s + 1) % 6];
      const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.c.worldToScreen(v1.x, v1.y);

      // --- "Along" axis: left vertex (poly[s]) → right vertex (poly[s+1]).
      // The road runs along this direction; image y maps to it.
      // Scale: edgeLen world-pixels = img.height image-pixels.
      // This means both neighbours of this shared edge use the same pixel/unit
      // ratio — they just read in opposite y-directions from the same edge.
      const edgeLen = Math.hypot(bx - ax, by - ay);
      if (edgeLen < 1e-3) continue;
      const alongX = (bx - ax) / edgeLen;
      const alongY = (by - ay) / edgeLen;

      // --- "Depth" axis: outer edge → hex centre (inward).
      // Image x maps to depth. We use the midpoint→centre vector for direction
      // but scale by edgeLen so the road width equals the road length, giving a
      // square tile that tiles cleanly.
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      let depthX = cx - mx;
      let depthY = cy - my;
      const depth = Math.hypot(depthX, depthY);
      if (depth < 1e-3) continue;
      depthX /= depth; depthY /= depth;

      // Both image axes use the same screen pixels-per-image-pixel ratio so the
      // road artwork is undistorted: 1 image pixel = edgeLen / img.height screen px.
      const scale = edgeLen / img.height;

      // image (0,0) → outer edge left vertex (ax, ay).
      // image x → depth (inward), image y → along (left→right).
      // ctx.transform(a, b, c, d, e, f):  screen = (a*ix + c*iy + e, b*ix + d*iy + f)
      const a = depthX * scale;
      const b2 = depthY * scale;
      const c2 = alongX * scale;
      const d = alongY * scale;

      // Nudge the origin 1px outside the outer edge so the clip never eats the
      // very first row of pixels — this closes hairline seams at the boundary.
      const EDGE_BLEED = 1.5; // screen px
      const ox = ax - depthX * EDGE_BLEED;
      const oy = ay - depthY * EDGE_BLEED;

      ctx.save();
      // Clip strictly to the triangular segment — this is the shape constraint.
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.clip();

      ctx.transform(a, b2, c2, d, ox, oy);
      ctx.globalAlpha = ROAD_ALPHA;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, img.width, img.height);
      ctx.restore();
    }

    // Draw pavement under building-occupied segments.
    const pavImg = tex.get('pavement');
    if (pavImg && pavImg.width >= 1) {
      const PAVE_ALPHA = 0.85;
      for (let s = 0; s < 6; s++) {
        if (!occupied.has(s)) continue;

        const v0 = ft.poly[s];
        const v1 = ft.poly[(s + 1) % 6];
        const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
        const [bx, by] = this.c.worldToScreen(v1.x, v1.y);

        const edgeLen = Math.hypot(bx - ax, by - ay);
        if (edgeLen < 1e-3) continue;
        const alongX = (bx - ax) / edgeLen;
        const alongY = (by - ay) / edgeLen;

        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        let depthX = cx - mx;
        let depthY = cy - my;
        const depth = Math.hypot(depthX, depthY);
        if (depth < 1e-3) continue;
        depthX /= depth; depthY /= depth;

        const scale = edgeLen / pavImg.height;
        const a = depthX * scale;
        const b2 = depthY * scale;
        const c2 = alongX * scale;
        const d = alongY * scale;

        const EDGE_BLEED = 1.5;
        const ox = ax - depthX * EDGE_BLEED;
        const oy = ay - depthY * EDGE_BLEED;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.closePath();
        ctx.clip();

        ctx.transform(a, b2, c2, d, ox, oy);
        ctx.globalAlpha = PAVE_ALPHA;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(pavImg, 0, 0, pavImg.width, pavImg.height);
        ctx.restore();
      }
    }
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
