/**
 * Logistics Renderer — scene wiring for the Oil Logistics System (task 15.2).
 *
 * This module instantiates and POSITIONS the procedural THREE.Group models built
 * by the `client/logisticsModel*` family (tasks 15.6–15.8) into a THREE.Scene,
 * and animates moving transports. It consumes the model builders directly — it
 * never uses sprites or reused-building bitmaps:
 *
 *   - `buildLogisticsModel(kind, factionHex, opts)`  → wells, refineries, hubs, bridges
 *     (`./logisticsModel.js`)
 *   - `buildTransportModel(tier, factionHex)`        → moving transports
 *     (`./logisticsModelTransport.js`)
 *   - `buildRoadMesh(path)` / `buildHighwayMesh(path)` → route ribbons; a route's
 *     `tier` selects which (`./logisticsModelRoad.js`)
 *
 * Oil deposits (`resourceType === 'oil'` tiles) get a small procedural marker
 * that is visible before a well is drilled (Req 1.3).
 *
 * All logistics entities are read straight from `WorldData.logistics` (the client
 * mirror from task 15.1). Seeded (Default_Test_World) and player-built entities
 * render through the IDENTICAL path — there is deliberately NO special-case branch
 * for the seeded default network (Req 13).
 *
 * ── View abstraction ──────────────────────────────────────────────────────────
 * The client has two very different views: the globe (a Three.js unit sphere,
 * `client/globe.ts`) and the local map (a 2D canvas, `client/localMap.ts`). Tile
 * world-positions are computed completely differently in each (sphere position
 * vs planar projection). To render into either without duplicating placement
 * logic, this module is parameterised over a `LogisticsRenderContext` that maps a
 * tile / segment to a world-space position, an up-vector, and a model scale.
 *
 *   - `createGlobeRenderContext(world)` — concrete context for the globe scene:
 *     positions come from `tile.pos` on the unit sphere, lifted by the same
 *     elevation curve `GlobeView` uses, with the outward radial as the up-vector.
 *   - `createFlatRenderContext(world, project, opts)` — a y-up planar context for a
 *     3D local-map / first-person scene (integration seam — see note at bottom).
 *
 * Entry points:
 *   - `renderLogistics(scene, world, ctx)` — one-shot build+add, returns a handle.
 *   - `class LogisticsRenderer` — same, plus `update(dt)` for transport animation
 *     and `dispose()` for teardown.
 *
 * Client layering: NO imports from `src/` or `server/`. Shared types come from
 * the `client/worldData.js` mirror or `shared/*.js`. All imports use `.js`
 * extensions; named exports only.
 */

import * as THREE from 'three';
import { buildLogisticsModel } from './logisticsModel.js';
import { buildTransportModel } from './logisticsModelTransport.js';
import { buildRoadMesh, buildHighwayMesh } from './logisticsModelRoad.js';
import { factionColor } from './colors.js';
import type {
  WorldData,
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
} from './worldData.js';

const UP_Y = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// View-agnostic placement context
// ---------------------------------------------------------------------------

/**
 * Maps logistics entities (by tile / segment) to world-space placement in a
 * particular view. Both the globe (sphere) and a flat 3D local map supply their
 * own implementation, so the renderer itself never hard-codes either projection.
 */
export interface LogisticsRenderContext {
  /** World-space centre of a tile, already lifted to the terrain surface. */
  tileCentre(tileIndex: number): THREE.Vector3 | null;
  /** World-space centre of one segment (triangular face) within a tile. */
  segmentCentre(tileIndex: number, segment: number): THREE.Vector3 | null;
  /** Outward surface normal (up-vector) at a tile; models orient +Y to this. */
  upAt(tileIndex: number): THREE.Vector3;
  /** Uniform model scale appropriate for entities on this tile in this view. */
  scaleAt(tileIndex: number): number;
  /** Faction colour (`#RRGGBB`) for an owner id, or undefined for neutral. */
  factionColorFor(ownerId: string): string | undefined;
}

