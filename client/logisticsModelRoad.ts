/**
 * Logistics route meshes — Road vs Highway (Req 14.6).
 *
 * Extends the road rendering pattern from `client/firstPersonTerrain.ts`, where
 * roads are textured triangle planes built from a `THREE.BufferGeometry`, using
 * `artifacts/road.webp` on a `MeshStandardMaterial`, lifted fractionally above
 * the terrain (see `roadSurfaceLift()`/`ROAD_LIFT`) to avoid z-fighting.
 *
 * Instead of per-hex-segment triangles, a logistics route is a continuous ribbon
 * that follows the route's `Route_Segment` tile-centre path (the `pathPoints`
 * argument — one world-space point per tile centre along the route).
 *
 *   - `buildRoadMesh(pathPoints, opts?)`    — a single-lane ribbon (one mesh part).
 *   - `buildHighwayMesh(pathPoints, opts?)` — a WIDER, multi-lane ribbon plus a
 *     centre-line / lane-divider strip (two mesh parts), so a Highway is
 *     immediately distinguishable from a Road: it is measurably wider AND has
 *     more geometry parts for the same path.
 *
 * Both return a `THREE.Group` so `client/logisticsRenderer.ts` (task 15.2) can
 * treat them uniformly (add to scene, position, dispose children).
 *
 * Client-layer rules: no imports from `src/` or `server/`; `.js` import
 * extensions; named exports only.
 */

import * as THREE from 'three';
import roadUrl from '../artifacts/road.webp';
import { roadSurfaceLift } from './firstPersonTerrain.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default single-lane road width, in world units. Override via `opts.width`. */
export const ROAD_LANE_WIDTH = 0.5;

/**
 * How much wider a Highway ribbon is than a Road, per lane-width. A Highway is a
 * broad multi-lane ribbon, so its width comfortably exceeds a Road's for the same
 * path — the structural distinction tests (15.11) rely on this being > 1.
 */
export const HIGHWAY_WIDTH_FACTOR = 2.6;

/** Fraction of the ribbon width taken up by the centre lane-divider strip. */
const DIVIDER_WIDTH_FRAC = 0.06;

/** Default Y lift above the path points, matching the road-plane epsilon feel. */
const DEFAULT_LIFT = 0.02;

/** Options shared by both builders. */
export interface RoadMeshOptions {
  /** Base single-lane width in world units (defaults to {@link ROAD_LANE_WIDTH}). */
  width?: number;
  /**
   * Y-offset added on top of each path point's own height so the ribbon sits
   * above the terrain without z-fighting. Callers that know the hex world radius
   * should pass `roadSurfaceLift(hexWorldRadius)`; defaults to {@link DEFAULT_LIFT}.
   */
  lift?: number;
  /**
   * Optional shared road texture. When omitted, a lazily-loaded module-cached
   * `artifacts/road.webp` texture is used, matching `firstPersonTerrain.ts`.
   */
  texture?: THREE.Texture;
}

// ---------------------------------------------------------------------------
// Texture (lazy, module-cached — mirrors the road.webp material in firstPersonTerrain)
// ---------------------------------------------------------------------------

let cachedRoadTexture: THREE.Texture | null = null;

function getRoadTexture(): THREE.Texture {
  if (!cachedRoadTexture) {
    cachedRoadTexture = new THREE.TextureLoader().load(roadUrl);
    cachedRoadTexture.wrapS = THREE.ClampToEdgeWrapping;
    cachedRoadTexture.wrapT = THREE.RepeatWrapping;
  }
  return cachedRoadTexture;
}

