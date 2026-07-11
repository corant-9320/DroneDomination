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
import type { WorldData, UnitData, TileData, BuildingData } from './worldData.js';
import { buildFlatView, FlatTile, pointInPoly } from './localMapProjection.js';
import {
  getMovementMode,
  isImpassableTerrain,
  getMaxMovement,
  ROTATION_FEE,
} from '../shared/movementConstants.js';
import { findPreferredSegment } from './localMapGeometry.js';
import { rotateHexIndex } from './facing.js';
import { UnitContextMenu } from './unitContextMenu.js';
import {
  computeMovementRange,
  computeMovementRouteForDestination,
  computeContextualAttackRoute,
  extractMovePlan,
  isInWeaponRange,
  weaponRangeInTileHops,
  type MovementRangeResult,
  type MovementCostRoute,
} from './localMapMovement.js';
import type { TurnManager } from './turnManager.js';
import { buildUnitModel } from './unitModel.js';
import { unitDataToModelAttrs } from './unitRenderer.js';
import { buildBuildingModel, BUILDING_BASE_FOOTPRINT } from './buildingModel.js';
import { buildLogisticsModel } from './logisticsModel.js';
import { buildTransportModel } from './logisticsModelTransport.js';
import { buildRoadMesh, buildHighwayMesh } from './logisticsModelRoad.js';
import { buildingDataToModelAttrs } from './buildingRenderer.js';
import { tileColorRGB, factionColor } from './colors.js';
import { TerrainTextures } from './terrainTextures.js';
import { dbg } from './debug.js';
import {
  buildTerrainMesh,
  buildVertexHeight as buildVertexHeightFn,
  elevationWorldHeight,
  avgHexRadius,
  roadSurfaceLift,
} from './firstPersonTerrain.js';
import { getShowEntityNumbers } from './localMapUnits.js';

/**
 * Command wiring injected by main.ts so first-person can issue the same
 * move/attack/repair commands the 2D map does, against the shared TurnManager.
 * When this is null the view stays read-only (look-around only).
 */
export interface FpCommandContext {
  turnManager: TurnManager;
  /** Current ownerId allowed to command units (the active faction). */
  getActiveFaction: () => string;
  /** Resolve an attack (server round-trip) — same handler the 2D map uses. */
  onAttack: (attackerId: string, targetId: string) => void;
  /** Resolve a repair — same handler the 2D map uses. */
  onRepair: (repairerId: string, targetId: string) => void;
  /** Put a unit to sleep (suppresses end-turn warning) — same handler the map uses. */
  onSleep: (unitId: string) => void;
  /** Open the refit/designer modal for a unit — same handler the map uses. */
  onRefit: (unitId: string) => void;
  /** Notify main that world/turn state changed so the 2D map + panels refresh. */
  onCommit: () => void;
}


/**
 * How many hex rings around the unit to render as the visible environment.
 * The 20v20 battle spans ~8 BFS layers seed-to-seed, so this is sized to keep
 * both armies in view from either end of the field.
 */
const VIEW_RADIUS = 17;

/** Target on-screen radius (world units) for a hex — drives the projection scale. */
const HEX_WORLD_RADIUS = 6;

/**
 * World-space vertical scale for terrain elevation. The shared elevation height
 * scale (see terrainContext.elevationHeight) runs 0 (flat) → 1 (mountain), so a
 * mountain rises ELEV_WORLD_SCALE world units above flat ground.
 * Vertically exaggerated (~2x real proportion) so mountains read as mountains
 * rather than gentle hills in the perspective view.
 */
const ELEV_WORLD_SCALE = HEX_WORLD_RADIUS * 4.4;

/** Camera eye height above the ground plane (world units). */
const EYE_HEIGHT = 2.4;

/** Look sensitivity (radians per pixel of mouse drag). */
const LOOK_SPEED = 0.005;

/** Pitch clamp so the camera can't flip over the poles. */
const MAX_PITCH = (85 * Math.PI) / 180;

/** World-space half-extent of the rendered field. */
const FIELD_EXTENT = HEX_WORLD_RADIUS * VIEW_RADIUS;

/**
 * Max camera altitude / pull-back distance (world units). Lets the eye lift well
 * above the field for a full battlefield overview.
 */
const BOOM_MAX = FIELD_EXTENT * 3.0;

/**
 * Zoom sensitivity: step = camY * BOOM_STEP_FACTOR, clamped to [BOOM_STEP_MIN, BOOM_STEP_MAX].
 * This gives fine control near the ground and fast travel when high up.
 */
const BOOM_STEP_FACTOR = 0.12;
const BOOM_STEP_MIN = 0.15;
const BOOM_STEP_MAX = BOOM_MAX / 8;

/**
 * Closest the boom zoom will dolly toward a unit's shoulder — small so the
 * camera can come right up to the model without clipping through it.
 */
const SHOULDER_STANDOFF = HEX_WORLD_RADIUS * 0.05;

/** Hard floor for the camera eye when zooming right up to a unit. */
const CAM_MIN_HEIGHT = 0.3;

/**
 * Pan distance per pixel of drag, per world unit of altitude. Scaling by height
 * keeps panning slow and precise at ground level yet fast enough to cross the
 * field when zoomed out for an overview.
 */
const PAN_FACTOR = 0.0016;

/** Hover altitude (world units) for drone models — they float above the terrain. */
const DRONE_AIR_HEIGHT = HEX_WORLD_RADIUS * 0.5;

/**
 * Forest scenery: how many trees to scatter across each forested hex in view.
 * Trees are static decoration (the 3D echo of the 2D map's forest tree icons),
 * instanced for performance.
 */
const TREES_PER_HEX = 22;

/** Base tree height as a fraction of a hex radius (canopy tip above ground). */
const TREE_HEX_FRACTION = 0.15;

/**
 * Unit model footprint as a fraction of a hex radius. Units are deliberately
 * tiny relative to the terrain (a tank is a handful of metres; a hex now reads
 * as a swathe of ground hundreds of metres across, with a formation spread out
 * inside it). Bump this to make units larger.
 */
const UNIT_HEX_FRACTION = 0.0825;

/**
 * Building model footprint as a fraction of a hex radius. Buildings are large
 * static structures — far bigger than the tiny unit models — so a clustered
 * city reads as a city from across the field. Sized so a full segment's worth
 * of structure sits comfortably inside the hex.
 */
const BUILDING_HEX_FRACTION = 0.315;

/** Radius (world units) of the selection ring under the player's own unit.
 *  Decoupled from unit size so the (now small) selected unit stays findable. */
const SELECT_RING_RADIUS = HEX_WORLD_RADIUS * 0.4;

/** Radius (world units) of the faction-colour ring drawn on the ground under
 *  every unit, so the (tiny) models are easy to spot and tell apart by side.
 *  Slightly smaller than the white selection ring so both stay distinct. */
const FACTION_RING_RADIUS = HEX_WORLD_RADIUS * 0.075;

/** Combat animation timings (ms) — kept in lockstep with the 2D map
 *  (combatAnimations.ts) so first-person and map attacks feel identical. */
