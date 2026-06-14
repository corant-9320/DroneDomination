/**
 * terrainFeatures.ts — Forest / vegetation icon drawing.
 *
 * Extracted from TerrainRenderer (P1 refactor). Operates through a shared
 * TerrainContext for canvas/view-transform access.
 */

import { FlatTile } from './localMapProjection.js';
import { TerrainContext } from './terrainContext.js';

export class TerrainFeatures {
  constructor(private c: TerrainContext) {}

  /**
   * Draw a small tree icon at a given screen position.
   */
  private drawTreeIcon(sx: number, sy: number, size: number): void {
    const ctx = this.c.ctx;
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
  drawForestCornerTrees(ft: FlatTile): void {
    if (ft.poly.length < 6) return;

    const [csx, csy] = this.c.worldToScreen(ft.cx, ft.cy);
    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.c.worldToScreen(v.x, v.y);
      const dx = vx - csx;
      const dy = vy - csy;
      avgRadius += Math.sqrt(dx * dx + dy * dy);
    }
    avgRadius /= ft.poly.length;

    if (avgRadius < 8) return;

    const treeSize = Math.max(2, avgRadius * 0.22);
    const inset = 0.62;

    for (const v of ft.poly) {
      const [vx, vy] = this.c.worldToScreen(v.x, v.y);
      const tx = vx + (csx - vx) * (1 - inset);
      const ty = vy + (csy - vy) * (1 - inset);
      this.drawTreeIcon(tx, ty, treeSize);
    }
  }
}