/** Options for {@link createGlobeRenderContext}. */
export interface GlobeContextOptions {
  /** Extra radial lift above the tile surface, in sphere units. Default 0.001. */
  surfaceLift?: number;
  /** Model size as a fraction of the tile's chord radius. Default 0.55. */
  scaleFactor?: number;
}

/** Matches `GlobeView.MAX_PUSH` so models sit on the same surface as the mesh. */
const GLOBE_MAX_PUSH = 0.06;

/** Radial elevation scale for a discrete terrain height 0–11 (mirrors GlobeView). */
function globeHeightScale(height: number): number {
  const t = Math.max(0, Math.min(11, height)) / 11;
  return 1 + GLOBE_MAX_PUSH * t * t;
}

/**
 * Build a placement context for the globe scene. Tile positions come from the
 * unit-sphere `tile.pos`, lifted by the same quadratic elevation curve the globe
 * mesh uses, so models rest exactly on the rendered surface. The up-vector at any
 * tile is its outward radial. Segment centres blend the tile centre with the
 * segment's boundary edge so per-segment structures (wells, refinery segments)
 * sit inside their own face.
 */
export function createGlobeRenderContext(
  world: WorldData,
  opts: GlobeContextOptions = {}
): LogisticsRenderContext {
  const lift = opts.surfaceLift ?? 0.001;
  const scaleFactor = opts.scaleFactor ?? 0.55;
  const tiles = world.tiles;

  /** Surface radius at a tile: ocean stays at sea level, land follows height. */
  const surfaceRadius = (t: WorldData['tiles'][number]): number =>
    t.terrain === 'ocean' && t.rv === undefined ? 1.0 : globeHeightScale(t.h ?? 0);

  return {
    tileCentre(tileIndex: number): THREE.Vector3 | null {
      const t = tiles[tileIndex];
      if (!t) return null;
      const dir = new THREE.Vector3(t.pos[0], t.pos[1], t.pos[2]).normalize();
      return dir.multiplyScalar(surfaceRadius(t) + lift);
    },
    segmentCentre(tileIndex: number, segment: number): THREE.Vector3 | null {
      const t = tiles[tileIndex];
      if (!t) return null;
      const sides = t.s;
      const b = t.b;
      const seg = ((segment % sides) + sides) % sides;
      const va = b[seg];
      const vb = b[(seg + 1) % sides];
      // Centroid of the triangular face: tile centre + the two shared edge verts.
      const cx = (t.pos[0] + va[0] + vb[0]) / 3;
      const cy = (t.pos[1] + va[1] + vb[1]) / 3;
      const cz = (t.pos[2] + va[2] + vb[2]) / 3;
      const dir = new THREE.Vector3(cx, cy, cz).normalize();
      return dir.multiplyScalar(surfaceRadius(t) + lift);
    },
    upAt(tileIndex: number): THREE.Vector3 {
      const t = tiles[tileIndex];
      if (!t) return UP_Y.clone();
      return new THREE.Vector3(t.pos[0], t.pos[1], t.pos[2]).normalize();
    },
    scaleAt(tileIndex: number): number {
      const t = tiles[tileIndex];
      if (!t) return 0.01;
      // Chord radius from centre to first boundary vertex approximates tile size.
      const c = new THREE.Vector3(t.pos[0], t.pos[1], t.pos[2]);
      const v0 = new THREE.Vector3(t.b[0][0], t.b[0][1], t.b[0][2]);
      const chord = c.distanceTo(v0);
      // Models are authored ~2 units wide, so scale a full-width model to ~1 tile.
      return (chord / 2) * scaleFactor;
    },
    factionColorFor(ownerId: string): string | undefined {
      return ownerId ? factionColor(world, ownerId) : undefined;
    },
  };
}

/**
 * Build a y-up planar placement context from a 2D tile projector. Intended for a
 * 3D local-map / first-person scene that lays tiles on the XZ plane. `project`
 * returns the tile centre's `(x, z)` in world units and its ground height `y`.
 *
 * This is the integration seam for the local-map / first-person view (see the
 * note at the bottom of this file): the globe is wired concretely, while any flat
 * 3D view can supply its own `project` to reuse all the placement logic here.
 */
