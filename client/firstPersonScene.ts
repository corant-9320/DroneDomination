/**
 * First-person scene construction — the renderer/lighting setup plus the
 * (re)builders for every 3D population of the field: unit models, buildings,
 * the Oil Logistics network, and static forest scenery. Also owns the
 * placement maths that turns an entity id into a world-space point (missile
 * muzzles, explosion centres, the camera's shoulder focus).
 *
 * Extracted verbatim from `firstPersonView.ts`. Each builder takes the view's
 * projection context ({@link FpViewContext}) plus the group and the
 * geometry/material ownership arrays it must fill, so none of it needs access to
 * the view instance. The view still owns the arrays and disposes them on close.
 */

import * as THREE from 'three';
import type { UnitData, TileData, BuildingData } from './worldData.js';
import type { FlatTile } from './localMapProjection.js';
import { getMaxMovement } from '../shared/movementConstants.js';
import { mulberry32 } from '../shared/rng.js';
import { facingDirection } from './facing.js';
import { buildUnitModel } from './unitModel.js';
import { unitDataToModelAttrs } from './unitRenderer.js';
import { buildBuildingModel, BUILDING_BASE_FOOTPRINT } from './buildingModel.js';
import { buildLogisticsModel } from './logisticsModel.js';
import { buildTransportModel } from './logisticsModelTransport.js';
import { buildRoadMesh, buildHighwayMesh } from './logisticsModelRoad.js';
import { buildingDataToModelAttrs } from './buildingRenderer.js';
import { factionColor } from './colors.js';
import { elevationWorldHeight, roadSurfaceLift } from './firstPersonTerrain.js';
import {
  getShowEntityNumbers,
  getShowEntitySelectionRings,
  getShowEntityStatusBars,
  getShowEntityUnitCircles,
} from './localMapUnits.js';
import {
  segmentCentroid,
  sampleSurface,
  orientToSurface,
  type FpViewContext,
} from './firstPersonGeometry.js';
import {
  HEX_WORLD_RADIUS,
  ELEV_WORLD_SCALE,
  FIELD_EXTENT,
  DRONE_AIR_HEIGHT,
  TREES_PER_HEX,
  TREE_HEX_FRACTION,
  UNIT_HEX_FRACTION,
  BUILDING_HEX_FRACTION,
  SELECT_RING_RADIUS,
  FACTION_RING_RADIUS,
} from './firstPersonConstants.js';

/** A resource the view releases on close. */
type Disposable = { dispose: () => void };

/** A drone is any unit with at least one point of flight movement. */
export function isDrone(unit: UnitData): boolean {
  return (unit.attributes.flightMovement ?? 0) >= 1;
}

/**
 * Build a THREE.Sprite showing the oil hex id (tile index) below an oil
 * structure/deposit model, matching the 2D local map's amber "#N" labels
 * (see `localMapUnits.ts::drawOilHexNumber`). Plain tile-index numbers, not
 * the internal entity id hash — this is what the shuttle-transport
 * destination picker shows.
 */
function buildOilHexNumberSprite(tileIndex: number): THREE.Sprite {
  const labelText = `#${tileIndex}`;
  const cvs = document.createElement('canvas');
  cvs.width = 128; cvs.height = 64;
  const ctx2d = cvs.getContext('2d')!;
  ctx2d.clearRect(0, 0, 128, 64);
  ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
  ctx2d.font = 'bold 36px sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(labelText, 65, 33);
  ctx2d.fillStyle = 'rgba(244,208,63,0.95)'; // amber — matches the oil-deposit ring colour
  ctx2d.fillText(labelText, 64, 32);
  const tex = new THREE.CanvasTexture(cvs);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  return new THREE.Sprite(mat);
}

/**
 * Create the scene, camera and WebGL renderer for the given canvas, with the
 * soft "daytime" lighting rig and horizon fog.
 */
export function buildScene(canvas: HTMLCanvasElement): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
} {
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x9ec7e8);
  scene.background = sky;
  // Fog starts beyond the battlefield so the whole field stays visible even
  // when zoomed out; it only softens the far horizon.
  scene.fog = new THREE.Fog(sky, FIELD_EXTENT * 2.2, FIELD_EXTENT * 5);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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

  return { scene, camera, renderer };
}

/**
 * World-space impact point near the middle of a building's body, used as the
 * missile target / explosion centre. Mirrors the placement maths in the
 * building `place()` helper (segment centroid → tilted surface sample) and
 * lifts to roughly mid-structure height.
 */
