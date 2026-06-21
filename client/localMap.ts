/**
 * Local Map View — flat hex map rendered with Canvas 2D.
 *
 * This file is the class shell and render() orchestrator.
 * Logic is delegated to:
 *   localMapProjection.ts  — coordinate math (buildFlatView, worldToScreen, …)
 *   localMapTerrain.ts     — all terrain / contour / water / forest drawing
 *   localMapUnits.ts       — unit and combat-highlight rendering
 *   localMapMovement.ts    — movement range computation and overlay rendering
 *   localMapGeometry.ts    — pure geometry / pathfinding (P7)
 */

import { WorldData, UnitData, TileData } from './worldData.js';
import { CombatAnimator } from './combatAnimations.js';
import { dbg } from './debug.js';
import { TurnManager } from './turnManager.js';
import { MapInputHandler, MapViewInterface, FlatTileRef } from './mapInput.js';
import {
  getMovementMode,
  getMaxMovement as sharedGetMaxMovement,
  isImpassableTerrain as sharedIsImpassableTerrain,
} from '../shared/movementConstants.js';
import {
  computeFacingAngle as _computeFacingAngle,
  angleToFacing as _angleToFacing,
  findPreferredSegment as _findPreferredSegment,
  findSegmentAt as _findSegmentAt,
  pointInTriangle as _pointInTriangle,
} from './localMapGeometry.js';
import {
  buildFlatView as _buildFlatView,
  worldToScreen as _worldToScreen,
  screenToWorld as _screenToWorld,
  findTileAt as _findTileAt,
  pointInPoly as _pointInPoly,
  screenHexRadius as _screenHexRadius,
  FlatTile,
} from './localMapProjection.js';
import { TerrainRenderer } from './localMapTerrain.js';
import { TerrainTextures } from './localMapTerrain.js';
import {
  getSegmentCentroid,
  getSegmentIconSize,
  drawUnits as _drawUnits,
  drawBuildings as _drawBuildings,
  drawPlannedBuildings as _drawPlannedBuildings,
  drawCombatHighlight as _drawCombatHighlight,
  drawMoveHighlight as _drawMoveHighlight,
} from './localMapUnits.js';
import { drawEwCoverage as _drawEwCoverage } from './ewOverlay.js';
import {
  computeMovementRange as _computeMovementRange,
  computeContextualAttackRoute as _computeContextualAttackRoute,
  computeMovementRouteForDestination as _computeMovementRouteForDestination,
  extractMovePlan as _extractMovePlan,
  drawMovementCostRoute as _drawMovementCostRoute,
  drawReachableSegments as _drawReachableSegments,
  drawAttackRangeRings as _drawAttackRangeRings,
  weaponRangeInTileHops as _weaponRangeInTileHops,
  isInWeaponRange as _isInWeaponRange,
  MovementRangeResult,
  MovementCostRoute,
  MovePlan,
} from './localMapMovement.js';

export class LocalMapView implements MapViewInterface {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  world: WorldData;
  flatTiles: FlatTile[] = [];
  centreTileIndex: number = -1;
  radius: number = 12; // BFS hop radius; hex count ≈ 1+3r(r+1). r10→331, r12→469 (~+50% hexes shown)
  /**
   * Current screen-up direction (world space) supplied by the globe camera.
   * Used as the flat-view basis so the map's orientation tracks the globe
   * continuously, including spin at the poles. Null → fall back to a
   * position-derived basis (canonical orientation). Persists across map-drag
   * recentres so orientation stays stable until the globe orbits again.
   */
  private viewUp: [number, number, number] | null = null;
  /** Callback when a tile is selected (exposed as onTileSelectCb for MapViewInterface). */
  private onTileSelect: (tileIndex: number, segment?: number) => void;
  hoveredTile: number = -1;
  selectedTile: number = -1;
  selectedSegment: number = -1;
  onCentreChange: ((tileIndex: number) => void) | null = null;
  /** Callback when player hovers an enemy tile (for attack preview). */
  onHoverEnemy: ((attacker: UnitData | null, target: UnitData | null) => void) | null = null;
  /** Track last hovered enemy to avoid redundant callbacks. */
  lastHoveredEnemyId: string | null = null;
  /** Active AI combat highlight (attacker → target). */
  private highlightAttackerId: string | null = null;
  private highlightTargetId: string | null = null;
  /** Active AI move highlight (unit that just moved + its origin tile/segment). */
  private highlightMoveUnitId: string | null = null;
  private highlightMoveFromTile: number | null = null;
  private highlightMoveFromSeg: number = 0;
  /**
   * Enemy units that have already moved/acted during the current AI turn.
   * Their unit number is drawn in red. Cleared at endTurn().
   */
  private aiActedUnits: Set<string> = new Set();

