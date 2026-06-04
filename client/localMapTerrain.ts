/**
 * localMapTerrain.ts — All terrain fill / shading / contour / water / forest drawing.
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
        this.ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        this.ctx.lineWidth = 0.5;
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

  /**
   * Faint centreline contour helper. These lines are nearly invisible guides.
   */
  private strokeContourSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    level: number,
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = `rgba(18,20,18,${(0.030 + level * 0.008).toFixed(3)})`;
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }

  /** Draw a quadrilateral gradient band extending out from a contour edge. */
  private fillContourGradientBand(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    nx: number,
    ny: number,
    width: number,
    nearColor: string,
    farColor: string,
  ): void {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(
      (ax + bx) / 2,
      (ay + by) / 2,
      (ax + bx) / 2 + nx * width,
      (ay + by) / 2 + ny * width,
    );
    grad.addColorStop(0.0, nearColor);
    grad.addColorStop(
      0.45,
      nearColor.replace(/,([0-9.]+)\)$/, (_m, a) => `,${(parseFloat(a) * 0.45).toFixed(3)})`),
    );
    grad.addColorStop(1.0, farColor);

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + nx * width, by + ny * width);
    ctx.lineTo(ax + nx * width, ay + ny * width);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  /**
   * Shade the actual high/low hex edge that creates a contour step.
   * Draws shadow on sun-facing and highlight on leading edge.
   */
  private drawContourEdgeRelief(
    ft: FlatTile,
    tile: TileData,
    segment: number,
    level: number,
    neighbour: TileData,
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

    const nx = outX / outLen;
    const ny = outY / outLen;
    const highNx = -nx;
    const highNy = -ny;

    const heightDrop = Math.max(1, this.elevationLevel(tile) - this.elevationLevel(neighbour));
    const radius = this.screenHexRadius(ft);
    const bandWidth = Math.max(8, radius * 0.50);
    const innerLip = Math.max(2, radius * 0.035);

    const strength = Math.min(1, 0.36 + heightDrop * 0.22 + level * 0.08);
    const edgeFacesSun = nx * SUN_X + ny * SUN_Y;
    const awayFromSun = Math.max(0, -edgeFacesSun);
    const towardSun = Math.max(0, edgeFacesSun);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    if (awayFromSun > 0.04) {
      const shadowAlpha = Math.min(0.42, (0.24 + level * 0.045) * strength * awayFromSun);
      this.fillContourGradientBand(
        ax, ay, bx, by, nx, ny, bandWidth,
        `rgba(5,8,14,${shadowAlpha.toFixed(3)})`,
        'rgba(5,8,14,0.000)',
      );
      this.fillContourGradientBand(
        ax, ay, bx, by, nx, ny, Math.max(3, radius * 0.10),
        `rgba(0,0,0,${(shadowAlpha * 0.45).toFixed(3)})`,
        'rgba(0,0,0,0.000)',
      );
    }

    if (towardSun > 0.04) {
      const highlightAlpha = Math.min(0.48, (0.30 + level * 0.055) * strength * towardSun);
      this.fillContourGradientBand(
        ax + highNx * innerLip, ay + highNy * innerLip,
        bx + highNx * innerLip, by + highNy * innerLip,
        highNx, highNy, bandWidth * 0.92,
        `rgba(255,252,218,${highlightAlpha.toFixed(3)})`,
        'rgba(255,252,218,0.000)',
      );
    }

    ctx.restore();
  }

  /**
   * Draw contours as centreline traces along the edge of each elevation band,
   * plus compact triangular peak shading for local high points.
   */
  private drawContourRelief(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // First pass: relief on actual high/low hex boundaries
    for (let level = 1; level <= 3; level++) {
      for (const ft of ftByTile.values()) {
        const tile = this.world.tiles[ft.tileIndex];
        if (tile.s !== 6 || this.elevationLevel(tile) < level || ft.poly.length < 6) continue;

        for (let seg = 0; seg < ft.poly.length; seg++) {
          const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
          if (!neighbour || this.elevationLevel(neighbour) >= level) continue;
          this.drawContourEdgeRelief(ft, tile, seg, level, neighbour);
        }
      }
    }

    // Second pass: compact triangular peak shading
    for (const ft of ftByTile.values()) {
      const tile = this.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      this.drawPeakTriangularRelief(ft, tile, ftByTile);
    }

    // Third pass: faint contour centreline
    const drawn = new Set<string>();

    for (let level = 1; level <= 3; level++) {
      for (const ft of ftByTile.values()) {
        const tile = this.world.tiles[ft.tileIndex];
        if (tile.s !== 6 || !this.isContourBandTile(ft.tileIndex, level)) continue;

        const [ax, ay] = this.worldToScreen(ft.cx, ft.cy);
        let connectedSameBand = false;

        for (const nIdx of tile.n) {
          const nft = ftByTile.get(nIdx);
          if (!nft || nIdx < ft.tileIndex) continue;
          if (!this.isContourBandTile(nIdx, level)) continue;

          connectedSameBand = true;
          drawn.add(`${level}:${ft.tileIndex}`);
          drawn.add(`${level}:${nIdx}`);

          const [bx, by] = this.worldToScreen(nft.cx, nft.cy);
          this.strokeContourSegment(ax, ay, bx, by, level);
        }

        if (!connectedSameBand && !drawn.has(`${level}:${ft.tileIndex}`)) {
          this.drawSingleHexRelief(ft, tile, level, ftByTile);
          drawn.add(`${level}:${ft.tileIndex}`);
        }
      }
    }

    ctx.restore();
  }

  /**
   * Compact triangular peak shading on any hex that stands above most neighbours.
   * Qualifies when four or more neighbours are lower.
   */
  private drawPeakTriangularRelief(
    ft: FlatTile,
    tile: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const ownLevel = this.elevationLevel(tile);
    if (ownLevel <= 0) return;

    const neighbourLevels = tile.n.map((nIdx: number) => this.elevationLevel(this.world.tiles[nIdx]));
    const lowerCount = neighbourLevels.filter((h) => h < ownLevel).length;
    if (lowerCount < 4) return;

    const maxDrop = Math.max(0, ...neighbourLevels.map((h) => ownLevel - h));
    const peakStrength = Math.min(1, 0.55 + (lowerCount - 4) * 0.18 + maxDrop * 0.10);

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (let seg = 0; seg < ft.poly.length; seg++) {
      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];
      const [ax, ay] = this.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.worldToScreen(v1.x, v1.y);
      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const dx = midX - csx;
      const dy = midY - csy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) continue;

      const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
      const neighbourLevel = neighbour ? this.elevationLevel(neighbour) : ownLevel;
      const drop = Math.max(0, ownLevel - neighbourLevel);
      const edgeWeight = drop > 0 ? Math.min(1.35, 0.82 + drop * 0.22) : 0.25;

      const facingSun = (dx / len) * SUN_X + (dy / len) * SUN_Y;
      const baseAlpha = (0.105 + ownLevel * 0.035) * peakStrength * edgeWeight * Math.abs(facingSun);
      const alpha = Math.min(0.34, baseAlpha);
      if (alpha < 0.01) continue;

      const grad = ctx.createLinearGradient(csx, csy, midX, midY);
      if (facingSun >= 0) {
        grad.addColorStop(0.0,  `rgba(255,252,220,${(alpha * 0.10).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(255,252,220,${(alpha * 0.38).toFixed(3)})`);
        grad.addColorStop(1.0,  `rgba(255,252,220,${alpha.toFixed(3)})`);
      } else {
        grad.addColorStop(0.0,  `rgba(7,12,22,${(alpha * 0.12).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(7,12,22,${(alpha * 0.48).toFixed(3)})`);
        grad.addColorStop(1.0,  `rgba(7,12,22,${(alpha * 1.12).toFixed(3)})`);
      }

      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Compact relief for a one-hex local trough (isolated low point).
   */
  private drawSingleHexRelief(
    ft: FlatTile,
    tile: TileData,
    level: number,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const ownLevel = this.elevationLevel(tile);
    const neighbourLevels = tile.n.map((nIdx: number) => this.elevationLevel(this.world.tiles[nIdx]));
    const isPeak   = neighbourLevels.every((h) => h < ownLevel);
    const isTrough = neighbourLevels.every((h) => h > ownLevel);
    if (isPeak) return; // handled by drawPeakTriangularRelief
    if (!isTrough) return;

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const ctx = this.ctx;

    for (let seg = 0; seg < ft.poly.length; seg++) {
      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];
      const [ax, ay] = this.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.worldToScreen(v1.x, v1.y);
      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const dx = midX - csx;
      const dy = midY - csy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) continue;

      const facingSun = ((dx / len) * SUN_X + (dy / len) * SUN_Y) * (isPeak ? 1 : -1);
      const alpha = (0.12 + level * 0.045) * Math.abs(facingSun);

      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fillStyle = facingSun >= 0
        ? `rgba(255,250,220,${alpha.toFixed(3)})`
        : `rgba(10,18,30,${(alpha * 1.25).toFixed(3)})`;
      ctx.fill();
    }
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
        peakPull = 0.18; litAlpha = 0.18; shadowAlpha = 0.12;
        break;
      case 'hills':
        peakPull = 0.38; litAlpha = 0.38; shadowAlpha = 0.24;
        break;
      case 'mountain':
      default:
        peakPull = 0.62; litAlpha = 0.62; shadowAlpha = 0.42;
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
        ? dot * relief * (tile.elevType === 'mountain' ? 0.42 : tile.elevType === 'hills' ? 0.24 : 0.12)
        : 0.025 * relief;
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