const MISSILE_DURATION = 520;
const EXPLOSION_DURATION = 680;
/** How many recent missile positions to keep for the glowing contrail. */
const MISSILE_TRAIL_POINTS = 16;

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
      if (e.key !== 'ArrowDown') this.handleRotateKey(e);
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
    const from = this.unitWorldPos(attackerId);
    const to = this.unitWorldPos(targetId);
    if (!from || !to) return;

    const color = new THREE.Color(factionColorHex);
    await this.playMissile3D(from, to, color);

    const blasts: Array<Promise<void>> = [this.playExplosion3D(to, damage, color)];
    for (const v of splashVictims) {
      if (v.unitId === targetId) continue;
      const p = this.unitWorldPos(v.unitId);
      if (p) blasts.push(this.playExplosion3D(p, v.damage, color));
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
    const from = this.unitWorldPos(attackerId);
    const to = this.buildingWorldPos(buildingId);
    if (!from || !to) return;

    const color = new THREE.Color(factionColorHex);
    await this.playMissile3D(from, to, color);

    const blasts: Array<Promise<void>> = [this.playExplosion3D(to, 12, color)];
    for (const v of splashVictims) {
      const p = this.unitWorldPos(v.unitId);
      if (p) blasts.push(this.playExplosion3D(p, v.damage, color));
    }
    await Promise.all(blasts);
  }

  /**
   * World-space impact point near the middle of a building's body, used as the
   * missile target / explosion centre. Mirrors the placement maths in the
   * building `place()` helper (segment centroid → tilted surface sample) and
   * lifts to roughly mid-structure height.
   */
  private buildingWorldPos(buildingId: string): THREE.Vector3 | null {
    const b = this.world.buildings.find((bb) => bb.id === buildingId);
    if (!b) return null;
    const ft = this.tileById.get(b.tileIndex);
    if (!ft) return null;
    const cen = segmentCentroid(ft, b.segment);
    const [wx, , wz] = this.toWorld(cen.x, cen.y);
    const fallbackTop = elevationWorldHeight(this.world.tiles[b.tileIndex], ELEV_WORLD_SCALE);
    // Clamp to the tile plateau so a building on a shore segment (whose outer
    // vertices slope down to the waterline) rests on dry ground rather than
    // sinking. The terrain mesh still slopes; only the building base is lifted.
    const groundY = Math.max(
      sampleSurface(ft, cen.x, cen.y, this.toWorld, this.heightOf, fallbackTop).height,
      fallbackTop,
    );
    const bodyLift = HEX_WORLD_RADIUS * BUILDING_HEX_FRACTION * 0.5;
    return new THREE.Vector3(wx, groundY + bodyLift, wz);
  }

  /**
   * World-space position near a unit's body centre, used as a missile muzzle /
   * impact point. Mirrors the placement maths in rebuildUnits (segment centroid
   * → tilted surface sample → drone air hover) and lifts to roughly mid-body.
   */
  private unitWorldPos(unitId: string): THREE.Vector3 | null {
    const unit = this.world.units.find((u) => u.id === unitId);
    if (!unit) return null;
    const ft = this.tileById.get(unit.tileIndex);
    if (!ft) return null;
    const cen = segmentCentroid(ft, unit.segment);
    const [wx, , wz] = this.toWorld(cen.x, cen.y);
    const fallbackTop = elevationWorldHeight(this.world.tiles[unit.tileIndex], ELEV_WORLD_SCALE);
    // Clamp to the tile plateau so a unit on a shore/water-adjacent segment
    // (whose outer vertices are pinned to the waterline by buildVertexHeight)
    // doesn't sample a triangle dragged down to the ocean floor — mirrors the
    // building anti-sink clamp (see DECISIONS.md 2026-07-01 / 2026-07-03).
    const groundY = Math.max(
      sampleSurface(ft, cen.x, cen.y, this.toWorld, this.heightOf, fallbackTop).height,
      fallbackTop,
    );
    const air = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;
    // Aim at roughly the unit's mid-body so missiles fly between models, not feet.
    const bodyLift = HEX_WORLD_RADIUS * UNIT_HEX_FRACTION * 0.5 + HEX_WORLD_RADIUS * 0.12;
    return new THREE.Vector3(wx, groundY + air + bodyLift, wz);
  }

  /**
   * Point roughly at a unit's shoulder — its mid-body lifted toward the top of
   * the torso. Used as the focal point for the boom zoom.
   */
  private shoulderWorldPos(unitId: string): THREE.Vector3 | null {
    const mid = this.unitWorldPos(unitId);
    if (!mid) return null;
    mid.y += HEX_WORLD_RADIUS * UNIT_HEX_FRACTION * 0.35;
    return mid;
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
    const shoulder = this.shoulderWorldPos(unitId);
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

  /** Aim the camera's yaw/pitch at a world target (does not move the eye). */
  private aimAt(target: THREE.Vector3): void {
    const dx = target.x - this.camPos.x;
    const dy = target.y - this.camPos.y;
    const dz = target.z - this.camPos.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.asin(dy / len)));
    this.yaw = Math.atan2(dx, -dz);
  }

  /**
   * Animate a glowing missile arcing from `from` to `to` with a fading contrail.
   * Resolves when it reaches the target.
   */
  private playMissile3D(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): Promise<void> {
    const scene = this.scene;
    if (!scene) return Promise.resolve();

    // Lob height scales with distance so short shots stay flat, long shots arc.
    const dist = from.distanceTo(to);
    const arc = Math.min(HEX_WORLD_RADIUS * 1.5, dist * 0.18);

    const headGeo = new THREE.SphereGeometry(HEX_WORLD_RADIUS * 0.06, 10, 10);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const head = new THREE.Mesh(headGeo, headMat);
    scene.add(head);

    // Glow shell around the head for a hot, bloomy look (additive).
    const glowGeo = new THREE.SphereGeometry(HEX_WORLD_RADIUS * 0.12, 10, 10);
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    scene.add(glow);

    // Contrail as an additive line we rebuild from recent positions each frame.
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MISSILE_TRAIL_POINTS * 3), 3));
    const trailMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const trail = new THREE.Line(trailGeo, trailMat);
    trail.frustumCulled = false;
    scene.add(trail);

    const tmp = new THREE.Vector3();
    const posAt = (t: number, out: THREE.Vector3): THREE.Vector3 => {
      out.lerpVectors(from, to, t);
      out.y += Math.sin(Math.PI * t) * arc; // parabolic lob
      return out;
    };

    const start = performance.now();
    const recent: THREE.Vector3[] = [];

    return new Promise<void>((resolve) => {
      const effect: ActiveEffect = {
        update: (now: number): boolean => {
          const raw = Math.min(1, (now - start) / MISSILE_DURATION);
          const t = easeInOutCubic(raw);
          const p = posAt(t, tmp);
          head.position.copy(p);
          glow.position.copy(p);

          recent.push(p.clone());
          if (recent.length > MISSILE_TRAIL_POINTS) recent.shift();
          const arr = trailGeo.attributes.position.array as Float32Array;
          for (let i = 0; i < MISSILE_TRAIL_POINTS; i++) {
            const src = recent[Math.min(i, recent.length - 1)] ?? p;
            arr[i * 3] = src.x; arr[i * 3 + 1] = src.y; arr[i * 3 + 2] = src.z;
          }
          trailGeo.attributes.position.needsUpdate = true;
          trailGeo.setDrawRange(0, recent.length);

          if (raw >= 1) { resolve(); return false; }
          return true;
        },
        dispose: () => {
          scene.remove(head, glow, trail);
          headGeo.dispose(); headMat.dispose();
          glowGeo.dispose(); glowMat.dispose();
          trailGeo.dispose(); trailMat.dispose();
        },
      };
      this.effects.push(effect);
    });
  }

  /**
   * Bloom an explosion at `centre`: a white-hot flash that expands and fades,
   * wrapped in a faction-tinted fireball. Size scales with damage to match the
   * 2D map. Resolves when it finishes.
   */
  private playExplosion3D(centre: THREE.Vector3, damage: number, color: THREE.Color): Promise<void> {
    const scene = this.scene;
    if (!scene) return Promise.resolve();

    const scale = Math.min(2.8, 0.6 + damage / 18);
    const maxR = HEX_WORLD_RADIUS * 0.5 * scale;

    const coreGeo = new THREE.SphereGeometry(1, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.copy(centre);
    scene.add(core);

    const fireGeo = new THREE.SphereGeometry(1, 16, 16);
    const fireMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const fire = new THREE.Mesh(fireGeo, fireMat);
    fire.position.copy(centre);
    scene.add(fire);

    const start = performance.now();
    return new Promise<void>((resolve) => {
      const effect: ActiveEffect = {
        update: (now: number): boolean => {
          const t = Math.min(1, (now - start) / EXPLOSION_DURATION);
          const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

          // White core flashes fast then vanishes.
          const coreR = maxR * (0.35 + ease * 0.55);
          core.scale.setScalar(coreR);
          coreMat.opacity = Math.max(0, 1 - t * 3.2);

          // Fireball expands fully and fades over the whole duration.
          fire.scale.setScalar(maxR * (0.5 + ease));
          fireMat.opacity = Math.max(0, 0.8 * (1 - ease));

          if (t >= 1) { resolve(); return false; }
          return true;
        },
        dispose: () => {
          scene.remove(core, fire);
          coreGeo.dispose(); coreMat.dispose();
          fireGeo.dispose(); fireMat.dispose();
        },
      };
      this.effects.push(effect);
    });
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
    this.buildScene();
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
    this.buildTrees();
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
    for (const fx of this.effects) {
      try { fx.dispose(); } catch { /* best-effort */ }
    }
    this.effects = [];

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
    this.clearGroup(this.rangeGroup);
    this.clearGroup(this.routeGroup);
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

  // ─── Scene construction ───────────────────────────────────────────────────

  private buildScene(): void {
    const scene = new THREE.Scene();
    const sky = new THREE.Color(0x9ec7e8);
    scene.background = sky;
    // Fog starts beyond the battlefield so the whole field stays visible even
    // when zoomed out; it only softens the far horizon.
    scene.fog = new THREE.Fog(sky, FIELD_EXTENT * 2.2, FIELD_EXTENT * 5);

    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas!, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lighting — a soft "daytime" setup so terrain colours and unit models read well.
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(20, 40, 15);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.4);
    fill.position.set(-20, 20, -10);
    scene.add(fill);

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
  }

  /** (Re)build a 3D model for every unit in view, into the units group. */
  private rebuildUnits(): void {
    const scene = this.scene;
    const group = this.unitsGroup;
    if (!scene || !group) return;

    // Tear down previous models (dispose geometries; materials are shared).
    for (const child of [...group.children]) group.remove(child);
    for (const g of this.unitGeoms) {
      try { g.dispose(); } catch { /* best-effort */ }
    }
    this.unitGeoms = [];
    for (const m of this.unitMats) {
      try { m.dispose(); } catch { /* best-effort */ }
    }
    this.unitMats = [];

    const flatTiles = this.flatTiles;
    const toWorld = this.toWorld;
    const heightOf = this.heightOf;
    const selectedUnitId = this.selectedUnitId ?? '';
    const tileById = this.tileById;

    for (const unit of this.world.units) {
      const ft = tileById.get(unit.tileIndex);
      if (!ft) continue;

      const attrs = unitDataToModelAttrs(unit);
      const fc = factionColor(this.world, unit.ownerId);
      const model = buildUnitModel(attrs, fc);

      // Normalise: drop the model onto the ground and scale to ~half a hex wide.
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxXZ = Math.max(size.x, size.z) || 1;
      const targetW = HEX_WORLD_RADIUS * UNIT_HEX_FRACTION;
      const s = targetW / maxXZ;
      model.scale.setScalar(s);

      // Recompute box after scaling to sit the base on the ground.
      const box2 = new THREE.Box3().setFromObject(model);
      const groundLift = -box2.min.y;

      // Sample the real (tilted) terrain surface under the unit's footprint so
      // it sits on the slope rather than floating at the flat plateau height.
      const cen = segmentCentroid(ft, unit.segment);
      const [wx, , wz] = toWorld(cen.x, cen.y);
      const fallbackTop = elevationWorldHeight(this.world.tiles[unit.tileIndex], ELEV_WORLD_SCALE);
      const sampled = sampleSurface(ft, cen.x, cen.y, toWorld, heightOf, fallbackTop);
      // Clamp to the tile plateau so a unit on a shore/water-adjacent segment
      // (whose outer vertices are pinned to the waterline by buildVertexHeight)
      // doesn't sample a triangle dragged down to the ocean floor, which hid
      // the model below the terrain mesh entirely — mirrors the building
      // anti-sink clamp (see DECISIONS.md 2026-07-01 / 2026-07-03). When the
      // clamp kicks in, treat the ground as flat plateau (upright normal)
      // rather than the (invalid) sampled slope.
      const clamped = sampled.height < fallbackTop;
      const groundY = clamped ? fallbackTop : sampled.height;
      const normal = clamped ? new THREE.Vector3(0, 1, 0) : sampled.normal;

      // City hexes have road/pavement geometry lifted by ROAD_LIFT above the raw
      // terrain mesh. Raise the unit by the same offset so it stands on the road
      // surface rather than sinking into it.
      const cityLift = this.world.tiles[unit.tileIndex].city ? roadSurfaceLift(HEX_WORLD_RADIUS) : 0;

      const dir = facingDirection(ft, unit.facing);
      const drone = isDrone(unit);

      // Ground units conform to the surface normal; drones hover level above it.
      const up = drone ? new THREE.Vector3(0, 1, 0) : normal;
      orientToSurface(model, up, dir);

      // Lift the model's base clear of the surface along the surface normal so a
      // tilted unit doesn't sink a corner into the slope. Drones add air hover.
      // cityLift raises ground units to the road surface on city hexes.
      const air = drone ? DRONE_AIR_HEIGHT : 0;
      model.position.set(
        wx + up.x * groundLift,
        groundY + up.y * groundLift + air + cityLift,
        wz + up.z * groundLift,
      );

      // Faction-colour ring on the ground under every unit so the tiny models
      // are easy to spot and tell apart by side. Laid flush with the terrain
      // surface (conforms to the slope normal) so it isn't cropped by the
      // hillside — for drones this sits on the ground directly beneath the hover.
      const ringUp = normal.clone().normalize();
      const factionRingGeo = new THREE.RingGeometry(FACTION_RING_RADIUS * 0.75, FACTION_RING_RADIUS, 32);
      const factionRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(fc), transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      const factionRing = new THREE.Mesh(factionRingGeo, factionRingMat);
      // Disable frustum culling — a flat ring's bounding sphere is near-zero
      // height, causing it to be culled as soon as the camera moves away even
      // though the ring is still visible in the distance. The whole point of
      // the ring is to identify units when they're small and far away.
      factionRing.frustumCulled = false;
      // RingGeometry faces +Z; rotate that onto the surface normal so the ring
      // lies on the slope instead of a flat horizontal plane.
      factionRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ringUp);
      factionRing.position.set(
        wx + ringUp.x * 0.02,
        groundY + ringUp.y * 0.02 + cityLift,
        wz + ringUp.z * 0.02,
      );
      group.add(factionRing);
      this.unitGeoms.push(factionRingGeo);
      this.unitMats.push(factionRingMat);

      // Subtle highlight ring under the selected unit. Sized off the hex (not
      // the unit) so the tiny model is still easy to locate. Conforms to the
      // slope like the faction ring.
      if (unit.id === selectedUnitId) {
        const ringGeo = new THREE.RingGeometry(SELECT_RING_RADIUS * 0.8, SELECT_RING_RADIUS, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.frustumCulled = false; // same reason as faction ring above
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ringUp);
        ring.position.set(
          wx + ringUp.x * 0.03,
          groundY + ringUp.y * 0.03,
          wz + ringUp.z * 0.03,
        );
        group.add(ring);
        this.unitGeoms.push(ringGeo);
        this.unitMats.push(ringMat);
      }

      group.add(model);
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) this.unitGeoms.push(mesh.geometry);
      });

      // ── Floating health bar — always visible above every unit ──
      {
        const HP_PER_POINT = 10;
        const maxHp = (unit.attributes.size ?? 1) * HP_PER_POINT;
        const ratio = Math.max(0, Math.min(1, unit.currentHealth / maxHp));

        const barW = 128;
        const barH = 20;
        const barCvs = document.createElement('canvas');
        barCvs.width = barW; barCvs.height = barH;
        const bc = barCvs.getContext('2d')!;

        // Background
        bc.fillStyle = 'rgba(0,0,0,0.7)';
        bc.beginPath();
        bc.roundRect(0, 0, barW, barH, 4);
        bc.fill();

        // Filled portion (green → yellow → red)
        const fillW = Math.round((barW - 4) * ratio);
        if (fillW > 0) {
          if (ratio >= 0.66) {
            bc.fillStyle = '#44dd44';
          } else if (ratio >= 0.33) {
            bc.fillStyle = '#dddd22';
          } else {
            bc.fillStyle = '#ee3322';
          }
          bc.beginPath();
          bc.roundRect(2, 2, fillW, barH - 4, 3);
          bc.fill();
        }

        const barTex = new THREE.CanvasTexture(barCvs);
        const barMat = new THREE.SpriteMaterial({ map: barTex, depthTest: false, transparent: true });
        const barSprite = new THREE.Sprite(barMat);
        const barScale = HEX_WORLD_RADIUS * 0.35 * 0.25;
        // Position just above the model top; drones offset by their air height.
        const modelTop = groundY + groundLift + (drone ? DRONE_AIR_HEIGHT : 0);
        barSprite.scale.set(barScale, barScale * (barH / barW), 1);
        barSprite.position.set(wx, modelTop + barScale * 0.18, wz);
        group.add(barSprite);
        this.unitMats.push(barMat);
      }

      // Unit number label — no background, white text with drop-shadow, below the model
      // (matches the 2D local-map style: white text underneath the unit icon, no box).
      if (getShowEntityNumbers()) {
        const idSuffix = unit.id.replace(/^unit_/, '');
        const labelText = `#${idSuffix}`;
        const cvs = document.createElement('canvas');
        cvs.width = 128; cvs.height = 64;
        const ctx2d = cvs.getContext('2d')!;
        ctx2d.clearRect(0, 0, 128, 64);
        // Drop-shadow pass (1 px offset, semi-transparent black)
        ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
        ctx2d.font = 'bold 36px sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText(labelText, 65, 33);
        // White text
        ctx2d.fillStyle = 'rgba(220,220,220,0.85)';
        ctx2d.fillText(labelText, 64, 32);
        const labelTex = new THREE.CanvasTexture(cvs);
        const labelMat = new THREE.SpriteMaterial({ map: labelTex, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(labelMat);
        const labelScale = HEX_WORLD_RADIUS * 0.35 * 0.25;
        // Position below the model base (groundY), not above the top.
        const labelY = groundY - labelScale * 0.3;
        sprite.scale.set(labelScale, labelScale * 0.5, 1);
        sprite.position.set(wx, labelY, wz);
        group.add(sprite);
        this.unitMats.push(labelMat);
      }
    }
  }

  /**
   * (Re)build a 3D model for every building into the buildings group. Real
   * buildings render solid; planned buildings (the same ones the City Design
   * planner shows as ghosts) render translucent. Buildings are immobile
   * full-segment structures, so they're placed upright at their segment
   * centroid — front facing the segment's outer edge — without slope tilt.
   */
  private rebuildBuildings(): void {
    const scene = this.scene;
    const group = this.buildingsGroup;
    if (!scene || !group) return;

    // Tear down previous models (dispose geometries AND materials).
    for (const child of [...group.children]) group.remove(child);
    for (const g of this.buildingGeoms) {
      try { g.dispose(); } catch { /* best-effort */ }
    }
    this.buildingGeoms = [];
    for (const m of this.buildingMats) {
      try { m.dispose(); } catch { /* best-effort */ }
    }
    this.buildingMats = [];

    const toWorld = this.toWorld;
    const heightOf = this.heightOf;
    const tileById = this.tileById;

    const place = (b: BuildingData, ghost: boolean): void => {
      const ft = tileById.get(b.tileIndex);
      if (!ft) return;

      const attrs = buildingDataToModelAttrs(b);
      const fc = factionColor(this.world, b.ownerId);
      const model = buildBuildingModel(attrs, fc);

      // Scale the structure to a building footprint (much larger than units).
      // Scale from the fixed base-block footprint — NOT the full bounding box —
      // so every building's body reads at the same on-screen size regardless of
      // equipment. Horizontally-protruding gear (gun barrels, anti-air dishes)
      // is then free to extend past the hex fraction instead of shrinking the
      // whole structure to make room for it.
      const s = (HEX_WORLD_RADIUS * BUILDING_HEX_FRACTION) / BUILDING_BASE_FOOTPRINT;
      model.scale.setScalar(s);

      // Sit the base flush on the terrain at the segment centroid, standing
      // upright (buildings don't tilt with the slope the way units do).
      const box2 = new THREE.Box3().setFromObject(model);
      const groundLift = -box2.min.y;
      const cen = segmentCentroid(ft, b.segment);
      const [wx, , wz] = toWorld(cen.x, cen.y);
      const fallbackTop = elevationWorldHeight(this.world.tiles[b.tileIndex], ELEV_WORLD_SCALE);
      // Clamp to the tile plateau so a building on a shore segment (whose outer
      // vertices slope down to the waterline) rests on dry ground instead of
      // sinking. Terrain still slopes; only the building base is lifted.
      const groundY = Math.max(
        sampleSurface(ft, cen.x, cen.y, toWorld, heightOf, fallbackTop).height,
        fallbackTop,
      );

      const dir = facingDirection(ft, b.segment);
      orientToSurface(model, new THREE.Vector3(0, 1, 0), dir);
      model.position.set(wx, groundY + groundLift, wz);

      // Planned buildings render as translucent "ghosts" (mirrors the dashed
      // grey markers the City Design planner draws).
      if (ghost) {
        model.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
          if (mat && 'opacity' in mat) {
            mat.transparent = true;
            mat.opacity = 0.35;
            mat.depthWrite = false;
          }
        });
      }

      group.add(model);
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) this.buildingGeoms.push(mesh.geometry);
        const mat = mesh.material;
        if (Array.isArray(mat)) this.buildingMats.push(...mat);
        else if (mat) this.buildingMats.push(mat as THREE.Material);
      });

      // Building number label — no background, white text with drop-shadow, below the base
      // (matches the 2D local-map style: white text underneath, no box).
      if (!ghost && getShowEntityNumbers()) {
        const bIdSuffix = b.id.replace(/^building_/, '');
        const labelText = `#${bIdSuffix}`;
        const cvs = document.createElement('canvas');
        cvs.width = 128; cvs.height = 64;
        const ctx2d = cvs.getContext('2d')!;
        ctx2d.clearRect(0, 0, 128, 64);
        // Drop-shadow pass
        ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
        ctx2d.font = 'bold 36px sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText(labelText, 65, 33);
        // White text
        ctx2d.fillStyle = 'rgba(220,220,220,0.85)';
        ctx2d.fillText(labelText, 64, 32);
        const labelTex = new THREE.CanvasTexture(cvs);
        const labelMat = new THREE.SpriteMaterial({ map: labelTex, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(labelMat);
        const labelScale = HEX_WORLD_RADIUS * 0.55 * 0.25;
        // Position below the building base (groundY), not above the top.
        sprite.scale.set(labelScale, labelScale * 0.5, 1);
        sprite.position.set(wx, groundY - labelScale * 0.3, wz);
        group.add(sprite);
        this.buildingGeoms.push(); // no geometry to track for the sprite
        this.buildingMats.push(labelMat); // labelTex is owned by labelMat and released with it
      }
    };

    for (const b of this.world.buildings) place(b, false);
    for (const b of this.world.plannedBuildings ?? []) place(b, true);
  }

  /**
   * (Re)build the full-detail 3D Oil Logistics network for every entity in view,
   * into the logistics group. This is where the high-fidelity procedural models
   * (pump-jack wells, distillation-tower refineries, silo hubs, tiered transports)
   * and the road/highway ribbons actually render at unit-model quality — the
   * globe and 2D local map only draw flat markers at their zoom levels.
   *
   * Placement mirrors `rebuildBuildings`: each model is scaled to a hex fraction,
   * seated flush on the sampled terrain surface at its segment/tile centroid, and
   * oriented to face outward. Only entities whose tile is within the current flat
   * view are built (others are clipped). Roads/highways are world-space ribbons
   * threaded through their route's tile-centre path.
   */
  private rebuildLogistics(): void {
    const scene = this.scene;
    const group = this.logisticsGroup;
    if (!scene || !group) return;

    // Tear down previous models (dispose geometries AND materials — fresh per build).
    for (const child of [...group.children]) group.remove(child);
    for (const g of this.logisticsGeoms) {
      try { g.dispose(); } catch { /* best-effort */ }
    }
    this.logisticsGeoms = [];
    for (const m of this.logisticsMats) {
      try { m.dispose(); } catch { /* best-effort */ }
    }
    this.logisticsMats = [];

    const toWorld = this.toWorld;
    const heightOf = this.heightOf;
    const tileById = this.tileById;
    const up = new THREE.Vector3(0, 1, 0);

    /** Track a model's geometries/materials for disposal on the next rebuild/close. */
    const track = (model: THREE.Object3D): void => {
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) this.logisticsGeoms.push(mesh.geometry);
        const mat = (mesh as THREE.Mesh).material;
        if (Array.isArray(mat)) this.logisticsMats.push(...mat);
        else if (mat) this.logisticsMats.push(mat as THREE.Material);
      });
    };

    /** Ground height (clamped to the tile plateau) at a tile-local point. */
    const groundAt = (tileIndex: number, ft: FlatTile, x: number, y: number): number => {
      const fallbackTop = elevationWorldHeight(this.world.tiles[tileIndex], ELEV_WORLD_SCALE);
      return Math.max(sampleSurface(ft, x, y, toWorld, heightOf, fallbackTop).height, fallbackTop);
    };

    /**
     * Scale a freshly-built model so its horizontal footprint fills `fraction`
     * of a hex, seat it on the terrain at (localX, localY) of `ft`, and orient it
     * to `dir`. Returns the placed model (already added to the group + tracked).
     */
    const placeModel = (
      model: THREE.Group,
      tileIndex: number,
      ft: FlatTile,
      localX: number,
      localY: number,
      dir: { x: number; z: number },
      fraction: number,
    ): void => {
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const footprint = Math.max(size.x, size.z) || 1;
      model.scale.setScalar((HEX_WORLD_RADIUS * fraction) / footprint);

      const box2 = new THREE.Box3().setFromObject(model);
      const groundLift = -box2.min.y;
      const [wx, , wz] = toWorld(localX, localY);
      const groundY = groundAt(tileIndex, ft, localX, localY);
      orientToSurface(model, up, dir);
      model.position.set(wx, groundY + groundLift, wz);
      group.add(model);
      track(model);
    };

    const logistics = this.world.logistics;

    // ── Oil-deposit markers (visible pre-drill) on 'oil' tiles in view ──
    for (const ft of this.flatTiles) {
      const tile = this.world.tiles[ft.tileIndex] as TileData | undefined;
      if (!tile || tile.resourceType !== 'oil') continue;
      // Skip if a well already sits on this tile (the derrick supersedes the marker).
      if (logistics?.wells?.some((w) => w.tileIndex === ft.tileIndex)) continue;
      const r = HEX_WORLD_RADIUS * 0.28;
      const geo = new THREE.CylinderGeometry(r, r * 1.1, r * 0.12, 20);
      const mat = new THREE.MeshStandardMaterial({ color: 0x0e0b08, roughness: 0.35, metalness: 0.5, emissive: 0x120d06 });
      const disc = new THREE.Mesh(geo, mat);
      const [wx, , wz] = toWorld(ft.cx, ft.cy);
      disc.position.set(wx, groundAt(ft.tileIndex, ft, ft.cx, ft.cy) + r * 0.06, wz);
      group.add(disc);
      this.logisticsGeoms.push(geo);
      this.logisticsMats.push(mat);
    }

    if (!logistics) return;

    // ── Routes: road / highway ribbons threaded through tile centres ──
    for (const route of logistics.routes ?? []) {
      const pts: THREE.Vector3[] = [];
      for (const idx of route.segments) {
        const ft = tileById.get(idx);
        if (!ft) continue; // tile outside the flat view — clip
        const [wx, , wz] = toWorld(ft.cx, ft.cy);
        pts.push(new THREE.Vector3(wx, groundAt(idx, ft, ft.cx, ft.cy), wz));
      }
      if (pts.length < 2) continue;
      const width = HEX_WORLD_RADIUS * 0.32;
      const lift = roadSurfaceLift(HEX_WORLD_RADIUS);
      const ribbon =
        route.tier === 'highway'
          ? buildHighwayMesh(pts, { width, lift })
          : buildRoadMesh(pts, { width, lift });
      if (route.operable === false) {
        ribbon.traverse((obj) => {
          const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (mat && 'opacity' in mat) { mat.transparent = true; mat.opacity = 0.4; }
        });
      }
      group.add(ribbon);
      track(ribbon);
    }

    // ── Static structures (wells / refineries / hubs) ──
    for (const refinery of logistics.refineries ?? []) {
      const ft = tileById.get(refinery.tileIndex);
      if (!ft) continue;
      const model = buildLogisticsModel('refinery', factionColor(this.world, refinery.ownerId), {
        segmentCount: Math.max(1, refinery.segments?.length ?? 1),
      });
      placeModel(model, refinery.tileIndex, ft, ft.cx, ft.cy, facingDirection(ft, 0), 1.4);
    }
    for (const hub of logistics.hubs ?? []) {
      const ft = tileById.get(hub.tileIndex);
      if (!ft) continue;
      const cen = segmentCentroid(ft, hub.segment);
      const model = buildLogisticsModel('hub', factionColor(this.world, hub.ownerId));
      placeModel(model, hub.tileIndex, ft, cen.x, cen.y, facingDirection(ft, hub.segment), 0.9);
    }
    for (const well of logistics.wells ?? []) {
      const ft = tileById.get(well.tileIndex);
      if (!ft) continue;
      const cen = segmentCentroid(ft, well.segment);
      const model = buildLogisticsModel('well', factionColor(this.world, well.ownerId));
      placeModel(model, well.tileIndex, ft, cen.x, cen.y, facingDirection(ft, well.segment), 0.8);
    }

    // ── Transports: placed at their current point along the assigned route ──
    const routeById = new Map(logistics.routes?.map((r) => [r.id, r]) ?? []);
    for (const transport of logistics.transports ?? []) {
      const route = routeById.get(transport.routeId);
      if (!route) continue;
      // World-space route path (in-view tiles only).
      const path: Array<{ tileIndex: number; ft: FlatTile; x: number; y: number }> = [];
      for (const idx of route.segments) {
        const ft = tileById.get(idx);
        if (ft) path.push({ tileIndex: idx, ft, x: ft.cx, y: ft.cy });
      }
      if (path.length === 0) continue;
      // Progress 0..1 from the turn countdown (0 at source when idle/just dispatched).
      const travel = Math.max(1, route.travelTime || 1);
      const progress = transport.inTransit
        ? Math.max(0, Math.min(1, (travel - transport.turnsRemaining) / travel))
        : 0;
      const fpos = progress * (path.length - 1);
      const i0 = Math.floor(fpos);
      const i1 = Math.min(path.length - 1, i0 + 1);
      const t = fpos - i0;
      const a = path[i0];
      const b = path[i1];
      const lx = a.x + (b.x - a.x) * t;
      const ly = a.y + (b.y - a.y) * t;
      const dir = i0 === i1 ? facingDirection(a.ft, 0) : { x: b.x - a.x, z: -(b.y - a.y) };
      const model = buildTransportModel(transport.tier, factionColor(this.world, transport.ownerId));
      placeModel(model, a.tileIndex, a.ft, lx, ly, dir, 0.55);
    }
  }

  /**
   * Scatter simple 3D trees across every forested hex currently in view. This is
   * the first-person echo of the 2D map's forest tree icons
   * (terrainFeatures.drawForestCornerTrees): a low-poly trunk + conical canopy,
   * drawn with two InstancedMeshes (one per part) for performance. Placement is
   * driven by a per-tile seeded RNG so a given forest looks identical each time
   * the view is opened. Trees are static scenery — built once on open() and torn
   * down with the rest of the scene on close() (geometry/material pushed onto
   * `disposables`).
   */
  private buildTrees(): void {
    const scene = this.scene;
    if (!scene) return;

    const toWorld = this.toWorld;
    const heightOf = this.heightOf;

    // Gather an upright world-space placement for every tree first, so we can
    // size the InstancedMeshes exactly. `round` mixes spherical canopies in
    // among the cones for a more varied treeline.
    const placements: Array<{ x: number; y: number; z: number; yaw: number; scale: number; round: boolean }> = [];
    for (const ft of this.flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      if (!tile.f) continue; // forested hexes only
      const n = ft.poly.length;
      const rand = mulberry32((ft.tileIndex * 0x9e3779b1) >>> 0);
      const fallbackTop = elevationWorldHeight(tile, ELEV_WORLD_SCALE);

      for (let t = 0; t < TREES_PER_HEX; t++) {
        // Random point inside the hex: pick a fan triangle (centre → edge) then
        // a uniform barycentric point within it.
        const seg = Math.min(n - 1, Math.floor(rand() * n));
        const v0 = ft.poly[seg];
        const v1 = ft.poly[(seg + 1) % n];
        let a = rand(), b = rand();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const px = ft.cx + a * (v0.x - ft.cx) + b * (v1.x - ft.cx);
        const py = ft.cy + a * (v0.y - ft.cy) + b * (v1.y - ft.cy);
        const [wx, , wz] = toWorld(px, py);
        const { height } = sampleSurface(ft, px, py, toWorld, heightOf, fallbackTop);
        placements.push({
          x: wx, y: height, z: wz,
          yaw: rand() * Math.PI * 2,
          scale: 0.7 + rand() * 0.6,
          round: rand() < 0.4, // ~40% rounded (deciduous) canopies, rest conical
        });
      }
    }
    if (placements.length === 0) return;

    // Tree parts, pre-translated in local Y so the trunk base sits at y=0 and
    // the canopy stacks above it. Sharing one matrix per instance across the
    // trunk + canopy meshes keeps each canopy locked to its trunk.
    const treeH = HEX_WORLD_RADIUS * TREE_HEX_FRACTION;
    const trunkH = treeH * 0.4;
    const coneH = treeH * 0.85;
    const sphereR = treeH * 0.32;

    const trunkGeo = new THREE.CylinderGeometry(treeH * 0.04, treeH * 0.06, trunkH, 6);
    trunkGeo.translate(0, trunkH / 2, 0);
    const coneGeo = new THREE.ConeGeometry(treeH * 0.28, coneH, 7);
    coneGeo.translate(0, trunkH + coneH / 2, 0);
    const sphereGeo = new THREE.SphereGeometry(sphereR, 8, 6);
    sphereGeo.translate(0, trunkH + sphereR * 0.85, 0);

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.95, metalness: 0 });
    const coneMat = new THREE.MeshStandardMaterial({ color: 0x2f6a24, roughness: 0.9, metalness: 0 });
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x4f8a32, roughness: 0.9, metalness: 0 });

    const coneCount = placements.filter((p) => !p.round).length;
    const sphereCount = placements.length - coneCount;
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, placements.length);
    const coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, coneCount);
    const sphereMesh = new THREE.InstancedMesh(sphereGeo, sphereMat, sphereCount);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let ci = 0, si = 0;
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      q.setFromAxisAngle(up, p.yaw);
      pos.set(p.x, p.y, p.z);
      scl.setScalar(p.scale);
      m.compose(pos, q, scl);
      trunkMesh.setMatrixAt(i, m);
      if (p.round) sphereMesh.setMatrixAt(si++, m);
      else coneMesh.setMatrixAt(ci++, m);
    }
    trunkMesh.instanceMatrix.needsUpdate = true;
    coneMesh.instanceMatrix.needsUpdate = true;
    sphereMesh.instanceMatrix.needsUpdate = true;

    scene.add(trunkMesh, coneMesh, sphereMesh);
    this.disposables.push(
      trunkMesh, coneMesh, sphereMesh,
      trunkGeo, coneGeo, sphereGeo,
      trunkMat, coneMat, sphereMat,
    );
  }

  // ─── Command interaction (select / move / attack / repair) ──────────────────

  /** Remaining movement points for a unit (0 when no command context wired). */
  private remainingMP(unitId: string): number {
    return this.cmd ? (this.cmd.turnManager.movementPoints.get(unitId) ?? 0) : 0;
  }

  /** Raycast a screen point to a tile + hex segment, or null if it missed terrain. */
  private pickTileSegment(clientX: number, clientY: number): { tileIndex: number; segment: number } | null {
    if (!this.camera || !this.canvas || this.pickMeshes.length === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickMeshes, false);
    if (hits.length === 0) return null;

    // Invert the projection: world (x, _, z) → flat (px, py).
    const p = hits[0].point;
    const px = p.x / this.projScale;
    const py = -p.z / this.projScale;

    for (const ft of this.flatTiles) {
      if (pointInPoly(px, py, ft.poly)) {
        return { tileIndex: ft.tileIndex, segment: this.segmentAtFlat(ft, px, py) };
      }
    }
    return null;
  }

  /** Which hex sub-triangle (segment) of a tile contains a flat-space point. */
  private segmentAtFlat(ft: FlatTile, px: number, py: number): number {
    const n = ft.poly.length;
    const a = { x: ft.cx, y: ft.cy };
    for (let s = 0; s < n; s++) {
      const w = baryWeights(px, py, a, ft.poly[s], ft.poly[(s + 1) % n]);
      if (w && w[0] >= -1e-6 && w[1] >= -1e-6 && w[2] >= -1e-6) return s;
    }
    return 0;
  }

  /** Select an own-faction unit by id: compute its range and refresh overlays. */
  private selectUnit(unitId: string): void {
    const unit = this.world.units.find((u) => u.id === unitId);
    this.selectedUnitId = unit ? unitId : null;
    this.rangeResult = null;
    if (unit) {
      const mp = this.remainingMP(unitId);
      if (mp > 0) this.rangeResult = computeMovementRange(this.world, unit, mp);
    }
    this.rebuildUnits();
    this.rebuildRangeOverlay();
    this.clearRouteOverlay();
  }

  /** Left-click: select the own-faction unit under the cursor, else deselect. */
  private handleLeftClick(clientX: number, clientY: number): void {
    if (!this.cmd) return;
    const pick = this.pickTileSegment(clientX, clientY);
    if (!pick) return;
    const faction = this.cmd.getActiveFaction();
    const unit = this.world.units.find(
      (u) => u.tileIndex === pick.tileIndex && u.segment === pick.segment && u.ownerId === faction,
    ) ?? this.world.units.find((u) => u.tileIndex === pick.tileIndex && u.ownerId === faction);
    if (unit) {
      this.selectUnit(unit.id);
    } else {
      // [BLDG-DBG] If a building occupies the clicked segment, log its placement data.
      const bldg = this.world.buildings.find(
        (b) => b.tileIndex === pick.tileIndex && b.segment === pick.segment,
      );
      if (bldg) {
        const bIdx = this.world.buildings.indexOf(bldg);
        const ft = this.tileById.get(bldg.tileIndex);
        const dbgTile = this.world.tiles[bldg.tileIndex];
        const fallbackTopDbg = elevationWorldHeight(dbgTile, ELEV_WORLD_SCALE);
        if (ft) {
          const cen = segmentCentroid(ft, bldg.segment);
          const { height: groundY } = sampleSurface(ft, cen.x, cen.y, this.toWorld, this.heightOf, fallbackTopDbg);
          const sampleHitFallback = Math.abs(groundY - fallbackTopDbg) < 1e-4;
          console.log(
            `[BLDG-POS] #${bIdx} id=${bldg.id} tile=${bldg.tileIndex} seg=${bldg.segment}` +
            ` h=${dbgTile?.h ?? 0}` +
            ` ss[seg]=${dbgTile?.ss?.[bldg.segment]?.toFixed(3) ?? 'n/a'}` +
            ` fallbackTop=${fallbackTopDbg.toFixed(3)}` +
            ` groundY=${groundY.toFixed(3)}` +
            ` sampleHitFallback=${sampleHitFallback}`,
          );
          // Dump heights of every polygon vertex so we can see which one is dragging groundY down.
          const n = ft.poly.length;
          for (let i = 0; i < n; i++) {
            const vp = ft.poly[i];
            const vh = this.heightOf(ft.tileIndex, vp);
            const vTile = this.world.tiles.find(t => t.idx === ft.tileIndex);
            console.log(
              `[BLDG-VERT] tile=${ft.tileIndex} vert=${i}` +
              ` pos=(${vp.x.toFixed(3)},${vp.y.toFixed(3)})` +
              ` height=${vh.toFixed(3)}` +
              ` inSeg=${i === bldg.segment || i === (bldg.segment + 1) % n ? 'YES' : 'no'}`,
            );
          }
          // Also log the segment's three triangle vertices (centre + two edge verts).
          const va = ft.poly[bldg.segment % n];
          const vb = ft.poly[(bldg.segment + 1) % n];
          const hCen = this.heightOf(ft.tileIndex, { x: ft.cx, y: ft.cy });
          const hA   = this.heightOf(ft.tileIndex, va);
          const hB   = this.heightOf(ft.tileIndex, vb);
          console.log(
            `[BLDG-TRI] seg=${bldg.segment}` +
            ` centre=(${ft.cx.toFixed(3)},${ft.cy.toFixed(3)}) h=${hCen.toFixed(3)}` +
            ` vA=(${va.x.toFixed(3)},${va.y.toFixed(3)}) h=${hA.toFixed(3)}` +
            ` vB=(${vb.x.toFixed(3)},${vb.y.toFixed(3)}) h=${hB.toFixed(3)}`,
          );
          for (let ni = 0; ni < (dbgTile.n?.length ?? 0); ni++) {
            const nIdx = dbgTile.n[ni];
            const nTile = this.world.tiles[nIdx];
            if (nTile) {
              console.log(
                `[BLDG-NBR] neighbour[${ni}]=${nIdx}` +
                ` terrain=${nTile.terrain}` +
                ` h=${nTile.h ?? 0}` +
                ` elevH=${elevationWorldHeight(nTile, ELEV_WORLD_SCALE).toFixed(3)}`,
              );
            }
          }
        }
      }
      this.selectedUnitId = null;
      this.rangeResult = null;
      this.rebuildUnits();
      this.rebuildRangeOverlay();
      this.clearRouteOverlay();
    }
  }

  /**
   * Right-click command dispatcher — mirrors the priority order of the 2D map's
   * onRightClick: attack → repair → move. Uses the shared TurnManager so MP and
   * acted-unit state stay consistent across both views.
   */
  private handleCommand(clientX: number, clientY: number): void {
    if (!this.cmd || !this.selectedUnitId) return;
    const unit = this.world.units.find((u) => u.id === this.selectedUnitId);
    if (!unit) return;

    const pick = this.pickTileSegment(clientX, clientY);
    if (!pick) return;
    const { tileIndex: targetTile, segment: targetSegment } = pick;

    // --- Context menu: right-click on the selected unit's own segment ---
    if (targetTile === unit.tileIndex && targetSegment === unit.segment) {
      this.showContextMenu(clientX, clientY, unit);
      return;
    }

    const targetTileData = this.world.tiles[targetTile];
    const tm = this.cmd.turnManager;
    const units = this.world.units;
    const playerOwner = unit.ownerId;

    // --- Attack ---
    const enemyTarget =
      units.find((u) => u.tileIndex === targetTile && u.segment === targetSegment && u.ownerId !== playerOwner) ??
      units.find((u) => u.tileIndex === targetTile && u.ownerId !== playerOwner);

    if (enemyTarget) {
      const canAct = (tm.movementPoints.get(unit.id) ?? 0) >= 1 && !tm.actedUnits.has(unit.id);
      if (!canAct) return;
      if (!isInWeaponRange(this.world.tiles, unit, enemyTarget)) return;
      tm.actedUnits.add(unit.id);
      tm.movementPoints.set(unit.id, Math.max(0, (tm.movementPoints.get(unit.id) ?? 0) - 1));
      this.cmd.onAttack(unit.id, enemyTarget.id);
      // MP changed — refresh range; main calls refresh() once the attack resolves.
      this.selectUnit(unit.id);
      this.cmd.onCommit();
      return;
    }

    // --- Repair (friendly damaged unit in the same hex) ---
    const repairCapable = (unit.attributes.repair ?? 0) >= 1;
    if (repairCapable && (tm.movementPoints.get(unit.id) ?? 0) > 0 && !tm.actedUnits.has(unit.id)) {
      const maxHp = (target: UnitData) => (target.attributes.size ?? 1) * 10;
      const friendly =
        units.find((u) => u.tileIndex === targetTile && u.segment === targetSegment && u.ownerId === playerOwner && u.id !== unit.id && u.currentHealth < maxHp(u)) ??
        units.find((u) => u.tileIndex === targetTile && u.ownerId === playerOwner && u.id !== unit.id && u.currentHealth < maxHp(u));
      if (friendly && unit.tileIndex === friendly.tileIndex) {
        tm.actedUnits.add(unit.id);
        tm.movementPoints.set(unit.id, Math.max(0, (tm.movementPoints.get(unit.id) ?? 0) - 1));
        this.cmd.onRepair(unit.id, friendly.id);
        this.selectUnit(unit.id);
        this.cmd.onCommit();
        return;
      }
    }

    // --- Move ---
    this.commitMove(unit, targetTile, targetSegment);
  }

  /**
   * Commit a move using the exact pathing the hover preview shows
   * (computeMovementRouteForDestination + extractMovePlan). Mirrors the 2D map's
   * move-commit block. Returns true if the unit moved.
   */
  private commitMove(unit: UnitData, targetTile: number, targetSegment: number): boolean {
    if (!this.cmd || !this.rangeResult) return false;
    const remaining = this.remainingMP(unit.id);
    if (remaining <= 0) return false;

    const targetTileData = this.world.tiles[targetTile];
    if (
      isImpassableTerrain(targetTileData.terrain) &&
      !targetTileData.bridge &&
      getMovementMode(unit.attributes) !== 'flight'
    ) {
      return false;
    }

    const preferredSegment = targetSegment >= 0 ? targetSegment : unit.segment;
    const route = computeMovementRouteForDestination(
      this.world, unit, targetTile, preferredSegment, remaining, this.rangeResult,
    );
    const plan = extractMovePlan(route, this.world.tiles);
    if (!plan) return false;
    if (plan.destTile === unit.tileIndex && plan.destSegment === unit.segment) return false;

    const units = this.world.units;
    const existingAtDest = units.filter((u) => u.tileIndex === plan.destTile && u.id !== unit.id);
    if (plan.destTile !== unit.tileIndex && existingAtDest.length >= 5) return false;

    const occupied = new Set<number>(existingAtDest.map((u) => u.segment));
    const free = findPreferredSegment(plan.destSegment, occupied);
    if (free < 0) return false;

    const travelFacing = (plan.facing ?? unit.facing) as 0 | 1 | 2 | 3 | 4 | 5;
    unit.tileIndex = plan.destTile;
    unit.segment = free as 0 | 1 | 2 | 3 | 4 | 5;
    unit.facing = travelFacing;
    this.cmd.turnManager.movementPoints.set(unit.id, Math.max(0, remaining - plan.mpCost));

    // Recompute range from the new position + refresh overlays/models.
    this.selectUnit(unit.id);
    this.cmd.onCommit();
    return true;
  }

  /** Hover preview — recompute and draw the route line to the hovered tile. */
  private handleHover(clientX: number, clientY: number): void {
    if (!this.cmd || !this.selectedUnitId || !this.rangeResult) {
      this.clearRouteOverlay();
      return;
    }
    const unit = this.world.units.find((u) => u.id === this.selectedUnitId);
    if (!unit) { this.clearRouteOverlay(); return; }
    const remaining = this.remainingMP(unit.id);
    if (remaining <= 0) { this.clearRouteOverlay(); return; }

    const pick = this.pickTileSegment(clientX, clientY);
    if (!pick) { this.clearRouteOverlay(); return; }
    const seg = pick.segment >= 0 ? pick.segment : 0;
    if (pick.tileIndex === unit.tileIndex && seg === unit.segment) { this.clearRouteOverlay(); return; }

    const enemy = this.world.units.find(
      (u) => u.tileIndex === pick.tileIndex && u.segment === seg && u.ownerId !== unit.ownerId,
    );
    const route = enemy
      ? computeContextualAttackRoute(
          this.world, unit, pick.tileIndex, seg, remaining,
          weaponRangeInTileHops(unit.attributes), this.rangeResult,
        )
      : computeMovementRouteForDestination(
          this.world, unit, pick.tileIndex, seg, remaining, this.rangeResult,
        );
    this.rebuildRouteOverlay(route);
  }

  /**
   * Charge the once-per-turn rotation fee for a facing change. Returns true if
   * the rotation is allowed (already paid this turn, or paid now). Mirrors
   * MapInputHandler.chargeRotation against the shared TurnManager.
   */
  private chargeRotation(unitId: string): boolean {
    if (!this.cmd) return false;
    const tm = this.cmd.turnManager;
    if (tm.rotatedUnits.has(unitId)) return true;
    const remaining = tm.movementPoints.get(unitId) ?? 0;
    if (remaining < ROTATION_FEE) return false;
    tm.movementPoints.set(unitId, remaining - ROTATION_FEE);
    tm.rotatedUnits.add(unitId);
    return true;
  }

  /**
   * Arrow-key rotation for the selected unit:
   *  · ←/→        rotate facing one step (charges the once-per-turn fee)
   *  · Shift+←/→  shift the unit to the adjacent hex segment (free re-position)
   *  · ↑          reset facing to neighbour index 0 (charges the fee)
   * Returns true if it handled the key.
   */
  private handleRotateKey(e: KeyboardEvent): boolean {
    if (!this.cmd || !this.selectedUnitId) return false;
    const unit = this.world.units.find((u) => u.id === this.selectedUnitId);
    if (!unit) return false;

    if (e.key === 'ArrowUp') {
      if (unit.facing !== 0 && this.chargeRotation(unit.id)) {
        unit.facing = 0;
        this.selectUnit(unit.id);
      }
      return true;
    }

    const direction = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) {
      // Re-position within the hex (segment change) — free, like the 2D map.
      unit.segment = rotateHexIndex(unit.segment, direction);
      this.selectUnit(unit.id);
    } else if (this.chargeRotation(unit.id)) {
      unit.facing = rotateHexIndex(unit.facing, direction);
      this.selectUnit(unit.id);
    }
    return true;
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
      chargeRotation: (id) => this.chargeRotation(id),
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
        onSleepUnit: (id) => cmd.onSleep(id),
        onViewUnit: null,
      },
    });
  }

  // ─── 3D command overlays ────────────────────────────────────────────────────

  /** Lift a flat-space point onto the rendered terrain surface (+ epsilon). */
  private liftFlat(ft: FlatTile, x: number, y: number, eps = 0.12): THREE.Vector3 {
    const [wx, , wz] = this.toWorld(x, y);
    const top = elevationWorldHeight(this.world.tiles[ft.tileIndex], ELEV_WORLD_SCALE);
    const h = sampleSurface(ft, x, y, this.toWorld, this.heightOf, top).height;
    return new THREE.Vector3(wx, h + eps, wz);
  }

  /** Translucent fill of one hex segment triangle (centre, vertex s, vertex s+1). */
  private addSegmentFill(group: THREE.Group, ft: FlatTile, seg: number, color: number, opacity: number): void {
    const n = ft.poly.length;
    const a = this.liftFlat(ft, ft.cx, ft.cy);
    const b = this.liftFlat(ft, ft.poly[seg % n].x, ft.poly[seg % n].y);
    const c = this.liftFlat(ft, ft.poly[(seg + 1) % n].x, ft.poly[(seg + 1) % n].y);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]), 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    group.add(new THREE.Mesh(geo, mat));
  }

  /** Rebuild the movement-range fill overlay from the current range result. */
  private rebuildRangeOverlay(): void {
    const group = this.rangeGroup;
    if (!group) return;
    this.clearGroup(group);
    const rr = this.rangeResult;
    if (!rr) return;

    for (const [key, zone] of rr.reachableSegments) {
      const ft = this.tileById.get(Math.floor(key / 6));
      if (!ft) continue;
      this.addSegmentFill(group, ft, key % 6, zone === 'attackReady' ? 0x33dd66 : 0x4488ff, 0.22);
    }
    // Static weapon-range segments (attack without moving) — red, where not already a move tint.
    for (const key of rr.staticAttackSegments) {
      if (rr.reachableSegments.has(key)) continue;
      const ft = this.tileById.get(Math.floor(key / 6));
      if (!ft) continue;
      this.addSegmentFill(group, ft, key % 6, 0xff4444, 0.18);
    }
  }

  private zoneColor(zone?: string): number {
    if (zone === 'attackReady') return 0x33dd66;
    if (zone === 'weaponRange') return 0xff4444;
    return 0x4488ff; // moveOnly / default
  }

  /** Centroid of a tile segment lifted onto the terrain surface (route height). */
  private centroidLift(tileIndex: number, segment: number): THREE.Vector3 | null {
    const ft = this.tileById.get(tileIndex);
    if (!ft) return null;
    const cen = segmentCentroid(ft, segment);
    return this.liftFlat(ft, cen.x, cen.y, 0.28);
  }

  /** Rebuild the hover route line, colouring each hop by its zone. */
  private rebuildRouteOverlay(route: MovementCostRoute | null): void {
    const group = this.routeGroup;
    if (!group) return;
    this.clearGroup(group);
    if (!route) return;

    let prev = this.centroidLift(route.startTile, route.startSegment);
    for (const hop of route.hops) {
      const cur = this.centroidLift(hop.tileIndex, hop.segment);
      if (prev && cur) {
        const geo = new THREE.BufferGeometry().setFromPoints([prev, cur]);
        const mat = new THREE.LineBasicMaterial({ color: this.zoneColor(hop.zone) });
        group.add(new THREE.Line(geo, mat));
      }
      prev = cur ?? prev;
    }
  }

  private clearRouteOverlay(): void {
    this.clearGroup(this.routeGroup);
  }

  /** Remove all children of an overlay group, disposing their geometry + material. */
  private clearGroup(group: THREE.Group | null): void {
    if (!group) return;
    for (const child of [...group.children]) {
      const obj = child as THREE.Mesh | THREE.Line;
      obj.geometry?.dispose();
      const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
      group.remove(child);
    }
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
        ? this.shoulderWorldPos(this.selectedUnitId)
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
          this.aimAt(shoulder);
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
      this.handleLeftClick(e.clientX, e.clientY);
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    this.handleCommand(e.clientX, e.clientY);
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
      if (this.active) this.handleHover(this.hoverX, this.hoverY);
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
    if (this.effects.length > 0) this.updateEffects();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Advance all active combat effects, disposing any that have finished. */
  private updateEffects(): void {
    const now = performance.now();
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].update(now)) {
        this.effects[i].dispose();
        this.effects.splice(i, 1);
      }
    }
  }
}

