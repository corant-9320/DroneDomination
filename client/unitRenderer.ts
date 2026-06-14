/**
 * Unit Renderer — offscreen Three.js renderer that produces cached sprite
 * bitmaps from 3D unit models. Each unique attribute + facing combination
 * is rendered once and cached as an ImageBitmap for fast Canvas 2D blitting.
 *
 * The 3D model is rotated around Y to match the unit's facing direction
 * before rendering, so the 2D sprite is drawn without rotation on the map.
 *
 * ─── FACING ASSUMPTION ───────────────────────────────────────────────────────
 *
 * This renderer assumes facing index N visually points at screen angle
 * (N × 60°) from north (up). Facing 0 = north, 1 = 60° clockwise (NE), etc.
 *
 * On the local map, the actual screen direction of tile.neighbours[N] varies
 * by tile position on the sphere. The caller (localMapUnits.ts) compensates
 * by selecting the sprite whose baked direction best matches the real screen
 * angle via getCorrectedFacing(). This avoids 2D canvas rotation which breaks
 * the isometric perspective.
 *
 * NEVER apply ctx.rotate() to these sprites on the map. Always select the
 * nearest pre-rendered facing index instead.
 */

import * as THREE from 'three';
import { buildUnitModel, initMaterials, isTextureReady } from './unitModel.js';
import type { ChassisType, UnitModelAttrs } from './unitModel.js';
import type { UnitData, WorldData } from './worldData.js';
import { factionColor } from './colors.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Resolution of each cached sprite (square). High res for crisp display at all zoom levels. */
const SPRITE_SIZE = 1024;

/**
 * We pre-render 6 facing directions (one per hex segment).
 * Facing index 0 = north (model front points up on screen).
 */
const FACING_COUNT = 6;

// ---------------------------------------------------------------------------
// Offscreen renderer (singleton)
// ---------------------------------------------------------------------------

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene;
let camera: THREE.OrthographicCamera;

function ensureRenderer(): void {
  if (renderer) return;

  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SPRITE_SIZE, SPRITE_SIZE);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  // Camera shifted 30° to the left of dead-behind (toward unit's left flank).
  // Original (2.5, 3.5, 2.5) was 45° azimuth = dead-on rear, no side visible.
  // New: 75° azimuth from +Z (30° further into +X) reveals the left flank.
  // XZ radius preserved at 3.54. Rotation compensation unchanged so the unit
  // still faces "north" on screen but the camera now catches the left side.
  // Frustum sized to 2.5 to prevent tall add-ons (anti-air launchers, repair
  // poles) from being clipped by the near/far planes of the orthographic camera.
  // unitIcons.ts compensates with a proportionally larger spriteSize multiplier
  // so the on-screen model size stays the same.
  const frustum = 2.5;
  camera = new THREE.OrthographicCamera(-frustum, frustum, frustum, -frustum, 0.1, 50);
  camera.position.set(3.42, 3.5, 0.916);
  camera.lookAt(0, 0, 0);

  // Lighting — bright enough that models read clearly even at small sprite sizes
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
  dirLight.position.set(2, 5, 3);
  scene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0xaabbff, 0.6);
  fillLight.position.set(-2, 3, -2);
  scene.add(fillLight);
  // Rim light from behind to separate the silhouette from the background
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.8);
  rimLight.position.set(0, 2, -4);
  scene.add(rimLight);
}

// ---------------------------------------------------------------------------
// Sprite Cache
// ---------------------------------------------------------------------------

/** Cache key → array of 6 ImageBitmaps (one per facing direction). */
const spriteCache = new Map<string, (ImageBitmap | null)[]>();
const pendingRenders = new Set<string>();

/**
 * Bump this whenever camera position or sprite rendering changes so that
 * HMR / cached-module scenarios automatically invalidate old sprites.
 */
const SPRITE_VERSION = 'cam75deg-v3';

/**
 * Generate a cache key from unit attributes (facing-independent).
 */
function attrKey(attrs: UnitModelAttrs, factionColor?: string): string {
  return `${SPRITE_VERSION}:${attrs.chassis}:${attrs.movement}:${attrs.kinetic}:${attrs.rangeAttack}:${attrs.splashAttack}:${attrs.antiAir}:${attrs.armour}:${attrs.defence}:${attrs.repair}:${factionColor ?? ''}`;
}

/**
 * Convert game UnitData attributes into the model builder format.
 */
export function unitDataToModelAttrs(unit: UnitData): UnitModelAttrs {
  const a = unit.attributes;
  let chassis: ChassisType = 'wheeled';
  let movement = a.wheeledMovement ?? 0;

  if ((a.flightMovement ?? 0) >= 1) {
    chassis = 'flight';
    movement = a.flightMovement!;
  } else if ((a.limbMovement ?? 0) >= 1) {
    chassis = 'limbed';
    movement = a.limbMovement!;
  }

  return {
    chassis,
    movement: Math.max(1, movement),
    kinetic: a.kinetic ?? 0,
    rangeAttack: a.rangeAttack ?? 0,
    splashAttack: a.splashAttack ?? 0,
    antiAir: a.antiAir ?? 0,
    armour: a.armour ?? 0,
    defence: a.defence ?? 0,
    repair: a.repair ?? 0,
  };
}

/**
 * Get a cached sprite for a unit at its current facing.
 * Returns the ImageBitmap if already rendered, or null if still rendering.
 *
 * @param factionHex  Faction color (#RRGGBB) to tint bolt-on parts.
 */
export function getUnitSprite(unit: UnitData, factionHex?: string): ImageBitmap | null {
  return getUnitSpriteAtFacing(unit, factionHex, unit.facing);
}

