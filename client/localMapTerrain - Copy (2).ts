/**
 * localMapTerrain.ts — All terrain fill / shading / contour / water / forest drawing.
 * v4: organic sun-position relief; centreline contours removed; softened non-faceted peaks.
 *
 * Extracted from LocalMapView (P1 refactor).
 * TerrainRenderer is a stateless class: it holds only a canvas context reference
 * and the current view transform. No game-state is stored here.
 */

import { WorldData, TileData } from './worldData.js';
import { baseTerrainColor, factionColor } from './colors.js';
import { FlatTile } from './localMapProjection.js';

export class TerrainRenderer {
  private ctx: CanvasRenderingContext2D;
  private world: WorldData;

  // Current view transform — set by LocalMapView before each render pass
  private scale: number = 1;
  private offsetX: number = 0;
  private offsetY: number = 0;
  private canvasRect: DOMRect = new DOMRect();

  constructor(ctx: CanvasRenderingContext2D, world: WorldData) {
    this.ctx = ctx;
    this.world = world;
  }

  /** Update the view transform to match the current LocalMapView state. */
  setViewTransform(
    scale: number,
    offsetX: number,
    offsetY: number,
    canvasRect: DOMRect,
  ): void {
    this.scale = scale;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.canvasRect = canvasRect;
  }

  /** Update world reference (called when world is replaced after combat). */
  setWorld(world: WorldData): void {
    this.world = world;
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
    // Build a visible tile lookup once so terrain shading can compare each
    // triangle with the neighbouring hex across that edge.
    const ftByTile = new Map<number, FlatTile>();
    for (const ft of flatTiles) {
      ftByTile.set(ft.tileIndex, ft);
    }

    // Draw each tile as its actual boundary polygon
    for (const ft of flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      let color = baseTerrainColor(tile);
      // Mountains are deliberately light grey rather than white so the
      // leading-edge contour highlights remain visible against them.
      if (!tile.city && (tile.elevType === 'mountain' || tile.terrain === 'mountain')) {
        color = '#cfcfcf';
      }
      if (tile.city) {
        color = factionColor(this.world, tile.city);
      }

      // Draw boundary polygon
      this.ctx.beginPath();
      for (let i = 0; i < ft.poly.length; i++) {
        const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
        if (i === 0) this.ctx.moveTo(sx, sy);
        else this.ctx.lineTo(sx, sy);
      }
      this.ctx.closePath();
      this.ctx.fillStyle = color;
      this.ctx.fill();

      if (this.isWaterTile(tile)) {
        this.drawWaterBoundaryEdges(ft, tile, ftByTile);
      } else {
        // Keep the ordinary hex grid quiet; elevation relief is drawn later.
        this.ctx.strokeStyle = 'rgba(0,0,0,0.045)';
        this.ctx.lineWidth = 0.35;
        this.ctx.stroke();
      }

      // Draw faint dotted segment dividers on land hexes only
      if (tile.s === 6 && !this.isWaterTile(tile)) {
        this.drawSegmentLines(ft);
      }

      // Draw tree icons in each corner of forested hexes
      if (tile.f && tile.s === 6) {
        this.drawForestCornerTrees(ft);
      }

      // Highlight selected segment (triangle overlay)
      if (ft.tileIndex === selectedTile && selectedSegment >= 0 && tile.s === 6) {
        this.drawSegmentHighlight(ft, selectedSegment);
      } else if (ft.tileIndex === selectedTile && selectedSegment < 0) {
        // No specific segment selected — outline the whole tile
        this.ctx.beginPath();
        for (let i = 0; i < ft.poly.length; i++) {
          const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
          if (i === 0) this.ctx.moveTo(sx, sy);
          else this.ctx.lineTo(sx, sy);
        }
        this.ctx.closePath();
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
      }

      // City label
      if (tile.city) {
        const city = this.world.cities.find((c) => c.id === tile.city);
        if (city) {
          const [sx, sy] = this.worldToScreen(ft.cx, ft.cy);
          this.ctx.fillStyle = '#000';
          this.ctx.font = 'bold 10px sans-serif';
          this.ctx.textAlign = 'center';
          this.ctx.textBaseline = 'middle';
          this.ctx.fillText(city.label, sx, sy);
        }
      }
    }

    // Water sheen pass — after all tiles are filled
    this.drawWaterSurfaceLighting(ftByTile);

    // Terrain relief passes
    this.drawTerrainFeathering(ftByTile);
    this.drawContourRelief(ftByTile);
  }