// ─── Pure geometry helpers (flat-view projected coords) ───────────────────────

/** A combat effect (missile / explosion) ticked each render frame.
 *  `update` returns false once finished, signalling the loop to dispose it. */
interface ActiveEffect {
  update(nowMs: number): boolean;
  dispose(): void;
}

/** Smooth ease used by the missile arc (mirrors combatAnimations.ts). */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** A drone is any unit with at least one point of flight movement. */
function isDrone(unit: UnitData): boolean {
  return (unit.attributes.flightMovement ?? 0) >= 1;
}

/**
 * Tiny deterministic PRNG (mulberry32). Seeded per forested tile so each
 * forest's tree scatter is stable across repeated open/close cycles.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Centroid of a hex segment (triangle: centre, vertex s, vertex s+1) in flat coords. */
function segmentCentroid(ft: FlatTile, segment: number): { x: number; y: number } {
  const n = ft.poly.length;
  const v0 = ft.poly[segment % n];
  const v1 = ft.poly[(segment + 1) % n];
  return { x: (ft.cx + v0.x + v1.x) / 3, y: (ft.cy + v0.y + v1.y) / 3 };
}

/**
 * World-space (X, Z) direction a unit faces, derived from the midpoint of its
 * faced boundary edge in the flat projection. Mapping: (px, py) → (px, -py).
 */