  // Movement system callbacks
  onTurnEnd: (() => void) | null = null;
  onAttack: ((attackerId: string, targetId: string) => void) | null = null;
  onRepair: ((repairerId: string, targetId: string) => void) | null = null;
  onSleepUnit: ((unitId: string) => void) | null = null;
  onRefit: ((unitId: string) => void) | null = null;
  onViewUnit: ((unitId: string) => void) | null = null;
  /** Enter first-person look-around at an arbitrary hex segment (no unit needed). */
  onViewSegment: ((tileIndex: number, segment: number) => void) | null = null;
  /** Open the City Design planner for a city (by city id). */
  onCityDesign: ((cityId: string) => void) | null = null;

  /** Open the refit modal for a player-owned building (by building id). */
  onBuildingRefit: ((buildingId: string) => void) | null = null;
  /** The faction (ownerId) allowed to select and move units. */
  activeFaction: string = '';
  /** Optional TurnManager — when set, endTurn() syncs state back to it. */
  private turnManager: TurnManager;

  // ─── Delegated state — backed by TurnManager ───────────────────────────────

  get selectedUnits(): Set<string> {
    return this.turnManager.selectedUnits;
  }

  get movementPoints(): Map<string, number> {
    return this.turnManager.movementPoints;
  }

  get actedUnits(): Set<string> {
    return this.turnManager.actedUnits;
  }

  get rotatedUnits(): Set<string> {
    return this.turnManager.rotatedUnits;
  }

  // Movement range overlay (results from last computeMovementRange call)
  private _rangeResult: MovementRangeResult = {
    moveRangeTiles: new Map(),
    attackReadyTiles: new Set(),
    weaponRangeTiles: new Set(),
    reachableSegments: new Map(),
    staticAttackSegments: new Set(),
    maxAttackSegments: new Set(),
  };

  // Movement cost route overlay (computed on hover when unit is selected)
  private _movementCostRoute: MovementCostRoute | null = null;

  // View transform
  offsetX: number = 0;
  offsetY: number = 0;
  scale: number = 1;
  dragging: boolean = false;
  mouseDownPos: { x: number; y: number } | null = null;
  lastMouse: { x: number; y: number } = { x: 0, y: 0 };
  dragEmitPending: boolean = false;
  lastEmittedCentreTile: number = -1;
  isProgrammaticCentre: boolean = false;

  // Combat animations
  private animator: CombatAnimator;
  private hiddenUnits: Set<string> = new Set();
  /**
   * In-flight move glides, keyed by unit id. Stores the origin/destination
   * tile+segment and eased progress (0–1) rather than a fixed screen position,
   * so drawUnits re-projects the interpolated point every frame. This keeps the
   * glide correct even when the map recentres mid-animation (e.g. the globe
   * pan-to-tile triggered by selecting the moved unit).
   */
  private unitMoveAnims: Map<
    string,
    { fromTile: number; fromSeg: number; toTile: number; toSeg: number; progress: number }
  > = new Map();

  // Terrain renderer (stateless except for view transform)
  private terrain: TerrainRenderer;

