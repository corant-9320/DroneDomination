/**
 * First-person 3D command overlays — the translucent movement-range hex fills
 * and the hover route line, drawn flush on the rendered (tilted) terrain.
 *
 * Extracted verbatim from `firstPersonView.ts`. Every function takes the view's
 * projection context ({@link FpViewContext}) and the target group explicitly, so
 * nothing here needs access to the view instance.
 */

import * as THREE from 'three';
import type { FlatTile } from './localMapProjection.js';
import type { MovementRangeResult, MovementCostRoute } from './localMapMovement.js';
import { elevationWorldHeight } from './firstPersonTerrain.js';
import { ELEV_WORLD_SCALE } from './firstPersonConstants.js';
import { sampleSurface, segmentCentroid, type FpViewContext } from './firstPersonGeometry.js';

/** Lift a flat-space point onto the rendered terrain surface (+ epsilon). */
export function liftFlat(ctx: FpViewContext, ft: FlatTile, x: number, y: number, eps = 0.12): THREE.Vector3 {
  const [wx, , wz] = ctx.toWorld(x, y);
  const top = elevationWorldHeight(ctx.world.tiles[ft.tileIndex], ELEV_WORLD_SCALE);
  const h = sampleSurface(ft, x, y, ctx.toWorld, ctx.heightOf, top).height;
  return new THREE.Vector3(wx, h + eps, wz);
}

/** Translucent fill of one hex segment triangle (centre, vertex s, vertex s+1). */
export function addSegmentFill(
  ctx: FpViewContext,
  group: THREE.Group,
  ft: FlatTile,
  seg: number,
  color: number,
  opacity: number,
): void {
  const n = ft.poly.length;
  const a = liftFlat(ctx, ft, ft.cx, ft.cy);
  const b = liftFlat(ctx, ft, ft.poly[seg % n].x, ft.poly[seg % n].y);
  const c = liftFlat(ctx, ft, ft.poly[(seg + 1) % n].x, ft.poly[(seg + 1) % n].y);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]), 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
  group.add(new THREE.Mesh(geo, mat));
}

/** Rebuild the movement-range fill overlay from the current range result. */
export function rebuildRangeOverlay(
  ctx: FpViewContext,
  group: THREE.Group | null,
  rangeResult: MovementRangeResult | null,
): void {
  if (!group) return;
  clearGroup(group);
  const rr = rangeResult;
  if (!rr) return;

  for (const [key, zone] of rr.reachableSegments) {
    const ft = ctx.tileById.get(Math.floor(key / 6));
    if (!ft) continue;
    addSegmentFill(ctx, group, ft, key % 6, zone === 'attackReady' ? 0x33dd66 : 0x4488ff, 0.22);
  }
  // Static weapon-range segments (attack without moving) — red, where not already a move tint.
  for (const key of rr.staticAttackSegments) {
    if (rr.reachableSegments.has(key)) continue;
    const ft = ctx.tileById.get(Math.floor(key / 6));
    if (!ft) continue;
    addSegmentFill(ctx, group, ft, key % 6, 0xff4444, 0.18);
  }
}

function zoneColor(zone?: string): number {
  if (zone === 'attackReady') return 0x33dd66;
  if (zone === 'weaponRange') return 0xff4444;
  return 0x4488ff; // moveOnly / default
}

/** Centroid of a tile segment lifted onto the terrain surface (route height). */
function centroidLift(ctx: FpViewContext, tileIndex: number, segment: number): THREE.Vector3 | null {
  const ft = ctx.tileById.get(tileIndex);
  if (!ft) return null;
  const cen = segmentCentroid(ft, segment);
  return liftFlat(ctx, ft, cen.x, cen.y, 0.28);
}

/** Rebuild the hover route line, colouring each hop by its zone. */
export function rebuildRouteOverlay(
  ctx: FpViewContext,
  group: THREE.Group | null,
  route: MovementCostRoute | null,
): void {
  if (!group) return;
  clearGroup(group);
  if (!route) return;

  let prev = centroidLift(ctx, route.startTile, route.startSegment);
  for (const hop of route.hops) {
    const cur = centroidLift(ctx, hop.tileIndex, hop.segment);
    if (prev && cur) {
      const geo = new THREE.BufferGeometry().setFromPoints([prev, cur]);
      const mat = new THREE.LineBasicMaterial({ color: zoneColor(hop.zone) });
      group.add(new THREE.Line(geo, mat));
    }
    prev = cur ?? prev;
  }
}

/** Remove all children of an overlay group, disposing their geometry + material. */
export function clearGroup(group: THREE.Group | null): void {
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
