/**
 * Building 3D Model Builder — procedural Three.js geometry for static structures.
 *
 * Mirrors the unit model pipeline (unitModel.ts) but with a deliberately plain
 * "block" base instead of a movement chassis. Buildings reuse the exact same
 * attribute add-on builders as units, so a building can be equipped with the
 * same combat/support gear:
 *
 *     kinetic · rangeAttack · splashAttack · antiAir · armour · defence · repair
 *
 * Movement (wheeled/limb/flight) and engineering are intentionally NOT supported
 * — buildings are immobile and never build bridges.
 *
 * The model is centred on X/Z at the origin and sits on the ground (Y from 0 up),
 * Y-up, matching the unit models so it can share the offscreen renderer's camera.
 */

import * as THREE from 'three';
import {
  BoltOnMaterials,
} from './unitModelHelpers.js';
import {
  addGunBarrel,
  addSplashAttack,
  addArmour,
  addDefence,
  addRepair,
  addAntiAir,
} from './unitModelAddons.js';

// ---------------------------------------------------------------------------
// Building texture assets
// Wall textures are randomly assigned per building; the roof is always the same.
// ---------------------------------------------------------------------------

import buiding1Url from '../artifacts/buiding1.webp';
import buiding2Url from '../artifacts/buiding2.webp';
import buiding3Url from '../artifacts/buiding3.webp';
import buiding4Url from '../artifacts/buiding4.webp';
import buiding5Url from '../artifacts/buiding5.webp';
import buildingRoofUrl from '../artifacts/building-roof.webp';

const WALL_TEXTURE_URLS = [
  buiding1Url,
  buiding2Url,
  buiding3Url,
  buiding4Url,
  buiding5Url,
];

/** Per-URL cache so we load each texture at most once across all buildings. */
const textureCache = new Map<string, THREE.Texture>();

/** Pending load promises keyed by URL — resolves once the image has loaded. */
const texturePendingMap = new Map<string, Promise<void>>();

/**
 * Load a texture and return a Promise that resolves once the image data is
 * ready. Uses an explicit HTMLImageElement so the promise resolves on the
 * image `load` event, avoiding the Three.js `'update'`-before-render deadlock.
 */
function getOrLoadTexture(url: string): { texture: THREE.Texture; ready: Promise<void> } {
  const existing = textureCache.get(url);
  if (existing) {
    return { texture: existing, ready: texturePendingMap.get(url) ?? Promise.resolve() };
  }

  const img = new Image();
  const texture = new THREE.Texture(img);
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(url, texture);

  const ready = new Promise<void>((resolve, reject) => {
    img.onload = () => {
      texture.needsUpdate = true;
      resolve();
    };
    img.onerror = () => reject(new Error(`Failed to load building texture: ${url}`));
    img.src = url;
  });
  texturePendingMap.set(url, ready);

  return { texture, ready };
}

/**
 * Returns a Promise that resolves once every texture used by the building
 * model for the given attrs has fully loaded. Safe to call multiple times —
 * the Promise is cached and reused.
 */
export function waitForBuildingTextures(attrs: BuildingModelAttrs): Promise<void> {
  const urls = [pickWallTextureUrl(attrs), buildingRoofUrl];
  const promises = urls.map((url) => getOrLoadTexture(url).ready);
  return Promise.all(promises).then(() => undefined);
}

/**
 * Pick a wall texture URL from the building's attribute loadout so every
 * distinct building type gets a consistent texture within a session.
 * Faction is ignored — no tinting.
 */
function pickWallTextureUrl(attrs: BuildingModelAttrs): string {
  // Hash the attribute values so different loadouts spread across textures.
  const vals = [attrs.kinetic, attrs.rangeAttack, attrs.splashAttack,
                attrs.antiAir, attrs.armour, attrs.defence, attrs.repair];
  let h = 5381;
  for (const v of vals) {
    h = ((h << 5) + h) ^ v;
    h = h >>> 0;
  }
  return WALL_TEXTURE_URLS[h % WALL_TEXTURE_URLS.length];
}

// ---------------------------------------------------------------------------
// Base block dimensions (kept simple — a plain blockhouse with a roof turret cap)
// ---------------------------------------------------------------------------

const BODY_W = 1.5;
const BODY_H = 1.2;
const BODY_D = 1.5;

