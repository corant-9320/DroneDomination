/**
 * Splash-bomb model loader — loads the `rocket_2.glb` munition once and hands
 * out normalized clones for the drone (flight chassis) splash-attack loadout.
 *
 * The drone's splash weapon is rendered as a bomb slung beneath the airframe
 * (see `addSplashAttack` in unitModelAddons.ts) instead of the procedural
 * rocket-pod used by ground chassis. The bomb's size scales with the unit's
 * splashAttack level.
 *
 * Loading is async but the unit-model pipeline (`buildUnitModel`) is sync, so
 * `preloadSplashBomb()` is awaited during startup (main.ts) before any sprites
 * are baked. Callers that run after startup (refit, first-person view) get the
 * cached template synchronously. If loading fails (e.g. a headless test
 * environment with no fetch), the template stays null and callers fall back to
 * the procedural launcher geometry.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import bombUrl from '../artifacts/rocket_2.glb?url';

/** Centred, unit-length (longest axis = 1, along +Z) template. Null until loaded. */
let template: THREE.Object3D | null = null;
/** Normalized bounding-box dimensions of the template (so callers can size it). */
let normalizedSize: THREE.Vector3 | null = null;
let loadPromise: Promise<void> | null = null;

/** True once the bomb model is loaded and clones can be produced. */
export function isSplashBombReady(): boolean {
  return template !== null;
}

/**
 * Load the bomb GLB once. Idempotent — repeated calls share one promise.
 * Resolves even on failure so startup never blocks on a missing asset.
 */
export function preloadSplashBomb(): Promise<void> {
  if (template) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve) => {
    const loader = new GLTFLoader();
    loader.load(
      bombUrl,
      (gltf) => {
        template = normalizeTemplate(gltf.scene);
        resolve();
      },
      undefined,
      (err) => {
        // Non-fatal: leave template null so callers use procedural fallback.
        console.warn('[splash-bomb] failed to load model, using fallback geometry:', err);
        resolve();
      },
    );
  });
  return loadPromise;
}

/**
 * Re-centre the loaded scene at the origin, reorient its longest axis to +Z
 * (so the bomb lies horizontally pointing forward), and scale so that longest
 * axis measures exactly 1 world unit. Callers then multiply by the desired
 * bomb length.
 */
function normalizeTemplate(scene: THREE.Object3D): THREE.Object3D {
  // Reorient: rotate the model's longest axis onto +Z.
  const preBox = new THREE.Box3().setFromObject(scene);
  const preSize = preBox.getSize(new THREE.Vector3());

  const orient = new THREE.Group();
  orient.add(scene);
  if (preSize.x >= preSize.y && preSize.x >= preSize.z) {
    orient.rotation.y = Math.PI / 2; // X → Z
  } else if (preSize.y >= preSize.x && preSize.y >= preSize.z) {
    orient.rotation.x = Math.PI / 2; // Y → Z
  }
  orient.updateMatrixWorld(true);

  // Centre at origin and scale so the longest dimension == 1.
  const box = new THREE.Box3().setFromObject(orient);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  orient.position.sub(center);

  const root = new THREE.Group();
  root.add(orient);
  root.scale.setScalar(1 / maxDim);
  root.updateMatrixWorld(true);

  normalizedSize = size.clone().multiplyScalar(1 / maxDim);
  return root;
}

/**
 * Produce a fresh, disposable clone of the bomb template, or null if the model
 * hasn't loaded. Geometry is deep-cloned so the sprite renderer's
 * `geometry.dispose()` pass never frees the shared template geometry.
 *
 * The returned object has the template transform baked in: centred at origin,
 * longest axis along +Z, total length 1 world unit before any caller scaling.
 */
export function buildSplashBomb(): THREE.Object3D | null {
  if (!template) return null;
  const clone = SkeletonUtils.clone(template);
  clone.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      mesh.geometry = mesh.geometry.clone();
    }
  });
  return clone;
}

/** Normalized (unit-length) bounding-box size of the template, or null if unloaded. */
export function splashBombNormalizedSize(): THREE.Vector3 | null {
  return normalizedSize ? normalizedSize.clone() : null;
}