/**
 * Get a cached sprite for a unit at a specific facing index.
 * This allows the caller to override the facing (e.g. to correct for
 * tile geometry on the local map projection).
 *
 * @param factionHex  Faction color (#RRGGBB) to tint bolt-on parts.
 * @param facing      Facing index (0–5) to retrieve.
 */
export function getUnitSpriteAtFacing(unit: UnitData, factionHex: string | undefined, facing: number): ImageBitmap | null {
  const attrs = unitDataToModelAttrs(unit);
  const key = attrKey(attrs, factionHex);

  const cached = spriteCache.get(key);
  if (cached && cached[facing]) return cached[facing];

  // Start async render for all 6 facings of this unit type
  if (!pendingRenders.has(key)) {
    pendingRenders.add(key);
    renderAllFacings(attrs, key, factionHex);
  }

  return null;
}

/**
 * Render all 6 facing directions for a unit model (async).
 */
async function renderAllFacings(attrs: UnitModelAttrs, key: string, factionHex?: string): Promise<void> {
  ensureRenderer();
  initMaterials();

  const results: (ImageBitmap | null)[] = new Array(FACING_COUNT).fill(null);

  for (let facing = 0; facing < FACING_COUNT; facing++) {
    // Build a fresh model
    const model = buildUnitModel(attrs, factionHex);

    // Rotate model around Y to face the correct direction.
    // Facing 0 = north (up on screen) = model front (-Z) points toward camera-up.
    // Each facing step is 60° clockwise (when viewed top-down = -Y rotation).
    // +π/4 compensates for the 45° isometric camera azimuth so that on-screen
    // bearings match expected hex directions: N=0°, NE=60°, SE=120°, S=180°, etc.
    model.rotation.y = -(facing * Math.PI) / 3 + Math.PI / 4;

    scene.add(model);
    renderer!.setRenderTarget(null);
    renderer!.clear();
    renderer!.render(scene, camera);
    scene.remove(model);

    const bitmap = await createImageBitmap(renderer!.domElement);
    results[facing] = bitmap;

    // Clean up geometry
    model.traverse((obj) => {
      if ((obj as THREE.Mesh).geometry) {
        (obj as THREE.Mesh).geometry.dispose();
      }
    });
  }

  spriteCache.set(key, results);
  pendingRenders.delete(key);
}

/**
 * Dispose the offscreen renderer to free the WebGL context.
 * Called after all immediate pre-renders complete so the globe can
 * safely create its own context without hitting browser limits.
 */
function disposeRenderer(): void {
  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = null;
  }
}

/**
 * Invalidate the cached sprites for a unit (by its current attributes) and
 * immediately re-render them. Use after a refit changes a unit's loadout.
 *
 * Does NOT call disposeRenderer() so the globe's WebGL context is unaffected.
 * Resolves once all 6 facings for the unit are cached.
 */
export async function rerenderUnitSprite(unit: UnitData, world?: WorldData): Promise<void> {
  const attrs = unitDataToModelAttrs(unit);
  const fc = world ? factionColor(world, unit.ownerId) : undefined;
  const key = attrKey(attrs, fc);
  // Force re-render even if key already in cache
  spriteCache.delete(key);
  pendingRenders.delete(key);
  pendingRenders.add(key);
  await renderAllFacings(attrs, key, fc);
}

/**
 * Pre-render sprites for all units in the world (call once on load).
 * Also schedules a re-render once the hull texture has finished loading.
 */
export async function preRenderUnits(units: UnitData[], world?: WorldData): Promise<void> {
  const seen = new Set<string>();
  for (const unit of units) {
    const attrs = unitDataToModelAttrs(unit);
    const fc = world ? factionColor(world, unit.ownerId) : undefined;
    const key = attrKey(attrs, fc);
    if (seen.has(key)) continue;
    seen.add(key);
    // Serialize renders — they share a single WebGL context and scene.
    // 10 s timeout guards against WebGL being unavailable (e.g. headless CI).
    await Promise.race([
      renderAllFacingsIfNeeded(attrs, key, fc),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }

  // Release the WebGL context so the globe view can create its own
  disposeRenderer();

  // Schedule a full re-render once texture is loaded so sprites get texture detail
  scheduleTextureRerender(units, world);
}

/**
 * Render all facings for a unit if not already cached or pending.
 */
async function renderAllFacingsIfNeeded(attrs: UnitModelAttrs, key: string, factionHex?: string): Promise<void> {
  if (spriteCache.has(key) || pendingRenders.has(key)) return;
  pendingRenders.add(key);
  await renderAllFacings(attrs, key, factionHex);
}

/** Track whether we've already queued a texture re-render. */
let textureRerenderScheduled = false;

/**
 * Poll for texture readiness and re-render all sprite caches once loaded.
 */
function scheduleTextureRerender(units: UnitData[], world?: WorldData): void {
  if (textureRerenderScheduled) return;
  if (isTextureReady()) return; // already loaded
  textureRerenderScheduled = true;

  const check = () => {
    if (isTextureReady()) {
      // Clear the sprite cache so all sprites re-render with the texture
      spriteCache.clear();
      pendingRenders.clear();
      const seen = new Set<string>();
      for (const unit of units) {
        const attrs = unitDataToModelAttrs(unit);
        const fc = world ? factionColor(world, unit.ownerId) : undefined;
        const key = attrKey(attrs, fc);
        if (seen.has(key)) continue;
        seen.add(key);
        getUnitSprite(unit, fc);
      }
    } else {
      setTimeout(check, 100);
    }
  };
  setTimeout(check, 100);
}