export function createFlatRenderContext(
  world: WorldData,
  project: (tileIndex: number) => { x: number; y: number; z: number } | null,
  opts: { tileWorldSize?: number; scaleFactor?: number } = {}
): LogisticsRenderContext {
  const tileWorldSize = opts.tileWorldSize ?? 1;
  const scaleFactor = opts.scaleFactor ?? 0.5;
  const tiles = world.tiles;

  const centre = (tileIndex: number): THREE.Vector3 | null => {
    const p = project(tileIndex);
    return p ? new THREE.Vector3(p.x, p.y, p.z) : null;
  };

  return {
    tileCentre: centre,
    segmentCentre(tileIndex: number, segment: number): THREE.Vector3 | null {
      const t = tiles[tileIndex];
      const c = centre(tileIndex);
      if (!t || !c) return null;
      // Offset from the tile centre toward the segment's angular position on the
      // XZ plane (segments are evenly spaced around the tile).
      const sides = t.s;
      const seg = ((segment % sides) + sides) % sides;
      const ang = ((seg + 0.5) / sides) * Math.PI * 2;
      const r = tileWorldSize * 0.4;
      return new THREE.Vector3(c.x + Math.cos(ang) * r, c.y, c.z + Math.sin(ang) * r);
    },
    upAt(): THREE.Vector3 {
      return UP_Y.clone();
    },
    scaleAt(): number {
      return (tileWorldSize / 2) * scaleFactor;
    },
    factionColorFor(ownerId: string): string | undefined {
      return ownerId ? factionColor(world, ownerId) : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

/**
 * Orient and place `group` at `position` with its local +Y aligned to `up`. When
 * `forward` is supplied (e.g. a transport's travel tangent), the group is also
 * yawed so its local −Z (model "front") points along `forward`, projected onto
 * the tangent plane.
 */
function placeGroup(
  group: THREE.Object3D,
  position: THREE.Vector3,
  up: THREE.Vector3,
  forward?: THREE.Vector3
): void {
  group.position.copy(position);

  if (forward) {
    const fwd = forward.clone().projectOnPlane(up);
    if (fwd.lengthSq() > 1e-9) {
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
      // Re-orthogonalise forward so the basis is exactly orthonormal.
      const zAxis = new THREE.Vector3().crossVectors(right, up).normalize();
      // Model "front" is local −Z, so local +Z must point opposite to travel.
      zAxis.negate();
      const basis = new THREE.Matrix4().makeBasis(right, up.clone().normalize(), zAxis);
      group.quaternion.setFromRotationMatrix(basis);
      return;
    }
  }
  group.quaternion.setFromUnitVectors(UP_Y, up.clone().normalize());
}

/** Build a small procedural oil-deposit marker (dark pool + a stubby marker post). */
function buildDepositMarker(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'oil-deposit';

  const oilMat = new THREE.MeshStandardMaterial({
    color: 0x0e0b08,
    roughness: 0.35,
    metalness: 0.5,
    emissive: 0x120d06,
  });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xf4d03f, roughness: 0.6, metalness: 0.1 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.7, metalness: 0.4 });

  // Oil pool — a shallow disc sitting on the ground.
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.08, 20), oilMat);
  pool.position.y = 0.04;
  group.add(pool);

  // Rim band around the pool.
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.04, 8, 20), bandMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.08;
  group.add(rim);

  // Survey marker post with a flag so the deposit reads pre-drill.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), postMat);
  post.position.set(0.28, 0.45, 0.28);
  group.add(post);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.02), bandMat);
  flag.position.set(0.44, 0.78, 0.28);
  group.add(flag);

  return group;
}