export function buildingWorldPos(ctx: FpViewContext, buildingId: string): THREE.Vector3 | null {
  const b = ctx.world.buildings.find((bb) => bb.id === buildingId);
  if (!b) return null;
  const ft = ctx.tileById.get(b.tileIndex);
  if (!ft) return null;
  const cen = segmentCentroid(ft, b.segment);
  const [wx, , wz] = ctx.toWorld(cen.x, cen.y);
  const fallbackTop = elevationWorldHeight(ctx.world.tiles[b.tileIndex], ELEV_WORLD_SCALE);
  // Clamp to the tile plateau so a building on a shore segment (whose outer
  // vertices slope down to the waterline) rests on dry ground rather than
  // sinking. The terrain mesh still slopes; only the building base is lifted.
  const groundY = Math.max(
    sampleSurface(ft, cen.x, cen.y, ctx.toWorld, ctx.heightOf, fallbackTop).height,
    fallbackTop,
  );
  const bodyLift = HEX_WORLD_RADIUS * BUILDING_HEX_FRACTION * 0.5;
  return new THREE.Vector3(wx, groundY + bodyLift, wz);
}

/**
 * World-space position near a unit's body centre, used as a missile muzzle /
 * impact point. Mirrors the placement maths in rebuildUnits (segment centroid
 * → tilted surface sample → drone air hover) and lifts to roughly mid-body.
 */
export function unitWorldPos(ctx: FpViewContext, unitId: string): THREE.Vector3 | null {
  const unit = ctx.world.units.find((u) => u.id === unitId);
  if (!unit) return null;
  const ft = ctx.tileById.get(unit.tileIndex);
  if (!ft) return null;
  const cen = segmentCentroid(ft, unit.segment);
  const [wx, , wz] = ctx.toWorld(cen.x, cen.y);
  const fallbackTop = elevationWorldHeight(ctx.world.tiles[unit.tileIndex], ELEV_WORLD_SCALE);
  // Clamp to the tile plateau so a unit on a shore/water-adjacent segment
  // (whose outer vertices are pinned to the waterline by buildVertexHeight)
  // doesn't sample a triangle dragged down to the ocean floor — mirrors the
  // building anti-sink clamp (see DECISIONS.md 2026-07-01 / 2026-07-03).
  const groundY = Math.max(
    sampleSurface(ft, cen.x, cen.y, ctx.toWorld, ctx.heightOf, fallbackTop).height,
    fallbackTop,
  );
  const air = isDrone(unit) ? DRONE_AIR_HEIGHT : 0;
  // Aim at roughly the unit's mid-body so missiles fly between models, not feet.
  const bodyLift = HEX_WORLD_RADIUS * UNIT_HEX_FRACTION * 0.5 + HEX_WORLD_RADIUS * 0.12;
  return new THREE.Vector3(wx, groundY + air + bodyLift, wz);
}

/**
 * Point roughly at a unit's shoulder — its mid-body lifted toward the top of
 * the torso. Used as the focal point for the boom zoom.
 */
export function shoulderWorldPos(ctx: FpViewContext, unitId: string): THREE.Vector3 | null {
  const mid = unitWorldPos(ctx, unitId);
  if (!mid) return null;
  mid.y += HEX_WORLD_RADIUS * UNIT_HEX_FRACTION * 0.35;
  return mid;
}