function makeRoadMaterial(texture: THREE.Texture): THREE.MeshStandardMaterial {
  // Same material profile as the city road planes in firstPersonTerrain.ts.
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.85,
    metalness: 0.0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

// ---------------------------------------------------------------------------
// Ribbon geometry
// ---------------------------------------------------------------------------

/**
 * Build a flat ribbon `BufferGeometry` following `pathPoints`, `width` wide and
 * lifted by `lift` in Y. Each interior point uses the averaged tangent of its two
 * adjacent segments so joins stay smooth; endpoints use their single segment.
 * The perpendicular offset is taken in the horizontal (XZ) plane. UVs tile the
 * texture squarely: u spans 0..1 across the width, v accumulates distance/width
 * along the length (requires a `RepeatWrapping` texture on the V axis).
 *
 * Returns `null` for a degenerate path (< 2 usable points).
 */
function buildRibbonGeometry(
  pathPoints: THREE.Vector3[],
  width: number,
  lift: number
): THREE.BufferGeometry | null {
  // Drop consecutive duplicate points so tangents are well-defined.
  const pts: THREE.Vector3[] = [];
  for (const p of pathPoints) {
    if (pts.length === 0 || pts[pts.length - 1].distanceToSquared(p) > 1e-12) {
      pts.push(p.clone());
    }
  }
  if (pts.length < 2) return null;

  const half = width / 2;
  const up = new THREE.Vector3(0, 1, 0);

  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const vCoords: number[] = [];

  let accumDist = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];

    // Tangent along the path (averaged across the join at interior points).
    const tangent = new THREE.Vector3().subVectors(next, prev);
    tangent.y = 0; // keep the ribbon horizontal in cross-section
    if (tangent.lengthSq() < 1e-12) tangent.set(1, 0, 0);
    tangent.normalize();

    // Horizontal perpendicular = tangent × up (points to one side consistently).
    const perp = new THREE.Vector3().crossVectors(tangent, up);
    if (perp.lengthSq() < 1e-12) perp.set(0, 0, 1);
    perp.normalize().multiplyScalar(half);

    const base = pts[i];
    const y = base.y + lift;
    left.push(new THREE.Vector3(base.x - perp.x, y, base.z - perp.z));
    right.push(new THREE.Vector3(base.x + perp.x, y, base.z + perp.z));

    if (i > 0) accumDist += pts[i].distanceTo(pts[i - 1]);
    // v accumulates distance normalised by width so texels stay square.
    vCoords.push(width > 1e-9 ? accumDist / width : 0);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l0 = left[i];
    const r0 = right[i];
    const l1 = left[i + 1];
    const r1 = right[i + 1];
    const v0 = vCoords[i];
    const v1 = vCoords[i + 1];

    // Quad (l0, r0, r1, l1) → two triangles.
    positions.push(l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, r1.x, r1.y, r1.z);
    uvs.push(0, v0, 1, v0, 1, v1);

    positions.push(l0.x, l0.y, l0.z, r1.x, r1.y, r1.z, l1.x, l1.y, l1.z);
    uvs.push(0, v0, 1, v1, 0, v1);
  }

  if (positions.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/**
 * A single-lane road ribbon following the route's tile-centre path. Returns a
 * `THREE.Group` with one textured ribbon mesh (empty group for a degenerate path).
 */
export function buildRoadMesh(pathPoints: THREE.Vector3[], opts: RoadMeshOptions = {}): THREE.Group {
  const width = opts.width ?? ROAD_LANE_WIDTH;
  const lift = opts.lift ?? DEFAULT_LIFT;
  const group = new THREE.Group();
  group.name = 'logistics-road';

  const geo = buildRibbonGeometry(pathPoints, width, lift);
  if (!geo) return group;

  const texture = opts.texture ?? getRoadTexture();
  const mesh = new THREE.Mesh(geo, makeRoadMaterial(texture));
  mesh.name = 'road-surface';
  group.add(mesh);
  return group;
}

/**
 * A highway: a WIDER, multi-lane ribbon plus a bright centre-line / lane-divider
 * strip running down the middle. Returns a `THREE.Group` with two mesh parts
 * (surface + divider). For the same path this is measurably wider than
 * {@link buildRoadMesh} (by {@link HIGHWAY_WIDTH_FACTOR}) and has more mesh parts,
 * so a Highway is immediately distinguishable from a Road (Req 14.6).
 */
export function buildHighwayMesh(pathPoints: THREE.Vector3[], opts: RoadMeshOptions = {}): THREE.Group {
  const laneWidth = opts.width ?? ROAD_LANE_WIDTH;
  const lift = opts.lift ?? DEFAULT_LIFT;
  const ribbonWidth = laneWidth * HIGHWAY_WIDTH_FACTOR;

  const group = new THREE.Group();
  group.name = 'logistics-highway';

  const surfaceGeo = buildRibbonGeometry(pathPoints, ribbonWidth, lift);
  if (!surfaceGeo) return group;

  const texture = opts.texture ?? getRoadTexture();
  const surface = new THREE.Mesh(surfaceGeo, makeRoadMaterial(texture));
  surface.name = 'highway-surface';
  group.add(surface);

  // Centre lane-divider strip — a thin bright ribbon lifted a hair above the
  // surface so it reads as painted lane markings and never z-fights.
  const dividerGeo = buildRibbonGeometry(
    pathPoints,
    ribbonWidth * DIVIDER_WIDTH_FRAC,
    lift + 0.004
  );
  if (dividerGeo) {
    const dividerMat = new THREE.MeshStandardMaterial({
      color: 0xf4d03f,
      roughness: 0.6,
      metalness: 0.0,
      emissive: 0x2a2410,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const divider = new THREE.Mesh(dividerGeo, dividerMat);
    divider.name = 'highway-divider';
    group.add(divider);
  }

  return group;
}