/**
 * Footprint (max XZ extent) of the bare base block, with no equipment.
 * Used by views to scale buildings to a consistent on-screen size driven by the
 * structure itself — NOT the full bounding box, which would otherwise include
 * horizontally-protruding equipment (gun barrels, anti-air dishes) and shrink
 * the whole building so the protrusion fits.
 */
export const BUILDING_BASE_FOOTPRINT = Math.max(BODY_W, BODY_D);

// ---------------------------------------------------------------------------
// Turret dimensions — sits centred on the roof, present whenever a building
// has at least one weapon (kinetic, splashAttack, or antiAir).
// ---------------------------------------------------------------------------

const TURRET_W  = 0.425;
const TURRET_H  = 0.25;
const TURRET_D  = 0.425;

/** Y position of the top surface of the turret (weapons mount here). */
const TURRET_TOP_Y = BODY_H + TURRET_H;

/**
 * Equipment add-ons (splash launcher, anti-air) are rendered at this
 * fraction of their unit-sized geometry so they read proportionally against
 * the smaller turret body.
 */
const EQUIPMENT_SCALE = 0.55;

// ---------------------------------------------------------------------------
// Attributes — equipment only (no movement, no engineering)
// ---------------------------------------------------------------------------

export interface BuildingModelAttrs {
  kinetic: number;
  rangeAttack: number;
  splashAttack: number;
  antiAir: number;
  armour: number;
  defence: number;
  repair: number;
}