  // ─── Coordinate helper (mirrors LocalMapView.worldToScreen) ────────────────

  private worldToScreen(wx: number, wy: number): [number, number] {
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
    const terrain = String(tile.terrain ?? '').toLowerCase();
    const elev = String(tile.elevType ?? '').toLowerCase();
    return (
      terrain === 'ocean' ||
      terrain === 'water' ||
      terrain === 'lake' ||
      elev === 'ocean' ||
      elev === 'water' ||
      elev === 'lake'
    );
  }

  /** Base colour for feathering only; cities keep their hard faction fill. */
  private terrainFillColor(tile: TileData): string {
    if (tile.city) return factionColor(this.world, tile.city);
    if (tile.elevType === 'mountain' || tile.terrain === 'mountain') return '#cfcfcf';
    return baseTerrainColor(tile);
  }

  // ─── Elevation helpers ──────────────────────────────────────────────────────

  /** Convert terrain/elevation labels into a small continuous height scale. */
  private elevationHeight(tile: TileData): number {
    const elev = tile.elevType ?? tile.terrain;
    switch (elev) {
      case 'ocean':    return -0.25;
      case 'flat':     return 0.0;
      case 'rolling':  return 0.28;
      case 'hills':    return 0.58;
      case 'mountain': return 1.0;
      default:
        if (tile.terrain === 'ocean')    return -0.25;
        if (tile.terrain === 'hills')    return 0.58;
        if (tile.terrain === 'mountain') return 1.0;
        return 0.0;
    }
  }

  /** Convert elevation labels into discrete contour levels. */
  private elevationLevel(tile: TileData): number {
    const elev = tile.elevType ?? tile.terrain;
    switch (elev) {
      case 'ocean':    return -1;
      case 'flat':     return 0;
      case 'rolling':  return 1;
      case 'hills':    return 2;
      case 'mountain': return 3;
      default:
        if (tile.terrain === 'ocean')    return -1;
        if (tile.terrain === 'hills')    return 2;
        if (tile.terrain === 'mountain') return 3;
        return 0;
    }
  }

  /** True when this tile sits on the outer edge of an elevation threshold. */
  private isContourBandTile(tileIdx: number, level: number): boolean {
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
  private neighbourAcrossSegment(
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
  private screenHexRadius(ft: FlatTile): number {
    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    let radius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      radius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
    }
    return radius / Math.max(1, ft.poly.length);
  }

  // ─── Color helpers ──────────────────────────────────────────────────────────

  /** Convert a #rrggbb colour into RGB components. */
  private hexToRgb(color: string): { r: number; g: number; b: number } | null {
    const match = color.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255,
    };
  }

  /** Blend two CSS hex colours. Falls back to the first colour if parsing fails. */
  private mixHexColors(a: string, b: string, t: number): string {
    const ca = this.hexToRgb(a);
    const cb = this.hexToRgb(b);
    if (!ca || !cb) return a;
    const clamped = Math.max(0, Math.min(1, t));
    const r  = Math.round(ca.r + (cb.r - ca.r) * clamped);
    const g  = Math.round(ca.g + (cb.g - ca.g) * clamped);
    const bl = Math.round(ca.b + (cb.b - ca.b) * clamped);
    return `rgb(${r},${g},${bl})`;
  }

