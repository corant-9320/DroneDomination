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
import { onUnitSpriteRendered } from './unitRenderer.js';
import { onBuildingSpriteRendered } from './buildingRenderer.js';
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
  drawUnitSelectionRings as _drawUnitSelectionRings,
  drawBuildings as _drawBuildings,
  drawLogistics as _drawLogistics,
  drawBuildingSelectionRing as _drawBuildingSelectionRing,
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
  extractMovePath as _extractMovePath,
  drawMovementCostRoute as _drawMovementCostRoute,
  drawReachableSegments as _drawReachableSegments,
  drawAttackRangeRings as _drawAttackRangeRings,
  weaponRangeInTileHops as _weaponRangeInTileHops,
  isInWeaponRange as _isInWeaponRange,
  getRangeTiles as _getRangeTiles,
  MovementRangeResult,
  MovementCostRoute,
  MovePlan,
} from './localMapMovement.js';
import {
  segmentDistance as _segmentDistance,
  getRangeThreshold as _getRangeThreshold,
} from '../shared/rangeCheck.js';

export class LocalMapView implements MapViewInterface {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  world: WorldData;
  flatTiles: FlatTile[] = [];
  centreTileIndex: number = -1;
  radius: number = 17; // BFS hop radius; hex count ≈ 1+3r(r+1). r12→469, r17→919 (~2× hexes shown)
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
  /** Callback when player hovers an enemy with a building selected (for building attack preview). */
  onBuildingHoverEnemy: ((buildingId: string, target: UnitData | null) => void) | null = null;
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
  /** Attack an enemy building (building-damage feature). mode is 'splash'|'direct'; component required for direct. */
  onAttackBuilding: ((attackerId: string, buildingId: string, mode: 'splash' | 'direct', component?: string) => void) | null = null;
  onRepair: ((repairerId: string, targetId: string) => void) | null = null;
  onSleepUnit: ((unitId: string) => void) | null = null;
  /**
   * Fired after a player move is committed, with the tile-index path and the
   * arrival segment, so the move can be submitted to the authoritative session.
   */
  onMoveCommitted: ((unitId: string, path: number[], segment: number) => void) | null = null;
  onRefit: ((unitId: string) => void) | null = null;
  onViewUnit: ((unitId: string) => void) | null = null;
  /** Enter first-person look-around at an arbitrary hex segment (no unit needed). */
  onViewSegment: ((tileIndex: number, segment: number) => void) | null = null;
  /** Open the City Design planner for a city (by city id). */
  onCityDesign: ((cityId: string) => void) | null = null;

  /** Open the refit modal for a player-owned building (by building id). */
  onBuildingRefit: ((buildingId: string) => void) | null = null;
  /** Queue a server-authoritative bridge task without a selected engineer. */
  onGodModeBuildBridge: ((tileIndex: number) => void) | null = null;
  /** Queue a server-authoritative forest-clearing task without a selected engineer. */
  onGodModeClearForest: ((tileIndex: number) => void) | null = null;
  /** Build a server-authoritative standalone road on an empty segment. */
  onGodModeBuildRoad: ((tileIndex: number, segment: number) => void) | null = null;
  /** Create one well or refinery footprint on a God Mode-selected segment. */
  onGodModeCreateOilBuilding: ((structure: 'well' | 'refinery', tileIndex: number, segment: number) => void) | null = null;
  /** Edit the operational state of a God Mode-selected oil structure. */
  onGodModeEditOilBuilding: ((structure: 'well' | 'refinery', structureId: string) => void) | null = null;
  /** Delete a well or the selected footprint of a refinery. */
  onGodModeDeleteOilBuilding: ((structure: 'well' | 'refinery', structureId: string, segment: number) => void) | null = null;
  /** Edit a unit through the server-authoritative God Mode intent. */
  onGodModeEditUnit: ((unitId: string) => void) | null = null;
  /** Delete a unit through the server-authoritative God Mode intent. */
  onGodModeDeleteUnit: ((unitId: string) => void) | null = null;
  /** Edit a building through the server-authoritative God Mode intent. */
  onGodModeEditBuilding: ((buildingId: string) => void) | null = null;
  /** Delete a building through the server-authoritative God Mode intent. */
  onGodModeDeleteBuilding: ((buildingId: string) => void) | null = null;
  /** Create a point-to-point shuttle transport from this owned oil structure (RMB action). */
  onCreateShuttleTransport: ((structureId: string) => void) | null = null;
  /** Stop the shuttle transport currently parked on this segment (RMB action). */
  onStopShuttleTransport: ((transportId: string) => void) | null = null;
  /** Read-only capability getter backed by the latest authoritative match response. */
  private remoteTerrainTasksEnabled: () => boolean = () => false;
  /** Read-only capability getter backed by the latest authoritative match response. */
  private standaloneRoadConstructionEnabled: () => boolean = () => false;
  /** Read-only capability getter backed by the latest authoritative match response. */
  private entityEditingEnabled: () => boolean = () => false;
  /**
   * Fired when the player selects or deselects a building by left-clicking.
   * Called with the building id when a building is selected, or null when
   * the selection is cleared.
   */
  onBuildingSelected: ((buildingId: string | null) => void) | null = null;
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
  private spriteRedrawQueued = false;

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
    onUnitSpriteRendered(() => this.scheduleSpriteRedraw());
    onBuildingSpriteRendered(() => this.scheduleSpriteRedraw());

