/**
 * Local Map View — flat hex map rendered with Canvas 2D.
 * BFS 10 hops from centre, projects actual tile boundary polygons
 * onto a tangent plane. Pentagons are excluded.
 */

import { WorldData, UnitData, TileData } from './worldData.js';
import { baseTerrainColor, factionColor } from './colors.js';
import { drawUnitIcon, segmentAngle } from './unitIcons.js';
import { CombatAnimator } from './combatAnimations.js';
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
  /** Units that have already used their action this turn (attack or repair). */
  private actedUnits: Set<string> = new Set();
  /** Callback when turn ends. */
  private onTurnEnd: (() => void) | null = null;
  /** Callback when player initiates an attack (attackerId, targetId). */
  private onAttack: ((attackerId: string, targetId: string) => void) | null = null;
  /** Callback when player initiates a repair (repairerId, targetId). */
  private onRepair: ((repairerId: string, targetId: string) => void) | null = null;
  /** The faction (ownerId) allowed to select and move units. */
  private activeFaction: string = '';

  // Movement range overlay
  /** Tiles reachable within full MP (movement range). Keyed by tile index → MP cost to reach. */
  private moveRangeTiles: Map<number, number> = new Map();
  /** Tiles reachable with ≥1 MP remaining (can still attack after moving here). */
  private attackReadyTiles: Set<number> = new Set();
  /** Tiles within weapon range from attackReady hexes (outer attack radius). */
  private weaponRangeTiles: Set<number> = new Set();

  // View transform
  private offsetX: number = 0;
  private offsetY: number = 0;
  private scale: number = 0.3;
  private dragging: boolean = false;
  private mouseDownPos: { x: number; y: number } | null = null;
  private lastMouse: { x: number; y: number } = { x: 0, y: 0 };
  private dragEmitPending: boolean = false;
  private lastEmittedCentreTile: number = -1;
  private isProgrammaticCentre: boolean = false;

  // Combat animations
  private animator: CombatAnimator;
  /** Units hidden from rendering (e.g. destroyed during animation). */
  private hiddenUnits: Set<string> = new Set();

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldData,
    onTileSelect: (tileIndex: number, segment?: number) => void
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.world = world;
    this.onTileSelect = onTileSelect;
    this.animator = new CombatAnimator(canvas);
    this.animator.setRenderCallback(() => this.render());

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
    this.isProgrammaticCentre = true;
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
   * Get the screen-space position of a unit by its id.
   * Returns null if the unit isn't visible on the current view.
   */
  getUnitScreenPos(unitId: string): { x: number; y: number } | null {
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return null;

    const ft = this.flatTiles.find((f) => f.tileIndex === unit.tileIndex);
    if (!ft) return null;

    const seg = this.getSegmentCentroid(ft, unit.segment);
    if (!seg) return null;

    const [sx, sy] = this.worldToScreen(seg.x, seg.y);
    return { x: sx, y: sy };
  }

  /**
   * Play the full attack animation sequence (missile → explosion → smoke).
   * Renders the base map, then overlays animations.
   * Returns a promise that resolves when all animations complete.
   */
  async playAttackAnimation(
    attackerId: string,
    targetId: string,
    factionColorHex: string,
    damage: number,
    targetDestroyed: boolean,
  ): Promise<void> {
    const from = this.getUnitScreenPos(attackerId);
    const to = this.getUnitScreenPos(targetId);
    if (!from || !to) return; // units not visible, skip animation

    // Play missile → explosion, then hide the unit before the smoke plume
    await this.animator.playMissile(from, to, factionColorHex);
    await this.animator.playExplosion(to, damage, factionColorHex);
    if (targetDestroyed) {
      this.hiddenUnits.add(targetId);
      this.render();
      await this.animator.playSmoke(to);
      this.hiddenUnits.delete(targetId);
    }
  }

  /** Whether combat animations are currently playing. */
  get isAnimating(): boolean {
    return this.animator.isAnimating;
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

    // Build a visible tile lookup once so terrain shading can compare each
    // triangle with the neighbouring hex across that edge.
    const ftByTile = new Map<number, FlatTile>();
    for (const ft of this.flatTiles) {
      ftByTile.set(ft.tileIndex, ft);
    }

    // Draw each tile as its actual boundary polygon
    for (const ft of this.flatTiles) {
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

      // Water interiors should read as one continuous lake/sea surface, so do
      // not draw full hex outlines or tactical segment lines inside water.
      // Only draw the coastline/shoreline where water meets non-water.
      if (this.isWaterTile(tile)) {
        this.drawWaterBoundaryEdges(ft, tile, ftByTile);
      } else {
        this.ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        this.ctx.lineWidth = 0.5;
        this.ctx.stroke();
      }

      // Draw faint dotted segment dividers on land hexes only.
      if (tile.s === 6 && !this.isWaterTile(tile)) {
        this.drawSegmentLines(ft);
      }

      // Draw tree icons in each corner of forested hexes
      if (tile.f && tile.s === 6) {
        this.drawForestCornerTrees(ft);
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

    // Add a single-surface water sheen after all tiles are filled.  Because
    // internal water hex/segment lines are suppressed above, this pass can make
    // connected lakes read as reflective water rather than as blue board tiles.
    this.drawWaterSurfaceLighting(ftByTile);

    // Terrain relief is drawn as a separate map-level pass.  It does not use
    // hex-edge contours or visible triangle meshes.  Contour lines follow the
    // centres of tiles that sit on the same elevation band boundary; local
    // one-hex peaks/troughs get compact relief shading instead.
    this.drawTerrainFeathering(ftByTile);
    this.drawContourRelief(ftByTile);

    // Draw movement range overlay (before units, after tiles)
    this.drawMovementRange();

    // Draw units at all zoom levels
    this.drawUnits();

    // Draw AI combat highlights (attacker ring + target ring + connecting line)
    this.drawCombatHighlight();

    // Draw combat animation overlays (missiles, explosions, smoke)
    this.animator.drawFrame();

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
   * Draw a small tree icon at a given screen position.
   * The tree is a simple triangle (canopy) over a short trunk.
   * `size` controls the overall scale.
   */
  private drawTreeIcon(sx: number, sy: number, size: number): void {
    const ctx = this.ctx;
    const trunkH = size * 0.4;
    const trunkW = size * 0.18;
    const canopyH = size * 1.1;
    const canopyW = size * 0.85;

    ctx.save();

    // Trunk
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(sx - trunkW / 2, sy - trunkH, trunkW, trunkH);

    // Canopy (triangle)
    ctx.beginPath();
    ctx.moveTo(sx, sy - trunkH - canopyH);
    ctx.lineTo(sx - canopyW / 2, sy - trunkH);
    ctx.lineTo(sx + canopyW / 2, sy - trunkH);
    ctx.closePath();
    ctx.fillStyle = '#1a5c1a';
    ctx.fill();

    ctx.restore();
  }

  /** Convert terrain/elevation labels into a small continuous height scale. */
  private elevationHeight(tile: TileData): number {
    const elev = tile.elevType ?? tile.terrain;
    switch (elev) {
      case 'ocean': return -0.25;
      case 'flat': return 0.0;
      case 'rolling': return 0.28;
      case 'hills': return 0.58;
      case 'mountain': return 1.0;
      default:
        // Fallback for worlds where terrain carries the elevation signal.
        if (tile.terrain === 'ocean') return -0.25;
        if (tile.terrain === 'hills') return 0.58;
        if (tile.terrain === 'mountain') return 1.0;
        return 0.0;
    }
  }

  /**
   * Find the neighbour that lies across a particular polygon edge.
   *
   * This is more robust than assuming tile.n[segment] matches the boundary
   * vertex order: it chooses the visible neighbour whose projected centre is
   * most aligned with the edge's outward direction.  If no candidate neighbour
   * is visible at the edge of the local view, it falls back to tile.n[segment].
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

  /** Convert elevation labels into discrete contour levels. */
  private elevationLevel(tile: TileData): number {
    const elev = tile.elevType ?? tile.terrain;
    switch (elev) {
      case 'ocean': return -1;
      case 'flat': return 0;
      case 'rolling': return 1;
      case 'hills': return 2;
      case 'mountain': return 3;
      default:
        if (tile.terrain === 'ocean') return -1;
        if (tile.terrain === 'hills') return 2;
        if (tile.terrain === 'mountain') return 3;
        return 0;
    }
  }

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

  /** Blend two CSS hex colours.  Falls back to the first colour if parsing fails. */
  private mixHexColors(a: string, b: string, t: number): string {
    const ca = this.hexToRgb(a);
    const cb = this.hexToRgb(b);
    if (!ca || !cb) return a;
    const clamped = Math.max(0, Math.min(1, t));
    const r = Math.round(ca.r + (cb.r - ca.r) * clamped);
    const g = Math.round(ca.g + (cb.g - ca.g) * clamped);
    const bl = Math.round(ca.b + (cb.b - ca.b) * clamped);
    return `rgb(${r},${g},${bl})`;
  }

  /** Whether a tile should be treated as open water for rendering. */
  private isWaterTile(tile: TileData): boolean {
    const terrain = String(tile.terrain ?? '').toLowerCase();
    const elev = String(tile.elevType ?? '').toLowerCase();
    return terrain === 'ocean' || terrain === 'water' || terrain === 'lake' || elev === 'ocean' || elev === 'water' || elev === 'lake';
  }

  /** Base colour for feathering only; cities keep their hard faction fill. */
  private terrainFillColor(tile: TileData): string {
    if (tile.city) return factionColor(this.world, tile.city);
    if (tile.elevType === 'mountain' || tile.terrain === 'mountain') return '#cfcfcf';
    return baseTerrainColor(tile);
  }

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

  /** Deterministic pseudo-random helper for tiny water-sparkle placement. */
  private hash01(n: number): number {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

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

  /**
   * Draw connected water bodies as one uniform reflective surface.
   *
   * Water should not show per-hex lighting, random shimmer strokes, contour
   * shading, or tactical texture.  Each connected lake/sea is clipped as one
   * shape and receives a single broad reflection from the same upper-left sun
   * direction used by the elevation relief.
   */
  private drawWaterSurfaceLighting(ftByTile: Map<number, FlatTile>): void {
    const waterSet = new Set<number>();
    for (const ft of this.flatTiles) {
      if (this.isWaterTile(this.world.tiles[ft.tileIndex])) {
        waterSet.add(ft.tileIndex);
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

      // A single component-wide reflection gradient.  Because it is clipped to
      // the whole connected water body, it reads as one flat reflective surface
      // rather than as shaded individual hexes.
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

      // A broad, soft specular patch on the sun-facing side.  This is uniform
      // at the water-body scale and deliberately avoids line texture.
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

  /**
   * Soften hard biome edges by washing a mixed colour along shared borders.
   * This is intentionally a low-alpha pass: the map remains readable as hexes,
   * but adjacent terrain no longer looks like cut paper.
   */
  private drawTerrainFeathering(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const ft of this.flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      const color = this.terrainFillColor(tile);

      for (let seg = 0; seg < ft.poly.length; seg++) {
        const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
        if (!neighbour) continue;
        const neighbourIdx = this.world.tiles.indexOf(neighbour);
        if (neighbourIdx >= 0 && ft.tileIndex > neighbourIdx) continue;

        const nColor = this.terrainFillColor(neighbour);
        if (nColor === color && neighbour.terrain === tile.terrain && neighbour.elevType === tile.elevType) continue;

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

  /** True when this tile sits on the outer edge of an elevation threshold. */
  private isContourBandTile(tileIdx: number, level: number): boolean {
    const tile = this.world.tiles[tileIdx];
    if (!tile || this.elevationLevel(tile) < level) return false;
    return tile.n.some((nIdx: number) => this.elevationLevel(this.world.tiles[nIdx]) < level);
  }

  /**
   * Faint centreline contour helper.
   *
   * These lines are now only a nearly invisible guide to the contour path.
   * The terrain form is carried by the gradient relief painted on the actual
   * high/low boundary edges, not by this line.
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
    grad.addColorStop(0.45, nearColor.replace(/,([0-9.]+)\)$/, (_m, a) => `,${(parseFloat(a) * 0.45).toFixed(3)})`));
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
   *
   * The contour centreline is deliberately almost invisible.  Relief is drawn
   * as wide, feathered bands attached to the boundary between the higher tile
   * and its lower neighbour:
   * - shadow starts on the high edge and falls into the lower tile when the
   *   edge faces away from the sun
   * - highlight starts on the leading/sun-facing edge and fades back across
   *   the higher tile
   *
   * Both bands graduate to roughly half a hex radius so the effect reads as a
   * continuous slope rather than as another heavy line.
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

    // outward points from the higher contour tile toward the lower neighbour.
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

    // Cast shadow: attached to the high edge, then feathered deeply into the
    // lower neighbour.  This is a filled gradient band, not a stroked contour.
    if (awayFromSun > 0.04) {
      const shadowAlpha = Math.min(0.42, (0.24 + level * 0.045) * strength * awayFromSun);
      this.fillContourGradientBand(
        ax,
        ay,
        bx,
        by,
        nx,
        ny,
        bandWidth,
        `rgba(5,8,14,${shadowAlpha.toFixed(3)})`,
        'rgba(5,8,14,0.000)',
      );

      // A very tight contact shadow exactly at the terrain step helps the
      // wider feather read as a drop without turning the contour line heavy.
      this.fillContourGradientBand(
        ax,
        ay,
        bx,
        by,
        nx,
        ny,
        Math.max(3, radius * 0.10),
        `rgba(0,0,0,${(shadowAlpha * 0.45).toFixed(3)})`,
        'rgba(0,0,0,0.000)',
      );
    }

    // Leading-edge highlight: attached to the same boundary, but feathered
    // back across the higher tile on sun-facing edges.
    if (towardSun > 0.04) {
      const highlightAlpha = Math.min(0.48, (0.30 + level * 0.055) * strength * towardSun);
      this.fillContourGradientBand(
        ax + highNx * innerLip,
        ay + highNy * innerLip,
        bx + highNx * innerLip,
        by + highNy * innerLip,
        highNx,
        highNy,
        bandWidth * 0.92,
        `rgba(255,252,218,${highlightAlpha.toFixed(3)})`,
        'rgba(255,252,218,0.000)',
      );
    }

    ctx.restore();
  }

  /**
   * Draw contours as centreline traces along the edge of each elevation band.
   *
   * A contour for level N passes through centres of all tiles that are at or
   * above N and touch lower ground.  Adjacent contour-band tile centres are
   * connected, so protruding one-tile fingers remain part of the contour
   * instead of being smoothed away.
   */
  private drawContourRelief(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // First pass: paint relief on the actual high/low hex boundaries that
    // generate each contour.  This keeps shadow off the contour centreline
    // and puts the cast shadow onto the lower neighbouring terrain.
    for (let level = 1; level <= 3; level++) {
      for (const ft of this.flatTiles) {
        const tile = this.world.tiles[ft.tileIndex];
        if (tile.s !== 6 || this.elevationLevel(tile) < level || ft.poly.length < 6) continue;

        for (let seg = 0; seg < ft.poly.length; seg++) {
          const neighbour = this.neighbourAcrossSegment(tile, ft, seg, ftByTile);
          if (!neighbour || this.elevationLevel(neighbour) >= level) continue;
          this.drawContourEdgeRelief(ft, tile, seg, level, neighbour);
        }
      }
    }

    // Second pass: add compact triangular peak shading to every local high
    // point with four or more lower neighbours.  This preserves protruding
    // ridges and one-hex summits without reintroducing global triangle noise.
    for (const ft of this.flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      this.drawPeakTriangularRelief(ft, tile, ftByTile);
    }

    // Third pass: draw the contour path itself very faintly through the
    // centres of the contour-band tiles.  These are correct positional lines,
    // but they should not carry the relief/shadow styling.
    const drawn = new Set<string>();

    for (let level = 1; level <= 3; level++) {
      for (const ft of this.flatTiles) {
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
          // One-hex spurs still need a small local mark, but keep it compact
          // and let drawSingleHexRelief handle the local highlight/shadow.
          this.drawSingleHexRelief(ft, tile, level, ftByTile);
          drawn.add(`${level}:${ft.tileIndex}`);
        }
      }
    }

    ctx.restore();
  }

  /**
   * Draw compact triangular peak shading on any hex that stands above most of
   * its immediate neighbours.
   *
   * This is intentionally separate from the contour-edge relief: contour edges
   * communicate broad slopes, while this local pass makes small summits and
   * protruding ridge points read as raised terrain.  A hex qualifies when four
   * or more of its neighbours are lower, so single-hex peaks and ridge noses are
   * preserved instead of being lost inside the contour network.
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

      // For a raised hex, each triangular face is treated as sloping outward
      // from the centre.  Faces pointing toward the sun get a warm highlight;
      // faces pointing away get a cooler shadow.
      const facingSun = (dx / len) * SUN_X + (dy / len) * SUN_Y;
      const baseAlpha = (0.105 + ownLevel * 0.035) * peakStrength * edgeWeight * Math.abs(facingSun);
      const alpha = Math.min(0.34, baseAlpha);
      if (alpha < 0.01) continue;

      const grad = ctx.createLinearGradient(csx, csy, midX, midY);
      if (facingSun >= 0) {
        grad.addColorStop(0.0, `rgba(255,252,220,${(alpha * 0.10).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(255,252,220,${(alpha * 0.38).toFixed(3)})`);
        grad.addColorStop(1.0, `rgba(255,252,220,${alpha.toFixed(3)})`);
      } else {
        grad.addColorStop(0.0, `rgba(7,12,22,${(alpha * 0.12).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(7,12,22,${(alpha * 0.48).toFixed(3)})`);
        grad.addColorStop(1.0, `rgba(7,12,22,${(alpha * 1.12).toFixed(3)})`);
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
   * Compact relief for a one-hex local peak/trough.  This is the only place
   * where triangular shading is used, and it is deliberately localised.
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
    const isPeak = neighbourLevels.every((h) => h < ownLevel);
    const isTrough = neighbourLevels.every((h) => h > ownLevel);
    if (isPeak) return; // handled by drawPeakTriangularRelief for all local highs
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

    // No circular peak/trough contour here: isolated highs/lows now read
    // through the compact triangular relief shading above.
  }

  /** Average centre-to-vertex radius in screen pixels. */
  private getAverageHexScreenRadius(ft: FlatTile): number {
    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      avgRadius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
    }
    return avgRadius / Math.max(1, ft.poly.length);
  }

  /**
   * Draw elevation shading using a local height field rather than only the
   * current hex's elevation type.
   *
   * Each triangular face compares this tile's height with the neighbour across
   * that edge.  A mountain next to lower land produces a lit/shadowed downhill
   * face; a hill below a higher neighbour shades as an upslope.  This makes
   * ridges and valleys continue across hex boundaries while preserving the
   * stronger pointiness of hills and mountains.
   */
  private drawElevationShading(
    ft: FlatTile,
    tile: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);

    // Compute average hex radius in screen pixels
    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      avgRadius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
    }
    avgRadius /= ft.poly.length;
    if (avgRadius < 5) return;

    // Sun direction in screen space: upper-left / north-west.
    const SUN_X = -0.707;
    const SUN_Y = -0.707;

    const centreHeight = this.elevationHeight(tile);

    // Base pointiness still comes from this tile, so a lone mountain remains
    // sharper than rolling land, but face brightness comes from neighbour slope.
    let peakPull: number;
    let litAlpha: number;
    let shadowAlpha: number;
    let snowCap: boolean; // intentionally disabled below: elevation should read through triangles only

    switch (tile.elevType) {
      case 'rolling':
        peakPull = 0.18;
        litAlpha = 0.18;
        shadowAlpha = 0.12;
        snowCap = false;
        break;
      case 'hills':
        peakPull = 0.38;
        litAlpha = 0.38;
        shadowAlpha = 0.24;
        snowCap = false;
        break;
      case 'mountain':
      default:
        peakPull = 0.62;
        litAlpha = 0.62;
        shadowAlpha = 0.42;
        snowCap = false;
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

      // +1 means the face slopes downward away from this hex centre, so the
      // outward face normal catches light from SUN_X/Y. -1 means terrain rises
      // toward the neighbour, so the face normal points back inward.
      const slopeSign = Math.abs(heightDelta) < 0.03 ? 1 : Math.sign(heightDelta);
      const sunFacing = (normX * SUN_X + normY * SUN_Y) * slopeSign;

      // Keep subtle form on broad plateaus, but amplify cliffs/ridges where
      // neighbouring heights differ strongly.
      const slopeStrength = Math.min(1, Math.abs(heightDelta) * 1.8 + centreHeight * 0.25);
      const dot = sunFacing * (0.35 + 0.65 * slopeStrength);

      // Pull the apex a bit farther toward higher neighbouring terrain. This
      // visually links adjacent high tiles into ranges instead of isolated cones.
      const neighbourPull = heightDelta < -0.03 ? Math.min(0.18, Math.abs(heightDelta) * 0.12) : 0;
      const facePeakPull = Math.min(0.78, peakPull + neighbourPull);
      const apexX = csx + (midX - csx) * facePeakPull;
      const apexY = csy + (midY - csy) * facePeakPull;

      const grad = ctx.createLinearGradient(apexX, apexY, midX, midY);

      if (dot >= 0) {
        const a = dot * litAlpha;
        grad.addColorStop(0, `rgba(255,252,240,${(a * 1.0).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(255,252,240,${(a * 0.35).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(255,252,240,0.00)');
      } else {
        const a = (-dot) * shadowAlpha;
        grad.addColorStop(0, `rgba(20,30,50,${(a * 1.0).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(20,30,50,${(a * 0.55).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(20,30,50,0.00)');
      }

      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Ridge lines appear mostly where there is real relief against the
      // neighbour, so continuous ranges get structure without every flat edge
      // becoming noisy.
      const relief = Math.min(1, Math.abs(heightDelta) * 2.0 + centreHeight * 0.15);
      const ridgeAlpha = dot >= 0
        ? dot * relief * (tile.elevType === 'mountain' ? 0.42 : tile.elevType === 'hills' ? 0.24 : 0.12)
        : 0.025 * relief;
      ctx.strokeStyle = `rgba(255,255,255,${ridgeAlpha.toFixed(3)})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(ax, ay);
      ctx.moveTo(csx, csy);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // No separate snow caps/glints here: with fixed base colours, elevation
    // should come from triangle shading only, not extra symbols per hex.

    ctx.restore();
  }

  /**
   * Draw a small tree icon in each corner (boundary vertex) of a forested hex.
   * Trees are placed slightly inward from each vertex toward the hex centre,
   * scaled to fit without overlapping the segment dividers.
   */
  private drawForestCornerTrees(ft: FlatTile): void {
    if (ft.poly.length < 6) return;

    // Compute hex radius in screen pixels (average distance from centre to vertex)
    const [csx, csy] = this.worldToScreen(ft.cx, ft.cy);
    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      const dx = vx - csx;
      const dy = vy - csy;
      avgRadius += Math.sqrt(dx * dx + dy * dy);
    }
    avgRadius /= ft.poly.length;

    // Only draw trees when the hex is large enough to be legible
    if (avgRadius < 8) return;

    const treeSize = Math.max(2, avgRadius * 0.22);
    // Inset factor: pull the tree position toward the centre so it sits
    // inside the hex rather than on the edge
    const inset = 0.62;

    for (const v of ft.poly) {
      const [vx, vy] = this.worldToScreen(v.x, v.y);
      // Interpolate between vertex and centre
      const tx = vx + (csx - vx) * (1 - inset);
      const ty = vy + (csy - vy) * (1 - inset);
      this.drawTreeIcon(tx, ty, treeSize);
    }
  }

  /**
   * Draw faint dotted segment dividers from hex centre to each boundary vertex.
   */
  private drawSegmentLines(ft: FlatTile) {
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
      if (this.hiddenUnits.has(unit.id)) continue;
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

      // Movement points for this unit
      const currentMP = this.movementPoints.get(unit.id) ?? 0;
      const maxMP = this.getMaxMovement(unit);

      // Draw composite icon
      drawUnitIcon(this.ctx, unit, sx, sy, size, color, facingAngle, currentMP, maxMP);

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
      this.computeMovementRange();
      this.onTileSelect(tileIdx, segment >= 0 ? segment : undefined);
      if (this.selectedUnits.size === 0) this.canvas.style.cursor = '';
      this.render();
    } else {
      dbg.localMap.log('Click missed (no tile at position)');
      this.selectedUnits.clear();
      this.computeMovementRange();
      this.canvas.style.cursor = '';
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
      this.isProgrammaticCentre = false;
      this.render();
      this.emitDragCentreThrottled();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Attack preview: when player has a unit selected, hovering an enemy shows preview
    if (this.onHoverEnemy && this.selectedUnits.size > 0) {
      const tileIdx = this.findTileAt(x, y);
      if (tileIdx >= 0) {
        // Detect segment-level hover so preview updates when moving between
        // triangles within the same hex (not just when crossing hex boundaries).
        const ft = this.flatTiles.find((f) => f.tileIndex === tileIdx);
        const segment = ft ? this.findSegmentAt(x, y, ft) : -1;

        const playerUnits = this.world.units.filter((u) => this.selectedUnits.has(u.id));
        if (playerUnits.length > 0) {
          const playerOwner = playerUnits[0].ownerId;
          // Find enemy in the specific segment under the cursor
          const enemy = this.world.units.find(
            (u) => u.tileIndex === tileIdx && u.segment === segment && u.ownerId !== playerOwner
          );
          if (enemy) {
            // Crosshair cursor when hovering an enemy with a unit selected
            this.canvas.style.cursor = 'crosshair';
            if (this.lastHoveredEnemyId !== enemy.id) {
              this.lastHoveredEnemyId = enemy.id;
              this.onHoverEnemy(playerUnits[0], enemy);
            }
            return;
          }
        }
      }
      // No enemy under cursor — clear preview and reset cursor
      this.canvas.style.cursor = '';
      if (this.lastHoveredEnemyId !== null) {
        this.lastHoveredEnemyId = null;
        this.onHoverEnemy(null, null);
      }
    } else {
      // No unit selected — ensure default cursor
      this.canvas.style.cursor = '';
    }
  }

  /**
   * Throttled callback during drag to sync the globe view.
   * At low zoom, also recenter the local map to prevent drift.
   * At high zoom, only sync the globe without recentering (smooth pan).
   */
  private emitDragCentreThrottled() {
    if (this.dragEmitPending) return;
    if (this.isProgrammaticCentre) return; // Prevent feedback loop
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

      // At low zoom (< 1.5), recenter immediately to prevent map drift
      // At high zoom, defer recentering until mouse up for smooth panning
      if (this.scale < 1.5 && tileIdx !== this.centreTileIndex) {
        dbg.localMap.log('Recentering during drag (low zoom):', this.scale.toFixed(2));
        this.centreTileIndex = tileIdx;
        this.flatTiles = this.buildFlatView(tileIdx, this.radius);
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

  /**
   * Recenter the flat view when the user has dragged far enough that
   * tiles at the edge are running out. Called on mouse up.
   * At low zoom, recenter aggressively to prevent the whole map drifting.
   * At high zoom, allow more offset accumulation for smooth panning.
   */
  private recenterIfNeeded() {
    const rect = this.canvas.getBoundingClientRect();
    const centreX = rect.width / 2;
    const centreY = rect.height / 2;
    const tileIdx = this.findTileAt(centreX, centreY);
    if (tileIdx < 0) return;
    
    // Only recenter if we've moved significantly from the projection center
    if (tileIdx !== this.centreTileIndex) {
      const currentCentre = this.flatTiles.find(ft => ft.tileIndex === this.centreTileIndex);
      const newCentre = this.flatTiles.find(ft => ft.tileIndex === tileIdx);
      
      if (currentCentre && newCentre) {
        const dist = Math.sqrt(
          (newCentre.cx - currentCentre.cx) ** 2 + 
          (newCentre.cy - currentCentre.cy) ** 2
        );
        const avgRadius = this.screenHexRadius(currentCentre) / (this.scale * Math.min(rect.width, rect.height) * 3.5);
        
        // At low zoom (< 1.0), recenter after 1 tile. At high zoom, allow 3+ tiles.
        const threshold = this.scale < 1.0 ? avgRadius * 1.0 : avgRadius * 3.0;
        
        if (dist > threshold) {
          dbg.localMap.log('Recentering after drag: distance =', dist.toFixed(3), 'threshold =', threshold.toFixed(3), 'zoom =', this.scale.toFixed(2));
          this.centreTileIndex = tileIdx;
          this.flatTiles = this.buildFlatView(tileIdx, this.radius);
          this.offsetX = 0;
          this.offsetY = 0;
          this.render();
        }
      }
    }
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
    if (this.dragging) {
      this.dragging = false;
      this.recenterIfNeeded();
    }
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
    this.actedUnits.clear();
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

  /** Get the movement mode for a unit. */
  private getMovementMode(unit: UnitData): 'wheeled' | 'limb' | 'flight' {
    if ((unit.attributes.flightMovement ?? 0) >= 1) return 'flight';
    if ((unit.attributes.limbMovement ?? 0) >= 1) return 'limb';
    return 'wheeled';
  }

  /** Whether a terrain type is impassable for ground units. */
  private isImpassableTerrain(terrain: string): boolean {
    return terrain === 'mountain' || terrain === 'ocean';
  }

  /** Whether terrain counts as hill for movement costs. */
  private isHillTerrain(terrain: string): boolean {
    return terrain === 'hills';
  }

  /**
   * Calculate MP cost to enter a tile for a given movement mode.
   * isFirstHex: whether this is the first hex the unit moves into this turn.
   */
  private hexEntryCost(tile: TileData, mode: 'wheeled' | 'limb' | 'flight', isFirstHex: boolean): number {
    if (this.isImpassableTerrain(tile.terrain) && mode !== 'flight') return Infinity;
    if (isFirstHex) return 1;
    if (mode === 'flight') return 1;
    if (mode === 'limb') return 3;

    // Tank/wheeled
    const hill = this.isHillTerrain(tile.terrain);
    const forested = tile.f === true;
    if (hill && forested) return 4;
    if (hill || forested) return 3;
    return 2;
  }

  // -------------------------------------------------------------------------
  // Movement range overlay computation
  // -------------------------------------------------------------------------

  /**
   * Compute movement range zones for the selected unit using Dijkstra flood fill.
   * Populates moveRangeTiles, attackReadyTiles, and weaponRangeTiles.
   */
  private computeMovementRange(): void {
    this.moveRangeTiles.clear();
    this.attackReadyTiles.clear();
    this.weaponRangeTiles.clear();

    if (this.selectedUnits.size === 0) return;

    // Use the first selected unit for range display
    const unitId = [...this.selectedUnits][0];
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;

    const remainingMP = this.movementPoints.get(unitId) ?? 0;
    if (remainingMP <= 0) return;

    const mode = this.getMovementMode(unit);
    const totalMP = this.getMaxMovement(unit);
    const alreadySpent = totalMP - remainingMP;
    // If unit already moved (spent > 0), first-hex rule no longer applies
    const hexesMoved = alreadySpent > 0 ? 1 : 0;

    const startTile = unit.tileIndex;
    const tiles = this.world.tiles;

    // Dijkstra flood fill from the unit's current tile
    // dist map: tile index → total MP cost to reach that tile
    const dist = new Map<number, number>();
    dist.set(startTile, 0);

    // Priority queue (simple array sorted by cost — fine for small BFS radius)
    const pq: { idx: number; cost: number }[] = [{ idx: startTile, cost: 0 }];

    while (pq.length > 0) {
      // Extract minimum cost node
      let minI = 0;
      for (let i = 1; i < pq.length; i++) {
        if (pq[i].cost < pq[minI].cost) minI = i;
      }
      const { idx: current, cost: currentCost } = pq[minI];
      pq.splice(minI, 1);

      // Skip if we already found a better path
      if (currentCost > (dist.get(current) ?? Infinity)) continue;

      // Explore neighbours
      for (const neighbour of tiles[current].n) {
        const nTile = tiles[neighbour];
        // Determine if this is the first hex of the turn
        // hexesMoved tracks whether unit has already moved; if cost so far is 0
        // and hexesMoved is 0, the next hop is the first hex
        const hopsFromStart = currentCost === 0 && hexesMoved === 0;
        const entryCost = this.hexEntryCost(nTile, mode, hopsFromStart);
        if (entryCost === Infinity) continue;

        const newCost = currentCost + entryCost;
        if (newCost > remainingMP) continue;

        const existingCost = dist.get(neighbour);
        if (existingCost === undefined || newCost < existingCost) {
          dist.set(neighbour, newCost);
          pq.push({ idx: neighbour, cost: newCost });
        }
      }
    }

    // Remove the start tile from the range display (unit is already there)
    dist.delete(startTile);

    // Populate moveRangeTiles (all reachable hexes)
    this.moveRangeTiles = dist;

    // Populate attackReadyTiles (hexes reachable with ≥1 MP remaining for attack)
    for (const [tileIdx, cost] of dist) {
      if (remainingMP - cost >= 1) {
        this.attackReadyTiles.add(tileIdx);
      }
    }
    // Also include start tile as attack-ready if unit has MP for attack without moving
    if (remainingMP >= 1) {
      this.attackReadyTiles.add(startTile);
    }

    // Compute weapon range: rangeAttack value IS the range in hexes
    const rangeAttack = unit.attributes.rangeAttack ?? 0;
    const meleeAttack = unit.attributes.attack ?? 0;
    const weaponRange = Math.max(rangeAttack, meleeAttack > 0 ? 1 : 0);

    if (weaponRange > 0) {
      // BFS outward from every attack-ready tile up to weaponRange hops
      for (const readyTile of this.attackReadyTiles) {
        const queue: { idx: number; d: number }[] = [{ idx: readyTile, d: 0 }];
        const visited = new Set<number>();
        visited.add(readyTile);
        let head = 0;

        while (head < queue.length) {
          const { idx, d } = queue[head++];
          if (d >= weaponRange) continue;

          for (const neighbour of tiles[idx].n) {
            if (visited.has(neighbour)) continue;
            visited.add(neighbour);
            // Weapon range tiles are those NOT already in moveRange or attackReady
            if (!this.moveRangeTiles.has(neighbour) && !this.attackReadyTiles.has(neighbour) && neighbour !== startTile) {
              this.weaponRangeTiles.add(neighbour);
            }
            queue.push({ idx: neighbour, d: d + 1 });
          }
        }
      }
    }
  }

  /**
   * Draw movement range as bounding lines around each zone:
   * - Green solid: attack-ready tiles (movement leaving ≥1 MP)
   * - Blue dashed: max movement range (all reachable tiles)
   * - Red dotted: max weapon range (outer attack radius)
   *
   * Only edges that border tiles NOT in the same zone are drawn,
   * producing a clean perimeter outline for each radius.
   */
  private drawMovementRange(): void {
    if (this.moveRangeTiles.size === 0 && this.weaponRangeTiles.size === 0) return;

    // Build a tile→FlatTile lookup for visible tiles
    const ftByTile = new Map<number, FlatTile>();
    for (const ft of this.flatTiles) {
      ftByTile.set(ft.tileIndex, ft);
    }

    // The three zone sets (each zone is a superset of the previous):
    // 1. attackReady ⊆ moveRange ⊆ (moveRange ∪ weaponRange)
    const attackReadySet = this.attackReadyTiles;
    const moveRangeSet = new Set<number>(this.moveRangeTiles.keys());
    // Add attackReady start tile to moveRange for boundary purposes
    for (const t of attackReadySet) moveRangeSet.add(t);
    const allRangeSet = new Set<number>(moveRangeSet);
    for (const t of this.weaponRangeTiles) allRangeSet.add(t);

    // Draw weapon range boundary (red dotted) — outermost
    this.drawZoneBoundary(allRangeSet, ftByTile, 'rgba(255, 80, 60, 0.9)', [4, 4], 2);
    // Draw max movement boundary (blue dashed)
    this.drawZoneBoundary(moveRangeSet, ftByTile, 'rgba(80, 160, 255, 0.9)', [8, 4], 2);
    // Draw attack-ready boundary (green solid) — innermost
    this.drawZoneBoundary(attackReadySet, ftByTile, 'rgba(80, 220, 120, 0.9)', [], 2.5);
  }

  /**
   * Draw the boundary of a tile zone by outlining entire hexes that sit on the perimeter.
   * A tile is on the perimeter if any of its neighbours is outside the zone.
   */
  private drawZoneBoundary(
    zone: Set<number>,
    ftByTile: Map<number, FlatTile>,
    color: string,
    dash: number[],
    lineWidth: number,
  ): void {
    if (zone.size === 0) return;

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.setLineDash(dash);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();

    for (const tileIdx of zone) {
      const ft = ftByTile.get(tileIdx);
      if (!ft) continue;

      // Check if this tile is on the boundary (has any neighbour outside the zone)
      const tile = this.world.tiles[tileIdx];
      const onBoundary = tile.n.some((n: number) => !zone.has(n));
      if (!onBoundary) continue;

      // Draw full hex outline
      for (let i = 0; i < ft.poly.length; i++) {
        const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
        if (i === 0) this.ctx.moveTo(sx, sy);
        else this.ctx.lineTo(sx, sy);
      }
      this.ctx.closePath();
    }

    this.ctx.stroke();
    this.ctx.restore();
  }

  /** Draw a colored overlay on a tile polygon. */
  private drawTileOverlay(ft: FlatTile, color: string): void {
    this.ctx.beginPath();
    for (let i = 0; i < ft.poly.length; i++) {
      const [sx, sy] = this.worldToScreen(ft.poly[i].x, ft.poly[i].y);
      if (i === 0) this.ctx.moveTo(sx, sy);
      else this.ctx.lineTo(sx, sy);
    }
    this.ctx.closePath();
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  /**
   * Calculate how many BFS hops along a path a unit can afford.
   * hexesAlreadyMoved: how many hexes the unit has already moved this turn (for first-hex rule).
   * Returns the number of hops (tiles entered) affordable within remaining MP.
   */
  private affordableHops(path: number[], unit: UnitData, remainingMP: number, hexesAlreadyMoved: number): number {
    const mode = this.getMovementMode(unit);
    let spent = 0;
    let hops = 0;

    for (let i = 1; i < path.length; i++) {
      const isFirst = (hexesAlreadyMoved + i - 1) === 0;
      const cost = this.hexEntryCost(this.world.tiles[path[i]], mode, isFirst);
      if (cost === Infinity) break;
      spent += cost;
      if (spent > remainingMP) break;
      hops++;
    }
    return hops;
  }

  /**
   * Calculate the actual MP spent for a given number of hops along a path.
   */
  private mpSpentForHops(path: number[], unit: UnitData, hops: number, hexesAlreadyMoved: number): number {
    const mode = this.getMovementMode(unit);
    let spent = 0;
    for (let i = 1; i <= hops && i < path.length; i++) {
      const isFirst = (hexesAlreadyMoved + i - 1) === 0;
      spent += this.hexEntryCost(this.world.tiles[path[i]], mode, isFirst);
    }
    return spent;
  }

  /** Get the remaining movement points for a unit. */
  getRemainingMovement(unitId: string): number {
    return this.movementPoints.get(unitId) ?? 0;
  }

  /** Consume all remaining movement points for a unit (e.g. after repair action). */
  consumeMovement(unitId: string): void {
    this.movementPoints.set(unitId, 0);
  }

  /** Whether a unit has already used its action (attack or repair) this turn. */
  hasActed(unitId: string): boolean {
    return this.actedUnits.has(unitId);
  }

  /** Record that a unit has used its action this turn and drain its MP. */
  recordAction(unitId: string): void {
    this.actedUnits.add(unitId);
    this.movementPoints.set(unitId, 0);
  }

  /** Register callback for end-of-turn. */
  setOnTurnEnd(cb: () => void) {
    this.onTurnEnd = cb;
  }

  /** Register callback for when the player attacks. */
  setOnAttack(cb: (attackerId: string, targetId: string) => void) {
    this.onAttack = cb;
  }

  /** Register callback for when the player repairs a friendly unit. */
  setOnRepair(cb: (repairerId: string, targetId: string) => void) {
    this.onRepair = cb;
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
        // Attack with the first selected unit that has MP remaining and hasn't acted
        const attacker = playerUnits.find(
          (u) => (this.movementPoints.get(u.id) ?? 0) >= 1 && !this.actedUnits.has(u.id)
        );
        if (!attacker) {
          dbg.localMap.log('Attack blocked — no eligible attacker (no MP or already acted)');
          return;
        }
        dbg.localMap.log('Attack command:', attacker.label, '→', enemyTarget.label);
        this.actedUnits.add(attacker.id);
        this.movementPoints.set(attacker.id, 0);
        this.onAttack(attacker.id, enemyTarget.id);
        return;
      }

      // --- Repair check ---
      // If no enemy target, check for a friendly unit in the same hex that can be repaired.
      // The selected unit must have repair attribute, movement points remaining, and not yet acted.
      if (!enemyTarget && this.onRepair) {
        const repairer = playerUnits.find(
          (u) => (u.attributes.repair ?? 0) >= 1 && (this.movementPoints.get(u.id) ?? 0) > 0 && !this.actedUnits.has(u.id)
        );
        if (repairer) {
          // Find friendly target in the clicked segment (same hex, different unit, damaged)
          let friendlyTarget: UnitData | undefined;
          if (targetSegment >= 0) {
            friendlyTarget = unitsOnTarget.find(
              (u) => u.segment === targetSegment && u.ownerId === playerOwner && u.id !== repairer.id && u.currentHealth < (u.attributes.maxHealth ?? 1) * 10
            );
          }
          if (!friendlyTarget) {
            // No segment match — pick any damaged friendly on that tile
            friendlyTarget = unitsOnTarget.find(
              (u) => u.ownerId === playerOwner && u.id !== repairer.id && u.currentHealth < (u.attributes.maxHealth ?? 1) * 10
            );
          }
          if (friendlyTarget && repairer.tileIndex === friendlyTarget.tileIndex) {
            dbg.localMap.log('Repair command:', repairer.label, '→', friendlyTarget.label);
            this.actedUnits.add(repairer.id);
            this.movementPoints.set(repairer.id, 0);
            this.onRepair(repairer.id, friendlyTarget.id);
            return;
          }
        }
      }
    }

    // --- Movement (existing logic) ---
    // Gather selected units that can still move
    const units = this.world.units;
    const movingUnits = units.filter(
      (u) => this.selectedUnits.has(u.id) && (this.movementPoints.get(u.id) ?? 0) > 0
    );
    if (movingUnits.length === 0) return;

    // Can't move into impassable terrain (ground units)
    if (this.isImpassableTerrain(targetTileData.terrain)) {
      // Check if ALL selected units are drones (flight ignores impassable)
      const allFlight = movingUnits.every(
        (u) => this.getMovementMode(u) === 'flight'
      );
      if (!allFlight) {
        dbg.localMap.log('Movement blocked: impassable tile');
        return;
      }
    }

    // All selected units must share an origin for group movement.
    // If they're on different tiles, move each individually.
    const originTile = movingUnits[0].tileIndex;
    const allSameOrigin = movingUnits.every((u) => u.tileIndex === originTile);

    if (allSameOrigin) {
      // Shared path — all move together, limited by slowest unit's affordable hops
      const path = this.findPathBFS(originTile, targetTile);
      if (!path || path.length < 2) return;

      // For group movement: use the minimum affordable hops across all units
      // hexesAlreadyMoved is 0 at start of turn (first-hex rule applies to first move)
      const groupHops = Math.min(
        ...movingUnits.map((u) => {
          const remaining = this.movementPoints.get(u.id) ?? 0;
          const totalMP = this.getMaxMovement(u);
          const alreadyMoved = totalMP - remaining > 0 ? 1 : 0; // simplified: if MP spent, not first hex
          return this.affordableHops(path, u, remaining, alreadyMoved);
        })
      );

      if (groupHops === 0) return;

      const hops = Math.min(groupHops, path.length - 1);
      const destTileIndex = path[hops];
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

      const reachedTarget = destTileIndex === targetTile;
      const useTargetSegment = reachedTarget && targetSegment >= 0 && movingUnits.length === 1;
      const occupiedSegments = new Set<number>(existingAtDest.map((u) => u.segment));
      for (const unit of movingUnits) {
        const preferred = useTargetSegment ? targetSegment : unit.segment;
        const freeSegment = this.findPreferredSegment(preferred, occupiedSegments);
        if (freeSegment < 0) break;

        const remaining = this.movementPoints.get(unit.id) ?? 0;
        const totalMP = this.getMaxMovement(unit);
        const alreadyMoved = totalMP - remaining > 0 ? 1 : 0;
        const mpCost = this.mpSpentForHops(path, unit, hops, alreadyMoved);

        unit.tileIndex = destTileIndex;
        unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
        unit.facing = moveFacing;
        this.movementPoints.set(unit.id, Math.max(0, remaining - mpCost));
        occupiedSegments.add(freeSegment as 0 | 1 | 2 | 3 | 4 | 5);

        dbg.localMap.log(
          'Moved', unit.label, '→ tile', destTileIndex,
          'segment', freeSegment, '| MP spent:', mpCost, '| points left:', this.movementPoints.get(unit.id)
        );
      }
    } else {
      // Units on different tiles — move each individually
      for (const unit of movingUnits) {
        const path = this.findPathBFS(unit.tileIndex, targetTile);
        if (!path || path.length < 2) continue;

        const remaining = this.movementPoints.get(unit.id) ?? 0;
        const totalMP = this.getMaxMovement(unit);
        const alreadyMoved = totalMP - remaining > 0 ? 1 : 0;
        const maxHops = this.affordableHops(path, unit, remaining, alreadyMoved);
        if (maxHops === 0) continue;

        const hops = Math.min(maxHops, path.length - 1);
        const destTileIndex = path[hops];
        const prevTileIndex = path[hops - 1];

        const unitsAtDest = units.filter(
          (u) => u.tileIndex === destTileIndex && u.id !== unit.id
        );
        if (unitsAtDest.length >= 5) continue;

        const reachedTarget = destTileIndex === targetTile;
        const useTarget = reachedTarget && targetSegment >= 0 && movingUnits.length === 1;
        const preferred = useTarget ? targetSegment : unit.segment;
        const occupiedSegments = new Set<number>(unitsAtDest.map((u) => u.segment));
        const freeSegment = this.findPreferredSegment(preferred, occupiedSegments);
        if (freeSegment < 0) continue;

        const mpCost = this.mpSpentForHops(path, unit, hops, alreadyMoved);

        unit.tileIndex = destTileIndex;
        unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
        unit.facing = this.angleToFacing(this.computeFacingAngle(prevTileIndex, destTileIndex));
        this.movementPoints.set(unit.id, Math.max(0, remaining - mpCost));

        dbg.localMap.log(
          'Moved', unit.label, '→ tile', destTileIndex,
          'segment', freeSegment, '| MP spent:', mpCost, '| points left:', this.movementPoints.get(unit.id)
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

    this.computeMovementRange();
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
