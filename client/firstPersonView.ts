/**
 * First-Person View — a 3D battlefield view you can also command units from.
 *
 * The player selects a unit and enters a free-flying camera starting at that
 * unit's position. Drag pans the camera, Ctrl+drag looks around, the wheel
 * zooms (dollies). When a command context is wired (setCommandContext), the
 * view also supports the same unit commands the 2D map has: left-click selects
 * an own-faction unit (showing its movement range as translucent hex fills),
 * hovering previews the route line, right-click issues move / attack / repair
 * (or opens the unit's context menu when clicking the selected unit itself),
 * the ←/→ arrows rotate facing (Shift+←/→ shifts segment), and the context
 * menu offers rotate / refit / sleep — all using the SAME pure pathing logic
 * (computeMovementRange, computeMovementRouteForDestination, extractMovePlan),
 * the SAME shared TurnManager, and the SAME command handlers as the 2D map, so
 * MP and unit state stay consistent across views. Without a command context it
 * degrades to a read-only look-around camera.
 *
 * ── Module map ────────────────────────────────────────────────────────────────
 * This file is the view shell: lifecycle (open/openAt/enterView/close), the
 * free-fly camera, the DOM overlay + mouse/keyboard wiring, the render loop,
 * selection state, and the public surface main.ts depends on. The heavy lifting
 * lives in focused siblings:
 *
 *   firstPersonConstants.ts  world scale, camera limits, model fractions, timings
 *   firstPersonGeometry.ts   FpViewContext + flat-space geometry / surface sampling
 *   firstPersonTerrain.ts    terrain mesh + shared vertex heights (pre-existing)
 *   firstPersonScene.ts      renderer/lighting setup, unit/building/logistics/tree
 *                            builders, entity → world-space placement maths
 *   firstPersonOverlay.ts    3D movement-range fills + hover route line
 *   firstPersonEffects.ts    missile/explosion effects and the camera aim helper
 *   firstPersonInput.ts      FpCommandContext, picking, select/move/attack/rotate
 *
 * ── Design notes ──────────────────────────────────────────────────────────────
 *  - Geometry reuses the SAME tangent-plane projection as the 2D local map
 *    (buildFlatView), so the layout of hexes matches what the player sees on the
 *    flat map. The projected (x, y) coords are mapped to 3D as (x, 0, -y) and
 *    scaled up so a hex is a comfortable size for a perspective camera.
 *  - Terrain follows elevation: hex boundary vertices are lifted to a shared
 *    (neighbour-averaged) height, so adjacent hex tops tilt to meet each other
 *    and form one continuous sloping landform. Steeper neighbours tilt more.
 *    Vertical skirts drop the outer rim and coastline to a common floor so the
 *    field never shows see-through gaps.
 *  - Unit models reuse buildUnitModel() — the exact 3D meshes the sprite renderer
 *    bakes — placed at each unit's segment centroid and rotated to its facing.
 *  - WebGL context is created on enter and disposed on exit so we don't sit on a
 *    third live context while the player is on the normal map.
 *
 * See .kiro/steering/ui-defaults.md § "Unit Facing & Rendering" for the facing
 * coordinate-system background.
 */

import * as THREE from 'three';
import type { WorldData, UnitData } from './worldData.js';
import { buildFlatView, FlatTile } from './localMapProjection.js';
import { getMaxMovement } from '../shared/movementConstants.js';
import { facingDirection } from './facing.js';
import { UnitContextMenu } from './unitContextMenu.js';
import type { MovementRangeResult, MovementCostRoute } from './localMapMovement.js';
import { TerrainTextures } from './terrainTextures.js';
import { dbg } from './debug.js';
import {
  buildTerrainMesh,
  buildVertexHeight as buildVertexHeightFn,
  elevationWorldHeight,
  avgHexRadius,
} from './firstPersonTerrain.js';
import {
  VIEW_RADIUS,
  HEX_WORLD_RADIUS,
  ELEV_WORLD_SCALE,
  EYE_HEIGHT,
  LOOK_SPEED,
  MAX_PITCH,
  FIELD_EXTENT,
  BOOM_MAX,
  BOOM_STEP_FACTOR,
  BOOM_STEP_MIN,
  BOOM_STEP_MAX,
  SHOULDER_STANDOFF,
  CAM_MIN_HEIGHT,
  PAN_FACTOR,
  DRONE_AIR_HEIGHT,
} from './firstPersonConstants.js';
import { sampleSurface, segmentCentroid, type FpViewContext } from './firstPersonGeometry.js';
import {
  buildScene,
  buildTrees,
  isDrone,
  rebuildBuildings,
  rebuildLogistics,
  rebuildUnits,
  buildingWorldPos,
  unitWorldPos,
  shoulderWorldPos,
} from './firstPersonScene.js';
import {
  clearGroup,
  rebuildRangeOverlay,
  rebuildRouteOverlay,
} from './firstPersonOverlay.js';
import {
  aimAt,
  disposeEffects,
  playExplosion3D,
  playMissile3D,
  updateEffects,
  type ActiveEffect,
} from './firstPersonEffects.js';
import {
  chargeRotation,
  handleCommand,
  handleHover,
  handleLeftClick,
  handleRotateKey,
  handleSegmentCommand,
  movementRangeFor,
  pickTileSegment,
  type FpCommandContext,
  type FpInputHost,
} from './firstPersonInput.js';