/** (Re)build a 3D model for every unit in view, into the units group. */
export function rebuildUnits(args: {
  ctx: FpViewContext;
  scene: THREE.Scene | null;
  group: THREE.Group | null;
  /** Geometries owned by the units group — cleared and refilled here. */
  geoms: THREE.BufferGeometry[];
  /** Unique materials owned by the units group — cleared and refilled here. */
  mats: THREE.Material[];
  selectedUnitId: string | null;
  /** Remaining movement points for a unit (drives the movement bar). */
  remainingMP: (unitId: string) => number;
}): void {
  const { ctx, scene, group, geoms, mats, remainingMP } = args;
  if (!scene || !group) return;

  // Tear down previous models (dispose geometries; materials are shared).
  for (const child of [...group.children]) group.remove(child);
  for (const g of geoms) {
    try { g.dispose(); } catch { /* best-effort */ }
  }
  geoms.length = 0;
  for (const m of mats) {
    try { m.dispose(); } catch { /* best-effort */ }
  }
  mats.length = 0;

  const toWorld = ctx.toWorld;
  const heightOf = ctx.heightOf;
  const selectedUnitId = args.selectedUnitId ?? '';
  const tileById = ctx.tileById;

  for (const unit of ctx.world.units) {
    const ft = tileById.get(unit.tileIndex);
    if (!ft) continue;

    const attrs = unitDataToModelAttrs(unit);
    const fc = factionColor(ctx.world, unit.ownerId);
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
    const fallbackTop = elevationWorldHeight(ctx.world.tiles[unit.tileIndex], ELEV_WORLD_SCALE);
    const sampled = sampleSurface(ft, cen.x, cen.y, toWorld, heightOf, fallbackTop);
    // Clamp to the tile plateau so a unit on a shore/water-adjacent segment
    // (whose outer vertices are pinned to the waterline by buildVertexHeight)
    // doesn't sample a triangle dragged down to the ocean floor, which hid
    // the model below the terrain mesh entirely — mirrors the building
    // anti-sink clamp (see DECISIONS.md 2026-07-01 / 2026-07-03). When the
    // clamp kicks in, treat the ground as flat plateau (upright normal)
    // rather than the (invalid) sampled slope.
    const clamped = sampled.height < fallbackTop;
    const groundY = clamped ? fallbackTop : sampled.height;
    const normal = clamped ? new THREE.Vector3(0, 1, 0) : sampled.normal;

    // City hexes have road/pavement geometry lifted by ROAD_LIFT above the raw
    // terrain mesh. Raise the unit by the same offset so it stands on the road
    // surface rather than sinking into it.
    const cityLift = ctx.world.tiles[unit.tileIndex].city ? roadSurfaceLift(HEX_WORLD_RADIUS) : 0;

    const dir = facingDirection(ft, unit.facing);
    const drone = isDrone(unit);

    // Ground units conform to the surface normal; drones hover level above it.
    const up = drone ? new THREE.Vector3(0, 1, 0) : normal;
    orientToSurface(model, up, dir);

    // Lift the model's base clear of the surface along the surface normal so a
    // tilted unit doesn't sink a corner into the slope. Drones add air hover.
    // cityLift raises ground units to the road surface on city hexes.
    const air = drone ? DRONE_AIR_HEIGHT : 0;
    model.position.set(
      wx + up.x * groundLift,
      groundY + up.y * groundLift + air + cityLift,
      wz + up.z * groundLift,
    );

    // Faction-colour ring on the ground under every unit so the tiny models
    // are easy to spot and tell apart by side. Laid flush with the terrain
    // surface (conforms to the slope normal) so it isn't cropped by the
    // hillside — for drones this sits on the ground directly beneath the hover.
    const ringUp = normal.clone().normalize();
    if (getShowEntityUnitCircles()) {
      const factionRingGeo = new THREE.RingGeometry(FACTION_RING_RADIUS * 0.75, FACTION_RING_RADIUS, 32);
      const factionRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(fc), transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      const factionRing = new THREE.Mesh(factionRingGeo, factionRingMat);
      // Disable frustum culling — a flat ring's bounding sphere is near-zero
      // height, causing it to be culled as soon as the camera moves away even
      // though the ring is still visible in the distance. The whole point of
      // the ring is to identify units when they're small and far away.
      factionRing.frustumCulled = false;
      // RingGeometry faces +Z; rotate that onto the surface normal so the ring
      // lies on the slope instead of a flat horizontal plane.
      factionRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ringUp);
      factionRing.position.set(
        wx + ringUp.x * 0.02,
        groundY + ringUp.y * 0.02 + cityLift,
        wz + ringUp.z * 0.02,
      );
      group.add(factionRing);
      geoms.push(factionRingGeo);
      mats.push(factionRingMat);
    }

    // Subtle highlight ring under the selected unit. Sized off the hex (not
    // the unit) so the tiny model is still easy to locate. Conforms to the
    // slope like the faction ring.
    if (getShowEntitySelectionRings() && unit.id === selectedUnitId) {
      const ringGeo = new THREE.RingGeometry(SELECT_RING_RADIUS * 0.8, SELECT_RING_RADIUS, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.frustumCulled = false; // same reason as faction ring above
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ringUp);
      ring.position.set(
        wx + ringUp.x * 0.03,
        groundY + ringUp.y * 0.03,
        wz + ringUp.z * 0.03,
      );
      group.add(ring);
      geoms.push(ringGeo);
      mats.push(ringMat);
    }

    group.add(model);
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geoms.push(mesh.geometry);
    });

    // ── Floating health bar ────────────────────────────────────────────
    if (getShowEntityStatusBars()) {
      const HP_PER_POINT = 10;
      const maxHp = (unit.attributes.size ?? 1) * HP_PER_POINT;
      const ratio = Math.max(0, Math.min(1, unit.currentHealth / maxHp));


      const barW = 128;
      const barH = 20;
      const barCvs = document.createElement('canvas');
      barCvs.width = barW; barCvs.height = barH;
      const bc = barCvs.getContext('2d')!;

      // Background
      bc.fillStyle = 'rgba(0,0,0,0.7)';
      bc.beginPath();
      bc.roundRect(0, 0, barW, barH, 4);
      bc.fill();

      // Filled portion (green → yellow → red)
      const fillW = Math.round((barW - 4) * ratio);
      if (fillW > 0) {
        if (ratio >= 0.66) {
          bc.fillStyle = '#44dd44';
        } else if (ratio >= 0.33) {
          bc.fillStyle = '#dddd22';
        } else {
          bc.fillStyle = '#ee3322';
        }
        bc.beginPath();
        bc.roundRect(2, 2, fillW, barH - 4, 3);
        bc.fill();
      }

      const barTex = new THREE.CanvasTexture(barCvs);
      const barMat = new THREE.SpriteMaterial({ map: barTex, depthTest: false, transparent: true });
      const barSprite = new THREE.Sprite(barMat);
      const barScale = HEX_WORLD_RADIUS * 0.35 * 0.25;
      // Position just above the model top; drones offset by their air height.
      const modelTop = groundY + groundLift + (drone ? DRONE_AIR_HEIGHT : 0);
      barSprite.scale.set(barScale, barScale * (barH / barW), 1);
      barSprite.position.set(wx, modelTop + barScale * 0.18, wz);
      group.add(barSprite);
      mats.push(barMat);

      // Movement bar — same fixed 0–5 scale and maximum-MP tick as the 2D map.
      const movementCvs = document.createElement('canvas');
      movementCvs.width = barW; movementCvs.height = barH;
      const mc = movementCvs.getContext('2d')!;
      mc.fillStyle = 'rgba(0,0,0,0.7)';
      mc.beginPath();
      mc.roundRect(0, 0, barW, barH, 4);
      mc.fill();

      const MOVEMENT_SCALE = 5;
      const currentMP = Math.max(0, remainingMP(unit.id));
      const maxMP = getMaxMovement(unit.attributes);
      const movementFillW = Math.round((barW - 4) * Math.min(1, currentMP / MOVEMENT_SCALE));
      if (movementFillW > 0) {
        mc.fillStyle = '#4488ff';
        mc.beginPath();
        mc.roundRect(2, 2, movementFillW, barH - 4, 3);
        mc.fill();
      }
      const maxTickX = 2 + (barW - 4) * Math.min(1, maxMP / MOVEMENT_SCALE);
      mc.fillStyle = '#44dd44';
      mc.fillRect(maxTickX - 1, 2, 2, barH - 4);

      const movementTex = new THREE.CanvasTexture(movementCvs);
      const movementMat = new THREE.SpriteMaterial({ map: movementTex, depthTest: false, transparent: true });
      const movementSprite = new THREE.Sprite(movementMat);
      movementSprite.scale.set(barScale, barScale * (barH / barW), 1);
      movementSprite.position.set(wx, modelTop + barScale * 0.13, wz);
      group.add(movementSprite);
      mats.push(movementMat);
    }

    // Unit number label — no background, white text with drop-shadow, below the model
    // (matches the 2D local-map style: white text underneath the unit icon, no box).
    if (getShowEntityNumbers()) {
      const idSuffix = unit.id.replace(/^unit_/, '');
      const labelText = `#${idSuffix}`;
      const cvs = document.createElement('canvas');
      cvs.width = 128; cvs.height = 64;
      const ctx2d = cvs.getContext('2d')!;
      ctx2d.clearRect(0, 0, 128, 64);
      // Drop-shadow pass (1 px offset, semi-transparent black)
      ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
      ctx2d.font = 'bold 36px sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText(labelText, 65, 33);
      // White text
      ctx2d.fillStyle = 'rgba(220,220,220,0.85)';
      ctx2d.fillText(labelText, 64, 32);
      const labelTex = new THREE.CanvasTexture(cvs);
      const labelMat = new THREE.SpriteMaterial({ map: labelTex, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(labelMat);
      const labelScale = HEX_WORLD_RADIUS * 0.35 * 0.25;
      // Position below the model base (groundY), not above the top.
      const labelY = groundY - labelScale * 0.3;
      sprite.scale.set(labelScale, labelScale * 0.5, 1);
      sprite.position.set(wx, labelY, wz);
      group.add(sprite);
      mats.push(labelMat);
    }
  }
}

