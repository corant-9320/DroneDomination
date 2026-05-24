/**
 * Local Map View — flat hex map rendered with Canvas 2D.
 * BFS 10 hops from centre, projects actual tile boundary polygons
 * onto a tangent plane. Pentagons are excluded.
 */

import { WorldData, UnitData } from './worldData.js';
import { terrainColor, factionColor } from './colors.js';
import { drawUnitIcon, segmentAngle } from './unitIcons.js';
import { dbg } from './debug.js';

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
  private onTileSelect: (tileIndex: number, segment?: number) => void;
  private hoveredTile: number = -1;
  private selectedTile: number = -1;
  private selectedSegment: number = -1;
  private onCentreChange: ((tileIndex: number) => void) | null = null;
  /** Callback when player hovers an enemy tile (for attack preview). */
  private onHoverEnemy: ((attacker: UnitData | null, target: UnitData | null) => void) | null = null;
  /** Track last hovered enemy to avoid redundant callbacks. */
  private lastHoveredEnemyId: string | null = null;
  /** Active AI combat highlight (attacker → target). */
  private highlightAttackerId: string | null = null;
  private highlightTargetId: string | null = null;

  // Movement system
  /** Units currently selected for movement (by unit id). */
  private selectedUnits: Set<string> = new Set();
  /** Remaining movement points per unit this turn (keyed by unit id). */
  private movementPoints: Map<string, number> = new Map();
  /** Callback when turn ends. */
  private onTurnEnd: (() => void) | null = null;
  /** Callback when player initiates an attack (attackerId, targetId). */
  private onAttack: ((attackerId: string, targetId: string) => void) | null = null;
  /** The faction (ownerId) allowed to select and move units. */
  private activeFaction: string = '';

  // View transform
  private offsetX: number = 0;
  private offsetY: number = 0;
  private scale: number = 0.3;
  private dragging: boolean = false;
  private mouseDownPos: { x: number; y: number } | null = null;
  private lastMouse: { x: number; y: number } = { x: 0, y: 0 };
  private dragEmitPending: boolean = false;
  private lastEmittedCentreTile: number = -1;

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldData,
    onTileSelect: (tileIndex: number, segment?: number) => void
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.world = world;
    this.onTileSelect = onTileSelect;

    canvas.addEventListener('click', this.onClick.bind(this));
    canvas.addEventListener('contextmenu', this.onRightClick.bind(this));
    canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    canvas.addEventListener('wheel', this.onWheel.bind(this));
    canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    canvas.addEventListener('mouseleave', this.onMouseUp.bind(this));
    window.addEventListener('keydown', this.onKeyDown.bind(this));
    window.addEventListener('resize', () => this.render());

    // Initialize movement points for all units
    this.resetMovementPoints();

    if (world.cities.length > 0) {
      this.setCentre(world.cities[0].tileIndex);
    }
  }

  setCentre(tileIndex: number) {
    dbg.localMap.log('setCentre:', tileIndex);
    this.centreTileIndex = tileIndex;
    this.lastEmittedCentreTile = tileIndex;
    dbg.localMap.time('buildFlatView');
    this.flatTiles = this.buildFlatView(tileIndex, this.radius);
    dbg.localMap.timeEnd('buildFlatView');
    dbg.localMap.log('flatTiles count:', this.flatTiles.length);
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 0.3;
    this.render();
  }

  /** Pan to the player's home city at default zoom. */
  goHome() {
    const homeCity = this.world.cities.find((c) => c.isPlayerHome);
    dbg.localMap.log('goHome → city:', homeCity?.label, 'tile:', homeCity?.tileIndex);
    if (homeCity) {
      this.setCentre(homeCity.tileIndex);
    }
  }

  setSelected(tileIndex: number) {
    this.selectedTile = tileIndex;
    this.selectedSegment = -1;
    const inView = this.flatTiles.some((ft) => ft.tileIndex === tileIndex);
    if (!inView) {
      dbg.localMap.log('setSelected tile not in view, recentring:', tileIndex);
      this.setCentre(tileIndex);
    } else {
      this.render();
    }
  }

  /** Register a callback for when the local map's centre tile changes (drag recenter). */
  setOnCentreChange(cb: (tileIndex: number) => void) {
    this.onCentreChange = cb;
  }

  /** Register a callback for enemy hover (attack preview). */
  setOnHoverEnemy(cb: (attacker: UnitData | null, target: UnitData | null) => void) {
    this.onHoverEnemy = cb;
  }

  /** Highlight an attacker → target pair on the map (used during AI turns). */
  setHighlightCombat(attackerId: string | null, targetId: string | null): void {
    this.highlightAttackerId = attackerId;
    this.highlightTargetId = targetId;
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

    // Draw each tile as its actual boundary polygon
    for (const ft of this.flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      let color = terrainColor(tile.terrain);

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
      this.ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      this.ctx.lineWidth = 0.5;
      this.ctx.stroke();

      // Draw faint dotted segment dividers on all hexes
      if (tile.s === 6) {
        this.drawSegmentLines(ft);
      }

      // Highlight selected segment (triangle overlay)
      if (ft.tileIndex === this.selectedTile && this.selectedSegment >= 0 && tile.s === 6) {
        this.drawSegmentHighlight(ft, this.selectedSegment);
      } else if (ft.tileIndex === this.selectedTile && this.selectedSegment < 0) {
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

    // Draw units at all zoom levels
    this.drawUnits();

    // Draw AI combat highlights (attacker ring + target ring + connecting line)
    this.drawCombatHighlight();

    // HUD: zoom factor (top-left)
    this.ctx.save();
    this.ctx.font = '12px sans-serif';
    this.ctx.fillStyle = 'rgba(255,255,255,0.7)';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    this.ctx.fillText(`Zoom: ${this.scale.toFixed(1)}×`, 8, 8);
    this.ctx.restore();
  }

  /**
   * Draw faint dotted segment dividers from hex centre to each boundary vertex.
   */
  private drawSegmentLines(ft: FlatTile) {
    const [cx, cy] = this.worldToScreen(ft.cx, ft.cy);
    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    this.ctx.lineWidth = 0.5;
    this.ctx.setLineDash([3, 4]);

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
  private drawSegmentHighlight(ft: FlatTile, segment: number) {
    if (ft.poly.length < 6) return;
    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const [cx, cy] = this.worldToScreen(ft.cx, ft.cy);
    const [sx0, sy0] = this.worldToScreen(v0.x, v0.y);
    const [sx1, sy1] = this.worldToScreen(v1.x, v1.y);

    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy);
    this.ctx.lineTo(sx0, sy0);
    this.ctx.lineTo(sx1, sy1);
    this.ctx.closePath();

    // Semi-transparent white fill
    this.ctx.fillStyle = 'rgba(255,255,255,0.25)';
    this.ctx.fill();
    // Bright outline
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  /**
   * Draw unit markers in their segment triangles using composite icons.
   * Each unit faces its own `facing` direction (0–5 segment angle).
   */
  private drawUnits() {
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
      const tile = this.world.tiles[unit.tileIndex];
      if (tile.s !== 6) continue;

      // Always position in the unit's specific segment
      const segPos = this.getSegmentCentroid(ft, unit.segment);
      if (!segPos) continue;
      const [sx, sy] = this.worldToScreen(segPos.x, segPos.y);

      // Compute size from the segment triangle's screen-space inradius so the
      // icon scales proportionally with zoom and always fits inside the triangle.
      const size = this.getSegmentIconSize(ft, unit.segment);
      const color = this.ownerColor(unit.ownerId);

      // Per-unit facing direction
      const facingAngle = segmentAngle(unit.facing);

      // Draw composite icon
      drawUnitIcon(this.ctx, unit, sx, sy, size, color, facingAngle);

      // Selection ring for selected units
      if (this.selectedUnits.has(unit.id)) {
        this.ctx.beginPath();
        this.ctx.arc(sx, sy, size * 1.8, 0, Math.PI * 2);
        this.ctx.strokeStyle = '#fff';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
      }
    }
  }

  /**
   * Draw pulsing rings on the attacker (red) and target (blue) plus an
   * arrow line between them during AI combat actions.
   */
  private drawCombatHighlight(): void {
    if (!this.highlightAttackerId || !this.highlightTargetId) return;

    const attacker = this.world.units.find((u) => u.id === this.highlightAttackerId);
    const target = this.world.units.find((u) => u.id === this.highlightTargetId);
    if (!attacker || !target) return;

    const ftByTile = new Map<number, FlatTile>();
    for (const ft of this.flatTiles) ftByTile.set(ft.tileIndex, ft);

    const ftA = ftByTile.get(attacker.tileIndex);
    const ftT = ftByTile.get(target.tileIndex);
    if (!ftA || !ftT) return;

    const segA = this.getSegmentCentroid(ftA, attacker.segment);
    const segT = this.getSegmentCentroid(ftT, target.segment);
    if (!segA || !segT) return;

    const [ax, ay] = this.worldToScreen(segA.x, segA.y);
    const [tx, ty] = this.worldToScreen(segT.x, segT.y);
    const sizeA = this.getSegmentIconSize(ftA, attacker.segment);
    const sizeT = this.getSegmentIconSize(ftT, target.segment);

    this.ctx.save();

    // Attacker ring — pulsing red
    this.ctx.beginPath();
    this.ctx.arc(ax, ay, sizeA * 2.2, 0, Math.PI * 2);
    this.ctx.strokeStyle = '#f44';
    this.ctx.lineWidth = 3;
    this.ctx.setLineDash([6, 4]);
    this.ctx.stroke();

    // Target ring — pulsing cyan
    this.ctx.beginPath();
    this.ctx.arc(tx, ty, sizeT * 2.2, 0, Math.PI * 2);
    this.ctx.strokeStyle = '#4cf';
    this.ctx.lineWidth = 3;
    this.ctx.stroke();

    // Arrow line from attacker to target
    this.ctx.beginPath();
    this.ctx.moveTo(ax, ay);
    this.ctx.lineTo(tx, ty);
    this.ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([8, 6]);
    this.ctx.stroke();

    // Arrowhead at target end
    const angle = Math.atan2(ty - ay, tx - ax);
    const headLen = 12;
    this.ctx.setLineDash([]);
    this.ctx.beginPath();
    this.ctx.moveTo(tx, ty);
    this.ctx.lineTo(tx - headLen * Math.cos(angle - 0.4), ty - headLen * Math.sin(angle - 0.4));
    this.ctx.moveTo(tx, ty);
    this.ctx.lineTo(tx - headLen * Math.cos(angle + 0.4), ty - headLen * Math.sin(angle + 0.4));
    this.ctx.strokeStyle = '#f66';
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();

    this.ctx.restore();
  }

  /**
   * Compute the icon base-size for a segment triangle so the drawn unit
   * fills ~90% of the triangle at every zoom level.
   *
   * Returns a `size` value (half-width of body rectangle in drawUnitIcon).
   * The icon's maximum extent is roughly size * 1.75 (tank sprite radius),
   * so we target size ≈ inradius * 0.5 which places the outer edge at ~87%
   * of the triangle's inscribed circle.
   */
  private getSegmentIconSize(ft: FlatTile, segment: number): number {
    if (ft.poly.length < 6) return 8;

    // Triangle vertices in screen space
    const [cx, cy] = this.worldToScreen(ft.cx, ft.cy);
    const v0 = ft.poly[segment % 6];
    const v1 = ft.poly[(segment + 1) % 6];
    const [ax, ay] = this.worldToScreen(v0.x, v0.y);
    const [bx, by] = this.worldToScreen(v1.x, v1.y);

    // Centroid in screen space (where the icon is drawn)
    const px = (cx + ax + bx) / 3;
    const py = (cy + ay + by) / 3;

    // Distance from centroid to each of the three edges
    const d1 = this.pointToEdgeDist(px, py, cx, cy, ax, ay);
    const d2 = this.pointToEdgeDist(px, py, ax, ay, bx, by);
    const d3 = this.pointToEdgeDist(px, py, bx, by, cx, cy);
    const inradius = Math.min(d1, d2, d3);

    // size * 1.75 is the largest radius used (tank sprite), so
    // size = inradius * 0.5 keeps the sprite at ~87% of the triangle edge.
    return Math.max(4, inradius * 0.5);
  }

  /** Perpendicular distance from point (px,py) to the line through (x1,y1)-(x2,y2). */
  private pointToEdgeDist(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return 0;
    // Absolute value of cross product / length
    return Math.abs((px - x1) * dy - (py - y1) * dx) / len;
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

  /** Simple owner color palette. */
  private ownerColor(ownerId: string): string {
    return factionColor(this.world, ownerId);
  }

  /**
   * Hit-test a screen point against the triangular segments of a hex tile.
   * Returns segment index 0–5, or -1 if not in any segment (shouldn't happen
   * if the point is inside the tile polygon).
   */
  private findSegmentAt(sx: number, sy: number, ft: FlatTile): number {
    if (ft.poly.length < 6) return -1;
    const [wx, wy] = this.screenToWorld(sx, sy);
    for (let seg = 0; seg < ft.poly.length; seg++) {
      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];
      // Triangle: (centre, v0, v1)
      if (this.pointInTriangle(wx, wy, ft.cx, ft.cy, v0.x, v0.y, v1.x, v1.y)) {
        return seg;
      }
    }
    return -1;
  }

  /** Barycentric point-in-triangle test. */
  private pointInTriangle(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
  ): boolean {
    const v0x = cx - ax, v0y = cy - ay;
    const v1x = bx - ax, v1y = by - ay;
    const v2x = px - ax, v2y = py - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) < 1e-12) return false;
    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    return u >= 0 && v >= 0 && u + v <= 1;
  }

  private onClick(event: MouseEvent) {
    // Suppress click if the user dragged before releasing
    if (this.mouseDownPos) {
      const dx = event.clientX - this.mouseDownPos.x;
      const dy = event.clientY - this.mouseDownPos.y;
      if (dx * dx + dy * dy > 9) { // > 3px movement = drag, not click
        this.mouseDownPos = null;
        return;
      }
    }
    this.mouseDownPos = null;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const tileIdx = this.findTileAt(x, y);
    if (tileIdx >= 0) {
      const ft = this.flatTiles.find((f) => f.tileIndex === tileIdx);
      let segment = -1;
      // Shift+click selects the whole hex (no segment)
      if (!event.shiftKey && ft && this.world.tiles[tileIdx].s === 6) {
        segment = this.findSegmentAt(x, y, ft);
      }
      dbg.localMap.log('Click hit tile:', tileIdx, 'segment:', segment, '| terrain:', this.world.tiles[tileIdx]?.terrain);
      this.selectedTile = tileIdx;
      this.selectedSegment = segment;

      // Unit selection: select units on this tile (only active faction)
      const tileUnits = this.world.units.filter((u) => u.tileIndex === tileIdx);
      if (event.shiftKey) {
        // Shift+click: select all active-faction units on the hex
        this.selectedUnits.clear();
        for (const u of tileUnits) {
          if (u.ownerId === this.activeFaction) {
            this.selectedUnits.add(u.id);
          }
        }
      } else if (segment >= 0) {
        // Normal click on segment: select unit in that segment (if it's active faction)
        this.selectedUnits.clear();
        const segUnit = tileUnits.find((u) => u.segment === segment);
        if (segUnit && segUnit.ownerId === this.activeFaction) {
          this.selectedUnits.add(segUnit.id);
        }
      } else {
        // Click on empty area of the tile
        this.selectedUnits.clear();
      }

      dbg.localMap.log('Selected units:', [...this.selectedUnits]);
      this.onTileSelect(tileIdx, segment >= 0 ? segment : undefined);
      this.render();
    } else {
      dbg.localMap.log('Click missed (no tile at position)');
      this.selectedUnits.clear();
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
      this.emitDragCentre();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Attack preview: when player has a unit selected, hovering an enemy shows preview
    if (this.onHoverEnemy && this.selectedUnits.size > 0) {
      const tileIdx = this.findTileAt(x, y);
      if (tileIdx >= 0) {
        const unitsOnTile = this.world.units.filter((u) => u.tileIndex === tileIdx);
        const playerUnits = this.world.units.filter((u) => this.selectedUnits.has(u.id));
        if (playerUnits.length > 0) {
          const playerOwner = playerUnits[0].ownerId;
          const enemy = unitsOnTile.find((u) => u.ownerId !== playerOwner);
          if (enemy) {
            if (this.lastHoveredEnemyId !== enemy.id) {
              this.lastHoveredEnemyId = enemy.id;
              this.onHoverEnemy(playerUnits[0], enemy);
            }
            return;
          }
        }
      }
      // No enemy under cursor — clear preview
      if (this.lastHoveredEnemyId !== null) {
        this.lastHoveredEnemyId = null;
        this.onHoverEnemy(null, null);
      }
    }
  }

  /**
   * During drag, find the tile at viewport centre. If it's a different tile
   * than the current centre, rebuild the flat view around it so new territory
   * appears. Setting offset to 0 is correct because the tile at screen-centre
   * becomes the new projection centre (placed at screen centre by definition).
   * Also emit to the globe for smooth sync.
   */
  private emitDragCentre() {
    if (this.dragEmitPending) return;
    this.dragEmitPending = true;
    requestAnimationFrame(() => {
      this.dragEmitPending = false;
      const rect = this.canvas.getBoundingClientRect();
      const centreX = rect.width / 2;
      const centreY = rect.height / 2;
      const tileIdx = this.findTileAt(centreX, centreY);
      if (tileIdx < 0) return;
      if (tileIdx === this.lastEmittedCentreTile) return;
      this.lastEmittedCentreTile = tileIdx;

      // Rebuild flat view around the new centre tile — gives real panning
      if (tileIdx !== this.centreTileIndex) {
        this.centreTileIndex = tileIdx;
        this.flatTiles = this.buildFlatView(tileIdx, this.radius);
        // Reset offset: the tile that was at screen centre is now the
        // projection origin, so (0,0) lands at screen centre.
        this.offsetX = 0;
        this.offsetY = 0;
        this.render();
      }

      // Sync globe
      if (this.onCentreChange) {
        this.onCentreChange(tileIdx);
      }
    });
  }

  private onWheel(event: WheelEvent) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    this.scale *= factor;
    this.scale = Math.max(0.3, Math.min(15, this.scale));
    dbg.localMap.log('Zoom scale:', this.scale.toFixed(2));
    this.render();
  }

  private onMouseDown(event: MouseEvent) {
    if (event.button === 0) {
      this.dragging = true;
      this.mouseDownPos = { x: event.clientX, y: event.clientY };
      this.lastMouse = { x: event.clientX, y: event.clientY };
    }
  }

  private onMouseUp() {
    this.dragging = false;
  }

  /**
   * Arrow key rotation behaviour depends on selection mode:
   *
   * WHOLE HEX selected (selectedSegment === -1):
   *   L/R        → All units rotate but stay in their triangle (facing rotates ±1).
   *   Shift+L/R  → All units rotate triangles (segment ±1).
   *                Facing remains unchanged (preserves current orientation).
   *   Down       → Defensive orientation: units spread evenly across segments,
   *                each facing outward toward the nearest hex face.
   *   Up         → All units face North (facing = 0), segments unchanged.
   *
   * SINGLE UNIT selected (selectedSegment >= 0):
   *   L/R        → Rotate that single unit's facing ±1 (stays in its triangle).
   *   Shift+L/R  → All units on the hex rotate triangles (segment ±1).
   *                Facing of all units copies the selected unit's facing.
   */
  private onKeyDown(event: KeyboardEvent) {
    if (this.selectedTile < 0) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    // ArrowUp with whole hex: all units face North (facing = 0)
    if (event.key === 'ArrowUp') {
      if (this.selectedSegment >= 0) return; // only works with whole hex selected
      const units = this.world.units;
      if (!units) return;
      const tileUnits = units.filter((u) => u.tileIndex === this.selectedTile);
      if (tileUnits.length === 0) return;
      event.preventDefault();
      for (const unit of tileUnits) {
        unit.facing = 0 as 0 | 1 | 2 | 3 | 4 | 5;
      }
      dbg.localMap.log('All units face North');
      this.onTileSelect(this.selectedTile, undefined);
      this.render();
      return;
    }

    // ArrowDown with whole hex: defensive orientation — spread units evenly, face outward
    if (event.key === 'ArrowDown') {
      if (this.selectedSegment >= 0) return; // only works with whole hex selected
      const units = this.world.units;
      if (!units) return;
      const tileUnits = units.filter((u) => u.tileIndex === this.selectedTile);
      if (tileUnits.length === 0) return;
      event.preventDefault();
      // Distribute units evenly around the hex segments, each facing outward
      const step = Math.floor(6 / tileUnits.length);
      for (let i = 0; i < tileUnits.length; i++) {
        const seg = (i * step) % 6;
        tileUnits[i].segment = seg as 0 | 1 | 2 | 3 | 4 | 5;
        tileUnits[i].facing = seg as 0 | 1 | 2 | 3 | 4 | 5;
      }
      dbg.localMap.log('Defensive orientation: units spread outward');
      this.onTileSelect(this.selectedTile, undefined);
      this.render();
      return;
    }

    const units = this.world.units;
    if (!units) return;

    const tileUnits = units.filter((u) => u.tileIndex === this.selectedTile);
    if (tileUnits.length === 0) return;

    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;

    const wholeHexSelected = this.selectedSegment < 0;

    if (wholeHexSelected) {
      if (event.shiftKey) {
        // Shift+L/R with whole hex: rotate segments, facing preserved
        for (const unit of tileUnits) {
          unit.segment = ((unit.segment + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
        }
        dbg.localMap.log('Whole-hex Shift-rotate segments (facing preserved), dir:', direction);
      } else {
        // L/R with whole hex: rotate facing only, segments unchanged
        for (const unit of tileUnits) {
          unit.facing = ((unit.facing + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
        }
        dbg.localMap.log('Whole-hex rotate facing, dir:', direction);
      }
    } else {
      // Single unit selected
      if (event.shiftKey) {
        // Shift+L/R with single unit: rotate all segments, facing copies selected unit's facing
        const selectedUnit = tileUnits.find((u) => u.segment === this.selectedSegment);
        const selectedFacing = selectedUnit ? selectedUnit.facing : 0;
        for (const unit of tileUnits) {
          unit.segment = ((unit.segment + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
          unit.facing = selectedFacing;
        }
        // Update selected segment to follow the rotation
        this.selectedSegment = ((this.selectedSegment + direction + 6) % 6);
        dbg.localMap.log('Single-unit Shift-rotate segments (facing copies selected), dir:', direction);
      } else {
        // L/R with single unit: rotate only that unit's facing
        const selectedUnit = tileUnits.find((u) => u.segment === this.selectedSegment);
        if (selectedUnit) {
          selectedUnit.facing = ((selectedUnit.facing + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
          dbg.localMap.log('Single-unit rotate facing:', selectedUnit.label, 'dir:', direction);
        }
      }
    }

    this.onTileSelect(this.selectedTile, this.selectedSegment >= 0 ? this.selectedSegment : undefined);
    this.render();
  }

  // ─── Movement System ───────────────────────────────────────────────

  /** Reset movement points for all units based on their max movement attribute. */
  private resetMovementPoints() {
    this.movementPoints.clear();
    for (const unit of this.world.units) {
      this.movementPoints.set(unit.id, this.getMaxMovement(unit));
    }
  }

  /** Get the maximum movement points for a unit (best of its movement attributes). */
  private getMaxMovement(unit: UnitData): number {
    const attrs = unit.attributes;
    return Math.max(
      attrs.wheeledMovement ?? 0,
      attrs.limbMovement ?? 0,
      attrs.flightMovement ?? 0,
      1 // minimum 1 so every unit can move at least once
    );
  }

  /** Get the remaining movement points for a unit. */
  getRemainingMovement(unitId: string): number {
    return this.movementPoints.get(unitId) ?? 0;
  }

  /** Register callback for end-of-turn. */
  setOnTurnEnd(cb: () => void) {
    this.onTurnEnd = cb;
  }

  /** Register callback for when the player attacks. */
  setOnAttack(cb: (attackerId: string, targetId: string) => void) {
    this.onAttack = cb;
  }

  /** Set the faction allowed to select/move/attack. */
  setActiveFaction(factionId: string) {
    this.activeFaction = factionId;
  }

  /** End the current turn: reset all movement points and deselect. */
  endTurn() {
    dbg.localMap.log('End turn — resetting movement points');
    this.resetMovementPoints();
    this.selectedUnits.clear();
    this.render();
    if (this.onTurnEnd) this.onTurnEnd();
  }

  /** Get set of currently selected unit ids. */
  getSelectedUnits(): Set<string> {
    return this.selectedUnits;
  }

  /**
   * Compute the facing angle (radians, canvas convention: 0=right, π/2=down)
   * for movement from one tile to another, using their actual screen positions.
   * The angle points from `fromTileIndex` toward `toTileIndex` in screen space.
   */
  private computeFacingAngle(fromTileIndex: number, toTileIndex: number): number {
    // Try to find both tiles in the current flat view to get tangent-plane positions
    let fromX = 0, fromY = 0, toX = 0, toY = 0;
    let foundFrom = false, foundTo = false;

    for (const ft of this.flatTiles) {
      if (ft.tileIndex === fromTileIndex) {
        fromX = ft.cx; fromY = ft.cy;
        foundFrom = true;
      }
      if (ft.tileIndex === toTileIndex) {
        toX = ft.cx; toY = ft.cy;
        foundTo = true;
      }
      if (foundFrom && foundTo) break;
    }

    if (foundFrom && foundTo) {
      const dx = toX - fromX;
      const dy = toY - fromY;
      // In our worldToScreen, Y is flipped (wy → -sy), so screen-up = +dy in world.
      // Canvas angle: atan2(screen_dy, screen_dx), where screen_dy = -dy (flipped)
      const result = Math.atan2(-dy, dx);
      dbg.localMap.log('computeFacingAngle: from world pos', fromX.toFixed(4), fromY.toFixed(4),
        '→ to', toX.toFixed(4), toY.toFixed(4),
        '| dx:', dx.toFixed(4), 'dy:', dy.toFixed(4),
        '| angle (deg):', (result * 180 / Math.PI).toFixed(1));
      return result;
    }

    // Fallback: use 3D positions from world data
    const fromPos = this.world.tiles[fromTileIndex].pos;
    const toPos = this.world.tiles[toTileIndex].pos;
    // Rough: just use x,z as a flat projection (good enough for direction)
    const dx = toPos[0] - fromPos[0];
    const dz = toPos[2] - fromPos[2];
    return Math.atan2(-dz, dx);
  }

  /**
   * Convert a radian angle to the nearest facing index (0–5).
   * Segment 0 faces up (-π/2), each step rotates 60° clockwise.
   */
  private angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5 {
    // segmentAngle(i) = -π/2 + i * π/3
    // Invert: i = (angle + π/2) / (π/3)
    let idx = (angle + Math.PI / 2) / (Math.PI / 3);
    // Normalise to [0, 6)
    idx = ((idx % 6) + 6) % 6;
    return Math.round(idx) % 6 as 0 | 1 | 2 | 3 | 4 | 5;
  }

  /**
   * Right-click handler: move selected units toward the target hex,
   * OR attack an enemy unit on the target hex.
   *
   * If the target tile/segment has an enemy unit and the player has a
   * unit selected, it's treated as an attack command.
   */
  private onRightClick(event: MouseEvent) {
    event.preventDefault();

    if (this.selectedUnits.size === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const targetTile = this.findTileAt(x, y);
    if (targetTile < 0) return;

    const targetTileData = this.world.tiles[targetTile];

    // Detect explicitly clicked segment on the target hex
    let targetSegment: number = -1;
    if (targetTileData.s === 6) {
      const ft = this.flatTiles.find((f) => f.tileIndex === targetTile);
      if (ft) {
        targetSegment = this.findSegmentAt(x, y, ft);
      }
    }

    // --- Attack check ---
    // Find if there's an enemy unit at the right-clicked location.
    const unitsOnTarget = this.world.units.filter((u) => u.tileIndex === targetTile);
    const playerUnits = this.world.units.filter((u) => this.selectedUnits.has(u.id));
    if (playerUnits.length > 0) {
      const playerOwner = playerUnits[0].ownerId;

      // Find the specific enemy unit to attack
      let enemyTarget: UnitData | undefined;
      if (targetSegment >= 0) {
        // Clicked a specific segment — target that unit if it's an enemy
        enemyTarget = unitsOnTarget.find((u) => u.segment === targetSegment && u.ownerId !== playerOwner);
      }
      if (!enemyTarget) {
        // No segment match — target any enemy on that tile
        enemyTarget = unitsOnTarget.find((u) => u.ownerId !== playerOwner);
      }

      if (enemyTarget && this.onAttack) {
        // Attack with the first selected unit (single attacker per click)
        const attacker = playerUnits[0];
        dbg.localMap.log('Attack command:', attacker.label, '→', enemyTarget.label);
        this.onAttack(attacker.id, enemyTarget.id);
        return;
      }
    }

    // --- Movement (existing logic) ---
    // Can't move into ocean
    if (targetTileData.terrain === 'ocean') {
      dbg.localMap.log('Movement blocked: ocean tile');
      return;
    }

    // Gather selected units that can still move
    const units = this.world.units;
    const movingUnits = units.filter(
      (u) => this.selectedUnits.has(u.id) && (this.movementPoints.get(u.id) ?? 0) > 0
    );
    if (movingUnits.length === 0) return;

    // Group speed: minimum remaining movement among selected units
    const groupSpeed = Math.min(
      ...movingUnits.map((u) => this.movementPoints.get(u.id) ?? 0)
    );

    // All selected units must share an origin for group movement.
    // If they're on different tiles, move each individually at group speed.
    // BFS from first unit's tile (use shared path if same origin).
    const originTile = movingUnits[0].tileIndex;
    const allSameOrigin = movingUnits.every((u) => u.tileIndex === originTile);

    if (allSameOrigin) {
      // Shared path — all move together at group speed
      const path = this.findPathBFS(originTile, targetTile);
      if (!path || path.length < 2) return;

      const hops = Math.min(groupSpeed, path.length - 1);
      const destTileIndex = path[hops];
      // The tile they came from (for facing direction)
      const prevTileIndex = path[hops - 1];

      // Check capacity at destination
      const existingAtDest = units.filter(
        (u) => u.tileIndex === destTileIndex && !this.selectedUnits.has(u.id)
      );
      if (existingAtDest.length + movingUnits.length > 5) {
        dbg.localMap.log('Movement blocked: destination tile would exceed 5 units');
        return;
      }

      // Set unit facing based on movement direction
      const facingAngle = this.computeFacingAngle(prevTileIndex, destTileIndex);
      const moveFacing = this.angleToFacing(facingAngle);
      dbg.localMap.log('Facing: from tile', prevTileIndex, '→ to tile', destTileIndex,
        '| angle (rad):', facingAngle.toFixed(3),
        '| angle (deg):', (facingAngle * 180 / Math.PI).toFixed(1),
        '| facing idx:', moveFacing);

      // Move all units to destination, preserving their source segment.
      // If a single unit lands on the actual target tile and a segment was
      // explicitly right-clicked, use that as the preferred segment.
      // For multi-unit groups, always preserve original segments so the
      // formation doesn't rotate around the clicked segment.
      const reachedTarget = destTileIndex === targetTile;
      const useTargetSegment = reachedTarget && targetSegment >= 0 && movingUnits.length === 1;
      const occupiedSegments = new Set(existingAtDest.map((u) => u.segment));
      for (const unit of movingUnits) {
        const preferred = useTargetSegment ? targetSegment : unit.segment;
        const freeSegment = this.findPreferredSegment(preferred, occupiedSegments);
        if (freeSegment < 0) break;

        unit.tileIndex = destTileIndex;
        unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
        unit.facing = moveFacing;
        this.movementPoints.set(unit.id, (this.movementPoints.get(unit.id) ?? 0) - hops);
        occupiedSegments.add(freeSegment as 0 | 1 | 2 | 3 | 4 | 5);

        dbg.localMap.log(
          'Moved', unit.label, '→ tile', destTileIndex,
          'segment', freeSegment, '| points left:', this.movementPoints.get(unit.id)
        );
      }
    } else {
      // Units on different tiles — move each individually at group speed
      for (const unit of movingUnits) {
        const path = this.findPathBFS(unit.tileIndex, targetTile);
        if (!path || path.length < 2) continue;

        const hops = Math.min(groupSpeed, path.length - 1);
        const destTileIndex = path[hops];
        const prevTileIndex = path[hops - 1];

        const unitsAtDest = units.filter(
          (u) => u.tileIndex === destTileIndex && u.id !== unit.id
        );
        if (unitsAtDest.length >= 5) continue;

        const reachedTarget = destTileIndex === targetTile;
        const useTarget = reachedTarget && targetSegment >= 0 && movingUnits.length === 1;
        const preferred = useTarget ? targetSegment : unit.segment;
        const occupiedSegments = new Set(unitsAtDest.map((u) => u.segment));
        const freeSegment = this.findPreferredSegment(preferred, occupiedSegments);
        if (freeSegment < 0) continue;

        unit.tileIndex = destTileIndex;
        unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
        unit.facing = this.angleToFacing(this.computeFacingAngle(prevTileIndex, destTileIndex));
        this.movementPoints.set(unit.id, (this.movementPoints.get(unit.id) ?? 0) - hops);

        dbg.localMap.log(
          'Moved', unit.label, '→ tile', destTileIndex,
          'segment', freeSegment, '| points left:', this.movementPoints.get(unit.id)
        );
      }
    }

    // Move selection to follow the units that just moved
    if (movingUnits.length > 0) {
      const dest = movingUnits[0].tileIndex;
      this.selectedTile = dest;
      // If single unit, highlight its segment; otherwise whole hex
      this.selectedSegment = movingUnits.length === 1 ? movingUnits[0].segment : -1;
    } else {
      this.selectedTile = -1;
      this.selectedSegment = -1;
    }

    this.render();
  }

  /**
   * Find the best free segment for a unit arriving at a hex.
   * Prefers the unit's source segment; if taken, picks the nearest
   * alternative (±1, ±2, ±3 mod 6). Returns -1 if all occupied (max 5).
   */
  private findPreferredSegment(sourceSegment: number, occupied: Set<number>): number {
    // Try the same segment first
    if (!occupied.has(sourceSegment)) return sourceSegment;
    // Search outward: distance 1, 2, 3 in both directions
    for (let dist = 1; dist <= 3; dist++) {
      const cw = (sourceSegment + dist) % 6;
      if (!occupied.has(cw)) return cw;
      const ccw = (sourceSegment - dist + 6) % 6;
      if (!occupied.has(ccw)) return ccw;
    }
    return -1;
  }

  /**
   * BFS pathfinding on client tile graph. Returns array of tile indices
   * from `from` to `to` (inclusive), or null if unreachable.
   * Skips ocean tiles (impassable).
   */
  private findPathBFS(from: number, to: number): number[] | null {
    if (from === to) return [from];

    const tiles = this.world.tiles;
    const cameFrom = new Map<number, number>();
    const queue: number[] = [from];
    cameFrom.set(from, -1);
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++];
      if (current === to) {
        // Reconstruct path
        const path: number[] = [];
        let step = to;
        while (step !== -1) {
          path.unshift(step);
          step = cameFrom.get(step)!;
        }
        return path;
      }

      for (const neighbour of tiles[current].n) {
        if (cameFrom.has(neighbour)) continue;
        // Skip ocean (impassable)
        if (tiles[neighbour].terrain === 'ocean') continue;
        cameFrom.set(neighbour, current);
        queue.push(neighbour);
      }
    }

    return null;
  }
}
