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
import type { WorldData, UnitData, TileData } from './worldData.js';
import { buildFlatView, FlatTile, pointInPoly } from './localMapProjection.js';
import {
  tileHeight,
  HEIGHT_LEVELS,
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
import { tileColorRGB, factionColor } from './colors.js';
import { TerrainTextures } from './terrainTextures.js';
import { dbg } from './debug.js';

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

import oceanUrl from '../artifacts/ocean.webp';
import grassUrl from '../artifacts/grass.webp';
import plainsUrl from '../artifacts/plains.webp';
import desertUrl from '../artifacts/desert.webp';
import tundraUrl from '../artifacts/tundra.webp';
import hillsUrl from '../artifacts/hills.webp';
import hillsPlainsUrl from '../artifacts/HillsPlains.webp';
import mountainUrl from '../artifacts/mountain.webp';

/** Texture key → source URL, mirroring TerrainTextures.SOURCES so the 3D view shares the same artwork. */
const TEXTURE_SOURCES: Record<string, string> = {
  ocean: oceanUrl,
  grassland: grassUrl,
  plains: plainsUrl,
  desert: desertUrl,
  tundra: tundraUrl,
  hills: hillsUrl,
  hillsPlains: hillsPlainsUrl,
  mountain: mountainUrl,
};

/**
 * How many hex rings around the unit to render as the visible environment.
 * The 20v20 battle spans ~8 BFS layers seed-to-seed, so this is sized to keep
 * both armies in view from either end of the field.
 */
const VIEW_RADIUS = 12;

/** Target on-screen radius (world units) for a hex — drives the projection scale. */
const HEX_WORLD_RADIUS = 6;

/**
 * World-space vertical scale for terrain elevation. The shared elevation height
 * scale (see terrainContext.elevationHeight) runs 0 (flat) → 1 (mountain), so a
 * mountain rises ELEV_WORLD_SCALE world units above flat ground.
 */
const ELEV_WORLD_SCALE = HEX_WORLD_RADIUS * 2.2;

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

/** Forward/back travel per wheel notch (world units) when zooming. */
const BOOM_STEP = BOOM_MAX / 90;

/**
 * Pan distance per pixel of drag, per world unit of altitude. Scaling by height
 * keeps panning slow and precise at ground level yet fast enough to cross the
 * field when zoomed out for an overview.
 */
const PAN_FACTOR = 0.0016;

/** Hover altitude (world units) for drone models — they float above the terrain. */
const DRONE_AIR_HEIGHT = HEX_WORLD_RADIUS * 0.5;

/**
 * Unit model footprint as a fraction of a hex radius. Units are deliberately
 * tiny relative to the terrain (a tank is a handful of metres; a hex now reads
 * as a swathe of ground hundreds of metres across, with a formation spread out
 * inside it). Bump this to make units larger.
 */
const UNIT_HEX_FRACTION = 0.055;

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
  private terrainTextures: Map<string, THREE.Texture> | null = null;
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
  private heightOf: (p: { x: number; y: number }) => number = () => 0;

  /** Terrain top meshes — raycast targets for click picking. */
  private pickMeshes: THREE.Mesh[] = [];
  /** Group holding all unit models + selection ring (rebuilt after a command). */
  private unitsGroup: THREE.Group | null = null;
  /** Geometries owned by the units group (disposed on rebuild/close). */
  private unitGeoms: THREE.BufferGeometry[] = [];
  /** Unique materials owned by the units group (selection rings) — disposed on rebuild/close. */
  private unitMats: THREE.Material[] = [];
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

    // Rotation / re-positioning of the selected unit (mirrors the 2D map).
    if (this.contextMenuOpen) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      if (this.handleRotateKey(e)) e.preventDefault();
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
    const fallbackTop = elevationWorldHeight(this.world.tiles[unit.tileIndex]);
    const { height: groundY } = sampleSurface(ft, cen.x, cen.y, this.toWorld, this.heightOf, fallbackTop);
    const air = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;
    // Aim at roughly the unit's mid-body so missiles fly between models, not feet.
    const bodyLift = HEX_WORLD_RADIUS * UNIT_HEX_FRACTION * 0.5 + HEX_WORLD_RADIUS * 0.12;
    return new THREE.Vector3(wx, groundY + air + bodyLift, wz);
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
    if (this.active) this.close();

    const flatTiles = buildFlatView(this.world, unit.tileIndex, VIEW_RADIUS);
    const centre = flatTiles.find((ft) => ft.tileIndex === unit.tileIndex);
    if (!centre) {
      dbg.localMap.warn('FirstPersonView: centre tile not in flat view, aborting');
      return;
    }

    // Derive a projection scale so the centre hex has a comfortable world size.
    const hexR = avgHexRadius(centre);
    const scale = hexR > 1e-9 ? HEX_WORLD_RADIUS / hexR : 1;
    const toWorld = (px: number, py: number): [number, number, number] => [px * scale, 0, -py * scale];

    // Shared, neighbour-averaged height for every boundary vertex — defines the
    // single continuous tilted surface that both the terrain mesh and the units
    // sit on. Built once and reused so units conform to exactly what's drawn.
    const heightOf = this.buildVertexHeight(flatTiles);

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
    this.buildEnvironment(flatTiles, toWorld, heightOf);

    // Groups for units + command overlays, rebuilt independently as state changes.
    this.unitsGroup = new THREE.Group();
    this.rangeGroup = new THREE.Group();
    this.routeGroup = new THREE.Group();
    this.scene!.add(this.unitsGroup, this.rangeGroup, this.routeGroup);
    this.rebuildUnits();

    // Auto-select the entry unit if it belongs to the commandable faction.
    if (this.cmd && unit.ownerId === this.cmd.getActiveFaction()) {
      this.selectUnit(unit.id);
    }

    // Initial camera: sit at the selected unit's eye, looking along its facing,
    // then pull back and lift a little so the unit (and its ring) is in frame —
    // a gentle starting pose for the free-fly camera.
    const eye = segmentCentroid(centre, unit.segment);
    const [ex, , ez] = toWorld(eye.x, eye.y);
    const centreGround = sampleSurface(centre, eye.x, eye.y, toWorld, heightOf,
      elevationWorldHeight(this.world.tiles[unit.tileIndex])).height;
    const centreAir = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;

    const dir = facingDirection(centre, unit.facing);
    this.yaw = Math.atan2(dir.x, -dir.z);
    this.pitch = -0.12;

    const eyeY = centreGround + centreAir + EYE_HEIGHT;
    const back = HEX_WORLD_RADIUS * 6;
    const forward = this.forwardVec();
    this.camPos.set(ex, eyeY, ez)
      .addScaledVector(forward, -back)
      .add(new THREE.Vector3(0, back * 0.35, 0));
    this.clampPos();

    this.active = true;
    this.resize();
    this.applyLook();
    this.loop();

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);

    dbg.localMap.log('FirstPersonView opened for unit', unit.id, 'at tile', unit.tileIndex);
  }

  /** Exit first-person view and release all GPU resources. */
  close(): void {
    if (!this.active) return;
    this.active = false;

    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
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
    this.clearGroup(this.rangeGroup);
    this.clearGroup(this.routeGroup);
    this.unitsGroup = null;
    this.rangeGroup = null;
    this.routeGroup = null;
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

  /**
   * Lazily build (and cache) the THREE textures for terrain tops. Created from
   * the same `artifacts/*.webp` artwork the 2D map uses. THREE.TextureLoader
   * returns each Texture immediately and flips `needsUpdate` once the image
   * arrives, so the first render never blocks on the network.
   */
  private getTerrainTextures(): Map<string, THREE.Texture> {
    if (this.terrainTextures) return this.terrainTextures;
    const loader = new THREE.TextureLoader();
    const map = new Map<string, THREE.Texture>();
    for (const [key, url] of Object.entries(TEXTURE_SOURCES)) {
      const tex = loader.load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 4;
      map.set(key, tex);
    }
    this.terrainTextures = map;
    return map;
  }

  /**
   * Build the shared "continuous surface" height lookup: average each boundary
   * vertex's plateau height across every tile that touches it. Because adjacent
   * hexes share the same projected vertices, they resolve to identical heights —
   * so the plateau tops tilt to meet their neighbours and the terrain reads as
   * one smooth, sloping landform rather than stepped plateaus. The unit-placement
   * pass samples this exact surface so models conform to what's drawn.
   */
  private buildVertexHeight(flatTiles: FlatTile[]): (p: { x: number; y: number }) => number {
    const vKey = (p: { x: number; y: number }): string =>
      `${Math.round(p.x * 1e4)}:${Math.round(p.y * 1e4)}`;
    const vAccum = new Map<string, { sum: number; count: number }>();
    for (const ft of flatTiles) {
      const tTop = elevationWorldHeight(this.world.tiles[ft.tileIndex]);
      for (const p of ft.poly) {
        const k = vKey(p);
        const acc = vAccum.get(k);
        if (acc) { acc.sum += tTop; acc.count++; }
        else vAccum.set(k, { sum: tTop, count: 1 });
      }
    }
    return (p: { x: number; y: number }): number => {
      const acc = vAccum.get(vKey(p));
      return acc ? acc.sum / acc.count : 0;
    };
  }

  /** Build the ground hexes (raised to terrain elevation) and a far horizon disc. */
  private buildEnvironment(
    flatTiles: FlatTile[],
    toWorld: (px: number, py: number) => [number, number, number],
    vertexHeight: (p: { x: number; y: number }) => number,
  ): void {
    const scene = this.scene!;
    const textures = this.getTerrainTextures();

    // Determine the lowest terrain top so cliff skirts can drop to a common
    // floor below everything — this closes the vertical gaps that open up
    // between hexes at different elevations.
    let minTop = Infinity;
    for (const ft of flatTiles) {
      minTop = Math.min(minTop, elevationWorldHeight(this.world.tiles[ft.tileIndex]));
    }
    if (!isFinite(minTop)) minTop = 0;
    const floorY = minTop - HEX_WORLD_RADIUS * 1.5;

    // Far horizon ground so there's no void beyond the rendered hexes.
    const horizonGeo = new THREE.CircleGeometry(FIELD_EXTENT * 5, 48);
    const horizonMat = new THREE.MeshBasicMaterial({ color: 0x6f7d54 });
    const horizon = new THREE.Mesh(horizonGeo, horizonMat);
    horizon.rotation.x = -Math.PI / 2;
    horizon.position.y = floorY + 0.05;
    scene.add(horizon);
    this.disposables.push(horizonGeo, horizonMat);

    // Hex tops are grouped by texture key — one textured mesh per terrain type
    // — so each plateau shows the same artwork as the 2D map, tinted by the
    // tile's biome colour (vertex colours multiply the texture).
    type TopGroup = { positions: number[]; colors: number[]; uvs: number[] };
    const topGroups = new Map<string, TopGroup>();

    // Cliff skirts stay vertex-coloured (a darker wall, no texture needed) and
    // the rim outline is drawn as line segments.
    const skirtPositions: number[] = [];
    const skirtColors: number[] = [];
    const edgePositions: number[] = [];

    for (const ft of flatTiles) {
      const tile = this.world.tiles[ft.tileIndex];
      const [r, g, b] = tileColorRGB(tile);
      const n = ft.poly.length;

      // World positions of the boundary vertices, each lifted to its shared
      // (averaged) height so neighbouring tiles meet seamlessly.
      const tv = ft.poly.map((p) => {
        const w = toWorld(p.x, p.y);
        return [w[0], vertexHeight(p), w[2]] as [number, number, number];
      });

      // Per-tile UVs: map the hex's flat bounding box onto the full texture so
      // each hex shows the whole image (matching the 2D fillTileTexture look).
      let minX = Infinity, maxX = -Infinity, minPy = Infinity, maxPy = -Infinity;
      for (const p of ft.poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minPy) minPy = p.y;
        if (p.y > maxPy) maxPy = p.y;
      }
      const wX = maxX - minX || 1;
      const wY = maxPy - minPy || 1;
      const uvOf = (i: number): [number, number] => [
        (ft.poly[i].x - minX) / wX,
        1 - (ft.poly[i].y - minPy) / wY,
      ];

      const key = this.textureKeys.keyForTile(tile) ?? 'grassland';
      let grp = topGroups.get(key);
      if (!grp) {
        grp = { positions: [], colors: [], uvs: [] };
        topGroups.set(key, grp);
      }

      // Plateau top — triangle fan from poly[0].
      for (let i = 1; i < n - 1; i++) {
        for (const idx of [0, i, i + 1]) {
          grp.positions.push(tv[idx][0], tv[idx][1], tv[idx][2]);
          grp.colors.push(r, g, b);
          const [u, v] = uvOf(idx);
          grp.uvs.push(u, v);
        }
      }

      // Cliff skirts — a darker vertical wall from each edge down to the floor.
      const sr = r * 0.55, sg = g * 0.55, sb = b * 0.55;
      for (let i = 0; i < n; i++) {
        const a = tv[i];
        const c = tv[(i + 1) % n];
        // Two triangles forming the quad [a_top, c_top, c_floor, a_floor].
        const pushSkirt = (x: number, y: number, z: number) => {
          skirtPositions.push(x, y, z);
          skirtColors.push(sr, sg, sb);
        };
        pushSkirt(a[0], a[1], a[2]);
        pushSkirt(c[0], c[1], c[2]);
        pushSkirt(c[0], floorY, c[2]);
        pushSkirt(a[0], a[1], a[2]);
        pushSkirt(c[0], floorY, c[2]);
        pushSkirt(a[0], floorY, a[2]);
      }

      // Hex outline along the plateau rim (slightly raised to avoid z-fighting).
      for (let i = 0; i < n; i++) {
        const v0 = tv[i];
        const v1 = tv[(i + 1) % n];
        edgePositions.push(v0[0], v0[1] + 0.02, v0[2], v1[0], v1[1] + 0.02, v1[2]);
      }
    }

    // One textured mesh per terrain key for the plateau tops.
    this.pickMeshes = [];
    for (const [key, grp] of topGroups) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(grp.positions), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(grp.colors), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(grp.uvs), 2));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        map: textures.get(key) ?? null,
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      const topMesh = new THREE.Mesh(geo, mat);
      scene.add(topMesh);
      this.pickMeshes.push(topMesh);
      this.disposables.push(geo, mat);
    }

    // Vertex-coloured cliff skirts (no texture).
    const skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPositions), 3));
    skirtGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(skirtColors), 3));
    skirtGeo.computeVertexNormals();
    const skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
    scene.add(new THREE.Mesh(skirtGeo, skirtMat));
    this.disposables.push(skirtGeo, skirtMat);

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgePositions), 3));
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 });
    scene.add(new THREE.LineSegments(edgeGeo, edgeMat));
    this.disposables.push(edgeGeo, edgeMat);
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
      const fallbackTop = elevationWorldHeight(this.world.tiles[unit.tileIndex]);
      const { height: groundY, normal } = sampleSurface(ft, cen.x, cen.y, toWorld, heightOf, fallbackTop);

      const dir = facingDirection(ft, unit.facing);
      const drone = isDrone(unit);

      // Ground units conform to the surface normal; drones hover level above it.
      const up = drone ? new THREE.Vector3(0, 1, 0) : normal;
      orientToSurface(model, up, dir);

      // Lift the model's base clear of the surface along the surface normal so a
      // tilted unit doesn't sink a corner into the slope. Drones add air hover.
      const air = drone ? DRONE_AIR_HEIGHT : 0;
      model.position.set(
        wx + up.x * groundLift,
        groundY + up.y * groundLift + air,
        wz + up.z * groundLift,
      );

      // Faction-colour ring on the ground under every unit so the tiny models
      // are easy to spot and tell apart by side. Always laid flat at ground
      // level — for drones this sits on the ground directly beneath the hover.
      const factionRingGeo = new THREE.RingGeometry(FACTION_RING_RADIUS * 0.75, FACTION_RING_RADIUS, 32);
      const factionRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(fc), transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      const factionRing = new THREE.Mesh(factionRingGeo, factionRingMat);
      factionRing.rotation.x = -Math.PI / 2;
      factionRing.position.set(wx, groundY + 0.02, wz);
      group.add(factionRing);
      this.unitGeoms.push(factionRingGeo);
      this.unitMats.push(factionRingMat);

      // Subtle highlight ring under the selected unit. Sized off the hex (not
      // the unit) so the tiny model is still easy to locate.
      if (unit.id === selectedUnitId) {
        const ringGeo = new THREE.RingGeometry(SELECT_RING_RADIUS * 0.8, SELECT_RING_RADIUS, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(wx, groundY + 0.03, wz);
        group.add(ring);
        this.unitGeoms.push(ringGeo);
        this.unitMats.push(ringMat);
      }

      group.add(model);
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) this.unitGeoms.push(mesh.geometry);
      });
    }
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
      const maxHp = (target: UnitData) => (target.attributes.maxHealth ?? 1) * 10;
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
    const top = elevationWorldHeight(this.world.tiles[ft.tileIndex]);
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
        this.yaw -= dx * LOOK_SPEED;
        this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy * LOOK_SPEED));
      } else {
        // Pan: "grab the surface and drag it" — the point under the cursor follows
        // the cursor. Drag right → surface slides right (eye moves left); drag down
        // → surface slides toward you (eye moves forward). Stays on the horizontal
        // plane (yaw-based axes, pitch ignored) so altitude never changes.
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
      // Scroll up = move forward (zoom in); scroll down = move back (zoom out).
      const forward = this.forwardVec();
      this.camPos.addScaledVector(forward, e.deltaY > 0 ? -BOOM_STEP : BOOM_STEP);
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
    this.camPos.y = Math.max(0.5, Math.min(BOOM_MAX, this.camPos.y));
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
 * World-space terrain height for a tile, derived from its discrete 0–11 height.
 * Normalised to the shared 0→1 scale and lifted into world units via
 * ELEV_WORLD_SCALE. Ocean sits slightly below the flat floor.
 */
function elevationWorldHeight(tile: TileData): number {
  // True open ocean sits just below the flat floor. River hexes share the
  // ocean terrain type but descend the valley toward the sea — use their own
  // height so they don't render flattened at sea level.
  const isOpenOcean = (tile.terrain === 'ocean' || tile.elevType === 'ocean') && tile.rv === undefined;
  if (isOpenOcean) return -0.25 * ELEV_WORLD_SCALE;
  return (tileHeight(tile) / (HEIGHT_LEVELS - 1)) * ELEV_WORLD_SCALE;
}

/** Average distance from a flat tile's centre to its boundary vertices. */
function avgHexRadius(ft: FlatTile): number {
  let sum = 0;
  for (const v of ft.poly) {
    sum += Math.sqrt((v.x - ft.cx) ** 2 + (v.y - ft.cy) ** 2);
  }
  return sum / Math.max(1, ft.poly.length);
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
  heightOf: (p: { x: number; y: number }) => number,
  fallback: number,
): { height: number; normal: THREE.Vector3 } {
  const n = ft.poly.length;
  const lift = (p: { x: number; y: number }): THREE.Vector3 => {
    const [wx, , wz] = toWorld(p.x, p.y);
    return new THREE.Vector3(wx, heightOf(p), wz);
  };
  for (let i = 1; i < n - 1; i++) {
    const a = ft.poly[0], b = ft.poly[i], c = ft.poly[i + 1];
    const bary = baryWeights(px, py, a, b, c);
    if (!bary) continue;
    const [wa, wb, wc] = bary;
    if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
    const height = wa * heightOf(a) + wb * heightOf(b) + wc * heightOf(c);
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