/**
 * (Re)build a 3D model for every building into the buildings group. Real
 * buildings render solid; planned buildings (the same ones the City Design
 * planner shows as ghosts) render translucent. Buildings are immobile
 * full-segment structures, so they're placed upright at their segment
 * centroid — front facing the segment's outer edge — without slope tilt.
 */
export function rebuildBuildings(args: {
  ctx: FpViewContext;
  scene: THREE.Scene | null;
  group: THREE.Group | null;
  /** Geometries owned by the buildings group — cleared and refilled here. */
  geoms: THREE.BufferGeometry[];
  /** Materials owned by the buildings group (fresh per build) — cleared and refilled here. */
  mats: THREE.Material[];
}): void {
  const { ctx, scene, group, geoms, mats } = args;
  if (!scene || !group) return;

  // Tear down previous models (dispose geometries AND materials).
  for (const child of [...group.children]) group.remove(child);
  for (const g of geoms) {
    try { g.dispose(); } catch { /* best-effort */ }
  }
  geoms.length = 0;
  for (const m of mats) {
    try { m.dispose(); } catch { /* best-effort */ }
  }
  mats.length = 0;

  const toWorld = ctx.toWorld;
  const heightOf = ctx.heightOf;
  const tileById = ctx.tileById;

  const place = (b: BuildingData, ghost: boolean): void => {
    const ft = tileById.get(b.tileIndex);
    if (!ft) return;

    const attrs = buildingDataToModelAttrs(b);
    const fc = factionColor(ctx.world, b.ownerId);
    const model = buildBuildingModel(attrs, fc);

    // Scale the structure to a building footprint (much larger than units).
    // Scale from the fixed base-block footprint — NOT the full bounding box —
    // so every building's body reads at the same on-screen size regardless of
    // equipment. Horizontally-protruding gear (gun barrels, anti-air dishes)
    // is then free to extend past the hex fraction instead of shrinking the
    // whole structure to make room for it.
    const s = (HEX_WORLD_RADIUS * BUILDING_HEX_FRACTION) / BUILDING_BASE_FOOTPRINT;
    model.scale.setScalar(s);

    // Sit the base flush on the terrain at the segment centroid, standing
    // upright (buildings don't tilt with the slope the way units do).
    const box2 = new THREE.Box3().setFromObject(model);
    const groundLift = -box2.min.y;
    const cen = segmentCentroid(ft, b.segment);
    const [wx, , wz] = toWorld(cen.x, cen.y);
    const fallbackTop = elevationWorldHeight(ctx.world.tiles[b.tileIndex], ELEV_WORLD_SCALE);
    // Clamp to the tile plateau so a building on a shore segment (whose outer
    // vertices slope down to the waterline) rests on dry ground instead of
    // sinking. Terrain still slopes; only the building base is lifted.
    const groundY = Math.max(
      sampleSurface(ft, cen.x, cen.y, toWorld, heightOf, fallbackTop).height,
      fallbackTop,
    );

    const dir = facingDirection(ft, b.segment);
    orientToSurface(model, new THREE.Vector3(0, 1, 0), dir);
    model.position.set(wx, groundY + groundLift, wz);

    // Planned buildings render as translucent "ghosts" (mirrors the dashed
    // grey markers the City Design planner draws).
    if (ghost) {
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (mat && 'opacity' in mat) {
          mat.transparent = true;
          mat.opacity = 0.35;
          mat.depthWrite = false;
        }
      });
    }

    group.add(model);
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geoms.push(mesh.geometry);
      const mat = mesh.material;
      if (Array.isArray(mat)) mats.push(...mat);
      else if (mat) mats.push(mat as THREE.Material);
    });

    // Building number label — no background, white text with drop-shadow, below the base
    // (matches the 2D local-map style: white text underneath, no box).
    if (!ghost && getShowEntityNumbers()) {
      const bIdSuffix = b.id.replace(/^building_/, '');
      const labelText = `#${bIdSuffix}`;
      const cvs = document.createElement('canvas');
      cvs.width = 128; cvs.height = 64;
      const ctx2d = cvs.getContext('2d')!;
      ctx2d.clearRect(0, 0, 128, 64);
      // Drop-shadow pass
      ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
      ctx2d.font = 'bold 36px sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText(labelText, 65, 33);
      // White text
      ctx2d.fillStyle = 'rgba(220,220,220,0.85)';
      ctx2d.fillText(labelText, 64, 32);
      const labelTex = new THREE.CanvasTexture(cvs);
      const labelMat = new THREE.SpriteMaterial({ map: labelTex, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(labelMat);
      const labelScale = HEX_WORLD_RADIUS * 0.55 * 0.25;
      // Position below the building base (groundY), not above the top.
      sprite.scale.set(labelScale, labelScale * 0.5, 1);
      sprite.position.set(wx, groundY - labelScale * 0.3, wz);
      group.add(sprite);
      geoms.push(); // no geometry to track for the sprite
      mats.push(labelMat); // labelTex is owned by labelMat and released with it
    }
  };

  for (const b of ctx.world.buildings) place(b, false);
  for (const b of ctx.world.plannedBuildings ?? []) place(b, true);
}

