/**
 * Building Renderer — offscreen Three.js renderer that produces cached sprite
 * bitmaps from 3D building models, mirroring unitRenderer.ts.
 *
 * Buildings are static, so unlike units we render a SINGLE sprite per unique
 * loadout (no per-facing variants). The camera, lighting and sprite resolution
 * match unitRenderer.ts exactly so buildings sit at a consistent scale next to
 * units on the map.
 */

import * as THREE from 'three';
import { buildBuildingModel, EMPTY_BUILDING_ATTRS } from './buildingModel.js';
import type { BuildingModelAttrs } from './buildingModel.js';
import type { BuildingData, WorldData } from './worldData.js';
import { factionColor } from './colors.js';

// ---------------------------------------------------------------------------
// Configuration (kept identical to unitRenderer for consistent on-screen size)
// ---------------------------------------------------------------------------

const SPRITE_SIZE = 1024;

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

  const frustum = 2.5;
  camera = new THREE.OrthographicCamera(-frustum, frustum, frustum, -frustum, 0.1, 50);
  camera.position.set(3.42, 3.5, 0.916);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
  dirLight.position.set(2, 5, 3);
  scene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0xaabbff, 0.6);
  fillLight.position.set(-2, 3, -2);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.8);
  rimLight.position.set(0, 2, -4);
  scene.add(rimLight);
}

// ---------------------------------------------------------------------------
// Sprite Cache
// ---------------------------------------------------------------------------

const spriteCache = new Map<string, ImageBitmap>();
const pendingRenders = new Set<string>();

/** Bump when camera/model rendering changes to invalidate stale cached sprites. */
const SPRITE_VERSION = 'bld-v2';

function attrKey(attrs: BuildingModelAttrs, faction?: string): string {
  return `${SPRITE_VERSION}:${attrs.kinetic}:${attrs.rangeAttack}:${attrs.splashAttack}:${attrs.antiAir}:${attrs.armour}:${attrs.defence}:${attrs.repair}:${faction ?? ''}`;
}

/** Convert a building's optional attribute loadout into the model builder format. */
export function buildingDataToModelAttrs(building: BuildingData): BuildingModelAttrs {
  const a = building.attributes;
  if (!a) return EMPTY_BUILDING_ATTRS;
  return {
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
 * Get the cached sprite for a building. Returns the ImageBitmap if rendered,
 * or null if still rendering (a render is kicked off on first request).
 */
export function getBuildingSprite(building: BuildingData, factionHex?: string): ImageBitmap | null {
  const attrs = buildingDataToModelAttrs(building);
  const key = attrKey(attrs, factionHex);

  const cached = spriteCache.get(key);
  if (cached) return cached;

  if (!pendingRenders.has(key)) {
    pendingRenders.add(key);
    void renderBuilding(attrs, key, factionHex);
  }
  return null;
}

async function renderBuilding(attrs: BuildingModelAttrs, key: string, factionHex?: string): Promise<void> {
  ensureRenderer();

  const model = buildBuildingModel(attrs, factionHex);
  // Match the unit "facing 0" baseline so the structure reads at the same
  // isometric angle as nearby units (+45° compensates the camera azimuth).
  model.rotation.y = Math.PI / 4;

  scene.add(model);
  renderer!.setRenderTarget(null);
  renderer!.clear();
  renderer!.render(scene, camera);
  scene.remove(model);

  const bitmap = await createImageBitmap(renderer!.domElement);
  spriteCache.set(key, bitmap);
  pendingRenders.delete(key);

  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

/**
 * Invalidate the cached sprite for a building (by its current attributes) and
 * immediately re-render it. Use after a refit changes the loadout.
 *
 * Does NOT dispose the renderer (safe to call after the globe view exists).
 */
export async function rerenderBuildingSprite(building: BuildingData, world?: WorldData): Promise<void> {
  const attrs = buildingDataToModelAttrs(building);
  const fc = world ? factionColor(world, building.ownerId) : undefined;
  const key = attrKey(attrs, fc);
  spriteCache.delete(key);
  pendingRenders.delete(key);
  pendingRenders.add(key);
  await renderBuilding(attrs, key, fc);
}

function disposeRenderer(): void {
  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = null;
  }
}

/**
 * Pre-render sprites for all buildings in the world (call once on load, after
 * unit pre-rendering). Releases its WebGL context afterwards so the globe view
 * can create its own without hitting browser context limits.
 */
export async function preRenderBuildings(buildings: BuildingData[], world?: WorldData): Promise<void> {
  const seen = new Set<string>();
  for (const b of buildings) {
    const attrs = buildingDataToModelAttrs(b);
    const fc = world ? factionColor(world, b.ownerId) : undefined;
    const key = attrKey(attrs, fc);
    if (seen.has(key) || spriteCache.has(key)) continue;
    seen.add(key);
    pendingRenders.add(key);
    await Promise.race([
      renderBuilding(attrs, key, fc),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
  disposeRenderer();
}
