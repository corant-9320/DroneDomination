/**
 * First-Person View — a purely visual, read-only 3D "look around" mode.
 *
 * The player selects a unit and enters a ground-level perspective camera sitting
 * at that unit's position. They can freely look around (mouse drag = yaw/pitch)
 * to see the surrounding hex environment and nearby units rendered as full 3D
 * models. No game mechanics run here — it is a camera, nothing else.
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
import { buildFlatView, FlatTile } from './localMapProjection.js';
import { tileHeight, HEIGHT_LEVELS } from '../shared/movementConstants.js';
import { buildUnitModel } from './unitModel.js';
import { unitDataToModelAttrs } from './unitRenderer.js';
import { tileColorRGB, factionColor } from './colors.js';
import { TerrainTextures } from './terrainTextures.js';
import { dbg } from './debug.js';

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
 * Max camera pull-back distance (world units). At full zoom-out the eye lifts
 * well above and behind the unit so the entire battlefield — and plenty of
 * space behind the selected unit — is in frame.
 */
const BOOM_MAX = FIELD_EXTENT * 3.0;

/** Fraction of pull-back distance added as altitude — zooming out rises for an overview. */
const BOOM_LIFT = 0.6;

/** Pull-back distance change per wheel notch. */
const BOOM_STEP = BOOM_MAX / 30;

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

  // Look state
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  /** Anchor point the camera looks out from / orbits — the selected unit's eye position. */
  private anchor = new THREE.Vector3();
  /** Camera pull-back distance (0 = first person at the unit). Controlled by the wheel. */
  private boom = 0;

  // Disposables to release on close
  private disposables: Array<{ dispose: () => void }> = [];

  // Bound handlers (stable refs for add/removeEventListener)
  private onResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
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
  getDiagnostics(): { x: number; y: number; z: number; boom: number; yaw: number; pitch: number } | null {
    if (!this.active || !this.camera) return null;
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z, boom: this.boom, yaw: this.yaw, pitch: this.pitch };
  }

  /** Keep a fresh reference to the world (units may have changed between turns). */
  setWorld(world: WorldData): void {
    this.world = world;
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

    this.buildOverlay();
    this.buildScene();
    this.buildEnvironment(flatTiles, toWorld);
    this.placeUnits(flatTiles, toWorld, unit.id);

    // Camera anchor = the selected unit's segment centroid, eye-height above ground.
    const eye = segmentCentroid(centre, unit.segment);
    const [ex, , ez] = toWorld(eye.x, eye.y);
    const centreTop = elevationWorldHeight(this.world.tiles[unit.tileIndex]);
    const centreAir = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;
    this.anchor.set(ex, centreTop + centreAir + EYE_HEIGHT, ez);
    this.boom = 0;

    // Initial look direction = the unit's facing direction in the flat view.
    const dir = facingDirection(centre, unit.facing);
    this.yaw = Math.atan2(dir.x, -dir.z);
    this.pitch = 0;

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

  /** Build the ground hexes (raised to terrain elevation) and a far horizon disc. */
  private buildEnvironment(flatTiles: FlatTile[], toWorld: (px: number, py: number) => [number, number, number]): void {
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

    // Continuous surface: average each shared boundary vertex's height across
    // every tile that touches it. Because adjacent hexes share the same
    // projected vertices, they resolve to identical heights — so the plateau
    // tops tilt to meet their neighbours and the terrain reads as one smooth,
    // sloping landform rather than stepped plateaus. Steeper neighbours produce
    // steeper tilts. (Skirts below still close the outer rim and any coastline.)
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
    const vertexHeight = (p: { x: number; y: number }): number => {
      const acc = vAccum.get(vKey(p));
      return acc ? acc.sum / acc.count : 0;
    };

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
      scene.add(new THREE.Mesh(geo, mat));
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

  /** Build and place a 3D model for every unit within the view radius. */
  private placeUnits(
    flatTiles: FlatTile[],
    toWorld: (px: number, py: number) => [number, number, number],
    selectedUnitId: string,
  ): void {
    const scene = this.scene!;
    const tileById = new Map<number, FlatTile>();
    for (const ft of flatTiles) tileById.set(ft.tileIndex, ft);

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

      const cen = segmentCentroid(ft, unit.segment);
      const [wx, , wz] = toWorld(cen.x, cen.y);
      const top = elevationWorldHeight(this.world.tiles[unit.tileIndex]);
      const air = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;
      model.position.set(wx, top + air + groundLift, wz);

      // Rotate model so its front (-Z) points along the unit's facing direction.
      const dir = facingDirection(ft, unit.facing);
      model.rotation.y = Math.atan2(-dir.x, -dir.z);

      // Subtle highlight ring under the player's own selected unit. Sized off
      // the hex (not the unit) so the tiny model is still easy to locate.
      if (unit.id === selectedUnitId) {
        const ringGeo = new THREE.RingGeometry(SELECT_RING_RADIUS * 0.8, SELECT_RING_RADIUS, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(wx, top + 0.03, wz);
        scene.add(ring);
        this.disposables.push(ringGeo, ringMat);
      }

      scene.add(model);
      this.registerModelDisposables(model);
    }
  }

  /** Track per-model geometry so it can be freed on close (materials are shared singletons). */
  private registerModelDisposables(model: THREE.Object3D): void {
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) this.disposables.push(mesh.geometry);
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
    hint.textContent = 'Drag to look around · scroll to zoom out for a battlefield overview · Esc to exit';
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

    // Look controls — drag to rotate yaw/pitch.
    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      container.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', this.endDrag);
    canvas.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw += dx * LOOK_SPEED;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy * LOOK_SPEED));
      this.applyLook();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Scroll down/away = zoom out (pull the eye back and up); scroll up = zoom in.
      this.boom = Math.max(0, Math.min(BOOM_MAX, this.boom + (e.deltaY > 0 ? BOOM_STEP : -BOOM_STEP)));
      this.applyLook();
    }, { passive: false });

    document.body.appendChild(container);
    this.container = container;
    this.canvas = canvas;
  }

  private endDrag = () => {
    this.dragging = false;
    if (this.container) this.container.style.cursor = 'grab';
  };

  // ─── Per-frame ────────────────────────────────────────────────────────────

  private applyLook(): void {
    if (!this.camera) return;
    const cp = Math.cos(this.pitch);
    const forward = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
    // Eye pulls back along -forward and gains altitude as the boom grows, so
    // zooming out rises into an overview while still looking along `forward`.
    const pos = this.anchor.clone()
      .addScaledVector(forward, -this.boom)
      .add(new THREE.Vector3(0, BOOM_LIFT * this.boom, 0));
    pos.y = Math.max(pos.y, 0.5); // keep the eye above the ground
    this.camera.position.copy(pos);
    this.camera.lookAt(pos.x + forward.x, pos.y + forward.y, pos.z + forward.z);
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
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

// ─── Pure geometry helpers (flat-view projected coords) ───────────────────────

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
  if (tile.terrain === 'ocean' || tile.elevType === 'ocean') return -0.25 * ELEV_WORLD_SCALE;
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