  /** Deterministic pseudo-random helper for tiny water-sparkle placement. */
  private hash01(n: number): number {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  // ─── Clip helper ────────────────────────────────────────────────────────────

  /** Clip subsequent drawing to a tile polygon in screen space. */
  private clipToTile(ft: FlatTile): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < ft.poly.length; i++) {
      const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.clip();
  }

  // ─── Water rendering ────────────────────────────────────────────────────────

  /** Draw only the boundary edges where water meets land or the map edge. */
  private drawWaterBoundaryEdges(
    ft: FlatTile,
    tile: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 3) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(4,18,30,0.22)';
    ctx.lineWidth = 0.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let seg = 0; seg < ft.poly.length; seg++) {
      const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
      if (neighbour && this.isWaterTile(neighbour)) continue;

      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];
      const [ax, ay] = this.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.worldToScreen(v1.x, v1.y);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Draw connected water bodies as one uniform reflective surface.
   * Water should not show per-hex lighting, random shimmer strokes, contour
   * shading, or tactical texture. Each connected lake/sea is clipped as one
   * shape and receives a single broad reflection.
   */
  private drawWaterSurfaceLighting(ftByTile: Map<number, FlatTile>): void {
    const waterSet = new Set<number>();
    for (const [tileIdx] of ftByTile) {
      if (this.isWaterTile(this.world.tiles[tileIdx])) {
        waterSet.add(tileIdx);
      }
    }
    if (waterSet.size === 0) return;

    const visited = new Set<number>();
    const components: FlatTile[][] = [];

    for (const startIdx of waterSet) {
      if (visited.has(startIdx)) continue;

      const component: FlatTile[] = [];
      const queue: number[] = [startIdx];
      visited.add(startIdx);

      while (queue.length > 0) {
        const idx = queue.shift()!;
        const ft = ftByTile.get(idx);
        if (ft) component.push(ft);

        const tile = this.world.tiles[idx];
        for (const nIdx of tile.n) {
          if (!waterSet.has(nIdx) || visited.has(nIdx)) continue;
          visited.add(nIdx);
          queue.push(nIdx);
        }
      }

      if (component.length > 0) components.push(component);
    }

    const ctx = this.ctx;
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const REFLECT_X = -SUN_X;
    const REFLECT_Y = -SUN_Y;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (const component of components) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      ctx.save();
      ctx.beginPath();

      for (const ft of component) {
        for (let i = 0; i < ft.poly.length; i++) {
          const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
          minX = Math.min(minX, sx);
          minY = Math.min(minY, sy);
          maxX = Math.max(maxX, sx);
          maxY = Math.max(maxY, sy);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
      }

      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        ctx.restore();
        continue;
      }

      ctx.clip();

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const span = Math.sqrt(w * w + h * h);
      const pad = span * 0.25;

      const sheen = ctx.createLinearGradient(
        cx + SUN_X * span * 0.55,
        cy + SUN_Y * span * 0.55,
        cx + REFLECT_X * span * 0.55,
        cy + REFLECT_Y * span * 0.55,
      );
      sheen.addColorStop(0.00, 'rgba(255,255,245,0.210)');
      sheen.addColorStop(0.20, 'rgba(255,255,245,0.110)');
      sheen.addColorStop(0.52, 'rgba(255,255,245,0.018)');
      sheen.addColorStop(1.00, 'rgba(0,15,34,0.120)');
      ctx.fillStyle = sheen;
      ctx.fillRect(minX - pad, minY - pad, w + pad * 2, h + pad * 2);

      ctx.save();
      ctx.translate(cx + SUN_X * w * 0.16, cy + SUN_Y * h * 0.16);
      ctx.rotate(Math.atan2(REFLECT_Y, REFLECT_X));
      ctx.scale(Math.max(1, w * 0.72), Math.max(1, h * 0.34));
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      glow.addColorStop(0.00, 'rgba(255,255,245,0.150)');
      glow.addColorStop(0.38, 'rgba(255,255,245,0.060)');
      glow.addColorStop(1.00, 'rgba(255,255,245,0.000)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.restore();
    }

    ctx.restore();
  }

  // ─── Terrain feathering ─────────────────────────────────────────────────────

  /**
   * Soften hard biome edges by washing a mixed colour along shared borders.
   * Low-alpha pass: map remains readable as hexes, but adjacent terrain no
   * longer looks like cut paper.
   */
  private drawTerrainFeathering(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const ft of ftByTile.values()) {
      const tile = this.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      const color = this.terrainFillColor(tile);

      for (let seg = 0; seg < ft.poly.length; seg++) {
        const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
        if (!neighbour) continue;
        const neighbourIdx = this.world.tiles.indexOf(neighbour);
        if (neighbourIdx >= 0 && ft.tileIndex > neighbourIdx) continue;

        const nColor = this.terrainFillColor(neighbour);
        if (
          nColor === color &&
          neighbour.terrain === tile.terrain &&
          neighbour.elevType === tile.elevType
        ) continue;

        const v0 = ft.poly[seg];
        const v1 = ft.poly[(seg + 1) % ft.poly.length];
        const [ax, ay] = this.worldToScreen(v0.x, v0.y);
        const [bx, by] = this.worldToScreen(v1.x, v1.y);

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = this.mixHexColors(color, nColor, 0.5);
        ctx.globalAlpha = 0.13;
        ctx.lineWidth = 10;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ─── Contour relief ─────────────────────────────────────────────────────────

  /** Return the index of a tile object. Used only for renderer-side neighbour lookup. */
  private tileIndexOf(tile: TileData): number {
    return this.world.tiles.indexOf(tile);
  }

  /** Screen-space polygon path for clipping/filling. */
  private traceTilePath(ft: FlatTile): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < ft.poly.length; i++) {
      const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
  }

  /**
   * Draw a broad, rounded edge wash instead of a rectangular quad.
   * A blurred stroke keeps the original contrast but removes the hard blocky band.
   */
  private strokeOrganicEdgeWash(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    offsetX: number,
    offsetY: number,
    width: number,
    color: string,
    blur: number,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax + offsetX, ay + offsetY);
    ctx.lineTo(bx + offsetX, by + offsetY);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Soft organic relief for a high/low boundary.
   *
   * The previous implementation used rectangular gradient bands. This keeps the
   * same sun-vector intensity, but paints the light and shadow as clipped,
   * blurred strokes following the shared hex edge, so the result reads like
   * terrain relief rather than a blocky overlay.
   */
  private drawContourEdgeRelief(
    ft: FlatTile,
    tile: TileData,
    segment: number,
    level: number,
    neighbour: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const ctx = this.ctx;
    const SUN_X = -0.707;
    const SUN_Y = -0.707;

    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const [ax, ay] = this.worldToScreen(v0.x, v0.y);
    const [bx, by] = this.worldToScreen(v1.x, v1.y);
    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);

    const midX = (ax + bx) / 2;
    const midY = (ay + by) / 2;
    const outX = midX - csx;
    const outY = midY - csy;
    const outLen = Math.sqrt(outX * outX + outY * outY);
    if (outLen < 1e-6) return;

    const nx = outX / outLen;       // from high tile centre towards the lower side
    const ny = outY / outLen;
    const highNx = -nx;             // back into the high tile
    const highNy = -ny;

    const ownLevel = this.elevationLevel(tile);
    const neighbourLevel = this.elevationLevel(neighbour);
    const heightDrop = Math.max(1, ownLevel - neighbourLevel);
    const radius = this.screenHexRadius(ft);

    const strength = Math.min(1, 0.36 + heightDrop * 0.22 + level * 0.08);
    const edgeFacesSun = nx * SUN_X + ny * SUN_Y;
    const awayFromSun = Math.max(0, -edgeFacesSun);
    const towardSun = Math.max(0, edgeFacesSun);

    const neighbourIdx = this.tileIndexOf(neighbour);
    const nft = neighbourIdx >= 0 ? ftByTile.get(neighbourIdx) : undefined;

    const broadWidth = Math.max(7, radius * (0.42 + heightDrop * 0.055));
    const tightWidth = Math.max(2.5, radius * (0.060 + heightDrop * 0.012));
    const blur = Math.max(0.65, radius * 0.030);
    const broadOffset = Math.max(1.5, radius * 0.055);
    const lipOffset = Math.max(0.8, radius * 0.022);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Lower-side shadow: clipped to the lower tile when visible. This keeps the
    // falloff directional without drawing a rectangular extrusion beyond the edge.
    if (awayFromSun > 0.04) {
      const shadowAlpha = Math.min(0.66, (0.38 + level * 0.070) * strength * awayFromSun);
      const tightAlpha = Math.min(0.44, shadowAlpha * 0.58);

      ctx.save();
      if (nft) this.clipToTile(nft);
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        nx * broadOffset, ny * broadOffset,
        broadWidth,
        `rgba(5,8,14,${shadowAlpha.toFixed(3)})`,
        blur,
      );
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        nx * lipOffset, ny * lipOffset,
        tightWidth,
        `rgba(0,0,0,${tightAlpha.toFixed(3)})`,
        Math.max(0.25, blur * 0.35),
      );
      ctx.restore();
    }

    // High-side highlight: clipped to the high tile and nudged inward. This
    // preserves the original sun-position lighting but avoids a hard rectangle.
    if (towardSun > 0.04) {
      const highlightAlpha = Math.min(0.74, (0.46 + level * 0.084) * strength * towardSun);
      const rimAlpha = Math.min(0.50, highlightAlpha * 0.62);

      ctx.save();
      this.clipToTile(ft);
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        highNx * broadOffset, highNy * broadOffset,
        broadWidth * 0.90,
        `rgba(255,252,218,${highlightAlpha.toFixed(3)})`,
        blur,
      );
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        highNx * lipOffset, highNy * lipOffset,
        tightWidth,
        `rgba(255,255,240,${rimAlpha.toFixed(3)})`,
        Math.max(0.25, blur * 0.30),
      );
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Draw organic height relief on real elevation boundaries only.
   * Centre-to-centre contour traces are deliberately omitted for this style.
   */
  private drawContourRelief(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // First pass: relief on actual high/low hex boundaries.
    for (let level = 1; level <= 3; level++) {
      for (const ft of ftByTile.values()) {
        const tile = this.world.tiles[ft.tileIndex];
        if (tile.s !== 6 || this.elevationLevel(tile) < level || ft.poly.length < 6) continue;

        for (let seg = 0; seg < ft.poly.length; seg++) {
          const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
          if (!neighbour || this.elevationLevel(neighbour) >= level) continue;
          this.drawContourEdgeRelief(ft, tile, seg, level, neighbour, ftByTile);
        }
      }
    }

    // Second pass: softened local peaks/troughs with continuous gradients rather
    // than segment-by-segment triangular facets.
    for (const ft of ftByTile.values()) {
      const tile = this.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      this.drawPeakOrganicRelief(ft, tile);
      this.drawSingleHexRelief(ft, tile);
    }

    ctx.restore();
  }

  /**
   * Smooth summit relief for local high points.
   * Keeps the original peak cue, but uses clipped whole-hex gradients so the
   * result is rounded instead of a six-sided pyramid.
   */
  private drawPeakOrganicRelief(ft: FlatTile, tile: TileData): void {
    if (ft.poly.length < 6) return;

    const ownLevel = this.elevationLevel(tile);
    if (ownLevel <= 0) return;

    const neighbourLevels = tile.n.map((nIdx: number) => this.elevationLevel(this.world.tiles[nIdx]));
    const lowerCount = neighbourLevels.filter((h) => h < ownLevel).length;
    if (lowerCount < 4) return;

    const maxDrop = Math.max(0, ...neighbourLevels.map((h) => ownLevel - h));
    const peakStrength = Math.min(1, 0.56 + (lowerCount - 4) * 0.15 + maxDrop * 0.12);

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    const radius = this.screenHexRadius(ft);
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const ctx = this.ctx;

    const lightAlpha = Math.min(0.40, (0.16 + ownLevel * 0.055) * peakStrength);
    const shadowAlpha = Math.min(0.46, (0.18 + ownLevel * 0.060) * peakStrength);
    const domeAlpha = Math.min(0.16, (0.06 + ownLevel * 0.020) * peakStrength);

    ctx.save();
    this.clipToTile(ft);
    ctx.globalCompositeOperation = 'source-over';

    // Broad light from the sun side.
    const lightGrad = ctx.createRadialGradient(
      csx + SUN_X * radius * 0.42,
      csy + SUN_Y * radius * 0.42,
      radius * 0.06,
      csx + SUN_X * radius * 0.18,
      csy + SUN_Y * radius * 0.18,
      radius * 1.25,
    );
    lightGrad.addColorStop(0.00, `rgba(255,252,220,${lightAlpha.toFixed(3)})`);
    lightGrad.addColorStop(0.44, `rgba(255,252,220,${(lightAlpha * 0.28).toFixed(3)})`);
    lightGrad.addColorStop(1.00, 'rgba(255,252,220,0.000)');
    ctx.fillStyle = lightGrad;
    this.traceTilePath(ft);
    ctx.fill();

    // Broad shadow on the lee side.
    const shadowGrad = ctx.createRadialGradient(
      csx - SUN_X * radius * 0.55,
      csy - SUN_Y * radius * 0.55,
      radius * 0.02,
      csx - SUN_X * radius * 0.20,
      csy - SUN_Y * radius * 0.20,
      radius * 1.22,
    );
    shadowGrad.addColorStop(0.00, `rgba(7,12,22,${shadowAlpha.toFixed(3)})`);
    shadowGrad.addColorStop(0.48, `rgba(7,12,22,${(shadowAlpha * 0.30).toFixed(3)})`);
    shadowGrad.addColorStop(1.00, 'rgba(7,12,22,0.000)');
    ctx.fillStyle = shadowGrad;
    this.traceTilePath(ft);
    ctx.fill();

    // Soft central dome, very low alpha, to prevent the hex reading as a flat plate.
    const dome = ctx.createRadialGradient(csx, csy, 0, csx, csy, radius * 0.85);
    dome.addColorStop(0.00, `rgba(255,252,225,${domeAlpha.toFixed(3)})`);
    dome.addColorStop(0.45, `rgba(255,252,225,${(domeAlpha * 0.38).toFixed(3)})`);
    dome.addColorStop(1.00, 'rgba(255,252,225,0.000)');
    ctx.fillStyle = dome;
    this.traceTilePath(ft);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Smooth relief for one-hex local troughs. Kept subtle, but continuous.
   */
  private drawSingleHexRelief(ft: FlatTile, tile: TileData): void {
    if (ft.poly.length < 6) return;

    const ownLevel = this.elevationLevel(tile);
    const neighbourLevels = tile.n.map((nIdx: number) => this.elevationLevel(this.world.tiles[nIdx]));
    const isTrough = neighbourLevels.every((h) => h > ownLevel);
    if (!isTrough) return;

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    const radius = this.screenHexRadius(ft);
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const level = Math.max(1, Math.min(3, Math.max(...neighbourLevels) - ownLevel));
    const ctx = this.ctx;

    ctx.save();
    this.clipToTile(ft);

    const shadowAlpha = Math.min(0.34, 0.16 + level * 0.055);
    const lightAlpha = Math.min(0.24, 0.10 + level * 0.035);

    const shadow = ctx.createRadialGradient(
      csx + SUN_X * radius * 0.18,
      csy + SUN_Y * radius * 0.18,
      radius * 0.08,
      csx,
      csy,
      radius * 0.95,
    );
    shadow.addColorStop(0.00, `rgba(8,13,24,${shadowAlpha.toFixed(3)})`);
    shadow.addColorStop(0.55, `rgba(8,13,24,${(shadowAlpha * 0.35).toFixed(3)})`);
    shadow.addColorStop(1.00, 'rgba(8,13,24,0.000)');
    ctx.fillStyle = shadow;
    this.traceTilePath(ft);
    ctx.fill();

    const rim = ctx.createRadialGradient(
      csx - SUN_X * radius * 0.45,
      csy - SUN_Y * radius * 0.45,
      radius * 0.04,
      csx - SUN_X * radius * 0.20,
      csy - SUN_Y * radius * 0.20,
      radius * 1.10,
    );
    rim.addColorStop(0.00, `rgba(255,250,220,${lightAlpha.toFixed(3)})`);
    rim.addColorStop(0.46, `rgba(255,250,220,${(lightAlpha * 0.25).toFixed(3)})`);
    rim.addColorStop(1.00, 'rgba(255,250,220,0.000)');
    ctx.fillStyle = rim;
    this.traceTilePath(ft);
    ctx.fill();

    ctx.restore();
  }

  // ─── Forest rendering ───────────────────────────────────────────────────────

  /**
   * Draw a small tree icon at a given screen position.
   */
  private drawTreeIcon(sx: number, sy: number, size: number): void {
    const ctx = this.ctx;
    const trunkH  = size * 0.4;
    const trunkW  = size * 0.18;
    const canopyH = size * 1.1;
    const canopyW = size * 0.85;

    ctx.save();

    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(sx - trunkW / 2, sy - trunkH, trunkW, trunkH);

    ctx.beginPath();
    ctx.moveTo(sx, sy - trunkH - canopyH);
    ctx.lineTo(sx - canopyW / 2, sy - trunkH);
    ctx.lineTo(sx + canopyW / 2, sy - trunkH);
    ctx.closePath();
    ctx.fillStyle = '#1a5c1a';
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw a small tree icon in each corner (boundary vertex) of a forested hex.
   * Trees are placed slightly inward from each vertex toward the hex centre,
   * scaled to fit without overlapping the segment dividers.
   */
  private drawForestCornerTrees(ft: FlatTile): void {
    if (ft.poly.length < 6) return;

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      const dx = vx - csx;
      const dy = vy - csy;
      avgRadius += Math.sqrt(dx * dx + dy * dy);
    }
    avgRadius /= ft.poly.length;

    if (avgRadius < 8) return;

    const treeSize = Math.max(2, avgRadius * 0.22);
    const inset = 0.62;

    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      const tx = vx + (csx - vx) * (1 - inset);
      const ty = vy + (csy - vy) * (1 - inset);
      this.drawTreeIcon(tx, ty, treeSize);
    }
  }

  // ─── Hex line rendering ─────────────────────────────────────────────────────

  /**
   * Draw faint dotted segment dividers from hex centre to each boundary vertex.
   */
  drawSegmentLines(ft: FlatTile): void {
    const [cx, cy] = this.worldToScreen(ft.cx, ft.cy);
    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    this.ctx.lineWidth = 0.45;
    this.ctx.setLineDash([3, 5]);

    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      this.ctx.beginPath();
      this.ctx.moveTo(cx, cy);
      this.ctx.lineTo(vx, vy);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  /**
   * Draw a highlighted triangle for a selected segment.
   * Segment i = triangle(centre, boundary[i], boundary[(i+1)%6]).
   */
  drawSegmentHighlight(ft: FlatTile, segment: number): void {
    if (ft.poly.length < 6) return;
    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const [cx, cy]   = this.worldToScreen(ft.cx, ft.cy);
    const [sx0, sy0] = this.worldToScreen(v0.x, v0.y);
    const [sx1, sy1] = this.worldToScreen(v1.x, v1.y);

    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy);
    this.ctx.lineTo(sx0, sy0);
    this.ctx.lineTo(sx1, sy1);
    this.ctx.closePath();

    this.ctx.fillStyle = 'rgba(255,255,255,0.25)';
    this.ctx.fill();
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  // ─── Elevation shading (unused direct call, but kept for completeness) ──────

  /**
   * Draw elevation shading using a local height field.
   * This method is available for future use but is currently not called from
   * drawAllTiles (elevation is handled by drawContourRelief instead).
   */
  drawElevationShading(
    ft: FlatTile,
    tile: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);

    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      avgRadius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
    }
    avgRadius /= ft.poly.length;
    if (avgRadius < 5) return;

    const SUN_X = -0.707;
    const SUN_Y = -0.707;

    const centreHeight = this.elevationHeight(tile);

    let peakPull: number;
    let litAlpha: number;
    let shadowAlpha: number;

    switch (tile.elevType) {
      case 'rolling':
        peakPull = 0.18; litAlpha = 0.27; shadowAlpha = 0.18;
        break;
      case 'hills':
        peakPull = 0.38; litAlpha = 0.57; shadowAlpha = 0.36;
        break;
      case 'mountain':
      default:
        peakPull = 0.62; litAlpha = 0.93; shadowAlpha = 0.63;
        break;
    }

    const ctx = this.ctx;
    ctx.save();

    for (let seg = 0; seg < ft.poly.length; seg++) {
      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];

      const [ax, ay] = this.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.worldToScreen(v1.x, v1.y);

      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const outX = midX - csx;
      const outY = midY - csy;
      const outLen = Math.sqrt(outX * outX + outY * outY);
      if (outLen < 1e-6) continue;
      const normX = outX / outLen;
      const normY = outY / outLen;

      const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
      const neighbourHeight = neighbour ? this.elevationHeight(neighbour) : centreHeight;
      const heightDelta = centreHeight - neighbourHeight;

      const slopeSign = Math.abs(heightDelta) < 0.03 ? 1 : Math.sign(heightDelta);
      const sunFacing = (normX * SUN_X + normY * SUN_Y) * slopeSign;

      const slopeStrength = Math.min(1, Math.abs(heightDelta) * 1.8 + centreHeight * 0.25);
      const dot = sunFacing * (0.35 + 0.65 * slopeStrength);

      const neighbourPull = heightDelta < -0.03 ? Math.min(0.18, Math.abs(heightDelta) * 0.12) : 0;
      const facePeakPull = Math.min(0.78, peakPull + neighbourPull);
      const apexX = csx + (midX - csx) * facePeakPull;
      const apexY = csy + (midY - csy) * facePeakPull;

      const grad = ctx.createLinearGradient(apexX, apexY, midX, midY);

      if (dot >= 0) {
        const a = dot * litAlpha;
        grad.addColorStop(0,    `rgba(255,252,240,${(a * 1.0).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(255,252,240,${(a * 0.35).toFixed(3)})`);
        grad.addColorStop(1,    'rgba(255,252,240,0.00)');
      } else {
        const a = (-dot) * shadowAlpha;
        grad.addColorStop(0,    `rgba(20,30,50,${(a * 1.0).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(20,30,50,${(a * 0.55).toFixed(3)})`);
        grad.addColorStop(1,    'rgba(20,30,50,0.00)');
      }

      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      const relief = Math.min(1, Math.abs(heightDelta) * 2.0 + centreHeight * 0.15);
      const ridgeAlpha = dot >= 0
        ? dot * relief * (tile.elevType === 'mountain' ? 0.63 : tile.elevType === 'hills' ? 0.36 : 0.18)
        : 0.038 * relief;
      ctx.strokeStyle = `rgba(255,255,255,${ridgeAlpha.toFixed(3)})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(csx, csy); ctx.lineTo(ax, ay);
      ctx.moveTo(csx, csy); ctx.lineTo(bx, by);
      ctx.stroke();
    }

    ctx.restore();
  }
}