/** Build a small canvas-texture sprite showing a transport's cargo/ETA readout. */
function makeReadoutSprite(): { sprite: THREE.Sprite; setText: (text: string) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);

  let lastText = '';
  const setText = (text: string): void => {
    if (text === lastText) return;
    lastText = text;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(10,10,10,0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  };
  setText('');
  return { sprite, setText };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** Live handle for a rendered transport so `update` can animate it. */
interface TransportHandle {
  group: THREE.Group;
  readout: { sprite: THREE.Sprite; setText: (text: string) => void };
  /** World-space path (route tile centres) the transport travels along. */
  path: THREE.Vector3[];
  /** Cumulative arc length at each path point. */
  arcLengths: number[];
  totalLength: number;
  /** Base progress 0..1 from the transport's turn state at render time. */
  baseProgress: number;
  /** Per-segment progress delta so the crawl advances smoothly between turns. */
  progressPerTurn: number;
  cargo: number;
  turnsRemaining: number;
  scale: number;
}

/**
 * Renders every logistics entity in a world into a THREE.Scene and animates the
 * moving transports. Construct with a scene and a view context, call `render` to
 * (re)build, `update(dt)` each frame to animate transports, and `dispose` to tear
 * everything down.
 */
export class LogisticsRenderer {
  private scene: THREE.Scene;
  private ctx: LogisticsRenderContext;
  /** Root group holding all logistics content, so teardown is a single removal. */
  private root: THREE.Group;
  private transports: TransportHandle[] = [];
  private elapsed = 0;

  constructor(scene: THREE.Scene, ctx: LogisticsRenderContext) {
    this.scene = scene;
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'logistics';
    this.scene.add(this.root);
  }

  /** Swap the placement context (e.g. when the view changes) and rebuild. */
  setContext(ctx: LogisticsRenderContext): void {
    this.ctx = ctx;
  }

  /**
   * (Re)build all logistics content from the world's logistics state and oil
   * deposits. Clears any previously rendered content first. Seeded and
   * player-built entities go through the identical path (no special-casing).
   */
  render(world: WorldData): void {
    this.clear();

    this.renderDeposits(world);

    const logistics = world.logistics;
    if (!logistics) return;

    this.renderWells(logistics.wells ?? []);
    this.renderRefineries(logistics.refineries ?? []);
    this.renderHubs(logistics.hubs ?? []);
    this.renderRoutes(logistics.routes ?? [], world);
    this.renderTransports(logistics.transports ?? [], logistics.routes ?? []);
  }

  // ── Deposits (visible pre-drill) ──────────────────────────────────────────
  private renderDeposits(world: WorldData): void {
    for (const tile of world.tiles) {
      if (tile.resourceType !== 'oil') continue;
      const pos = this.ctx.tileCentre(tile.idx);
      if (!pos) continue;
      const marker = buildDepositMarker();
      const scale = this.ctx.scaleAt(tile.idx);
      marker.scale.setScalar(scale);
      placeGroup(marker, pos, this.ctx.upAt(tile.idx));
      this.root.add(marker);
    }
  }

  // ── Static structures ─────────────────────────────────────────────────────
  private renderWells(wells: OilWell[]): void {
    for (const well of wells) {
      const pos = this.ctx.segmentCentre(well.tileIndex, well.segment);
      if (!pos) continue;
      const model = buildLogisticsModel('well', this.ctx.factionColorFor(well.ownerId));
      model.scale.setScalar(this.ctx.scaleAt(well.tileIndex));
      placeGroup(model, pos, this.ctx.upAt(well.tileIndex));
      this.root.add(model);
    }
  }

  private renderRefineries(refineries: Refinery[]): void {
    for (const refinery of refineries) {
      // A refinery covers the whole hex; the model grows with its segment count.
      const segmentCount = Math.max(1, refinery.segments?.length ?? 1);
      const pos = this.ctx.tileCentre(refinery.tileIndex);
      if (!pos) continue;
      const model = buildLogisticsModel('refinery', this.ctx.factionColorFor(refinery.ownerId), {
        segmentCount,
      });
      model.scale.setScalar(this.ctx.scaleAt(refinery.tileIndex));
      placeGroup(model, pos, this.ctx.upAt(refinery.tileIndex));
      this.root.add(model);
    }
  }

  private renderHubs(hubs: DistributionHub[]): void {
    for (const hub of hubs) {
      const pos = this.ctx.tileCentre(hub.tileIndex);
      if (!pos) continue;
      const model = buildLogisticsModel('hub', this.ctx.factionColorFor(hub.ownerId));
      model.scale.setScalar(this.ctx.scaleAt(hub.tileIndex));
      placeGroup(model, pos, this.ctx.upAt(hub.tileIndex));
      this.root.add(model);
    }
  }

  // ── Routes: roads vs highways ─────────────────────────────────────────────
  private renderRoutes(routes: LogisticsRoute[], world: WorldData): void {
    for (const route of routes) {
      const path = this.routePath(route);
      if (path.length < 2) continue;
      // Scale road width to the tiles it crosses so it reads at the view's scale.
      const width = this.ctx.scaleAt(route.segments[0]) * 0.9;
      const group =
        route.tier === 'highway'
          ? buildHighwayMesh(path, { width })
          : buildRoadMesh(path, { width });
      // A destroyed/inoperable route is dimmed but still drawn.
      if (route.operable === false) {
        group.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
          if (mat && 'opacity' in mat) {
            mat.transparent = true;
            mat.opacity = 0.35;
          }
        });
      }
      this.root.add(group);
    }
    void world;
  }

  /** Route tile-centre world path, dropping any tiles the context can't place. */
  private routePath(route: LogisticsRoute): THREE.Vector3[] {
    const path: THREE.Vector3[] = [];
    for (const tileIndex of route.segments ?? []) {
      const p = this.ctx.tileCentre(tileIndex);
      if (p) path.push(p);
    }
    return path;
  }

  // ── Moving transports with cargo/ETA readouts ─────────────────────────────
  private renderTransports(transports: Transport[], routes: LogisticsRoute[]): void {
    const routeById = new Map<string, LogisticsRoute>();
    for (const r of routes) routeById.set(r.id, r);

    for (const transport of transports) {
      const route = routeById.get(transport.routeId);
      if (!route) continue;
      const path = this.routePath(route);
      if (path.length < 2) continue;

      const model = buildTransportModel(transport.tier, this.ctx.factionColorFor(transport.ownerId) ?? '#8090a0');
      const scale = this.ctx.scaleAt(route.segments[0]);
      model.scale.setScalar(scale);

      // Arc-length table so we can interpolate an even crawl along the path.
      const arcLengths: number[] = [0];
      for (let i = 1; i < path.length; i++) {
        arcLengths.push(arcLengths[i - 1] + path[i].distanceTo(path[i - 1]));
      }
      const totalLength = arcLengths[arcLengths.length - 1];

      // Progress from the turn countdown: at dispatch turnsRemaining = travelTime
      // (progress 0), at arrival turnsRemaining = 0 (progress 1).
      const travelTime = Math.max(1, route.travelTime || 1);
      const baseProgress = transport.inTransit
        ? Math.max(0, Math.min(1, (travelTime - transport.turnsRemaining) / travelTime))
        : 0;

      const readout = makeReadoutSprite();
      readout.sprite.scale.setScalar(scale * 3);
      model.add(readout.sprite);
      readout.sprite.position.set(0, 2.4, 0);

      const handle: TransportHandle = {
        group: model,
        readout,
        path,
        arcLengths,
        totalLength,
        baseProgress,
        progressPerTurn: 1 / travelTime,
        cargo: transport.cargo,
        turnsRemaining: transport.turnsRemaining,
        scale,
      };
      this.transports.push(handle);
      this.root.add(model);
      this.positionTransport(handle, baseProgress);
      this.updateReadout(handle);
    }
  }

  /** Place a transport at `progress` (0..1) along its path, facing the tangent. */
  private positionTransport(h: TransportHandle, progress: number): void {
    if (h.totalLength <= 0) {
      placeGroup(h.group, h.path[0], UP_Y);
      return;
    }
    const target = progress * h.totalLength;
    let i = 1;
    while (i < h.arcLengths.length && h.arcLengths[i] < target) i++;
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(h.path.length - 1, i);
    const segLen = h.arcLengths[i1] - h.arcLengths[i0] || 1;
    const t = Math.max(0, Math.min(1, (target - h.arcLengths[i0]) / segLen));
    const pos = h.path[i0].clone().lerp(h.path[i1], t);
    const tangent = h.path[i1].clone().sub(h.path[i0]);
    // Up-vector: interpolate the endpoints' positions to a rough surface normal.
    const up = pos.clone().normalize().lengthSq() > 1e-9 ? pos.clone().normalize() : UP_Y.clone();
    placeGroup(h.group, pos, up, tangent);
  }

  private updateReadout(h: TransportHandle): void {
    const eta = h.turnsRemaining > 0 ? `ETA ${h.turnsRemaining}` : 'idle';
    h.readout.setText(`${h.cargo} • ${eta}`);
  }

  /**
   * Animate transports each frame. `dt` is seconds since the last call. Within a
   * turn the transport crawls smoothly from its current turn's progress toward
   * the next turn's, giving continuous motion between discrete turn updates.
   */
  update(dt: number): void {
    if (this.transports.length === 0) return;
    this.elapsed += dt;
    // A slow visual crawl within the current turn (loops every ~4s per turn-step).
    const withinTurn = (this.elapsed % 4) / 4;
    for (const h of this.transports) {
      if (h.turnsRemaining <= 0) continue;
      const progress = Math.min(1, h.baseProgress + withinTurn * h.progressPerTurn);
      this.positionTransport(h, progress);
    }
  }

  /** Remove and dispose all rendered content (keeps the root group attached). */
  clear(): void {
    disposeChildren(this.root);
    this.transports = [];
  }

  /** Full teardown: remove the root group from the scene and dispose everything. */
  dispose(): void {
    this.clear();
    this.scene.remove(this.root);
  }
}

