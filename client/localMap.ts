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
  drawCombatHighlight as _drawCombatHighlight,
} from './localMapUnits.js';
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

  // Movement system callbacks
  onTurnEnd: (() => void) | null = null;
  onAttack: ((attackerId: string, targetId: string) => void) | null = null;
  onRepair: ((repairerId: string, targetId: string) => void) | null = null;
  onSleepUnit: ((unitId: string) => void) | null = null;
  onRefit: ((unitId: string) => void) | null = null;
  onViewUnit: ((unitId: string) => void) | null = null;
  /** The faction (ownerId) allowed to select and move units. */
  activeFaction: string = '';
  /** Optional TurnManager — when set, endTurn() syncs state back to it. */
  private turnManager: TurnManager | null = null;

  // ─── Delegated state — backed by TurnManager once wired ────────────────────

  get selectedUnits(): Set<string> {
    return this.turnManager ? this.turnManager.selectedUnits : this._localSelectedUnits;
  }
  private _localSelectedUnits: Set<string> = new Set();

  get movementPoints(): Map<string, number> {
    return this.turnManager ? this.turnManager.movementPoints : this._localMovementPoints;
  }
  private _localMovementPoints: Map<string, number> = new Map();

  get actedUnits(): Set<string> {
    return this.turnManager ? this.turnManager.actedUnits : this._localActedUnits;
  }
  private _localActedUnits: Set<string> = new Set();

  get rotatedUnits(): Set<string> {
    return this.turnManager ? this.turnManager.rotatedUnits : this._localRotatedUnits;
  }
  private _localRotatedUnits: Set<string> = new Set();

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
  /** Screen-position overrides for units currently being move-animated. */
  private unitScreenOverrides: Map<string, { x: number; y: number }> = new Map();

  // Terrain renderer (stateless except for view transform)
  private terrain: TerrainRenderer;

  /** Input handler — owns all 8 event listeners. */
  private inputHandler: MapInputHandler;

  constructor(
    canvas: HTMLCanvasElement,
    world: WorldData,
    onTileSelect: (tileIndex: number, segment?: number) => void,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.world = world;
    this.onTileSelect = onTileSelect;
    this.animator = new CombatAnimator(canvas);
    this.animator.setRenderCallback(() => this.render());
    this.terrain = new TerrainRenderer(this.ctx, world);

    // Delegate all input event handling to MapInputHandler
    this.inputHandler = new MapInputHandler(canvas, this);

    window.addEventListener('resize', () => this.render());

    // Load terrain textures asynchronously; trigger a re-render once ready.
    const textures = new TerrainTextures();
    textures.load().then(() => {
      this.terrain.setTextures(textures);
      this.render();
    });

    // Initialize movement points for all units (pre-TurnManager fallback)
    this._localMovementPoints.clear();
    this._localActedUnits.clear();
    this._localRotatedUnits.clear();
    for (const unit of world.units) {
      this._localMovementPoints.set(unit.id, sharedGetMaxMovement(unit.attributes));
    }

    if (world.cities.length > 0) {
      this.setCentre(world.cities[0].tileIndex, true);
    }
  }

  /** Satisfies MapViewInterface — forwards to the private onTileSelect callback. */
  get onTileSelectCb(): (tileIndex: number, segment?: number) => void {
    return this.onTileSelect;
  }

  setCentre(tileIndex: number, resetZoom = false): void {
    dbg.localMap.log('setCentre:', tileIndex, 'resetZoom:', resetZoom);
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

  setOnCentreChange(cb: (tileIndex: number) => void): void {
    this.onCentreChange = cb;
  }

  setOnHoverEnemy(cb: (attacker: UnitData | null, target: UnitData | null) => void): void {
    this.onHoverEnemy = cb;
  }

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
   * Animate a unit gliding from its current screen position to its destination.
   *
   * The unit's facing is updated to point toward the destination BEFORE the
   * animation begins (so the sprite rotates immediately, then slides).
   * During the animation the unit is rendered via a screen-position override
   * rather than its tile centroid, so the world state can be updated
   * (tileIndex / segment changed) at any point without snapping the sprite.
   *
   * @param unitId     The id of the unit to animate
   * @param fromPos    The screen position the unit started at (before world update)
   * @param newFacing  Facing index to apply before animating
   */
  async playMoveAnimation(
    unitId: string,
    fromPos: { x: number; y: number },
    newFacing: 0 | 1 | 2 | 3 | 4 | 5,
  ): Promise<void> {
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;

    // Apply facing immediately so the sprite points the right way from frame 1
    unit.facing = newFacing;

    // Compute where the unit will end up (world state already reflects destination)
    const toPos = this.getUnitScreenPos(unitId);
    if (!toPos) return;

    // Skip if start and end are essentially the same screen position
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    if (dx * dx + dy * dy < 4) return;

    // Seed the override at the start position so the first frame is correct
    this.unitScreenOverrides.set(unitId, { ...fromPos });

    await this.animator.playMove(fromPos, toPos, (pos) => {
      this.unitScreenOverrides.set(unitId, { x: pos.x, y: pos.y });
    });

    this.unitScreenOverrides.delete(unitId);
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

    // Draw units
    _drawUnits(
      this.ctx,
      this.world,
      this.flatTiles,
      this.selectedUnits,
      this.movementPoints,
      this.hiddenUnits,
      (wx, wy) => this.worldToScreen(wx, wy),
      this.actedUnits,
      this.unitScreenOverrides,
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
    return _buildFlatView(this.world, centreIdx, radius);
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

  /** Get the remaining movement points for a unit. */
  getRemainingMovement(unitId: string): number {
    if (this.turnManager) return this.turnManager.getMovementPoints(unitId);
    return this._localMovementPoints.get(unitId) ?? 0;
  }

  /** Consume all remaining movement points for a unit (e.g. after repair action). */
  consumeMovement(unitId: string): void {
    this.movementPoints.set(unitId, 0);
  }

  /** Whether a unit has already used its once-per-turn repair action this turn. */
  hasActed(unitId: string): boolean {
    return this.actedUnits.has(unitId);
  }

  /** Record that a unit has attacked (costs 1 MP, once per turn). */
  recordAttack(unitId: string): void {
    if (this.turnManager) {
      this.turnManager.recordAttack(unitId);
    } else {
      this._localActedUnits.add(unitId);
      const current = this._localMovementPoints.get(unitId) ?? 0;
      this._localMovementPoints.set(unitId, Math.max(0, current - 1));
    }
  }

  /** Record that a unit has used its once-per-turn repair action (costs 1 MP). */
  recordAction(unitId: string): void {
    if (this.turnManager) {
      this.turnManager.recordRepair(unitId);
    } else {
      this._localActedUnits.add(unitId);
      const current = this._localMovementPoints.get(unitId) ?? 0;
      this._localMovementPoints.set(unitId, Math.max(0, current - 1));
    }
  }

  /** Wire the TurnManager that owns movement/action/selection state. */
  setTurnManager(tm: TurnManager): void {
    this.turnManager = tm;
    this._localMovementPoints.clear();
    this._localActedUnits.clear();
    this._localRotatedUnits.clear();
    this._localSelectedUnits.clear();
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

  setActiveFaction(factionId: string): void {
    this.activeFaction = factionId;
    // Also update terrain renderer's world reference (faction colors may change)
    this.terrain.setWorld(this.world);
  }

  endTurn(): void {
    dbg.localMap.log('End turn — resetting movement points');
    if (this.turnManager) {
      this.turnManager.endTurn();
    } else {
      this._localMovementPoints.clear();
      this._localActedUnits.clear();
          this._localRotatedUnits.clear();
    this._localSelectedUnits.clear();
      for (const unit of this.world.units) {
        this._localMovementPoints.set(unit.id, sharedGetMaxMovement(unit.attributes));
      }
    }
    this.render();
    if (this.onTurnEnd) this.onTurnEnd();
  }

  /** Get set of currently selected unit ids. */
  getSelectedUnits(): Set<string> {
    return this.selectedUnits;
  }
}