function facingDirection(ft: FlatTile, facing: number): { x: number; z: number } {
  const n = ft.poly.length;
  const v0 = ft.poly[facing % n];
  const v1 = ft.poly[(facing + 1) % n];
  const ex = (v0.x + v1.x) / 2 - ft.cx;
  const ey = (v0.y + v1.y) / 2 - ft.cy;
  const len = Math.sqrt(ex * ex + ey * ey) || 1;
  return { x: ex / len, z: -ey / len };
}

/**
 * Barycentric weights of point (px,py) within triangle a-b-c (flat coords).
 * Returns [wa, wb, wc] or null for a degenerate triangle. Weights are invariant
 * under the uniform scale + y-flip of `toWorld`, so they're computed in flat
 * space and reused to interpolate world-space heights.
 */
function baryWeights(
  px: number, py: number,
  a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number },
): [number, number, number] | null {
  const v0x = b.x - a.x, v0y = b.y - a.y;
  const v1x = c.x - a.x, v1y = c.y - a.y;
  const v2x = px - a.x, v2y = py - a.y;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-12) return null;
  const wb = (v2x * v1y - v1x * v2y) / den;
  const wc = (v0x * v2y - v2x * v0y) / den;
  return [1 - wb - wc, wb, wc];
}

/**
 * Sample the rendered hex-top surface at a flat-view point. The top is drawn as
 * a triangle fan from poly[0] using the shared (neighbour-averaged) vertex
 * heights, so this finds the fan triangle containing (px,py), returns the
 * barycentric-interpolated world height, and the triangle's upward normal (so
 * units can be tilted to match the slope they're standing on). Falls back to the
 * tile's flat plateau height with a straight-up normal if no triangle matches.
 */