/** Recursively dispose geometries/materials/textures and detach all children. */
function disposeChildren(root: THREE.Object3D): void {
  for (const child of [...root.children]) {
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => disposeMaterial(m));
      else if (mat) disposeMaterial(mat);
      const sprite = obj as THREE.Sprite;
      if (sprite.isSprite && sprite.material) disposeMaterial(sprite.material);
    });
    root.remove(child);
  }
}

function disposeMaterial(mat: THREE.Material): void {
  const m = mat as THREE.MeshStandardMaterial & { map?: THREE.Texture | null };
  if (m.map) m.map.dispose();
  mat.dispose();
}

// ---------------------------------------------------------------------------
// Convenience one-shot entry point
// ---------------------------------------------------------------------------

/**
 * One-shot build: create a {@link LogisticsRenderer}, render `world`, and return
 * it so the caller can drive `update(dt)` from its render loop and `dispose()` on
 * teardown. Mirrors the task's suggested `renderLogistics(scene, world, ctx)`.
 */
export function renderLogistics(
  scene: THREE.Scene,
  world: WorldData,
  ctx: LogisticsRenderContext
): LogisticsRenderer {
  const renderer = new LogisticsRenderer(scene, ctx);
  renderer.render(world);
  return renderer;
}

// ---------------------------------------------------------------------------
// Integration seams left for follow-up (documented per task 15.2)
// ---------------------------------------------------------------------------
//
// 1. Globe wiring: `client/globe.ts` should construct a LogisticsRenderer with
//    `createGlobeRenderContext(world)` against its private `scene`, call
//    `render(world)` after the tile mesh is built, and call `update(dt)` from its
//    `animate()` loop. That requires exposing the globe's scene/render hook; left
//    as a minimal follow-up so this module lands independently testable.
//
// 2. Local map: `client/localMap.ts` is a 2D canvas (no THREE scene), so it
//    cannot host these 3D Groups directly. The natural second 3D target is the
//    first-person view (`client/firstPersonView.ts` / `firstPersonTerrain.ts`);
//    supply `createFlatRenderContext(world, project)` with that view's tile→world
//    projector to reuse all placement logic here unchanged.
//
// 3. Deposits on the wire: `resourceType` is now serialized by
//    `src/world/compact.ts::toCompactTile` into `shared/wireTypes.ts::WireTile`
//    (identical field name) and flows through the `/api/world-tiles` regeneration
//    path, so `renderDeposits` receives `tile.resourceType === 'oil'` tiles at
//    runtime and draws their markers.