export type { FpCommandContext } from './firstPersonInput.js';

export class FirstPersonView {
  private world: WorldData;

  /** Lazily-built THREE textures keyed like TerrainTextures.keyForTile. Loaded once, reused across opens. */
  private terrainTextureCache: Map<string, THREE.Texture> = new Map();
  /** Shared instance used purely for its tile→texture-key mapping. */
  private readonly textureKeys = new TerrainTextures();

  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  private rafId = 0;
  private active = false;

  // Free-fly camera state.
  /** Where the camera eye sits (world units). Driven by pan + zoom; clamped to the field. */
  private camPos = new THREE.Vector3();
  /** View direction (radians). yaw 0 = looking toward -Z; pitch +up / -down. */
  private yaw = 0;
  private pitch = 0;
  /**
   * Whether wheel-zoom should "boom" toward the selected unit's shoulder (dolly
   * in + re-aim). Armed by explicit focus actions (open + Home) and cleared the
   * moment the player pans or looks, so once you move the camera yourself, zoom
   * stays a plain dolly pointing where you aimed until you re-focus.
   */
  private boomFocus = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  // Disposables to release on close
  private disposables: Array<{ dispose: () => void }> = [];

  // ─── Command / interaction state ───────────────────────────────────────────
  /** Injected command wiring (null = read-only look-around mode). */
  private cmd: FpCommandContext | null = null;

  // Projection state captured on open() so picking + overlays can reuse it.
  private flatTiles: FlatTile[] = [];
  private tileById = new Map<number, FlatTile>();
  private projScale = 1;
  private toWorld: (px: number, py: number) => [number, number, number] = (px, py) => [px, 0, -py];
  private heightOf: (tileIndex: number, p: { x: number; y: number }) => number = () => 0;

  /** Terrain top meshes — raycast targets for click picking. */
  private pickMeshes: THREE.Mesh[] = [];
  /** Group holding all unit models + selection ring (rebuilt after a command). */
  private unitsGroup: THREE.Group | null = null;
  /** Geometries owned by the units group (disposed on rebuild/close). */
  private unitGeoms: THREE.BufferGeometry[] = [];
  /** Unique materials owned by the units group (selection rings) — disposed on rebuild/close. */
  private unitMats: THREE.Material[] = [];
  /** Group holding all building models (real structures + planned ghosts). */
  private buildingsGroup: THREE.Group | null = null;
  /** Geometries owned by the buildings group (disposed on rebuild/close). */
  private buildingGeoms: THREE.BufferGeometry[] = [];
  /** Materials owned by the buildings group. Unlike unit models (shared
   *  singletons), buildBuildingModel mints fresh materials per call, so these
   *  must be disposed on rebuild/close too. */
  private buildingMats: THREE.Material[] = [];
  /** Group holding all Oil Logistics models (wells/refineries/hubs/transports/roads/deposits). */
  private logisticsGroup: THREE.Group | null = null;
  /** Geometries owned by the logistics group (disposed on rebuild/close). */
  private logisticsGeoms: THREE.BufferGeometry[] = [];
  /** Materials owned by the logistics group (fresh per build — disposed on rebuild/close). */
  private logisticsMats: THREE.Material[] = [];
  /** Movement-range fill overlay (rebuilt on selection change). */
  private rangeGroup: THREE.Group | null = null;
  /** Hover route line overlay (rebuilt on hover). */
  private routeGroup: THREE.Group | null = null;

  /** Active combat effects (missiles / explosions) updated each render frame. */
  private effects: ActiveEffect[] = [];

  /** Currently selected commandable unit (own faction). */
  private selectedUnitId: string | null = null;
  private rangeResult: MovementRangeResult | null = null;
  /** Right-click context menu for the selected unit (rotate/refit/sleep). */
  private contextMenu = new UnitContextMenu();
  private contextMenuOpen = false;