/**
 * (Re)build the full-detail 3D Oil Logistics network for every entity in view,
 * into the logistics group. This is where the high-fidelity procedural models
 * (pump-jack wells, distillation-tower refineries, silo hubs, tiered transports)
 * and the road/highway ribbons actually render at unit-model quality — the
 * globe and 2D local map only draw flat markers at their zoom levels.
 *
 * Placement mirrors `rebuildBuildings`: each model is scaled to a hex fraction,
 * seated flush on the sampled terrain surface at its segment/tile centroid, and
 * oriented to face outward. Only entities whose tile is within the current flat
 * view are built (others are clipped). Roads/highways are world-space ribbons
 * threaded through their route's tile-centre path.
 */
export function rebuildLogistics(args: {
  ctx: FpViewContext;
  scene: THREE.Scene | null;
  group: THREE.Group | null;
  /** Geometries owned by the logistics group — cleared and refilled here. */
  geoms: THREE.BufferGeometry[];
  /** Materials owned by the logistics group (fresh per build) — cleared and refilled here. */
  mats: THREE.Material[];
}): void {
  const { ctx, scene, group, geoms, mats } = args;
  if (!scene || !group) return;

  // Tear down previous models (dispose geometries AND materials — fresh per build).
  for (const child of [...group.children]) group.remove(child);
  for (const g of geoms) {
    try { g.dispose(); } catch { /* best-effort */ }
  }
  geoms.length = 0;
  for (const m of mats) {
    try { m.dispose(); } catch { /* best-effort */ }
  }
  mats.length = 0;

  const toWorld = ctx.toWorld;
  const heightOf = ctx.heightOf;
  const tileById = ctx.tileById;
  const up = new THREE.Vector3(0, 1, 0);

  /** Track a model's geometries/materials for disposal on the next rebuild/close. */
  const track = (model: THREE.Object3D): void => {
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) geoms.push(mesh.geometry);
      const mat = (mesh as THREE.Mesh).material;
      if (Array.isArray(mat)) mats.push(...mat);
      else if (mat) mats.push(mat as THREE.Material);
    });
  };

  /** Ground height (clamped to the tile plateau) at a tile-local point. */
  const groundAt = (tileIndex: number, ft: FlatTile, x: number, y: number): number => {
    const fallbackTop = elevationWorldHeight(ctx.world.tiles[tileIndex], ELEV_WORLD_SCALE);
    return Math.max(sampleSurface(ft, x, y, toWorld, heightOf, fallbackTop).height, fallbackTop);
  };

  /**
   * Scale a freshly-built model so its horizontal footprint fills `fraction`
   * of a hex, seat it on the terrain at (localX, localY) of `ft`, and orient it
   * to `dir`. Returns the placed model (already added to the group + tracked).
   */
  const placeModel = (
    model: THREE.Group,
    tileIndex: number,
    ft: FlatTile,
    localX: number,
    localY: number,
    dir: { x: number; z: number },
    fraction: number,
  ): void => {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const footprint = Math.max(size.x, size.z) || 1;
    model.scale.setScalar((HEX_WORLD_RADIUS * fraction) / footprint);

    const box2 = new THREE.Box3().setFromObject(model);
    const groundLift = -box2.min.y;
    const [wx, , wz] = toWorld(localX, localY);
    const groundY = groundAt(tileIndex, ft, localX, localY);
    orientToSurface(model, up, dir);
    model.position.set(wx, groundY + groundLift, wz);
    group.add(model);
    track(model);
  };

  const logistics = ctx.world.logistics;

  /** Place the oil hex id (#tileIndex) label just above ground at (localX, localY) of `ft`. */
  const placeOilHexNumber = (tileIndex: number, ft: FlatTile, localX: number, localY: number): void => {
    if (!getShowEntityNumbers()) return;
    const sprite = buildOilHexNumberSprite(tileIndex);
    const labelScale = HEX_WORLD_RADIUS * 0.35 * 0.25;
    const [wx, , wz] = toWorld(localX, localY);
    const groundY = groundAt(tileIndex, ft, localX, localY);
    sprite.scale.set(labelScale, labelScale * 0.5, 1);
    sprite.position.set(wx, groundY + labelScale * 0.4, wz);
    group.add(sprite);
    mats.push(sprite.material);
  };

  // ── Oil-deposit markers (visible pre-drill) on 'oil' tiles in view ──
  for (const ft of ctx.flatTiles) {
    const tile = ctx.world.tiles[ft.tileIndex] as TileData | undefined;
    if (!tile || tile.resourceType !== 'oil') continue;
    // Skip if a well already sits on this tile (the derrick supersedes the marker).
    if (logistics?.wells?.some((w) => w.tileIndex === ft.tileIndex)) continue;
    const r = HEX_WORLD_RADIUS * 0.28;
    const geo = new THREE.CylinderGeometry(r, r * 1.1, r * 0.12, 20);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0e0b08, roughness: 0.35, metalness: 0.5, emissive: 0x120d06 });
    const disc = new THREE.Mesh(geo, mat);
    const [wx, , wz] = toWorld(ft.cx, ft.cy);
    disc.position.set(wx, groundAt(ft.tileIndex, ft, ft.cx, ft.cy) + r * 0.06, wz);
    group.add(disc);
    geoms.push(geo);
    mats.push(mat);
    placeOilHexNumber(ft.tileIndex, ft, ft.cx, ft.cy);
  }

  if (!logistics) return;

  // ── Routes: road / highway ribbons threaded through segment centres ──
  for (const route of logistics.routes ?? []) {
    const pts: THREE.Vector3[] = [];
    for (const key of route.segments) {
      const tileIndex = Math.floor(key / 6);
      const segment = key % 6;
      const ft = tileById.get(tileIndex);
      if (!ft) continue; // tile outside the flat view — clip
      const centre = segmentCentroid(ft, segment);
      const [wx, , wz] = toWorld(centre.x, centre.y);
      pts.push(new THREE.Vector3(
        wx,
        groundAt(tileIndex, ft, centre.x, centre.y),
        wz,
      ));
    }
    if (pts.length < 2) continue;
    const width = HEX_WORLD_RADIUS * 0.32;
    const lift = roadSurfaceLift(HEX_WORLD_RADIUS);
    const ribbon =
      route.tier === 'highway'
        ? buildHighwayMesh(pts, { width, lift })
        : buildRoadMesh(pts, { width, lift });
    if (route.operable === false) {
      ribbon.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (mat && 'opacity' in mat) { mat.transparent = true; mat.opacity = 0.4; }
      });
    }
    group.add(ribbon);
    track(ribbon);
  }

  // ── Static structures (wells / refineries / hubs) ──
  for (const refinery of logistics.refineries ?? []) {
    const ft = tileById.get(refinery.tileIndex);
    if (!ft) continue;
    const model = buildLogisticsModel('refinery', factionColor(ctx.world, refinery.ownerId), {
      segmentCount: Math.max(1, refinery.segments?.length ?? 1),
    });
    placeModel(model, refinery.tileIndex, ft, ft.cx, ft.cy, facingDirection(ft, 0), 1.4);
    placeOilHexNumber(refinery.tileIndex, ft, ft.cx, ft.cy);
  }
  for (const hub of logistics.hubs ?? []) {
    const ft = tileById.get(hub.tileIndex);
    if (!ft) continue;
    const cen = segmentCentroid(ft, hub.segment);
    const model = buildLogisticsModel('hub', factionColor(ctx.world, hub.ownerId));
    placeModel(model, hub.tileIndex, ft, cen.x, cen.y, facingDirection(ft, hub.segment), 0.9);
    placeOilHexNumber(hub.tileIndex, ft, cen.x, cen.y);
  }
  for (const well of logistics.wells ?? []) {
    const ft = tileById.get(well.tileIndex);
    if (!ft) continue;
    const cen = segmentCentroid(ft, well.segment);
    const model = buildLogisticsModel('well', factionColor(ctx.world, well.ownerId));
    placeModel(model, well.tileIndex, ft, cen.x, cen.y, facingDirection(ft, well.segment), 0.8);
    placeOilHexNumber(well.tileIndex, ft, cen.x, cen.y);
  }

  // ── Transports: placed at their current point along their path ──
  // Shuttle transports (shuttleMode) walk their own fixed shuttlePath (no
  // meaningful LogisticsRoute); ordinary cargo transports follow their
  // assigned route via the turn-countdown progress.
  const routeById = new Map(logistics.routes?.map((r) => [r.id, r]) ?? []);
  for (const transport of logistics.transports ?? []) {
    const segmentKeys = transport.shuttleMode ? (transport.shuttlePath ?? []) : routeById.get(transport.routeId)?.segments;
    if (!segmentKeys || segmentKeys.length === 0) continue;
    // World-space path (in-view tiles only), threaded segment-to-segment so
    // the transport rides the same course as the road ribbon above.
    const path: Array<{ tileIndex: number; ft: FlatTile; x: number; y: number }> = [];
    for (const key of segmentKeys) {
      const tileIndex = Math.floor(key / 6);
      const segment = key % 6;
      const ft = tileById.get(tileIndex);
      if (!ft) continue;
      const centre = segmentCentroid(ft, segment);
      path.push({ tileIndex, ft, x: centre.x, y: centre.y });
    }
    if (path.length === 0) continue;

    let fpos: number;
    if (transport.shuttleMode) {
      // Direct index along the shuttle's own fixed path (no interpolated countdown).
      fpos = Math.max(0, Math.min(path.length - 1, transport.shuttlePosition ?? 0));
    } else {
      // Progress 0..1 from the turn countdown (0 at source when idle/just dispatched).
      const route = routeById.get(transport.routeId);
      const travel = Math.max(1, route?.travelTime || 1);
      const progress = transport.inTransit
        ? Math.max(0, Math.min(1, (travel - transport.turnsRemaining) / travel))
        : 0;
      fpos = progress * (path.length - 1);
    }
    const i0 = Math.floor(fpos);
    const i1 = Math.min(path.length - 1, i0 + 1);
    const t = fpos - i0;
    const a = path[i0];
    const b = path[i1];
    const lx = a.x + (b.x - a.x) * t;
    const ly = a.y + (b.y - a.y) * t;
    const dir = i0 === i1 ? facingDirection(a.ft, 0) : { x: b.x - a.x, z: -(b.y - a.y) };
    const model = buildTransportModel(transport.tier, factionColor(ctx.world, transport.ownerId));
    placeModel(model, a.tileIndex, a.ft, lx, ly, dir, 0.55);
  }
}

