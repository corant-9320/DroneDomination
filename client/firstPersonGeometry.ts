/**
 * Pure geometry helpers for the first-person view, working in the flat-view
 * projected coordinate space (the SAME tangent-plane projection the 2D local map
 * uses, see `localMapProjection.buildFlatView`).
 *
 * Extracted verbatim from `firstPersonView.ts`. These stay client-local rather
 * than moving to `shared/`:
 *  - `sampleSurface` / `orientToSurface` depend on THREE, which `shared/` must
 *    not pull in (it is imported by `src/` and `server/` too).
 *  - `segmentCentroid` / `baryWeights` are pure maths, but the only other
 *    client consumers of "segment centroid" (`localMapUnits.getSegmentCentroid`,
 *    `movementDraw.getSegmentCentroidLocal`) take a `TileData` as well and
 *    return null for non-hex tiles — a different contract, so folding them
 *    together would change 2D-map behaviour.
 */

import * as THREE from 'three';
import type { WorldData } from './worldData.js';
import type { FlatTile } from './localMapProjection.js';

/**
 * Everything the first-person placement/overlay maths needs to turn flat-view
 * coordinates into world-space points. Built fresh from the view's captured
 * projection state on each use, so a `setWorld()` swap is always picked up.
 */
export interface FpViewContext {
  /** Live world data (units, buildings, tiles, logistics). */
  world: WorldData;
  /** Tiles currently projected into the flat view. */
  flatTiles: FlatTile[];
  /** Fast lookup of the same tiles by tile index. */
  tileById: Map<number, FlatTile>;
  /** Flat (px, py) → world (x, y=0, z). */
  toWorld: (px: number, py: number) => [number, number, number];
  /** Shared (neighbour-averaged) height of a boundary vertex of a tile. */
  heightOf: (tileIndex: number, p: { x: number; y: number }) => number;
}

/** Centroid of a hex segment (triangle: centre, vertex s, vertex s+1) in flat coords. */
export function segmentCentroid(ft: FlatTile, segment: number): { x: number; y: number } {
  const n = ft.poly.length;
  const v0 = ft.poly[segment % n];
  const v1 = ft.poly[(segment + 1) % n];
  return { x: (ft.cx + v0.x + v1.x) / 3, y: (ft.cy + v0.y + v1.y) / 3 };
}

/**
 * Barycentric weights of point (px,py) within triangle a-b-c (flat coords).
 * Returns [wa, wb, wc] or null for a degenerate triangle. Weights are invariant
 * under the uniform scale + y-flip of `toWorld`, so they're computed in flat
 * space and reused to interpolate world-space heights.
 */
export function baryWeights(
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
export function sampleSurface(
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
export function orientToSurface(model: THREE.Object3D, up: THREE.Vector3, dir: { x: number; z: number }): void {
  const y = up.clone().normalize();
  // Local +Z = backward; tangent it onto the surface so the model lies flush.
  const z = new THREE.Vector3(-dir.x, 0, -dir.z);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-9) z.set(0, 0, 1); // facing parallel to normal — pick any tangent
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