    window.addEventListener('resize', () => this.render());

    // Load terrain textures asynchronously; trigger a re-render once ready.
    const textures = new TerrainTextures();
    textures.load().then(() => {
      this.terrain.setTextures(textures);
      this.render();
    }).catch((err: unknown) => {
      dbg.detail.error('Failed to load terrain textures:', err);
    });

    if (world.cities.length > 0) {
      this.setCentre(world.cities[0].tileIndex, true);
    }
  }

  /** Coalesce async sprite-cache completions into one Canvas repaint per frame. */
  private scheduleSpriteRedraw(): void {
    if (this.spriteRedrawQueued) return;
    this.spriteRedrawQueued = true;
    requestAnimationFrame(() => {
      this.spriteRedrawQueued = false;
      this.render();
    });
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

  setOnBuildingHoverEnemy(cb: (buildingId: string, target: UnitData | null) => void): void {
    this.onBuildingHoverEnemy = cb;
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
    // Attacker may be a unit or an automated building (building auto-fire).
    const from = this.getUnitScreenPos(attackerId) ?? this.getBuildingScreenPos(attackerId);
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
   * Get the screen-space position of a building by its id.
   * Returns null if the building isn't visible on the current view.
   */
  getBuildingScreenPos(buildingId: string): { x: number; y: number } | null {
    const building = this.world.buildings.find((b) => b.id === buildingId);
    if (!building) return null;

    const ft = this.flatTiles.find((f) => f.tileIndex === building.tileIndex);
    if (!ft) return null;

    const seg = getSegmentCentroid(ft, building.segment);
    if (!seg) return null;

    const [sx, sy] = this.worldToScreen(seg.x, seg.y);
    return { x: sx, y: sy };
  }

  /**
   * Play the attack animation against a building (building-damage feature):
   * a missile arcs from the attacker to the building, an explosion blooms on
   * it, and any enemy units caught in Splash_Fire explode (and smoke if
   * destroyed). Buildings are never destroyed, so the building itself never
   * smokes. No-op if either endpoint is off-screen.
   */
  async playBuildingAttackAnimation(
    attackerId: string,
    buildingId: string,
    factionColorHex: string,
    splashVictims: Array<{ unitId: string; damage: number; destroyed: boolean }> = [],
  ): Promise<void> {
    const from = this.getUnitScreenPos(attackerId);
    const to = this.getBuildingScreenPos(buildingId);
    if (!from || !to) return;

    await this.animator.playMissile(from, to, factionColorHex);

    // Building explosion + any co-located splash-victim explosions in parallel.
    const splashExplosions: Promise<void>[] = splashVictims.map((v) => {
      const pos = this.getUnitScreenPos(v.unitId);
      return pos ? this.animator.playExplosion(pos, v.damage, factionColorHex) : Promise.resolve();
    });
    await Promise.all([
      this.animator.playExplosion(to, 12, factionColorHex),
      ...splashExplosions,
    ]);

    // Smoke for any destroyed splash victims (the building itself is never destroyed).
    const destroyedPositions: Array<{ id: string; pos: { x: number; y: number } }> = [];
    for (const v of splashVictims) {
      if (v.destroyed) {
        const pos = this.getUnitScreenPos(v.unitId);
        if (pos) destroyedPositions.push({ id: v.unitId, pos });
      }
    }
    if (destroyedPositions.length > 0) {
      for (const { id } of destroyedPositions) this.hiddenUnits.add(id);
      this.render();
      await Promise.all(destroyedPositions.map(({ pos }) => this.animator.playSmoke(pos)));
      for (const { id } of destroyedPositions) this.hiddenUnits.delete(id);
    }
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

    // Draw the oil-logistics network (deposits, routes, structures) beneath units
    _drawLogistics(
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

    // Draw selection rings unclipped so they don't get cropped on slopes
    _drawUnitSelectionRings(
      this.ctx,
      this.world,
      this.flatTiles,
      this.selectedUnits,
      (wx, wy) => this.worldToScreen(wx, wy),
      this.unitMoveAnims,
    );

    // Draw selection ring for the selected building (gold ring, drawn unclipped)
    _drawBuildingSelectionRing(
      this.ctx,
      this.world,
      this.flatTiles,
      this.turnManager.selectedBuilding?.id ?? null,
      (wx, wy) => this.worldToScreen(wx, wy),
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

  /**
   * Compute the contiguous tile-index path for a planned move (same route the
   * preview line + planMove use). Empty/1-element for a pure intra-hex move.
   */
  planMovePath(unit: UnitData, destTile: number, destSegment: number, remainingMP: number): number[] {
    const route = _computeMovementRouteForDestination(
      this.world, unit, destTile, destSegment, remainingMP, this._rangeResult,
    );
    return _extractMovePath(route);
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

  isGodModeRemoteTerrainTasksEnabled(): boolean {
    return this.remoteTerrainTasksEnabled();
  }

  isGodModeStandaloneRoadConstructionEnabled(): boolean {
    return this.standaloneRoadConstructionEnabled();
  }

  isGodModeEntityEditingEnabled(): boolean {
    return this.entityEditingEnabled();
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

    // Unit selected — standard movement + attack range
    if (this.selectedUnits.size > 0) {
      const unitId = [...this.selectedUnits][0];
      const unit   = this.world.units.find((u) => u.id === unitId);
      if (!unit) return;

      const remainingMP = this.movementPoints.has(unitId)
        ? (this.movementPoints.get(unitId) ?? 0)
        : sharedGetMaxMovement(unit.attributes);
      if (remainingMP <= 0) return;

      this._rangeResult = _computeMovementRange(this.world, unit, remainingMP);
      return;
    }

    // Building selected — static attack range only (buildings don't move)
    const building = this.turnManager.selectedBuilding;
    if (!building) return;
    const attrs = building.attributes ?? {};
    const hasWeaponAttr = (attrs.kinetic ?? 0) > 0
      || (attrs.splashAttack ?? 0) > 0
      || (attrs.antiAir ?? 0) > 0
      || (attrs.rangeAttack ?? 0) > 0;
    if (!hasWeaponAttr) return;

    const tiles = this.world.tiles;
    const rangeTiles = _getRangeTiles(tiles);
    const rangeAttack = attrs.rangeAttack ?? 0;
    const threshold = _getRangeThreshold(rangeAttack);
    const weaponHops = _weaponRangeInTileHops(attrs);
    const startTile = building.tileIndex;
    const startSegment = building.segment;

    // BFS outward from the building's tile to find candidate tiles
    const candidateTiles = new Set<number>();
    candidateTiles.add(startTile);
    const bfsQ: { idx: number; d: number }[] = [{ idx: startTile, d: 0 }];
    let bHead = 0;
    const bVis = new Set<number>([startTile]);
    while (bHead < bfsQ.length) {
      const { idx, d } = bfsQ[bHead++];
      if (d >= weaponHops) continue;
      for (const nb of tiles[idx].n) {
        if (!bVis.has(nb)) { bVis.add(nb); candidateTiles.add(nb); bfsQ.push({ idx: nb, d: d + 1 }); }
      }
    }

    // Compute staticAttackSegments from building position
    const staticAttackSegments = new Set<number>();
    for (const candTile of candidateTiles) {
      const candTileData = tiles[candTile];
      const sides = candTileData.s;
      for (let seg = 0; seg < sides; seg++) {
        const segKey = candTile * 6 + seg;
        const dist = _segmentDistance(rangeTiles, startTile, startSegment, candTile, seg);
        if (dist <= threshold) {
          staticAttackSegments.add(segKey);
        }
      }
    }

    this._rangeResult = {
      moveRangeTiles: new Map(),
      attackReadyTiles: new Set(),
      weaponRangeTiles: new Set(),
      reachableSegments: new Map(),
      staticAttackSegments,
      maxAttackSegments: staticAttackSegments, // same as static — building can't move
    };
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

    // ─── Building selected: static red line to enemy ─────────────────────────
    const building = this.turnManager.selectedBuilding;
    if (this.selectedUnits.size === 0 && building) {
      if (destTile === building.tileIndex && destSegment === building.segment) return;
      const bAttrs = building.attributes ?? {};
      const bHasWeapon = (bAttrs.kinetic ?? 0) > 0
        || (bAttrs.splashAttack ?? 0) > 0
        || (bAttrs.antiAir ?? 0) > 0
        || (bAttrs.rangeAttack ?? 0) > 0;
      if (!bHasWeapon) return;

      // Only show line to enemies in range
      const enemy = this.world.units.find(
        (u) => u.tileIndex === destTile && u.segment === destSegment && u.ownerId !== building.ownerId,
      );
      if (!enemy) return;

      // Range check using shared formula
      const bForRange = { tileIndex: building.tileIndex, segment: building.segment, attributes: bAttrs };
      const inRange = _isInWeaponRange(this.world.tiles, bForRange, enemy);
      if (!inRange) return;

      // Red-line-only route (no movement hops, single weapon-range hop)
      this._movementCostRoute = {
        startTile: building.tileIndex,
        startSegment: building.segment,
        hops: [{
          tileIndex: destTile,
          segment: destSegment,
          hopCost: 0,
          cumulativeCost: 0,
          zone: 'weaponRange' as const,
        }],
      };
      return;
    }

    // ─── Unit selected: standard route computation ───────────────────────────
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
    // ─── Building selected: check weapon range from building position ─────
    const building = this.turnManager.selectedBuilding;
    if (this.selectedUnits.size === 0 && building) {
      const bAttrs = building.attributes ?? {};
      const bHasWeapon = (bAttrs.kinetic ?? 0) > 0
        || (bAttrs.splashAttack ?? 0) > 0
        || (bAttrs.antiAir ?? 0) > 0
        || (bAttrs.rangeAttack ?? 0) > 0;
      if (!bHasWeapon) return false;

      const enemy = enemySegment !== undefined
        ? this.world.units.find(
            (u) => u.tileIndex === enemyTile && u.segment === enemySegment && u.ownerId !== building.ownerId,
          )
        : this.world.units.find(
            (u) => u.tileIndex === enemyTile && u.ownerId !== building.ownerId,
          );
      if (!enemy) return false;

      const bForRange = { tileIndex: building.tileIndex, segment: building.segment, attributes: bAttrs };
      return _isInWeaponRange(this.world.tiles, bForRange, enemy);
    }

    // ─── Unit selected: standard attacker check ──────────────────────────
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

  setOnAttackBuilding(cb: (attackerId: string, buildingId: string, mode: 'splash' | 'direct', component?: string) => void): void {
    this.onAttackBuilding = cb;
  }

  setOnRepair(cb: (repairerId: string, targetId: string) => void): void {
    this.onRepair = cb;
  }

  setOnMoveCommitted(cb: (unitId: string, path: number[], segment: number) => void): void {
    this.onMoveCommitted = cb;
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

  setOnGodModeBuildBridge(cb: (tileIndex: number) => void): void {
    this.onGodModeBuildBridge = cb;
  }

  setOnGodModeClearForest(cb: (tileIndex: number) => void): void {
    this.onGodModeClearForest = cb;
  }

  setOnGodModeBuildRoad(cb: (tileIndex: number, segment: number) => void): void {
    this.onGodModeBuildRoad = cb;
  }

  setOnGodModeCreateOilBuilding(
    cb: (structure: 'well' | 'refinery', tileIndex: number, segment: number) => void,
  ): void {
    this.onGodModeCreateOilBuilding = cb;
  }

  setOnGodModeEditOilBuilding(cb: (structure: 'well' | 'refinery', structureId: string) => void): void {
    this.onGodModeEditOilBuilding = cb;
  }

  setOnGodModeDeleteOilBuilding(
    cb: (structure: 'well' | 'refinery', structureId: string, segment: number) => void,
  ): void {
    this.onGodModeDeleteOilBuilding = cb;
  }

  setOnGodModeEditUnit(cb: (unitId: string) => void): void {
    this.onGodModeEditUnit = cb;
  }

  setOnGodModeDeleteUnit(cb: (unitId: string) => void): void {
    this.onGodModeDeleteUnit = cb;
  }

  setOnGodModeEditBuilding(cb: (buildingId: string) => void): void {
    this.onGodModeEditBuilding = cb;
  }

  setOnGodModeDeleteBuilding(cb: (buildingId: string) => void): void {
    this.onGodModeDeleteBuilding = cb;
  }

  setOnCreateShuttleTransport(cb: (structureId: string) => void): void {
    this.onCreateShuttleTransport = cb;
  }

  setOnStopShuttleTransport(cb: (transportId: string) => void): void {
    this.onStopShuttleTransport = cb;
  }

  setRemoteTerrainTasksEnabled(cb: () => boolean): void {
    this.remoteTerrainTasksEnabled = cb;
  }

  setStandaloneRoadConstructionEnabled(cb: () => boolean): void {
    this.standaloneRoadConstructionEnabled = cb;
  }

  setEntityEditingEnabled(cb: () => boolean): void {
    this.entityEditingEnabled = cb;
  }

  setOnBuildingSelected(cb: (buildingId: string | null) => void): void {
    this.onBuildingSelected = cb;
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
