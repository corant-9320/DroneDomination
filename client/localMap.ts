/**
 * Local Map View — flat hex map rendered with Canvas 2D.
 * BFS 10 hops from centre, projects actual tile boundary polygons
 * onto a tangent plane. Pentagons are excluded.
 */

import { WorldData, UnitData } from './worldData.js';
import { terrainColor } from './terrainColors.js';
import { factionColor } from './factionColors.js';

interface FlatTile {
  tileIndex: number;
  cx: number;
  cy: number;
  /** Projected boundary polygon in tangent-plane coords */
  poly: { x: number; y: number }[];
  distance: number;
}

export class LocalMapView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: WorldData;
  private flatTiles: FlatTile[] = [];
  private centreTileIndex: number = -1;
  private radius: number = 10;
  private onTileSelect: (tileIndex: number) => void;
  private hoveredTile: number = -1;
  private selectedTile: number = -1;

  // View transform
  private offsetX: number = 0;
  private offsetY: number = 0;
  private scale: number = 0.3;
  private dragging: boolean = false;
  private lastMouse: { x: number; y: number } = { x: 0, y: 0 };

  /** Zoom threshold above which segments and unit detail are drawn. */
  private static readonly SEGMENT_ZOOM_THRESHOLD = 1.5;
  /** Zoom threshold above which attribute bars are drawn on units. */
  private static readonly DETAIL_ZOOM_THRESHOLD = 2.5;

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldData,
    onTileSelect: (tileIndex: number) => void
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.world = world;
    this.onTileSelect = onTileSelect;

    canvas.addEventListener('click', this.onClick.bind(this));
    canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    canvas.addEventListener('wheel', this.onWheel.bind(this));
    canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    canvas.addEventListener('mouseleave', this.onMouseUp.bind(this));
    window.addEventListener('resize', () => this.render());

    if (world.cities.length > 0) {
      this.setCentre(world.cities[0].tileIndex);
    }
  }

  setCentre(tileIndex: number) {
    this.centreTileIndex = tileIndex;
    this.flatTiles = this.buildFlatView(tileIndex, this.radius);
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 0.3;
    this.render();
  }

  /** Pan to the player's home city at default zoom. */
  goHome() {
    const homeCity = this.world.cities.find((c) => c.isPlayerHome);
    if (homeCity) {
      this.setCentre(homeCity.tileIndex);
    }
  }

  setSelected(tileIndex: number) {
    this.selectedTile = tileIndex;
    const inView = this.flatTiles.some((ft) => ft.tileIndex === tileIndex);
    if (!inView) {
      this.setCentre(tileIndex);
    } else {
      this.render();
    }
  }

  /**
   * BFS out from centre, skip pentagons, project tile boundaries
   * onto the tangent plane at the centre tile.
   */
  private buildFlatView(centreIdx: number, radius: number): FlatTile[] {
    // BFS
    const distances = new Map<number, number>();
    distances.set(centreIdx, 0);
    const queue: [number, number][] = [[centreIdx, 0]];
    let head = 0;

    while (head < queue.length) {
      const [current, dist] = queue[head++];
      if (dist >= radius) continue;
      const tile = this.world.tiles[current];
      for (const n of tile.n) {
        if (!distances.has(n)) {
          distances.set(n, dist + 1);
          queue.push([n, dist + 1]);
        }
      }
    }

    // Build tangent-plane basis at centre
    const centre = this.world.tiles[centreIdx];
    const [cx, cy, cz] = centre.pos;

    // Normal = centre position (unit sphere)
    const nx = cx, ny = cy, nz = cz;

    // Tangent vector
    let tx: number, ty: number, tz: number;
    if (Math.abs(ny) < 0.9) {
      tx = nz; ty = 0; tz = -nx;
    } else {
      tx = 0; ty = -nz; tz = ny;
    }
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    tx /= tLen; ty /= tLen; tz /= tLen;

    // Binormal = cross(normal, tangent)
    let bx = ny * tz - nz * ty;
    let by = nz * tx - nx * tz;
    let bz = nx * ty - ny * tx;
    const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
    bx /= bLen; by /= bLen; bz /= bLen;

    const project = (p: [number, number, number]): { x: number; y: number } => {
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const dz = p[2] - cz;
      return {
        x: dx * tx + dy * ty + dz * tz,
        y: dx * bx + dy * by + dz * bz,
      };
    };

    const result: FlatTile[] = [];
    for (const [tileIdx, dist] of distances) {
      const tile = this.world.tiles[tileIdx];
      // Skip pentagons
      if (tile.s === 5) continue;

      const projected = project(tile.pos);
      const poly = tile.b.map((v) => project(v));

      result.push({
        tileIndex: tileIdx,
        cx: projected.x,
        cy: projected.y,
        poly,
        distance: dist,
      });
    }

    return result;
  }

  private worldToScreen(wx: number, wy: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const baseScale = Math.min(w, h) * 3.5;

    const sx = w / 2 + wx * baseScale * this.scale + this.offsetX;
    const sy = h / 2 + -wy * baseScale * this.scale + this.offsetY;
    return [sx, sy];
  }

  private screenToWorld(sx: number, sy: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const baseScale = Math.min(w, h) * 3.5;

    const wx = (sx - w / 2 - this.offsetX) / (baseScale * this.scale);
    const wy = -(sy - h / 2 - this.offsetY) / (baseScale * this.scale);
    return [wx, wy];
  }

  private findTileAt(sx: number, sy: number): number {
    const [wx, wy] = this.screenToWorld(sx, sy);

    // Point-in-polygon test for each tile
    for (const ft of this.flatTiles) {
      if (this.pointInPoly(wx, wy, ft.poly)) {
        return ft.tileIndex;
      }
    }
    return -1;
  }

  private pointInPoly(px: number, py: number, poly: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  render() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.ctx.fillStyle = '#0d0d0d';
    this.ctx.fillRect(0, 0, rect.width, rect.height);

    if (this.flatTiles.length === 0) return;

    const showSegments = this.scale >= LocalMapView.SEGMENT_ZOOM_THRESHOLD;
    const showDetail = this.scale >= LocalMapView.DETAIL_ZOOM_THRESHOLD;

    // Draw each tile as its actual boundary polygon
    for (const ft of this.flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      let color = terrainColor(tile.terrain);

      if (ft.tileIndex === this.selectedTile) {
        color = '#ffffff';
      } else if (ft.tileIndex === this.hoveredTile) {
        color = '#ffff88';
      } else if (tile.city) {
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
      this.ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      this.ctx.lineWidth = 0.5;
      this.ctx.stroke();

      // Draw segment lines when zoomed in
      if (showSegments && tile.s === 6) {
        this.drawSegmentLines(ft);
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

    // Draw units when zoomed in enough to see segments
    if (showSegments) {
      this.drawUnits(showDetail);
    }
  }

  /**
   * Draw the 6 segment dividers from hex centre to each boundary vertex.
   */
  private drawSegmentLines(ft: FlatTile) {
    const [cx, cy] = this.worldToScreen(ft.cx, ft.cy);
    this.ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    this.ctx.lineWidth = 0.5;

    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      this.ctx.beginPath();
      this.ctx.moveTo(cx, cy);
      this.ctx.lineTo(vx, vy);
      this.ctx.stroke();
    }
  }

  /**
   * Draw unit markers in their segment triangles.
   * Each segment's centroid is 1/3 between the hex centre and the midpoint
   * of the corresponding boundary edge.
   */
  private drawUnits(showDetail: boolean) {
    const units = this.world.units;
    if (!units || units.length === 0) return;

    // Build a lookup of tileIndex -> flatTile for visible tiles
    const ftByTile = new Map<number, FlatTile>();
    for (const ft of this.flatTiles) {
      ftByTile.set(ft.tileIndex, ft);
    }

    for (const unit of units) {
      const ft = ftByTile.get(unit.tileIndex);
      if (!ft) continue;
      // Only draw in hexes (pentagons are excluded from flatTiles anyway)
      const tile = this.world.tiles[unit.tileIndex];
      if (tile.s !== 6) continue;

      const segPos = this.getSegmentCentroid(ft, unit.segment);
      if (!segPos) continue;

      const [sx, sy] = this.worldToScreen(segPos.x, segPos.y);

      // Unit pip
      const radius = Math.max(3, 4 * this.scale / 3);
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      this.ctx.fillStyle = this.ownerColor(unit.ownerId);
      this.ctx.fill();
      this.ctx.strokeStyle = '#000';
      this.ctx.lineWidth = 1;
      this.ctx.stroke();

      // Attribute detail when deeply zoomed
      if (showDetail) {
        this.drawUnitDetail(unit, sx, sy, radius);
      }
    }
  }

  /**
   * Get the centroid of a triangular segment within a hex.
   * Segment i = triangle(centre, boundary[i], boundary[(i+1)%6])
   */
  private getSegmentCentroid(ft: FlatTile, segment: number): { x: number; y: number } | null {
    if (ft.poly.length < 6) return null;
    const v0 = ft.poly[segment % 6];
    const v1 = ft.poly[(segment + 1) % 6];
    return {
      x: (ft.cx + v0.x + v1.x) / 3,
      y: (ft.cy + v0.y + v1.y) / 3,
    };
  }

  /** Draw compact attribute bars beneath the unit marker. */
  private drawUnitDetail(unit: UnitData, sx: number, sy: number, radius: number) {
    const attrs = unit.attributes;
    const barY = sy + radius + 3;
    const barW = radius * 3;
    const barH = 2;
    let row = 0;

    const drawBar = (value: number | undefined, max: number, color: string) => {
      if (value === undefined || value <= 0) return;
      const x = sx - barW / 2;
      const y = barY + row * (barH + 1);
      // Background
      this.ctx.fillStyle = 'rgba(0,0,0,0.5)';
      this.ctx.fillRect(x, y, barW, barH);
      // Fill
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x, y, barW * (value / max), barH);
      row++;
    };

    drawBar(unit.currentHealth, attrs.maxHealth ?? 5, '#4f4');
    drawBar(attrs.armour, 5, '#88f');
    drawBar(attrs.meleeAttack, 5, '#f44');
    drawBar(attrs.rangeAttack, 5, '#fa4');
    drawBar(attrs.wheeledMovement, 5, '#aaa');
    drawBar(attrs.limbMovement, 5, '#8d6');
    drawBar(attrs.flightMovement, 5, '#4df');
    drawBar(attrs.repair, 5, '#ff8');
    drawBar(attrs.initiative, 5, '#d8f');
  }

  /** Simple owner color palette. */
  private ownerColor(ownerId: string): string {
    return factionColor(this.world, ownerId);
  }

  private onClick(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const tileIdx = this.findTileAt(x, y);
    if (tileIdx >= 0) {
      this.selectedTile = tileIdx;
      this.onTileSelect(tileIdx);
      this.render();
    }
  }

  private onMouseMove(event: MouseEvent) {
    if (this.dragging) {
      const dx = event.clientX - this.lastMouse.x;
      const dy = event.clientY - this.lastMouse.y;
      this.offsetX += dx;
      this.offsetY += dy;
      this.lastMouse = { x: event.clientX, y: event.clientY };
      this.render();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const tileIdx = this.findTileAt(x, y);
    if (tileIdx !== this.hoveredTile) {
      this.hoveredTile = tileIdx;
      this.render();
    }
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    this.scale *= factor;
    this.scale = Math.max(0.3, Math.min(15, this.scale));
    this.render();
  }

  private onMouseDown(event: MouseEvent) {
    if (event.button === 0) {
      this.dragging = true;
      this.lastMouse = { x: event.clientX, y: event.clientY };
    }
  }

  private onMouseUp() {
    this.dragging = false;
  }
}