function sampleSurface(
  ft: FlatTile,
  px: number, py: number,
  toWorld: (px: number, py: number) => [number, number, number],
  heightOf: (tileIndex: number, p: { x: number; y: number }) => number,
  fallback: number,
): { height: number; normal: THREE.Vector3 } {
  const n = ft.poly.length;
  const h = (p: { x: number; y: number }): number => heightOf(ft.tileIndex, p);
  const lift = (p: { x: number; y: number }): THREE.Vector3 => {
    const [wx, , wz] = toWorld(p.x, p.y);
    return new THREE.Vector3(wx, h(p), wz);
  };
  for (let i = 1; i < n - 1; i++) {
    const a = ft.poly[0], b = ft.poly[i], c = ft.poly[i + 1];
    const bary = baryWeights(px, py, a, b, c);
    if (!bary) continue;
    const [wa, wb, wc] = bary;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
    const height = wa * h(a) + wb * h(b) + wc * h(c);
    const pa = lift(a), pb = lift(b), pc = lift(c);
    const normal = new THREE.Vector3()
      .subVectors(pb, pa)
      .cross(new THREE.Vector3().subVectors(pc, pa))
      .normalize();
    if (normal.y < 0) normal.negate();
    return { height, normal };
  }
  return { height: fallback, normal: new THREE.Vector3(0, 1, 0) };
}

/**
 * Orient `model` so its up axis (+Y) aligns with the surface normal `up` and its
 * front (-Z) points along the horizontal facing direction `dir`, projected onto
 * the surface's tangent plane. On flat ground this reduces to a plain yaw; on a
 * slope it tilts the model to lie flush with the terrain.
 */
function orientToSurface(model: THREE.Object3D, up: THREE.Vector3, dir: { x: number; z: number }): void {
  const y = up.clone().normalize();
  // Local +Z = backward; tangent it onto the surface so the model lies flush.
  const z = new THREE.Vector3(-dir.x, 0, -dir.z);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-9) z.set(0, 0, 1); // facing parallel to normal — pick any tangent
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