  /** Input handler — owns all 8 event listeners. */
  private inputHandler: MapInputHandler;

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldData,
    onTileSelect: (tileIndex: number, segment?: number) => void,
    tm: TurnManager,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.world = world;
    this.onTileSelect = onTileSelect;
    this.turnManager = tm;
    this.animator = new CombatAnimator(canvas);
    this.animator.setRenderCallback(() => this.render());
    this.terrain = new TerrainRenderer(this.ctx, world);

    // Delegate all input event handling to MapInputHandler
    this.inputHandler = new MapInputHandler(canvas, this, tm);

    window.addEventListener('resize', () => this.render());

    // Load terrain textures asynchronously; trigger a re-render once ready.
    const textures = new TerrainTextures();
    textures.load().then(() => {
      this.terrain.setTextures(textures);
      this.render();
    });

    if (world.cities.length > 0) {
      this.setCentre(world.cities[0].tileIndex, true);
    }
  }

  /** Satisfies MapViewInterface — forwards to the private onTileSelect callback. */
  get onTileSelectCb(): (tileIndex: number, segment?: number) => void {
    return this.onTileSelect;
  }

  setCentre(tileIndex: number, resetZoom = false, up?: [number, number, number] | null): void {
    dbg.localMap.log('setCentre:', tileIndex, 'resetZoom:', resetZoom);
    // Update the orientation only when the caller supplies one (globe orbit).
    // Programmatic centres (goHome, battle, unit cycle) omit it and keep the
    // current orientation.
    if (up !== undefined) this.viewUp = up;
    this.centreTileIndex = tileIndex;
    this.lastEmittedCentreTile = tileIndex;
    dbg.localMap.time('buildFlatView');
    this.flatTiles = this.buildFlatView(tileIndex, this.radius);
    dbg.localMap.timeEnd('buildFlatView');
    dbg.localMap.log('flatTiles count:', this.flatTiles.length);
    this.offsetX = 0;
    this.offsetY = 0;
    if (resetZoom) this.scale = 1;
    this.isProgrammaticCentre = true;
    this.render();
  }

  /** Pan to the player's home city at default zoom. */
  goHome(): void {
    const homeCity = this.world.cities.find((c) => c.isPlayerHome);
    dbg.localMap.log('goHome → city:', homeCity?.label, 'tile:', homeCity?.tileIndex);
    if (homeCity) {
      this.setCentre(homeCity.tileIndex, true);
    }
  }

  setSelected(tileIndex: number): void {
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

  /**
   * Centre on, select, and highlight a specific unit by id — mirrors the
   * left-click selection path (clears selectedUnits, selects the unit's
   * segment, recomputes the movement range overlay). Used by the end-turn
   * confirmation popup so clicking a listed unit actually selects it on the map
   * rather than only moving the camera.
   */
  focusUnit(unitId: string): void {
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;
    this.setCentre(unit.tileIndex);
    this.selectedUnits.clear();
    this.selectedUnits.add(unitId);
    this.selectedTile = unit.tileIndex;
    this.selectedSegment = unit.segment;
    this.computeMovementRange();
    this.render();
  }

  setOnCentreChange(cb: (tileIndex: number) => void): void {
    this.onCentreChange = cb;
  }

  setOnHoverEnemy(cb: (attacker: UnitData | null, target: UnitData | null) => void): void {
    this.onHoverEnemy = cb;
  }

  setHighlightCombat(attackerId: string | null, targetId: string | null): void {
    this.highlightAttackerId = attackerId;
    this.highlightTargetId = targetId;
    // An attack supersedes any lingering move indicator for the same step.
    if (attackerId) {
      this.highlightMoveUnitId = null;
      this.highlightMoveFromTile = null;
    }
  }

  /**
   * Highlight an enemy move: draws an origin ring and a dashed arrow from the
   * unit's starting segment to its current position. Pass a null unitId to clear.
   */
  setHighlightMove(unitId: string | null, fromTile: number | null, fromSeg: number = 0): void {
    this.highlightMoveUnitId = unitId;
    this.highlightMoveFromTile = fromTile;
    this.highlightMoveFromSeg = fromSeg;
    // A move indicator supersedes any lingering combat highlight.
    if (unitId) {
      this.highlightAttackerId = null;
      this.highlightTargetId = null;
    }
  }

  /** Mark an enemy unit as having moved/acted this AI turn (red unit number). */
  markAiActed(unitId: string): void {
    this.aiActedUnits.add(unitId);
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

    const seg = getSegmentCentroid(ft, unit.segment);
    if (!seg) return null;

    const [sx, sy] = this.worldToScreen(seg.x, seg.y);
    return { x: sx, y: sy };
  }

  async playAttackAnimation(
    attackerId: string,
    targetId: string,
    factionColorHex: string,
    damage: number,
    targetDestroyed: boolean,
    splashVictims: Array<{ unitId: string; damage: number; destroyed: boolean }> = [],
  ): Promise<void> {
    const from = this.getUnitScreenPos(attackerId);
    const to   = this.getUnitScreenPos(targetId);
    if (!from || !to) return;

    await this.animator.playMissile(from, to, factionColorHex);

    // Primary target explosion + any splash victims in parallel
    const splashExplosions: Promise<void>[] = splashVictims
      .filter((v) => v.unitId !== targetId)
      .map((v) => {
        const pos = this.getUnitScreenPos(v.unitId);
        return pos ? this.animator.playExplosion(pos, v.damage, factionColorHex) : Promise.resolve();
      });
    await Promise.all([
      this.animator.playExplosion(to, damage, factionColorHex),
      ...splashExplosions,
    ]);

    // Smoke for all destroyed units (primary + splash)
    const destroyedPositions: Array<{ id: string; pos: { x: number; y: number } }> = [];
    if (targetDestroyed) {
      destroyedPositions.push({ id: targetId, pos: to });
    }
    for (const v of splashVictims) {
      if (v.destroyed && v.unitId !== targetId) {
        const pos = this.getUnitScreenPos(v.unitId);
        if (pos) destroyedPositions.push({ id: v.unitId, pos });
      }
    }

    if (destroyedPositions.length > 0) {
      // Hide all destroyed units, render once, then play smoke in parallel
      for (const { id } of destroyedPositions) this.hiddenUnits.add(id);
      this.render();
      await Promise.all(destroyedPositions.map(({ pos }) => this.animator.playSmoke(pos)));
      for (const { id } of destroyedPositions) this.hiddenUnits.delete(id);
    }
  }

  get isAnimating(): boolean {
    return this.animator.isAnimating;
  }

  /**
   * Animate a unit gliding from its origin segment to its destination segment.
   *
   * The unit's facing is updated to point toward the destination BEFORE the
   * animation begins (so the sprite rotates immediately, then slides).
   *
   * The glide is driven by eased progress (0–1); drawUnits re-projects the
   * interpolated origin→destination point every frame using the current view
   * transform. This means the world state can already reflect the destination,
   * and the map can recentre mid-glide (e.g. the globe pan-to-tile triggered by
   * selecting the moved unit) without the sprite overshooting or snapping.
   *
   * @param unitId     The id of the unit to animate
   * @param fromTile   Tile index the unit started on (before world update)
   * @param fromSeg    Segment the unit started on (before world update)
   * @param newFacing  Facing index to apply before animating
   */
  async playMoveAnimation(
    unitId: string,
    fromTile: number,
    fromSeg: number,
    newFacing: 0 | 1 | 2 | 3 | 4 | 5,
  ): Promise<void> {
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;

    // Apply facing immediately so the sprite points the right way from frame 1
    unit.facing = newFacing;

    // Skip the glide for a pure intra-segment move (no visible displacement).
    if (fromTile === unit.tileIndex && fromSeg === unit.segment) return;

    const anim = {
      fromTile,
      fromSeg,
      toTile: unit.tileIndex,
      toSeg: unit.segment,
      progress: 0,
    };
    this.unitMoveAnims.set(unitId, anim);

    await this.animator.playMove((progress) => {
      anim.progress = progress;
    });

    this.unitMoveAnims.delete(unitId);
    this.render();
  }

  render(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width  = rect.width  + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.ctx.fillStyle = '#0d0d0d';
    this.ctx.fillRect(0, 0, rect.width, rect.height);

    if (this.flatTiles.length === 0) return;

    const canvasRect = this.canvas.getBoundingClientRect();

    // Update terrain renderer view transform
    this.terrain.setViewTransform(this.scale, this.offsetX, this.offsetY, canvasRect);

    // Draw terrain (fills, contours, water, forest, selection highlight, city labels)
    this.terrain.drawAllTiles(this.flatTiles, this.selectedTile, this.selectedSegment);

    // Draw reachable segment shading (green/blue triangle fills behind units)
    _drawReachableSegments(
      this.ctx,
      this.flatTiles,
      this._rangeResult.reachableSegments,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

    // Draw attack range rings (segment-level perimeter outlines)
    _drawAttackRangeRings(
      this.ctx,
      this.world,
      this.flatTiles,
      this._rangeResult.staticAttackSegments,
      this._rangeResult.maxAttackSegments,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

    // Draw movement cost route overlay (hover feedback)
    _drawMovementCostRoute(
      this.ctx,
      this.world,
      this.flatTiles,
      this._movementCostRoute,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

    // Draw EW coverage circles (toggle 'e' / RMB) beneath structures & units
    _drawEwCoverage(
      this.ctx,
      this.world,
      this.flatTiles,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

    // Draw buildings (static structures) beneath the mobile units
    _drawPlannedBuildings(
      this.ctx,
      this.world,
      this.flatTiles,
      (wx, wy) => this.worldToScreen(wx, wy),
    );
    _drawBuildings(
      this.ctx,
      this.world,
      this.flatTiles,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

    // Draw units
    _drawUnits(
      this.ctx,
      this.world,
      this.flatTiles,
      this.selectedUnits,
      this.movementPoints,
      this.hiddenUnits,
      (wx, wy) => this.worldToScreen(wx, wy),
      this.aiActedUnits,
      this.unitMoveAnims,
    );

    // Draw AI move indicator (origin ring + dashed arrow to current position)
    _drawMoveHighlight(
      this.ctx,
      this.world,
      this.flatTiles,
      this.highlightMoveUnitId,
      this.highlightMoveFromTile,
      this.highlightMoveFromSeg,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

    // Draw AI combat highlights (attacker ring + target ring + connecting line)
    _drawCombatHighlight(
      this.ctx,
      this.world,
      this.flatTiles,
      this.highlightAttackerId,
      this.highlightTargetId,
      (wx, wy) => this.worldToScreen(wx, wy),
    );

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

  // ─── Projection delegation (MapViewInterface) ───────────────────────────────

  buildFlatView(centreIdx: number, radius: number): FlatTile[] {
    return _buildFlatView(this.world, centreIdx, radius, this.viewUp);
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return _worldToScreen(
      wx, wy,
      this.canvas.getBoundingClientRect(),
      this.scale, this.offsetX, this.offsetY,
    );
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return _screenToWorld(
      sx, sy,
      this.canvas.getBoundingClientRect(),
      this.scale, this.offsetX, this.offsetY,
    );
  }

  findTileAt(sx: number, sy: number): number {
    return _findTileAt(
      this.flatTiles, sx, sy,
      (s, t) => this.screenToWorld(s, t),
    );
  }

  screenHexRadius(ft: FlatTile): number {
    return _screenHexRadius(ft, (wx, wy) => this.worldToScreen(wx, wy));
  }

  // ─── Geometry delegation (MapViewInterface) ─────────────────────────────────

  findSegmentAt(sx: number, sy: number, ft: FlatTile): number {
    return _findSegmentAt(
      sx, sy, ft,
      (wx, wy) => this.worldToScreen(wx, wy),
      (s, t) => this.screenToWorld(s, t),
    );
  }

  computeFacingAngle(fromTileIndex: number, toTileIndex: number): number {
    return _computeFacingAngle(fromTileIndex, toTileIndex, this.flatTiles, this.world.tiles);
  }

  angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5 {
    return _angleToFacing(angle);
  }

  findPreferredSegment(sourceSegment: number, occupied: Set<number>): number {
    return _findPreferredSegment(sourceSegment, occupied);
  }

  /**
   * Compute the executable move plan for a unit toward a destination tile.
   *
   * Delegates to the SAME route computation that draws the on-screen movement
   * line (computeMovementRouteForDestination), then reduces it to a concrete
   * destination + MP cost + facing. Because the preview and the right-click
   * execution share this one path, the line and the move can never diverge.
   */
  planMove(unit: UnitData, destTile: number, destSegment: number, remainingMP: number): MovePlan | null {
    const route = _computeMovementRouteForDestination(
      this.world, unit, destTile, destSegment, remainingMP, this._rangeResult,
    );
    return _extractMovePlan(route, this.world.tiles);
  }

  // ─── Movement helpers delegation (MapViewInterface) ─────────────────────────

  getMaxMovement(unit: UnitData): number {
    return sharedGetMaxMovement(unit.attributes);
  }

  getMovementMode(unit: UnitData): 'wheeled' | 'limb' | 'flight' {
    return getMovementMode(unit.attributes);
  }

  isImpassableTerrain(terrain: string): boolean {
    return sharedIsImpassableTerrain(terrain);
  }

  // ─── Movement range ─────────────────────────────────────────────────────────

  computeMovementRange(): void {
    this._rangeResult = {
      moveRangeTiles: new Map(),
      attackReadyTiles: new Set(),
      weaponRangeTiles: new Set(),
      reachableSegments: new Map(),
      staticAttackSegments: new Set(),
      maxAttackSegments: new Set(),
    };

    if (this.selectedUnits.size === 0) return;

    const unitId = [...this.selectedUnits][0];
    const unit   = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;

    const remainingMP = this.movementPoints.has(unitId)
      ? (this.movementPoints.get(unitId) ?? 0)
      : sharedGetMaxMovement(unit.attributes);
    if (remainingMP <= 0) return;

    this._rangeResult = _computeMovementRange(this.world, unit, remainingMP);
  }

  /**
   * Compute and cache the movement cost route for the hovered destination.
   * Called from MapInputHandler on mousemove.
   *
   * Context-dependent behavior:
   * - Enemy in weapon range from current position → red line only
   * - Enemy reachable this turn (min green move + fire) → green path + red line
   * - Enemy out of range this turn → green + blue (full move) + red toward enemy (capped)
   * - Empty tile in movement range → green/blue path, no red
   * - Empty tile out of movement range → green/blue path to edge toward that tile
   */
  computeMovementCostRouteForHover(destTile: number, destSegment: number): void {
    this._movementCostRoute = null;

    if (this.selectedUnits.size === 0) return;
    const unitId = [...this.selectedUnits][0];
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;

    const remainingMP = this.movementPoints.get(unitId) ?? 0;
    if (remainingMP <= 0) return;

    if (destTile === unit.tileIndex && destSegment === unit.segment) return;

    // Compute effective weapon range (tile hops)
    const weaponRange = _weaponRangeInTileHops(unit.attributes);

    // Is there an enemy at the destination?
    const playerOwner = unit.ownerId;
    const enemy = this.world.units.find(
      (u) => u.tileIndex === destTile && u.segment === destSegment && u.ownerId !== playerOwner,
    );

    if (enemy) {
      // ─── Enemy hover cases ───────────────────────────────────────────────
      this._movementCostRoute = _computeContextualAttackRoute(
        this.world, unit, destTile, destSegment, remainingMP, weaponRange,
        this._rangeResult,
      );
    } else {
      // ─── Empty tile hover cases ──────────────────────────────────────────
      // Uses the same route computation as the right-click execution
      // (computeMovementRouteForDestination), so the previewed line and the
      // actual move are guaranteed identical.
      this._movementCostRoute = _computeMovementRouteForDestination(
        this.world, unit, destTile, destSegment, remainingMP, this._rangeResult,
      );
    }
  }

  /** Clear the movement cost route overlay. */
  clearMovementCostRoute(): void {
    if (this._movementCostRoute !== null) {
      this._movementCostRoute = null;
      this.render();
    }
  }

  /** Check if an enemy tile+segment is within immediate attack range (no movement needed).
   *
   * Pass enemySegment to target the specific unit segment the player hovered/clicked,
   * avoiding a wrong-unit match when multiple enemies share a tile.
   *
   * Checks the first eligible attacker (has MP ≥ 1, hasn't acted) among selected units —
   * the same unit the right-click handler would actually use to attack.
   */
  isInAttackRange(enemyTile: number, enemySegment?: number): boolean {
    if (this.selectedUnits.size === 0) return false;

    // Find the first eligible attacker — mirrors the selection logic in onRightClick
    let attacker: UnitData | undefined;
    for (const unitId of this.selectedUnits) {
      const unit = this.world.units.find((u) => u.id === unitId);
      if (!unit) continue;
      const remainingMP = this.movementPoints.get(unitId) ?? 0;
      if (remainingMP < 1) continue;
      if (this.actedUnits.has(unitId)) continue;
      attacker = unit;
      break;
    }
    if (!attacker) return false;

    // Find the specific enemy to check range against
    const enemy = enemySegment !== undefined
      ? this.world.units.find(
          (u) => u.tileIndex === enemyTile && u.segment === enemySegment && u.ownerId !== attacker!.ownerId,
        )
      : this.world.units.find(
          (u) => u.tileIndex === enemyTile && u.ownerId !== attacker!.ownerId,
        );
    if (!enemy) return false;

    // Use shared segment-distance check — same formula as server combat resolution
    return _isInWeaponRange(this.world.tiles, attacker, enemy);
  }

  // ─── Turn state ─────────────────────────────────────────────────────────────

  /** Wire the TurnManager that owns movement/action/selection state. */
  setTurnManager(_tm: TurnManager): void {
    // TurnManager is now injected at construction time; this method is a no-op
    // kept for call-site compatibility during the transition period.
  }

  setOnTurnEnd(cb: () => void): void {
    this.onTurnEnd = cb;
  }

  setOnAttack(cb: (attackerId: string, targetId: string) => void): void {
    this.onAttack = cb;
  }

  setOnRepair(cb: (repairerId: string, targetId: string) => void): void {
    this.onRepair = cb;
  }

  setOnSleepUnit(cb: (unitId: string) => void): void {
    this.onSleepUnit = cb;
  }

  setOnRefit(cb: (unitId: string) => void): void {
    this.onRefit = cb;
  }

  setOnViewUnit(cb: (unitId: string) => void): void {
    this.onViewUnit = cb;
  }

  setOnViewSegment(cb: (tileIndex: number, segment: number) => void): void {
    this.onViewSegment = cb;
  }

  setOnCityDesign(cb: (cityId: string) => void): void {
    this.onCityDesign = cb;
  }

  setOnBuildingRefit(cb: (buildingId: string) => void): void {
    this.onBuildingRefit = cb;
  }

  setActiveFaction(factionId: string): void {
    this.activeFaction = factionId;
    // Also update terrain renderer's world reference (faction colors may change)
    this.terrain.setWorld(this.world);
  }

  endTurn(): void {
    dbg.localMap.log('End turn — resetting movement points');
    this.aiActedUnits.clear();
    this.highlightMoveUnitId = null;
    this.highlightMoveFromTile = null;
    this.turnManager.endTurn();
    this.render();
    if (this.onTurnEnd) this.onTurnEnd();
  }

  /** Get set of currently selected unit ids. */
  getSelectedUnits(): Set<string> {
    return this.selectedUnits;
  }
}
