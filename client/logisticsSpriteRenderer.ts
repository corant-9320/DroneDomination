/**
 * Logistics Sprite Renderer — offscreen Three.js renderer that produces cached
 * 2D sprite bitmaps from the oil-logistics 3D models (oil well, refinery,
 * distribution hub), mirroring `buildingRenderer.ts` / `unitRenderer.ts`.
 *
 * The 3D logistics models (`client/logisticsModel*`) only render live inside a
 * THREE.Scene (globe / first-person via `logisticsRenderer.ts`). The tactical
 * local map, however, is a plain 2D canvas and previously showed these
 * structures as flat text badges (⛏ / R / H). This renderer bakes each
 * structure's detailed 3D model into an `ImageBitmap` once, so the 2D map can
 * blit a real sprite of the building instead of a glyph.
 *
 * Structures are static, so — like buildings — we render a SINGLE sprite per
 * unique (kind · segmentCount · faction) loadout (no per-facing variants). The
 * camera, lighting and sprite resolution match `buildingRenderer.ts` exactly so
 * logistics structures sit at a consistent scale next to buildings and units.
 *
 * Unlike buildings, the logistics models are purely procedural
 * `MeshStandardMaterial` geometry with no async texture loading, and they vary
 * a lot in native size (a compact well vs a wide multi-segment refinery). Each
 * model is therefore normalised to a common bounding-box fit before rendering so
 * every structure reads at a comparable on-screen footprint on the map.
 *
 * Client layering: NO imports from `src/` or `server/`. All imports use `.js`
 * extensions; named exports only.
 */

import * as THREE from 'three';
import { buildLogisticsModel } from './logisticsModel.js';
import type { LogisticsModelKind } from './logisticsModel.js';
import type { WorldData } from './worldData.js';
import { factionColor } from './colors.js';

// ---------------------------------------------------------------------------
// Configuration (kept identical to buildingRenderer for consistent on-screen size)
// ---------------------------------------------------------------------------

const SPRITE_SIZE = 1024;

/**
 * Every model is scaled so the largest dimension of its (rotated) bounding box
 * equals this many world units before rendering. This normalises the wildly
 * different native sizes of a well, hub and multi-segment refinery to a single
 * on-screen footprint, and keeps tall parts (flare stacks, gantries) inside the
 * orthographic frustum. Chosen to sit within the frustum (±2.5) with margin
 * while reading at roughly the same visual weight as an equipped building.
 */
const FIT_MAX_DIMENSION = 2.2;

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
const SPRITE_VERSION = 'logi-v1';

/** A structure's sprite is uniquely determined by kind, size and faction tint. */
function spriteKey(kind: LogisticsModelKind, segmentCount: number, faction?: string): string {
  return `${SPRITE_VERSION}:${kind}:${segmentCount}:${faction ?? ''}`;
}

/**
 * Get the cached sprite for a logistics structure. Returns the ImageBitmap if
 * rendered, or null if still rendering (a render is kicked off on first request).
 *
 * @param kind          Which static logistics structure ('well' | 'refinery' | 'hub' | 'bridge').
 * @param factionHex    Faction color (#RRGGBB) to tint metal parts, or undefined for neutral.
 * @param segmentCount  Refinery segment count (drives its size); ignored by other kinds.
 */
export function getLogisticsSprite(
  kind: LogisticsModelKind,
  factionHex?: string,
  segmentCount = 1,
): ImageBitmap | null {
  const key = spriteKey(kind, segmentCount, factionHex);

  const cached = spriteCache.get(key);
  if (cached) return cached;

  if (!pendingRenders.has(key)) {
    pendingRenders.add(key);
    void renderStructure(kind, segmentCount, key, factionHex);
  }
  return null;
}

/**
 * Rotate to the shared isometric baseline, then scale + recentre `model` so its
 * bounding box fits {@link FIT_MAX_DIMENSION} and it sits centred on the ground.
 * Returns the wrapper group to add to the scene.
 */
function fitModel(model: THREE.Group): THREE.Group {
  const holder = new THREE.Group();
  // Match the building "facing 0" baseline so the structure reads at the same
  // isometric angle as nearby buildings (+45° compensates the camera azimuth).
  model.rotation.y = Math.PI / 4;
  holder.add(model);

  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  holder.scale.setScalar(FIT_MAX_DIMENSION / maxDim);

  // Recentre horizontally on the origin and drop the base onto the ground plane
  // so framing matches the ground-anchored building/unit models.
  holder.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(holder);
  const centre = fitted.getCenter(new THREE.Vector3());
  holder.position.x -= centre.x;
  holder.position.z -= centre.z;
  holder.position.y -= fitted.min.y;

  return holder;
}

async function renderStructure(
  kind: LogisticsModelKind,
  segmentCount: number,
  key: string,
  factionHex?: string,
): Promise<void> {
  ensureRenderer();

  const model = buildLogisticsModel(kind, factionHex, { segmentCount });
  const holder = fitModel(model);

  scene.add(holder);
  renderer!.setRenderTarget(null);
  renderer!.clear();
  renderer!.render(scene, camera);
  scene.remove(holder);

  const bitmap = await createImageBitmap(renderer!.domElement);
  spriteCache.set(key, bitmap);
  pendingRenders.delete(key);

  holder.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

function disposeRenderer(): void {
  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = null;
  }
}

/**
 * Pre-render sprites for every logistics structure present in the world (call
 * once on load, alongside unit/building pre-rendering). Releases its WebGL
 * context afterwards so the globe view can create its own without hitting
 * browser context limits.
 */
export async function preRenderLogistics(world: WorldData): Promise<void> {
  const logistics = world.logistics;
  if (!logistics) return;

  const jobs: Array<{ kind: LogisticsModelKind; segmentCount: number; faction?: string }> = [];
  const seen = new Set<string>();

  const enqueue = (kind: LogisticsModelKind, ownerId: string, segmentCount = 1): void => {
    const faction = ownerId ? factionColor(world, ownerId) : undefined;
    const key = spriteKey(kind, segmentCount, faction);
    if (seen.has(key) || spriteCache.has(key)) return;
    seen.add(key);
    jobs.push({ kind, segmentCount, faction });
  };

  for (const well of logistics.wells ?? []) enqueue('well', well.ownerId);
  for (const hub of logistics.hubs ?? []) enqueue('hub', hub.ownerId);
  for (const refinery of logistics.refineries ?? []) {
    enqueue('refinery', refinery.ownerId, Math.max(1, refinery.segments?.length ?? 1));
  }

  for (const job of jobs) {
    const key = spriteKey(job.kind, job.segmentCount, job.faction);
    pendingRenders.add(key);
    await Promise.race([
      renderStructure(job.kind, job.segmentCount, key, job.faction),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }

  disposeRenderer();
}
