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
  hexEntryCost as sharedHexEntryCost,
  getMaxMovement as sharedGetMaxMovement,
  isImpassableTerrain as sharedIsImpassableTerrain,
} from '../shared/movementConstants.js';
import {
  findPathBFS as _findPathBFS,
  computeFacingAngle as _computeFacingAngle,
  angleToFacing as _angleToFacing,
  findPreferredSegment as _findPreferredSegment,
  findSegmentAt as _findSegmentAt,
  pointInTriangle as _pointInTriangle,
  affordableHops as _affordableHops,
  mpSpentForHops as _mpSpentForHops,
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
import {
  getSegmentCentroid,
  getSegmentIconSize,
  drawUnits as _drawUnits,
  drawCombatHighlight as _drawCombatHighlight,
} from './localMapUnits.js';
import {
  computeMovementRange as _computeMovementRange,
  drawMovementRange as _drawMovementRange,
  MovementRangeResult,
} from './localMapMovement.js';

export class LocalMapView implements MapViewInterface {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  world: WorldData;
  flatTiles: FlatTile[] = [];
  centreTileIndex: number = -1;
  radius: number = 10;
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

  // Movement range overlay (results from last computeMovementRange call)
  private _rangeResult: MovementRangeResult = {
    moveRangeTiles: new Map(),
    attackReadyTiles: new Set(),
    weaponRangeTiles: new Set(),
  };

  // View transform
  offsetX: number = 0;
  offsetY: number = 0;
  scale: number = 0.3;
  dragging: boolean = false;
  mouseDownPos: { x: number; y: number } | null = null;
  lastMouse: { x: number; y: number } = { x: 0, y: 0 };
  dragEmitPending: boolean = false;
  lastEmittedCentreTile: number = -1;
  isProgrammaticCentre: boolean = false;

  // Combat animations
  private animator: CombatAnimator;
  private hiddenUnits: Set<string> = new Set();

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

    // Initialize movement points for all units (pre-TurnManager fallback)
    this._localMovementPoints.clear();
    this._localActedUnits.clear();
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
    if (resetZoom) this.scale = 0.3;
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

  // ─── Render orchestrator ────────────────────────────────────────────────────

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

    // Draw movement range overlay (before units, after tiles)
    _drawMovementRange(
      this.ctx,
      this.world,
      this.flatTiles,
      this._rangeResult.moveRangeTiles,
      this._rangeResult.attackReadyTiles,
      this._rangeResult.weaponRangeTiles,
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

  findPathBFS(from: number, to: number): number[] | null {
    return _findPathBFS(from, to, this.world.tiles);
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

  hexEntryCost(tile: TileData, mode: 'wheeled' | 'limb' | 'flight', isFirstHex: boolean): number {
    return sharedHexEntryCost(tile, mode, isFirstHex);
  }

  affordableHops(path: number[], unit: UnitData, remainingMP: number, hexesAlreadyMoved: number): number {
    return _affordableHops(path, unit, remainingMP, hexesAlreadyMoved, this.world.tiles);
  }

  mpSpentForHops(path: number[], unit: UnitData, hops: number, hexesAlreadyMoved: number): number {
    return _mpSpentForHops(path, unit, hops, hexesAlreadyMoved, this.world.tiles);
  }

  // ─── Movement range ─────────────────────────────────────────────────────────

  computeMovementRange(): void {
    this._rangeResult = {
      moveRangeTiles: new Map(),
      attackReadyTiles: new Set(),
      weaponRangeTiles: new Set(),
    };

    if (this.selectedUnits.size === 0) return;

    const unitId = [...this.selectedUnits][0];
    const unit   = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;

    const remainingMP = this.movementPoints.get(unitId) ?? 0;
    if (remainingMP <= 0) return;

    this._rangeResult = _computeMovementRange(this.world, unit, remainingMP);
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

  /** Whether a unit has already used its action (attack or repair) this turn. */
  hasActed(unitId: string): boolean {
    return this.actedUnits.has(unitId);
  }

  /** Record that a unit has used its action this turn and drain its MP. */
  recordAction(unitId: string): void {
    if (this.turnManager) {
      this.turnManager.recordAction(unitId);
    } else {
      this._localActedUnits.add(unitId);
      this._localMovementPoints.set(unitId, 0);
    }
  }

  /** Wire the TurnManager that owns movement/action/selection state. */
  setTurnManager(tm: TurnManager): void {
    this.turnManager = tm;
    this._localMovementPoints.clear();
    this._localActedUnits.clear();
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
