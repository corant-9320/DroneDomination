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
  createTintedMaterials,
  hexToColor,
  tintColor,
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

/** Small turret cap on the roof — gives equipment something to mount from. */
const CAP_W = 0.7;
const CAP_H = 0.3;
const CAP_D = 0.7;

/**
 * Equipment add-ons (guns, launchers, dishes, repair mast) are rendered at this
 * fraction of their unit-sized geometry so they read smaller relative to the
 * building body. The bare block, roof cap, and wall-bolted armour stay full size.
 */
const EQUIPMENT_SCALE = 0.5;

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
 * @param factionHex  Optional faction color (#RRGGBB) to tint the structure and
 *                    its bolt-on equipment. If omitted, uses neutral greys.
 */
export function buildBuildingModel(attrs: BuildingModelAttrs, factionHex?: string): THREE.Group {
  const group = new THREE.Group();

  // Structural / accent material — neutral, untinted (matches unit `dark`).
  const matDark = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.7, metalness: 0.3 });

  // Body material — concrete-ish, tinted toward the faction colour for at-a-glance ownership.
  const bodyColor = factionHex
    ? tintColor(0x8a8a82, hexToColor(factionHex))
    : new THREE.Color(0x8a8a82);
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85, metalness: 0.1 });

  const bom: BoltOnMaterials = factionHex
    ? createTintedMaterials(factionHex, matDark)
    : {
        metal: new THREE.MeshStandardMaterial({ color: 0x889090, roughness: 0.4, metalness: 0.7 }),
        antenna: new THREE.MeshStandardMaterial({ color: 0x889090, roughness: 0.3, metalness: 0.8 }),
        rotor: new THREE.MeshStandardMaterial({ color: 0x586060, roughness: 0.5, metalness: 0.6 }),
        leg: new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.6, metalness: 0.5 }),
        dark: matDark,
      };

  // ── Base block ────────────────────────────────────────────────────────────
  const body = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D), bodyMat);
  body.position.set(0, BODY_H / 2, 0);
  group.add(body);

  // Roof turret cap — the mount point for any kinetic/splash/anti-air equipment.
  const cap = new THREE.Mesh(new THREE.BoxGeometry(CAP_W, CAP_H, CAP_D), matDark);
  cap.position.set(0, BODY_H + CAP_H / 2, 0);
  group.add(cap);

  // ── Equipment add-ons (shared with the unit pipeline) ───────────────────────
  const turretY = BODY_H + CAP_H / 2;        // centre of the roof cap
  const turretZ = 0;
  const turretFrontZ = -CAP_D / 2;            // front face of the cap (barrel origin)

  // Mountable gear goes into its own group so it can be rendered at half size
  // *relative to the building body*. Armour is deliberately excluded: its plates
  // bolt flush to the walls and must stay wall-sized, so it's added at full
  // scale to the main group below.
  const equip = new THREE.Group();
  addGunBarrel(equip, attrs.kinetic, attrs.rangeAttack, turretY, turretZ, turretFrontZ, bom);
  addSplashAttack(equip, attrs.splashAttack, attrs.rangeAttack, turretY, turretFrontZ, 'building', bom);
  addDefence(equip, attrs.defence, turretY, 'building', bom);
  addRepair(equip, attrs.repair, 'building', bom);
  addAntiAir(equip, attrs.antiAir, attrs.rangeAttack, turretY, turretFrontZ, 'building', bom);

  // Scale about the roof surface (y = BODY_H) so roof-mounted bases stay seated
  // on the roof while the gear above them shrinks toward the centre.
  equip.scale.setScalar(EQUIPMENT_SCALE);
  equip.position.y = BODY_H * (1 - EQUIPMENT_SCALE);
  group.add(equip);

  // Wall armour stays full size, bolted to the body walls.
  addArmour(group, attrs.armour, 'building', factionHex);

  return group;
}
