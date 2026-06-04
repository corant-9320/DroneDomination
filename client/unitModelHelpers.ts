/**
 * Shared geometry helpers and material types used by all chassis builders.
 * Imported by unitModelWheeled.ts, unitModelLimbed.ts, unitModelFlight.ts,
 * and unitModel.ts (for the attribute add-on builders).
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Faction-tinted material helpers
// ---------------------------------------------------------------------------

/** Parse a hex color string (#RRGGBB) to a THREE.Color. */
export function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/**
 * Blend a base grey color with a faction color.
 * Mix ratio: 55% faction, 45% base — strong tint for visibility at small sizes.
 */
export function tintColor(baseHex: number, factionColor: THREE.Color): THREE.Color {
  const base = new THREE.Color(baseHex);
  return base.lerp(factionColor, 0.55);
}

/**
 * Create a set of faction-tinted bolt-on materials.
 * These are disposable (created per model build) since each faction gets different tints.
 * `dark` is deliberately untinted — it represents structural/joint detail that stays neutral.
 */
export function createTintedMaterials(factionHex: string, darkMat: THREE.MeshStandardMaterial): BoltOnMaterials {
  const fc = hexToColor(factionHex);
  return {
    metal: new THREE.MeshStandardMaterial({ color: tintColor(0x889090, fc), roughness: 0.4, metalness: 0.7 }),
    antenna: new THREE.MeshStandardMaterial({ color: tintColor(0x889090, fc), roughness: 0.3, metalness: 0.8 }),
    rotor: new THREE.MeshStandardMaterial({ color: tintColor(0x586060, fc), roughness: 0.5, metalness: 0.6 }),
    leg: new THREE.MeshStandardMaterial({ color: tintColor(0x6a6a6a, fc), roughness: 0.6, metalness: 0.5 }),
    dark: darkMat,
  };
}

/** Material set passed to builders — either faction-tinted or the shared defaults. */
export interface BoltOnMaterials {
  metal: THREE.MeshStandardMaterial;
  antenna: THREE.MeshStandardMaterial;
  rotor: THREE.MeshStandardMaterial;
  leg: THREE.MeshStandardMaterial;
  /** Dark accent material (bolts, tracks, joints). Untinted — always the same neutral dark. */
  dark: THREE.MeshStandardMaterial;
}

// ---------------------------------------------------------------------------
// Shared geometry detail helpers
// ---------------------------------------------------------------------------

export function addBoxDetail(
  group: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  rotation?: [number, number, number]
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  group.add(mesh);
  return mesh;
}

export function addCylinderDetail(
  group: THREE.Group,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  position: [number, number, number],
  material: THREE.Material,
  axis: 'x' | 'y' | 'z' = 'y'
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments),
    material
  );
  mesh.position.set(position[0], position[1], position[2]);
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  group.add(mesh);
  return mesh;
}

export function addCylinderBetween(
  group: THREE.Group,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radiusTop: number,
  radiusBottom: number,
  radialSegments: number,
  material: THREE.Material
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, length, radialSegments),
    material
  );
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  group.add(mesh);
  return mesh;
}

export function addBoltHead(
  group: THREE.Group,
  position: [number, number, number],
  material: THREE.Material,
  axis: 'x' | 'y' | 'z' = 'y',
  radius: number = 0.022
): void {
  addCylinderDetail(group, radius, radius, 0.018, 6, position, material, axis);
}