/** A building with no equipment — the plain default block. */
export const EMPTY_BUILDING_ATTRS: BuildingModelAttrs = {
  kinetic: 0,
  rangeAttack: 0,
  splashAttack: 0,
  antiAir: 0,
  armour: 0,
  defence: 0,
  repair: 0,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a complete building model as a THREE.Group based on its attributes.
 *
 * @param attrs       Equipment levels (0–5 each). Pass EMPTY_BUILDING_ATTRS for a
 *                    plain block.
 * @param factionHex  Accepted but ignored — buildings are no longer faction-tinted.
 */
export function buildBuildingModel(attrs: BuildingModelAttrs, factionHex?: string): THREE.Group {
  const group = new THREE.Group();

  // Structural / accent material — neutral dark grey.
  const matDark = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.7, metalness: 0.3 });
  const matTurret = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.65, metalness: 0.45 });

  // Wall material — facade texture, no tint.
  const wallTex = getOrLoadTexture(pickWallTextureUrl(attrs)).texture;
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85, metalness: 0.1 });

  // Roof material — dedicated roof texture.
  const roofTex = getOrLoadTexture(buildingRoofUrl).texture;
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.75, metalness: 0.05 });

  // Bottom material — plain dark (never visible from isometric camera).
  const bottomMat = matDark;

  // BoxGeometry face order: +X, -X, +Y (top), -Y (bottom), +Z, -Z
  const boxMats = [wallMat, wallMat, roofMat, bottomMat, wallMat, wallMat];

  // Bolt-on equipment — neutral metals, no faction tint.
  const bom: BoltOnMaterials = {
    metal: new THREE.MeshStandardMaterial({ color: 0x889090, roughness: 0.4, metalness: 0.7 }),
    antenna: new THREE.MeshStandardMaterial({ color: 0x889090, roughness: 0.3, metalness: 0.8 }),
    rotor: new THREE.MeshStandardMaterial({ color: 0x586060, roughness: 0.5, metalness: 0.6 }),
    leg: new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.6, metalness: 0.5 }),
    dark: matDark,
  };

  // ── Base block ────────────────────────────────────────────────────────────
  const body = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D), boxMats);
  body.position.set(0, BODY_H / 2, 0);
  group.add(body);

  // ── Weapon turret (present only when at least one weapon is equipped) ────
  const hasWeapon = attrs.kinetic > 0 || attrs.splashAttack > 0 || attrs.antiAir > 0;

  if (hasWeapon) {
    // Turret box — sits centred on the roof, dark armoured look.
    // BoxGeometry face order: +X, -X, +Y (top), -Y (bottom), +Z, -Z
    // Roof texture on top so it blends with the building roof beneath it.
    const turretTopMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.65, metalness: 0.2 });
    const turretMats = [matTurret, matTurret, turretTopMat, matTurret, matTurret, matTurret];
    const turretMesh = new THREE.Mesh(new THREE.BoxGeometry(TURRET_W, TURRET_H, TURRET_D), turretMats);
    // Centre on roof: Y positions the bottom of the turret flush with BODY_H.
    turretMesh.position.set(0, BODY_H + TURRET_H / 2, 0);
    group.add(turretMesh);

    // ── Weapons — mounted on/from the turret, scaled down proportionally ──
    // All weapon add-ons are placed in an `equip` group that is then scaled.
    // `turretY` given to each addon = the top surface of the turret in
    // *pre-scale* space, which is where pedestals/pivots sit.
    const equip = new THREE.Group();

    // addGunBarrel places the barrel pointing along -Z from turretFrontZ.
    // We want it emerging from the SIDE (-X face) of the turret, so we:
    //   1. Add the barrel into a pivot group with Y-rotation +π/2
    //      (which maps -Z → -X, i.e. the barrel exits left).
    //   2. Position the pivot so the mantlet sits flush at the -X face of
    //      the turret.  The barrel+mantlet extend further left from there.
    if (attrs.kinetic > 0) {
      // In the barrel's local frame (before pivot rotation):
      //   mantlet centre is at (0, turretY, barrelStartZ + 0.02)
      //   barrelStartZ = turretFrontZ
      // After Y-rotation +π/2:  Z → X, so mantlet ends up at x = barrelStartZ + 0.02
      // We want the mantlet at x = -(TURRET_W/2), i.e. flush with the -X face.
      // So turretFrontZ = -(TURRET_W/2) - 0.02
      const sideBarrelStartZ = -(TURRET_W / 2) - 0.02;
      const barrelGroup = new THREE.Group();
      barrelGroup.rotation.y = Math.PI / 2;   // -Z barrel direction → exits -X
      addGunBarrel(barrelGroup, attrs.kinetic, attrs.rangeAttack,
        TURRET_TOP_Y, 0, sideBarrelStartZ, bom);
      equip.add(barrelGroup);
    }

    // Splash launcher — sits on top of the turret, centred, angled upward.
    // Pass turretY = TURRET_TOP_Y so the pedestal base sits on the turret roof.
    // turretFrontZ = 0 (centred on turret top, no Z offset needed).
    if (attrs.splashAttack > 0) {
      addSplashAttack(equip, attrs.splashAttack, attrs.rangeAttack,
        TURRET_TOP_Y, 0, 'building', bom);
    }

    // Anti-air launcher — also mounts on top of the turret.
    // addAntiAir 'building' case hardcodes baseY=1.2, baseZ=0.
    // We override by passing turretY as the reference so the pedestal
    // lands on the turret roof.  addAntiAir uses baseY = turretY (building case
    // re-uses the parameter directly), so pass TURRET_TOP_Y.
    if (attrs.antiAir > 0) {
      addAntiAir(equip, attrs.antiAir, attrs.rangeAttack,
        TURRET_TOP_Y, 0, 'building', bom);
    }

    // Scale equip group so weapons read proportionally against the turret.
    // Scale origin = turret top (BODY_H + TURRET_H) so roof-mounted pedestals
    // stay seated on the turret surface while geometry above shrinks inward.
    equip.scale.setScalar(EQUIPMENT_SCALE);
    equip.position.y = (BODY_H + TURRET_H) * (1 - EQUIPMENT_SCALE);
    group.add(equip);
  }

  // ── Non-weapon equipment (defence, repair) — mounted directly on roof ───
  // These don't need the turret; position them on the building roof.
  const roofEquip = new THREE.Group();
  const roofTurretY = BODY_H;   // top of building body (roof surface)
  const roofTurretFrontZ = 0;   // centred

  addDefence(roofEquip, attrs.defence, roofTurretY, 'building', bom);
  addRepair(roofEquip, attrs.repair, 'building', bom);

  roofEquip.scale.setScalar(EQUIPMENT_SCALE);
  roofEquip.position.y = BODY_H * (1 - EQUIPMENT_SCALE);
  group.add(roofEquip);

  // Roof-edge cage armour — full size, sits on the roof perimeter.
  addArmour(group, attrs.armour, 'building', undefined);

  return group;
}
