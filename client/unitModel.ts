/**
 * Unit 3D Model Builder — procedural Three.js geometry based on unit attributes.
 *
 * Extracted from the Unit Designer (test-units.html) so it can be shared
 * between the designer preview and the in-game map renderer.
 *
 * This file contains:
 *   - Material management (shared singletons)
 *   - UnitModelAttrs interface and ChassisType type
 *   - buildUnitModel() orchestrator that delegates to chassis-specific files
 *
 * Attribute add-on builders live in unitModelAddons.ts (P10 refactor).
 */

import * as THREE from 'three';
import { BoltOnMaterials, createTintedMaterials } from './unitModelHelpers.js';
import { buildWheeledModel, initWheeledMaterials } from './unitModelWheeled.js';
import { buildLimbedModel, initLimbedMaterials } from './unitModelLimbed.js';
import { buildFlightModel, initFlightMaterials } from './unitModelFlight.js';
import {
  addGunBarrel,
  addSplashAttack,
  addArmour,
  addDefence,
  addRepair,
  addAntiAir,
} from './unitModelAddons.js';
import type { TurretInfo } from './unitModelTypes.js';

// ---------------------------------------------------------------------------
// Materials (shared across all model instances)
// ---------------------------------------------------------------------------

let materialsReady = false;
let matHull: THREE.MeshStandardMaterial;
let matDark: THREE.MeshStandardMaterial;
let matMetal: THREE.MeshStandardMaterial;
let matArmour: THREE.MeshStandardMaterial;
let matAntenna: THREE.MeshStandardMaterial;
let matRotor: THREE.MeshStandardMaterial;
let matLeg: THREE.MeshStandardMaterial;

/** Shared texture for hull and armour surfaces. Loaded once, applied when ready. */
let hullTexture: THREE.Texture | null = null;

export function initMaterials(): void {
  if (materialsReady) return;
  materialsReady = true;

  hullTexture = null;

  matHull = new THREE.MeshStandardMaterial({ color: 0x9aba9a, roughness: 0.6, metalness: 0.2 });
  matDark = new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.7, metalness: 0.3 });
  matMetal = new THREE.MeshStandardMaterial({ color: 0xa8b0b0, roughness: 0.35, metalness: 0.6 });
  matArmour = new THREE.MeshStandardMaterial({ color: 0x7a8a6a, roughness: 0.55, metalness: 0.4 });
  matAntenna = new THREE.MeshStandardMaterial({ color: 0xa8b0b0, roughness: 0.3, metalness: 0.7 });
  matRotor = new THREE.MeshStandardMaterial({ color: 0x788080, roughness: 0.45, metalness: 0.5 });
  matLeg = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.5, metalness: 0.4 });

  initWheeledMaterials(matHull, matDark, matMetal);
  initLimbedMaterials(matHull, matDark, matMetal);
  initFlightMaterials(matHull, matDark);
}

/**
 * Returns true once materials are available.
 */
export function isTextureReady(): boolean {
  return materialsReady;
}

// ---------------------------------------------------------------------------
// Chassis types
// ---------------------------------------------------------------------------

/**
 * Re-exported from unitModelTypes.ts (moved there to break an import cycle:
 * unitModel.ts imports the per-chassis builders, which need these types).
 */
import type { ChassisType, UnitChassisType, UnitModelAttrs } from './unitModelTypes.js';
export type { ChassisType, UnitChassisType, UnitModelAttrs };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a complete unit 3D model as a THREE.Group based on attributes.
 * The group is centred at the origin with Y-up.
 *
 * @param factionHex  Optional faction color (#RRGGBB) to tint bolt-on parts.
 *                    If omitted, uses the default grey materials.
 */
export function buildUnitModel(attrs: UnitModelAttrs, factionHex?: string): THREE.Group {
  initMaterials();

  const bom: BoltOnMaterials = factionHex
    ? createTintedMaterials(factionHex, matDark)
    : { metal: matMetal, antenna: matAntenna, rotor: matRotor, leg: matLeg, dark: matDark };

  const group = new THREE.Group();
  const modelRoot = attrs.chassis === 'limbed' ? new THREE.Group() : group;

  let turretInfo: TurretInfo;
  switch (attrs.chassis) {
    case 'wheeled': {
      const result = buildWheeledModel(attrs, bom, factionHex);
      modelRoot.add(result.group);
      turretInfo = result.turretInfo;
      break;
    }
    case 'limbed': {
      const result = buildLimbedModel(attrs, bom, factionHex);
      modelRoot.add(result.group);
      turretInfo = result.turretInfo;
      break;
    }
    case 'flight': {
      const result = buildFlightModel(attrs, bom, factionHex);
      modelRoot.add(result.group);
      turretInfo = result.turretInfo;
      break;
    }
    case 'building':
      // buildUnitModel only builds mobile-chassis units. Buildings use their
      // own standalone builder (buildingModel.ts), which calls the shared
      // attribute add-on builders directly rather than going through here.
      throw new Error('buildUnitModel does not support the "building" chassis; use buildBuildingModel in buildingModel.ts');
  }

  const { turretY, turretZ, turretFrontZ } = turretInfo!;

  addGunBarrel(modelRoot, attrs.kinetic, attrs.rangeAttack, turretY, turretZ, turretFrontZ, bom);
  addSplashAttack(modelRoot, attrs.splashAttack, attrs.rangeAttack, turretY, turretFrontZ, attrs.chassis, bom);
  addArmour(modelRoot, attrs.armour, attrs.chassis, factionHex);
  addDefence(modelRoot, attrs.defence, turretY, attrs.chassis, bom);
  addRepair(modelRoot, attrs.repair, attrs.chassis, bom);
  addAntiAir(modelRoot, attrs.antiAir, attrs.rangeAttack, turretY, turretFrontZ, attrs.chassis, bom);

  // Spider chassis is scaled as a whole so the body, legs, cage armour and all
  // attribute equipment keep their current proportions while becoming 20% smaller.
  if (attrs.chassis === 'limbed') {
    modelRoot.scale.setScalar(0.8);
    group.add(modelRoot);
  }

  return group;
}