  // Left-drag vs click discrimination.
  private downX = 0;
  private downY = 0;
  private moved = false;
  /** rAF throttle flag for hover route recompute. */
  private hoverPending = false;
  private hoverX = 0;
  private hoverY = 0;
  private readonly raycaster = new THREE.Raycaster();

  // Bound handlers (stable refs for add/removeEventListener)
  private onResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => {
    // Don't steal keys from inputs (e.g. refit modal fields).
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;

    if (e.key === 'Escape') {
      // If the context menu is open, let it close first; keep the view open.
      if (this.contextMenuOpen) return;
      e.preventDefault();
      this.close();
      return;
    }

    // Home: snap onto the selected unit's shoulder, looking along its facing.
    // Swallow in the capture phase so the 2D map's Home handler (centre on home
    // city) doesn't also fire while first-person owns the keyboard.
    if (e.key === 'Home') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.contextMenuOpen) return;
      this.snapToShoulderOfSelected();
      return;
    }

    // The first-person overlay owns keyboard input while open. The 2D map's
    // own window keydown listener is still attached, so unless we stop the
    // event here BOTH handlers would rotate the same unit on every arrow press
    // (facing advancing by 2 → only 3 of the 6 facings ever land). Swallow the
    // rotation keys in the capture phase so the map never sees them.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.contextMenuOpen) return;
      // ArrowDown is swallowed (so the 2D map can't act on it) but is not a
      // first-person command, so it does not rotate.
      if (e.key !== 'ArrowDown') handleRotateKey(this.inputHost(), e);
    }
  };

  constructor(world: WorldData) {
    this.world = world;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Read-only camera diagnostics for headless tests/debugging.
   * Returns null when the view is not open.
   */
  getDiagnostics(): { x: number; y: number; z: number; yaw: number; pitch: number } | null {
    if (!this.active || !this.camera) return null;
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch };
  }

  /** Keep a fresh reference to the world (units may have changed between turns). */
  setWorld(world: WorldData): void {
    this.world = world;
  }

  /**
   * Inject command wiring so the view can select/move/attack/repair units using
   * the same pure pathing logic and shared TurnManager as the 2D map. Pass once
   * after construction; safe to call again to update callbacks.
   */
  setCommandContext(ctx: FpCommandContext): void {
    this.cmd = ctx;
  }

  /**
   * Rebuild unit models + overlays from the current world/turn state. Called by
   * main after an async attack/repair resolves (units may have died/moved).
   */
  refresh(): void {
    if (!this.active) return;
    this.rebuildBuildings();
    this.rebuildLogistics();
    this.rebuildUnits();
    this.rebuildRangeOverlay();
    this.clearRouteOverlay();
  }

  // ─── Shared context objects (rebuilt per use so setWorld() is picked up) ────

  /** Projection + world state the scene/overlay/input modules operate on. */
  private sceneCtx(): FpViewContext {
    return {
      world: this.world,
      flatTiles: this.flatTiles,
      tileById: this.tileById,
      toWorld: this.toWorld,
      heightOf: this.heightOf,
    };
  }

  /** The slice of view state the command handlers need, plus their callbacks. */
  private inputHost(): FpInputHost {
    return {
      ctx: this.sceneCtx(),
      cmd: this.cmd,
      selectedUnitId: this.selectedUnitId,
      rangeResult: this.rangeResult,
      pick: (x, y) => this.pickAt(x, y),
      remainingMP: (id) => this.remainingMP(id),
      select: (id) => this.selectUnit(id),
      showRoute: (route) => this.showRoute(route),
      openContextMenu: (x, y, unit) => this.showContextMenu(x, y, unit),
    };
  }

  /**
   * Play the 3D equivalent of the 2D map's attack animation: a glowing missile
   * arcs from the attacker to the target, then an explosion blooms at the
   * target (plus any splash victims), mirroring `localMap.playAttackAnimation`
   * timing so first-person and map combat feel identical. Resolves when the
   * sequence finishes. No-op (resolves immediately) when the view is closed.
   */
  async playAttackAnimation(
    attackerId: string,
    targetId: string,
    factionColorHex: string,
    damage: number,
    _targetDestroyed: boolean,
    splashVictims: Array<{ unitId: string; damage: number; destroyed: boolean }> = [],
  ): Promise<void> {
    if (!this.active || !this.scene) return;
    const ctx = this.sceneCtx();
    const from = unitWorldPos(ctx, attackerId);
    const to = unitWorldPos(ctx, targetId);
    if (!from || !to) return;

    const color = new THREE.Color(factionColorHex);
    await playMissile3D(this.scene, this.effects, from, to, color);

    const blasts: Array<Promise<void>> = [playExplosion3D(this.scene, this.effects, to, damage, color)];
    for (const v of splashVictims) {
      if (v.unitId === targetId) continue;
      const p = unitWorldPos(ctx, v.unitId);
      if (p) blasts.push(playExplosion3D(this.scene, this.effects, p, v.damage, color));
    }
    await Promise.all(blasts);
  }

  /**
   * First-person equivalent of `localMap.playBuildingAttackAnimation`
   * (building-damage feature): a missile arcs from the attacker to the targeted
   * building, an explosion blooms on it, and any enemy units caught in
   * Splash_Fire also explode. Buildings are indestructible, so there is no
   * building destruction effect. No-op when the view is closed or an endpoint
   * can't be located.
   */
  async playBuildingAttackAnimation(
    attackerId: string,
    buildingId: string,
    factionColorHex: string,
    splashVictims: Array<{ unitId: string; damage: number; destroyed: boolean }> = [],
  ): Promise<void> {
    if (!this.active || !this.scene) return;
    const ctx = this.sceneCtx();
    const from = unitWorldPos(ctx, attackerId);
    const to = buildingWorldPos(ctx, buildingId);
    if (!from || !to) return;

    const color = new THREE.Color(factionColorHex);
    await playMissile3D(this.scene, this.effects, from, to, color);

    const blasts: Array<Promise<void>> = [playExplosion3D(this.scene, this.effects, to, 12, color)];
    for (const v of splashVictims) {
      const p = unitWorldPos(ctx, v.unitId);
      if (p) blasts.push(playExplosion3D(this.scene, this.effects, p, v.damage, color));
    }
    await Promise.all(blasts);
  }

  /**
   * Snap the camera onto the selected unit's shoulder, looking horizontally in
   * the direction the unit faces. Bound to the Home key in first-person view.
   * No-op when nothing is selected or the unit can't be located.
   */
  private snapToShoulderOfSelected(): void {
    const unitId = this.selectedUnitId;
    if (!unitId) return;
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return;
    const ft = this.tileById.get(unit.tileIndex);
    if (!ft) return;
    const shoulder = shoulderWorldPos(this.sceneCtx(), unitId);
    if (!shoulder) return;

    // Horizontal facing direction → yaw; pitch level so we look straight ahead.
    const dir = facingDirection(ft, unit.facing);
    const fLen = Math.hypot(dir.x, dir.z) || 1;
    const fx = dir.x / fLen;
    const fz = dir.z / fLen;
    this.yaw = Math.atan2(fx, -fz);
    this.pitch = 0;

    // Sit just behind and slightly to the side of the shoulder so the unit
    // reads in the lower frame (over-the-shoulder), looking forward along its
    // facing. Right-hand perpendicular of the horizontal forward is (fz, -fx).
    const back = HEX_WORLD_RADIUS * 0.5;
    const side = HEX_WORLD_RADIUS * 0.28;
    this.camPos.set(
      shoulder.x - fx * back + fz * side,
      shoulder.y,
      shoulder.z - fz * back - fx * side,
    );
    // Re-frames the unit, so re-arm boom-zoom focus until the next pan/look.
    this.boomFocus = true;
    this.applyLook();
  }

  /**
   * Enter first-person view positioned at the given unit.
   * Builds the scene, environment and unit models, then starts the render loop.
   */
  open(unit: UnitData): void {
    const selectId = this.cmd && unit.ownerId === this.cmd.getActiveFaction() ? unit.id : null;
    const airHeight = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;
    if (this.enterView(unit.tileIndex, unit.segment, unit.facing, airHeight, selectId)) {
      dbg.localMap.log('FirstPersonView opened for unit', unit.id, 'at tile', unit.tileIndex);
    }
  }

  /**
   * Enter first-person view at an arbitrary hex segment, with no unit required.
   * Used by the segment right-click "View" menu so the player can look around
   * from any tile, occupied or not. Read-only: no unit is selected and the
   * camera sits at ground level facing north.
   */
  openAt(tileIndex: number, segment: number): void {
    const seg = (segment >= 0 ? segment : 0) as 0 | 1 | 2 | 3 | 4 | 5;
    if (this.enterView(tileIndex, seg, 0, 0, null)) {
      dbg.localMap.log('FirstPersonView opened at tile', tileIndex, 'segment', seg);
    }
  }

  /**
   * Shared scene-entry used by both {@link open} and {@link openAt}. Builds the
   * flat view, terrain, units and buildings around `centreTileIndex`, then poses
   * the free-fly camera at the given `segment`/`facing`. When `selectUnitId` is
   * provided it selects that unit (command overlays). Returns false (and logs)
   * if the centre tile is not in the flat view.
   */
  private enterView(
    centreTileIndex: number,
    segment: 0 | 1 | 2 | 3 | 4 | 5,
    facing: 0 | 1 | 2 | 3 | 4 | 5,
    airHeight: number,
    selectUnitId: string | null,
  ): boolean {
    if (this.active) this.close();

    const flatTiles = buildFlatView(this.world, centreTileIndex, VIEW_RADIUS);
    const centre = flatTiles.find((ft) => ft.tileIndex === centreTileIndex);
    if (!centre) {
      dbg.localMap.warn('FirstPersonView: centre tile not in flat view, aborting');
      return false;
    }

    // Derive a projection scale so the centre hex has a comfortable world size.
    const hexR = avgHexRadius(centre);
    const scale = hexR > 1e-9 ? HEX_WORLD_RADIUS / hexR : 1;
    const toWorld = (px: number, py: number): [number, number, number] => [px * scale, 0, -py * scale];

    // Shared, neighbour-averaged height for every boundary vertex — defines the
    // single continuous tilted surface that both the terrain mesh and the units
    // sit on. Built once and reused so units conform to exactly what's drawn.
    const heightOf = buildVertexHeightFn(flatTiles, this.world, ELEV_WORLD_SCALE);

    // Capture projection state for picking + overlays.
    this.flatTiles = flatTiles;
    this.tileById = new Map(flatTiles.map((ft) => [ft.tileIndex, ft]));
    this.projScale = scale;
    this.toWorld = toWorld;
    this.heightOf = heightOf;
    this.selectedUnitId = null;
    this.rangeResult = null;

    this.buildOverlay();
    const built = buildScene(this.canvas!);
    this.scene = built.scene;
    this.camera = built.camera;
    this.renderer = built.renderer;
    const terrainResult = buildTerrainMesh(
      flatTiles,
      this.world,
      toWorld,
      heightOf,
      this.terrainTextureCache,
      this.textureKeys,
      HEX_WORLD_RADIUS,
      FIELD_EXTENT,
      ELEV_WORLD_SCALE,
      this.scene!,
    );
    this.pickMeshes = terrainResult.pickMeshes;
    this.disposables.push(...terrainResult.disposables);

    // Groups for units + command overlays, rebuilt independently as state changes.
    this.unitsGroup = new THREE.Group();
    this.rangeGroup = new THREE.Group();
    this.routeGroup = new THREE.Group();
    this.buildingsGroup = new THREE.Group();
    this.logisticsGroup = new THREE.Group();
    this.scene!.add(this.unitsGroup, this.rangeGroup, this.routeGroup, this.buildingsGroup, this.logisticsGroup);
    this.rebuildBuildings();
    this.rebuildLogistics();
    this.rebuildUnits();

    // Scatter static forest scenery across forested hexes (built once per open).
    buildTrees({ ctx: this.sceneCtx(), scene: this.scene, disposables: this.disposables });
    if (selectUnitId) {
      this.selectUnit(selectUnitId);
    }

    // Initial camera: sit at the segment's eye, looking along `facing`, then
    // pull back and lift a little so the spot (and any unit there) is in frame —
    // a gentle starting pose for the free-fly camera.
    const eye = segmentCentroid(centre, segment);
    const [ex, , ez] = toWorld(eye.x, eye.y);
    const centreGround = sampleSurface(centre, eye.x, eye.y, toWorld, heightOf,
      elevationWorldHeight(this.world.tiles[centreTileIndex], ELEV_WORLD_SCALE)).height;
    const centreAir = airHeight;

    const dir = facingDirection(centre, facing);
    this.yaw = Math.atan2(dir.x, -dir.z);
    this.pitch = -0.12;

    const eyeY = centreGround + centreAir + EYE_HEIGHT;
    const back = HEX_WORLD_RADIUS * 6;
    const forward = this.forwardVec();
    this.camPos.set(ex, eyeY, ez)
      .addScaledVector(forward, -back)
      .add(new THREE.Vector3(0, back * 0.35, 0));
    this.clampPos();
    // Initial pose frames the unit, so arm boom-zoom focus until the player
    // takes manual control (pan/look).
    this.boomFocus = true;

    this.active = true;
    this.resize();
    this.applyLook();
    this.loop();

    window.addEventListener('resize', this.onResize);
    // Capture phase + stopImmediatePropagation in the handler ensures the 2D
    // map's window keydown listener (also on window) does NOT also process
    // arrow keys while first-person is open.
    window.addEventListener('keydown', this.onKeyDown, true);

    return true;
  }

  /** Exit first-person view and release all GPU resources. */
  close(): void {
    if (!this.active) return;
    this.active = false;

    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.contextMenu.close();
    this.contextMenuOpen = false;

    // Dispose any in-flight combat effects (missiles / explosions).
    disposeEffects(this.effects);

    // Dispose command-overlay + unit geometries (materials are shared singletons).
    for (const g of this.unitGeoms) {
      try { g.dispose(); } catch { /* best-effort */ }
    }
    this.unitGeoms = [];
    for (const m of this.unitMats) {
      try { m.dispose(); } catch { /* best-effort */ }
    }
    this.unitMats = [];
    // Building models own both their geometries AND materials (fresh per build).
    for (const g of this.buildingGeoms) {
      try { g.dispose(); } catch { /* best-effort */ }
    }
    this.buildingGeoms = [];
    for (const m of this.buildingMats) {
      try { m.dispose(); } catch { /* best-effort */ }
    }
    this.buildingMats = [];
    // Logistics models own both geometries AND materials (fresh per build).
    for (const g of this.logisticsGeoms) {
      try { g.dispose(); } catch { /* best-effort */ }
    }
    this.logisticsGeoms = [];
    for (const m of this.logisticsMats) {
      try { m.dispose(); } catch { /* best-effort */ }
    }
    this.logisticsMats = [];
    clearGroup(this.rangeGroup);
    clearGroup(this.routeGroup);
    this.unitsGroup = null;
    this.rangeGroup = null;
    this.routeGroup = null;
    this.buildingsGroup = null;
    this.logisticsGroup = null;
    this.pickMeshes = [];
    this.flatTiles = [];
    this.tileById.clear();
    this.selectedUnitId = null;
    this.rangeResult = null;

    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
    this.disposables = [];

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;

    if (this.container && this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    this.container = null;
    this.canvas = null;

    dbg.localMap.log('FirstPersonView closed');
  }

  // ─── Scene / overlay rebuild wrappers ─────────────────────────────────────

  private rebuildUnits(): void {
    rebuildUnits({
      ctx: this.sceneCtx(),
      scene: this.scene,
      group: this.unitsGroup,
      geoms: this.unitGeoms,
      mats: this.unitMats,
      selectedUnitId: this.selectedUnitId,
      remainingMP: (id) => this.remainingMP(id),
    });
  }

  private rebuildBuildings(): void {
    rebuildBuildings({
      ctx: this.sceneCtx(),
      scene: this.scene,
      group: this.buildingsGroup,
      geoms: this.buildingGeoms,
      mats: this.buildingMats,
    });
  }

  private rebuildLogistics(): void {
    rebuildLogistics({
      ctx: this.sceneCtx(),
      scene: this.scene,
      group: this.logisticsGroup,
      geoms: this.logisticsGeoms,
      mats: this.logisticsMats,
    });
  }

  /** Rebuild the movement-range fill overlay from the current range result. */
  private rebuildRangeOverlay(): void {
    rebuildRangeOverlay(this.sceneCtx(), this.rangeGroup, this.rangeResult);
  }

  /** Draw the hover route line (null clears it). */
  private showRoute(route: MovementCostRoute | null): void {
    rebuildRouteOverlay(this.sceneCtx(), this.routeGroup, route);
  }

  private clearRouteOverlay(): void {
    clearGroup(this.routeGroup);
  }

  // ─── Command interaction (select / move / attack / repair) ──────────────────

  /** Remaining movement points for a unit (0 when no command context wired). */
  private remainingMP(unitId: string): number {
    return this.cmd ? (this.cmd.turnManager.movementPoints.get(unitId) ?? 0) : 0;
  }

  /** Raycast a screen point to a tile + hex segment, or null if it missed terrain. */
  private pickAt(clientX: number, clientY: number): { tileIndex: number; segment: number } | null {
    return pickTileSegment({
      camera: this.camera,
      canvas: this.canvas,
      raycaster: this.raycaster,
      pickMeshes: this.pickMeshes,
      projScale: this.projScale,
      flatTiles: this.flatTiles,
      clientX,
      clientY,
    });
  }

  /**
   * Select an own-faction unit by id: compute its range and refresh overlays.
   * Passing null (or an id that no longer exists) clears the selection.
   */
  private selectUnit(unitId: string | null): void {
    const unit = unitId ? this.world.units.find((u) => u.id === unitId) : undefined;
    this.selectedUnitId = unit ? unitId : null;
    this.rangeResult = null;
    if (unit) {
      this.rangeResult = movementRangeFor(this.sceneCtx(), unit, this.remainingMP(unit.id));
    }
    this.rebuildUnits();
    this.rebuildRangeOverlay();
    this.clearRouteOverlay();
  }

  /**
   * Right-click context menu for the selected unit (rotate / refit / sleep).
   * Reuses the shared UnitContextMenu via a thin host adapter. The "View" item
   * is suppressed (onViewUnit = null) since we are already in first-person.
   */
  private showContextMenu(clientX: number, clientY: number, unit: UnitData): void {
    if (!this.cmd) return;
    const cmd = this.cmd;
    this.contextMenu.close();
    this.contextMenuOpen = true;

    this.contextMenu.show(clientX, clientY, unit, {
      chargeRotation: (id) => chargeRotation(this.inputHost(), id),
      closeContextMenu: () => {
        this.contextMenu.close();
        this.contextMenuOpen = false;
      },
      view: {
        selectedTile: unit.tileIndex,
        selectedSegment: unit.segment,
        // Facing/segment may have changed — rebuild models + range overlay.
        onTileSelectCb: () => { this.selectUnit(unit.id); },
        render: () => { /* continuous render loop handles redraw */ },
        getMaxMovement: (u) => getMaxMovement(u.attributes),
        movementPoints: cmd.turnManager.movementPoints,
        onRefit: (id) => cmd.onRefit(id),
        isGodModeEntityEditingEnabled: cmd.isGodModeEntityEditingEnabled,
        onGodModeEditUnit: (id) => cmd.onGodModeEditUnit(id),
        onGodModeDeleteUnit: (id) => cmd.onGodModeDeleteUnit(id),
        onSleepUnit: (id) => cmd.onSleep(id),
        onViewUnit: null,
      },
    });
  }

  // ─── DOM overlay ──────────────────────────────────────────────────────────

  private buildOverlay(): void {
    const container = document.createElement('div');
    container.id = 'first-person-overlay';
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '3000',
      background: '#000',
      cursor: 'grab',
    } as CSSStyleDeclaration);

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' } as CSSStyleDeclaration);
    container.appendChild(canvas);

    const hint = document.createElement('div');
    hint.textContent = 'Click a unit to select · right-click to move/attack (or open its menu) · ←/→ rotate · drag to pan · Ctrl+drag to look · scroll zoom · Esc exit';
    Object.assign(hint.style, {
      position: 'absolute',
      bottom: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '6px 14px',
      background: 'rgba(10,10,10,0.5)',
      color: '#eee',
      font: "12px 'Segoe UI', sans-serif",
      borderRadius: '14px',
      pointerEvents: 'none',
      userSelect: 'none',
    } as CSSStyleDeclaration);
    container.appendChild(hint);

    const exitBtn = document.createElement('button');
    exitBtn.textContent = '✕ Exit View';
    Object.assign(exitBtn.style, {
      position: 'absolute',
      top: '14px',
      right: '14px',
      padding: '8px 14px',
      background: 'rgba(10,10,10,0.6)',
      color: '#eee',
      border: '1px solid #555',
      borderRadius: '6px',
      cursor: 'pointer',
      font: "13px 'Segoe UI', sans-serif",
    } as CSSStyleDeclaration);
    exitBtn.addEventListener('click', () => this.close());
    container.appendChild(exitBtn);

    // Free-fly controls:
    //  · left-drag        → pan the camera across the battlefield (screen plane)
    //  · Ctrl+left-drag   → look around in place (yaw/pitch, no movement)
    //  · left-click       → select an own-faction unit (shows movement range)
    //  · right-click      → move / attack / repair with the selected unit
    //  · wheel            → dolly forward/back along the view direction (zoom)
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // left button only; right-click is a command
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.moved = false;
      container.style.cursor = e.ctrlKey ? 'grabbing' : 'move';
    });
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('mousemove', (e) => {
      if (!this.dragging) {
        this.queueHover(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (Math.abs(e.clientX - this.downX) > 4 || Math.abs(e.clientY - this.downY) > 4) this.moved = true;

      if (e.ctrlKey) {
        // Look around in place — "grab the surface and turn it": dragging moves
        // the world the same way it does when panning. Drag right → world swings
        // right (camera yaws left); drag down → world tilts down (camera looks up).
        this.boomFocus = false;
        this.yaw -= dx * LOOK_SPEED;
        this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy * LOOK_SPEED));
      } else {
        // Pan: "grab the surface and drag it" — the point under the cursor follows
        // the cursor. Drag right → surface slides right (eye moves left); drag down
        // → surface slides toward you (eye moves forward). Stays on the horizontal
        // plane (yaw-based axes, pitch ignored) so altitude never changes.
        this.boomFocus = false;
        const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
        const fwdX = sinY, fwdZ = -cosY;   // horizontal forward (yaw only)
        const rightX = cosY, rightZ = sinY; // horizontal right
        const panAmt = PAN_FACTOR * Math.max(this.camPos.y, EYE_HEIGHT);
        this.camPos.x += (dy * fwdX - dx * rightX) * panAmt;
        this.camPos.z += (dy * fwdZ - dx * rightZ) * panAmt;
      }
      this.applyLook();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Step scales with current altitude: tiny near the ground, large when high up.
      const step = Math.min(BOOM_STEP_MAX, Math.max(BOOM_STEP_MIN, this.camPos.y * BOOM_STEP_FACTOR));
      const zoomIn = e.deltaY < 0;
      // Boom zoom: only while focus is armed (right after open or the Home
      // shoulder-snap) does the wheel dolly toward + re-aim at the selected
      // unit's shoulder. Once the player pans or looks, focus is cleared and
      // zoom becomes a plain forward dolly that keeps pointing where they aimed.
      const shoulder = this.boomFocus && this.selectedUnitId
        ? shoulderWorldPos(this.sceneCtx(), this.selectedUnitId)
        : null;
      let boomed = false;
      if (shoulder) {
        const dir = shoulder.clone().sub(this.camPos);
        const dist = dir.length();
        if (dist > 1e-3) {
          dir.divideScalar(dist);
          // Leave a small standoff when zooming in so the camera frames the
          // shoulder rather than punching through the model.
          const move = zoomIn ? Math.min(step, Math.max(0, dist - SHOULDER_STANDOFF)) : -step;
          this.camPos.addScaledVector(dir, move);
          const aim = aimAt(this.camPos, shoulder);
          if (aim) {
            this.pitch = aim.pitch;
            this.yaw = aim.yaw;
          }
          boomed = true;
        }
      }
      if (!boomed) {
        const forward = this.forwardVec();
        this.camPos.addScaledVector(forward, zoomIn ? step : -step);
      }
      this.applyLook();
    }, { passive: false });

    document.body.appendChild(container);
    this.container = container;
    this.canvas = canvas;
  }

  private onMouseUp = (e: MouseEvent) => {
    const wasDragging = this.dragging;
    this.dragging = false;
    if (this.container) this.container.style.cursor = 'grab';
    // A left press that didn't drag (and isn't a look gesture) is a selection click.
    if (wasDragging && e.button === 0 && !this.moved && !e.ctrlKey) {
      handleLeftClick(this.inputHost(), e.clientX, e.clientY);
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (!this.selectedUnitId) {
      handleSegmentCommand(this.inputHost(), e.clientX, e.clientY);
      return;
    }
    handleCommand(this.inputHost(), e.clientX, e.clientY);
  };

  /** Throttle hover-route recomputation to once per animation frame. */
  private queueHover(x: number, y: number): void {
    if (!this.cmd || !this.selectedUnitId) return;
    this.hoverX = x;
    this.hoverY = y;
    if (this.hoverPending) return;
    this.hoverPending = true;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      if (this.active) handleHover(this.inputHost(), this.hoverX, this.hoverY);
    });
  }

  // ─── Per-frame ────────────────────────────────────────────────────────────

  /** Unit view-direction vector from the current yaw/pitch. */
  private forwardVec(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
  }

  /** Keep the free-fly eye inside the battlefield borders and above the ground. */
  private clampPos(): void {
    this.camPos.x = Math.max(-FIELD_EXTENT, Math.min(FIELD_EXTENT, this.camPos.x));
    this.camPos.z = Math.max(-FIELD_EXTENT, Math.min(FIELD_EXTENT, this.camPos.z));
    this.camPos.y = Math.max(CAM_MIN_HEIGHT, Math.min(BOOM_MAX, this.camPos.y));
  }

  private applyLook(): void {
    if (!this.camera) return;
    this.clampPos();
    const forward = this.forwardVec();
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(
      this.camPos.x + forward.x,
      this.camPos.y + forward.y,
      this.camPos.z + forward.z,
    );
  }

  private resize(): void {
    if (!this.renderer || !this.camera || !this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private loop(): void {
    if (!this.active) return;
    this.rafId = requestAnimationFrame(() => this.loop());
    if (this.effects.length > 0) updateEffects(this.effects);
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