/**
 * Scatter simple 3D trees across every forested hex currently in view. This is
 * the first-person echo of the 2D map's forest tree icons
 * (terrainFeatures.drawForestCornerTrees): a low-poly trunk + conical canopy,
 * drawn with two InstancedMeshes (one per part) for performance. Placement is
 * driven by a per-tile seeded RNG so a given forest looks identical each time
 * the view is opened. Trees are static scenery — built once on open() and torn
 * down with the rest of the scene on close() (geometry/material pushed onto
 * `disposables`).
 */
export function buildTrees(args: {
  ctx: FpViewContext;
  scene: THREE.Scene | null;
  /** The view's close()-time disposal list. */
  disposables: Disposable[];
}): void {
  const { ctx, scene, disposables } = args;
  if (!scene) return;

  const toWorld = ctx.toWorld;
  const heightOf = ctx.heightOf;

  // Gather an upright world-space placement for every tree first, so we can
  // size the InstancedMeshes exactly. `round` mixes spherical canopies in
  // among the cones for a more varied treeline.
  const placements: Array<{ x: number; y: number; z: number; yaw: number; scale: number; round: boolean }> = [];
  for (const ft of ctx.flatTiles) {
    const tile = ctx.world.tiles[ft.tileIndex];
    if (!tile.f) continue; // forested hexes only
    const n = ft.poly.length;
    const rand = mulberry32((ft.tileIndex * 0x9e3779b1) >>> 0);
    const fallbackTop = elevationWorldHeight(tile, ELEV_WORLD_SCALE);

    for (let t = 0; t < TREES_PER_HEX; t++) {
      // Random point inside the hex: pick a fan triangle (centre → edge) then
      // a uniform barycentric point within it.
      const seg = Math.min(n - 1, Math.floor(rand() * n));
      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % n];
      let a = rand(), b = rand();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      const px = ft.cx + a * (v0.x - ft.cx) + b * (v1.x - ft.cx);
      const py = ft.cy + a * (v0.y - ft.cy) + b * (v1.y - ft.cy);
      const [wx, , wz] = toWorld(px, py);
      const { height } = sampleSurface(ft, px, py, toWorld, heightOf, fallbackTop);
      placements.push({
        x: wx, y: height, z: wz,
        yaw: rand() * Math.PI * 2,
        scale: 0.7 + rand() * 0.6,
        round: rand() < 0.4, // ~40% rounded (deciduous) canopies, rest conical
      });
    }
  }
  if (placements.length === 0) return;

  // Tree parts, pre-translated in local Y so the trunk base sits at y=0 and
  // the canopy stacks above it. Sharing one matrix per instance across the
  // trunk + canopy meshes keeps each canopy locked to its trunk.
  const treeH = HEX_WORLD_RADIUS * TREE_HEX_FRACTION;
  const trunkH = treeH * 0.4;
  const coneH = treeH * 0.85;
  const sphereR = treeH * 0.32;

  const trunkGeo = new THREE.CylinderGeometry(treeH * 0.04, treeH * 0.06, trunkH, 6);
  trunkGeo.translate(0, trunkH / 2, 0);
  const coneGeo = new THREE.ConeGeometry(treeH * 0.28, coneH, 7);
  coneGeo.translate(0, trunkH + coneH / 2, 0);
  const sphereGeo = new THREE.SphereGeometry(sphereR, 8, 6);
  sphereGeo.translate(0, trunkH + sphereR * 0.85, 0);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.95, metalness: 0 });
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x2f6a24, roughness: 0.9, metalness: 0 });
  const sphereMat = new THREE.MeshStandardMaterial({ color: 0x4f8a32, roughness: 0.9, metalness: 0 });

  const coneCount = placements.filter((p) => !p.round).length;
  const sphereCount = placements.length - coneCount;
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, placements.length);
  const coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, coneCount);
  const sphereMesh = new THREE.InstancedMesh(sphereGeo, sphereMat, sphereCount);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let ci = 0, si = 0;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    q.setFromAxisAngle(up, p.yaw);
    pos.set(p.x, p.y, p.z);
    scl.setScalar(p.scale);
    m.compose(pos, q, scl);
    trunkMesh.setMatrixAt(i, m);
    if (p.round) sphereMesh.setMatrixAt(si++, m);
    else coneMesh.setMatrixAt(ci++, m);
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  coneMesh.instanceMatrix.needsUpdate = true;
  sphereMesh.instanceMatrix.needsUpdate = true;

  scene.add(trunkMesh, coneMesh, sphereMesh);
  disposables.push(
    trunkMesh, coneMesh, sphereMesh,
    trunkGeo, coneGeo, sphereGeo,
    trunkMat, coneMat, sphereMat,
  );
}
