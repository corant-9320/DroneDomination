/**
 * terrainWater.ts — Water boundary edges + connected-surface reflective sheen.
 *
 * Extracted from TerrainRenderer (P1 refactor). Operates through a shared
 * TerrainContext for canvas/world/view-transform access.
 */

import { TileData } from './worldData.js';
import { FlatTile } from './localMapProjection.js';
import { TerrainContext } from './terrainContext.js';

export class TerrainWater {
  constructor(private c: TerrainContext) {}

  /** Draw only the boundary edges where water meets land or the map edge. */
  drawBoundaryEdges(
    ft: FlatTile,
    tile: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 3) return;

    const ctx = this.c.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(4,18,30,0.22)';
    ctx.lineWidth = 0.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let seg = 0; seg < ft.poly.length; seg++) {
      const neighbour = this.c.neighbourAcrossSegment(tile, ft, seg, ftByTile);
      if (neighbour && this.c.isWaterTile(neighbour)) continue;

      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];
      const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.c.worldToScreen(v1.x, v1.y);
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
  drawSurfaceLighting(ftByTile: Map<number, FlatTile>): void {
    const waterSet = new Set<number>();
    for (const [tileIdx] of ftByTile) {
      if (this.c.isWaterTile(this.c.world.tiles[tileIdx])) {
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

        const tile = this.c.world.tiles[idx];
        for (const nIdx of tile.n) {
          if (!waterSet.has(nIdx) || visited.has(nIdx)) continue;
          visited.add(nIdx);
          queue.push(nIdx);
        }
      }

      if (component.length > 0) components.push(component);
    }

    const ctx = this.c.ctx;
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
          const [sx, sy] = this.c.worldToScreen(ft.poly[i].x, ft.poly[i].y);
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
}
