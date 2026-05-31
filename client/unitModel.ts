/**
 * Unit 3D Model Builder — procedural Three.js geometry based on unit attributes.
 *
 * Extracted from the Unit Designer (test-units.html) so it can be shared
 * between the designer preview and the in-game map renderer.
 */

import * as THREE from 'three';

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

  // Keep hull/armour surfaces solid. The old repeating mini texture shimmered badly
  // when unit models were rendered small or converted to sprites, especially on tanks.
  hullTexture = null;

  matHull = new THREE.MeshStandardMaterial({ color: 0x9aba9a, roughness: 0.6, metalness: 0.2 });
  matDark = new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.7, metalness: 0.3 });
  matMetal = new THREE.MeshStandardMaterial({ color: 0xa8b0b0, roughness: 0.35, metalness: 0.6 });
  matArmour = new THREE.MeshStandardMaterial({ color: 0x7a8a6a, roughness: 0.55, metalness: 0.4 });
  matAntenna = new THREE.MeshStandardMaterial({ color: 0xa8b0b0, roughness: 0.3, metalness: 0.7 });
  matRotor = new THREE.MeshStandardMaterial({ color: 0x788080, roughness: 0.45, metalness: 0.5 });
  matLeg = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.5, metalness: 0.4 });
}

// ---------------------------------------------------------------------------
// Faction-tinted material helpers
// ---------------------------------------------------------------------------

/** Parse a hex color string (#RRGGBB) to a THREE.Color. */
function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/**
 * Blend a base grey color with a faction color.
 * Mix ratio: 55% faction, 45% base — strong tint for visibility at small sizes.
 */
function tintColor(baseHex: number, factionColor: THREE.Color): THREE.Color {
  const base = new THREE.Color(baseHex);
  return base.lerp(factionColor, 0.55);
}

/**
 * Create a set of faction-tinted bolt-on materials.
 * These are disposable (created per model build) since each faction gets different tints.
 */
function createTintedMaterials(factionHex: string) {
  const fc = hexToColor(factionHex);
  return {
    metal: new THREE.MeshStandardMaterial({ color: tintColor(0x889090, fc), roughness: 0.4, metalness: 0.7 }),
    antenna: new THREE.MeshStandardMaterial({ color: tintColor(0x889090, fc), roughness: 0.3, metalness: 0.8 }),
    rotor: new THREE.MeshStandardMaterial({ color: tintColor(0x586060, fc), roughness: 0.5, metalness: 0.6 }),
    leg: new THREE.MeshStandardMaterial({ color: tintColor(0x6a6a6a, fc), roughness: 0.6, metalness: 0.5 }),
  };
}

/** Material set passed to builders — either faction-tinted or the shared defaults. */
interface BoltOnMaterials {
  metal: THREE.MeshStandardMaterial;
  antenna: THREE.MeshStandardMaterial;
  rotor: THREE.MeshStandardMaterial;
  leg: THREE.MeshStandardMaterial;
}

/**
 * Returns true once materials are available. Hull/armour surfaces are now solid,
 * so there is no async texture load to wait for before rendering sprites.
 */
export function isTextureReady(): boolean {
  return materialsReady;
}

// ---------------------------------------------------------------------------
// Chassis types
// ---------------------------------------------------------------------------

export type ChassisType = 'wheeled' | 'limbed' | 'flight';

export interface UnitModelAttrs {
  attack: number;
  rangeAttack: number;
  splashAttack: number;
  antiAir: number;
  armour: number;
  defence: number;
  repair: number;
  movement: number;
  chassis: ChassisType;
}

interface TurretInfo {
  turretY: number;
  turretZ: number;
  /** Z coordinate of the front face of the turret/body — barrel starts here */
  turretFrontZ: number;
}

// ---------------------------------------------------------------------------
// Chamfered wedge hull geometry helper
// ---------------------------------------------------------------------------

/**
 * Builds a hull with chamfered edges, a wedge-shaped front (narrowing in X),
 * AND a sloped bonnet (front dips down in Y, like a car hood).
 *
 * Uses raw BufferGeometry with 8 unique corners:
 *   - 4 rear corners at full width & full height
 *   - 4 front corners at tapered width & reduced top height (bonnet slope)
 *
 * The geometry is centred on the origin so it can be positioned like a BoxGeometry.
 *
 * @param width   Full width at the rear (X axis)
 * @param height  Hull height at the rear (Y axis)
 * @param length  Total length front-to-back (Z axis, front at -Z)
 * @param taper   Front width as a fraction of full width (0.5 = half width at tip)
 * @param chamfer Bevel size for edge softening
 * @param bonnetDrop How much the front top drops (fraction of height, e.g. 0.35 = 35%)
 */
function createChamferedWedgeHull(
  width: number, height: number, length: number,
  taper: number, chamfer: number, bonnetDrop: number = 0.35
): THREE.BufferGeometry {
  const hw = width / 2;         // half-width at rear
  const fhw = hw * taper;      // half-width at front
  const hh = height / 2;       // half-height
  const hl = length / 2;       // half-length
  const drop = height * bonnetDrop; // how much front top sinks

  // We'll build a top-down shape (the hull footprint) with the wedge taper,
  // then extrude it, but to get the bonnet slope we need a custom approach.
  // Strategy: build geometry from scratch with positioned vertices.

  // Use a slightly simpler approach: create two cross-section shapes (rear & front)
  // and loft between them using ShapeGeometry-like construction.

  // Instead, we'll use a pragmatic two-part approach:
  // 1. Main rear box section (from back to transition point) with chamfered edges
  // 2. Front wedge section (tapered + sloped) as a separate extruded shape

  // Even simpler: use the 2D top-down shape approach but apply vertex displacement
  // for the bonnet slope after extrusion.

  // Build the top-down wedge profile.
  // Shape coords: X = world X, Y = world Z after rotateX(PI/2).
  // After rotateX(PI/2): shape +Y → world +Z (rear), shape -Y → world -Z (front).
  // So we place the narrow (taper) end at shape -Y = world -Z = model front.
  const transZ = hl * 0.35; // how far from centre the taper transition sits

  const shape = new THREE.Shape();
  shape.moveTo(-fhw, -hl);       // front-left (narrow, at -Y = front)
  shape.lineTo(fhw, -hl);        // front-right (narrow)
  shape.lineTo(hw, -transZ);     // right widens at transition
  shape.lineTo(hw, hl);          // back-right (full width)
  shape.lineTo(-hw, hl);         // back-left (full width)
  shape.lineTo(-hw, -transZ);    // left widens at transition
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: chamfer,
    bevelSize: chamfer,
    bevelSegments: 2,
  });

  // Rotate so extrusion axis (local Z) → world Y, and shape Y → world -Z
  geo.rotateX(Math.PI / 2);

  // Centre the geometry on its own bounding box (same as BoxGeometry behaviour)
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -cy, -cz);

  // Apply bonnet slope: push top vertices downward in the front portion.
  // After centering: front (narrow) is at minZ, rear (wide) at maxZ. Top is at +Y.
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const bb2 = geo.boundingBox!;
  const minZ = bb2.min.z;
  const maxZ = bb2.max.z;
  const minY = bb2.min.y;
  const maxY = bb2.max.y;
  const totalZ = maxZ - minZ;
  const totalY = maxY - minY;
  const frontZone = totalZ * 0.55; // front 55% of the hull length gets the slope
  const frontThreshold = minZ + frontZone; // z values below this are in the front

  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const y = pos.getY(i);

    // Only affect vertices in the front zone (near minZ) above the bottom
    if (z < frontThreshold && y > minY + totalY * 0.2) {
      const t = Math.min(1, (frontThreshold - z) / frontZone); // 0 at transition, 1 at tip
      const heightFrac = (y - minY) / totalY; // 0 at bottom, 1 at top
      const dropAmount = drop * t * heightFrac;
      pos.setY(i, y - dropAmount);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  return geo;
}


/**
 * Drone payload hull with a deliberately simple top surface: one flat square rear
 * deck and one sloped trapezium bonnet.  The shared top edge is the only crease;
 * there is no triangulated/pyramidal centre point on the roof.
 */
function createFlightPayloadHull(
  width: number,
  height: number,
  length: number,
  taper: number,
  bonnetDrop: number = 0.25,
  bevel: number = 0.035
): THREE.BufferGeometry {
  const hw = width / 2;
  const fhw = hw * taper;
  const hh = height / 2;
  const hl = length / 2;
  const frontZ = -hl;
  const rearZ = hl;
  const transZ = -hl * 0.35;
  const topY = hh;
  const frontTopY = hh - height * bonnetDrop;
  const bottomY = -hh;
  const b = Math.min(bevel, width * 0.12, length * 0.12);

  // Outer upper rim sits slightly below the roof.  The narrow bevel strip between
  // this rim and the inset roof gives the drone the same softened/chamfered edge
  // language as the tank and spider, without reintroducing a triangulated roof.
  const rearRimY = topY - b;
  const frontRimY = frontTopY - b;

  const v = {
    // Inset roof vertices: keep the payload top as exactly two major planes.
    roofRearL: [-hw + b, topY, rearZ - b] as [number, number, number],
    roofRearR: [hw - b, topY, rearZ - b] as [number, number, number],
    roofTransL: [-hw + b, topY, transZ] as [number, number, number],
    roofTransR: [hw - b, topY, transZ] as [number, number, number],
    roofFrontL: [-fhw + b, frontTopY, frontZ + b] as [number, number, number],
    roofFrontR: [fhw - b, frontTopY, frontZ + b] as [number, number, number],

    // Full-size upper rim that the side walls rise to.
    rimRearL: [-hw, rearRimY, rearZ] as [number, number, number],
    rimRearR: [hw, rearRimY, rearZ] as [number, number, number],
    rimTransL: [-hw, rearRimY, transZ] as [number, number, number],
    rimTransR: [hw, rearRimY, transZ] as [number, number, number],
    rimFrontL: [-fhw, frontRimY, frontZ] as [number, number, number],
    rimFrontR: [fhw, frontRimY, frontZ] as [number, number, number],

    // Bottom footprint.
    bottomRearL: [-hw, bottomY, rearZ] as [number, number, number],
    bottomRearR: [hw, bottomY, rearZ] as [number, number, number],
    bottomTransL: [-hw, bottomY, transZ] as [number, number, number],
    bottomTransR: [hw, bottomY, transZ] as [number, number, number],
    bottomFrontL: [-fhw, bottomY, frontZ] as [number, number, number],
    bottomFrontR: [fhw, bottomY, frontZ] as [number, number, number],
  };

  const positions: number[] = [];
  const addTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    positions.push(...a, ...b, ...c);
  };
  const addQuad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number]
  ) => {
    addTri(a, b, c);
    addTri(a, c, d);
  };

  // Top: exactly two visible primary planes.
  addQuad(v.roofRearL, v.roofRearR, v.roofTransR, v.roofTransL); // square rear deck
  addQuad(v.roofTransL, v.roofTransR, v.roofFrontR, v.roofFrontL); // sloped trapezium bonnet

  // Chamfered roof perimeter.  These are the narrow bevel faces; the shared edge
  // between the rear deck and bonnet remains a clean crease, not a bevel.
  addQuad(v.rimRearL, v.rimRearR, v.roofRearR, v.roofRearL); // rear bevel
  addQuad(v.rimFrontL, v.roofFrontL, v.roofFrontR, v.rimFrontR); // front bevel
  addQuad(v.rimRearL, v.roofRearL, v.roofTransL, v.rimTransL); // left rear bevel
  addQuad(v.rimTransL, v.roofTransL, v.roofFrontL, v.rimFrontL); // left bonnet bevel
  addQuad(v.rimRearR, v.rimTransR, v.roofTransR, v.roofRearR); // right rear bevel
  addQuad(v.rimTransR, v.rimFrontR, v.roofFrontR, v.roofTransR); // right bonnet bevel

  // Rear, front and side walls.
  addQuad(v.bottomRearL, v.bottomRearR, v.rimRearR, v.rimRearL);
  addQuad(v.bottomFrontL, v.rimFrontL, v.rimFrontR, v.bottomFrontR);
  addQuad(v.bottomRearL, v.rimRearL, v.rimTransL, v.bottomTransL);
  addQuad(v.bottomTransL, v.rimTransL, v.rimFrontL, v.bottomFrontL);
  addQuad(v.bottomRearR, v.bottomTransR, v.rimTransR, v.rimRearR);
  addQuad(v.bottomTransR, v.bottomFrontR, v.rimFrontR, v.rimTransR);

  // Bottom closes the hull.
  addQuad(v.bottomRearL, v.bottomTransL, v.bottomTransR, v.bottomRearR);
  addQuad(v.bottomTransL, v.bottomFrontL, v.bottomFrontR, v.bottomTransR);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
// ---------------------------------------------------------------------------
// Low-profile chassis detail helpers
// ---------------------------------------------------------------------------

function addBoxDetail(
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

function addCylinderDetail(
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


function addCylinderBetween(
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

function addBoltHead(
  group: THREE.Group,
  position: [number, number, number],
  material: THREE.Material,
  axis: 'x' | 'y' | 'z' = 'y',
  radius: number = 0.022
): void {
  addCylinderDetail(group, radius, radius, 0.018, 6, position, material, axis);
}

function addWheeledHullDetails(group: THREE.Group, bom: BoltOnMaterials): void {
  // Deliberately use darker raised geometry here: the hull texture is visually noisy,
  // so tiny green-on-green detail disappears at game-camera distances.

  // Chunky side skirt / appliqué armour panels above the tracks.
  // These are still shallow enough that cage armour can sit outside them cleanly.
  for (const side of [-1, 1]) {
    const x = side * 0.72;
    const faceX = x + side * 0.018;

    addBoxDetail(group, [0.04, 0.24, 1.62], [x, 0.39, 0.02], matDark);
    addBoxDetail(group, [0.048, 0.035, 1.5], [faceX, 0.52, 0.02], matMetal);
    addBoxDetail(group, [0.048, 0.03, 1.5], [faceX, 0.27, 0.02], matMetal);

    // Three larger panel blocks read better than many small marks against the texture.
    // Rear panels sit over the fuller side-skirt area, so push every panel and its trim
    // clearly outward from the hull face to avoid z-fighting/shimmering.
    const sidePanelOutset = 0.032;
    const sidePanelTrimOutset = 0.046;
    const sidePanelBoltOutset = 0.062;
    for (const z of [-0.55, 0.02, 0.59]) {
      addBoxDetail(group, [0.052, 0.15, 0.34], [faceX + side * sidePanelOutset, 0.39, z], bom.metal);
      addBoxDetail(group, [0.058, 0.018, 0.3], [faceX + side * sidePanelTrimOutset, 0.465, z], matDark);
      addBoxDetail(group, [0.058, 0.018, 0.3], [faceX + side * sidePanelTrimOutset, 0.315, z], matDark);

      addBoltHead(group, [faceX + side * sidePanelBoltOutset, 0.455, z - 0.13], matMetal, 'x', 0.024);
      addBoltHead(group, [faceX + side * sidePanelBoltOutset, 0.325, z + 0.13], matMetal, 'x', 0.024);
    }

    // A distinct louvre bank on the rear side, large enough to survive sprite rendering.
    for (let i = 0; i < 4; i++) {
      addBoxDetail(
        group,
        [0.065, 0.028, 0.12],
        [faceX + side * 0.02, 0.55, 0.42 + i * 0.115],
        matDark,
        [0, 0, side * 0.22]
      );
    }
  }

  // Front glacis: broad access plate, lamps, tow hooks and a visible seam.
  addBoxDetail(group, [0.86, 0.026, 0.035], [0, 0.555, -0.8], matDark);
  addBoxDetail(group, [0.62, 0.12, 0.035], [0, 0.41, -1.012], matDark);
  addBoxDetail(group, [0.5, 0.024, 0.045], [0, 0.48, -1.04], matMetal);

  for (const x of [-0.48, 0.48]) {
    addBoxDetail(group, [0.12, 0.09, 0.05], [x, 0.42, -1.045], matDark);
    addCylinderDetail(group, 0.04, 0.04, 0.022, 10, [x, 0.42, -1.077], matMetal, 'z');
    addCylinderDetail(group, 0.026, 0.026, 0.1, 8, [x * 0.55, 0.27, -1.065], matMetal, 'x');
  }

  // Rear deck grilles/access panels: placed behind the turret/add-on footprint.
  addBoxDetail(group, [0.82, 0.018, 0.34], [0, 0.63, 0.68], matDark);
  for (const x of [-0.27, 0, 0.27]) {
    addBoxDetail(group, [0.18, 0.024, 0.24], [x, 0.65, 0.68], matMetal);
  }
  for (const z of [0.56, 0.64, 0.72, 0.8]) {
    addBoxDetail(group, [0.72, 0.026, 0.018], [0, 0.675, z], matDark);
  }

  // Rear vertical hull panel: oversized details so the flat back face still reads in sprites.
  // This gives the tank a clear rear silhouette without relying on noisy texture detail.
  addBoxDetail(group, [0.78, 0.2, 0.04], [0, 0.38, 1.025], matDark);
  addBoxDetail(group, [0.5, 0.12, 0.052], [0, 0.39, 1.052], matHull);
  addBoxDetail(group, [0.42, 0.026, 0.06], [0, 0.455, 1.086], matMetal);
  addBoxDetail(group, [0.42, 0.026, 0.06], [0, 0.325, 1.086], matMetal);

  for (const x of [-0.42, 0.42]) {
    addBoxDetail(group, [0.14, 0.09, 0.055], [x, 0.38, 1.082], matDark);
    addCylinderDetail(group, 0.035, 0.035, 0.024, 10, [x, 0.38, 1.12], matMetal, 'z');
  }

  for (const x of [-0.24, 0, 0.24]) {
    addBoxDetail(group, [0.13, 0.024, 0.056], [x, 0.56, 1.078], matDark, [0.16, 0, 0]);
  }

  for (const x of [-0.32, 0.32]) {
    addBoltHead(group, [x, 0.485, 1.105], matMetal, 'z', 0.022);
    addBoltHead(group, [x, 0.295, 1.105], matMetal, 'z', 0.022);
  }
}

function addTrackFaceDetail(
  group: THREE.Group,
  side: number,
  trackW: number,
  halfH: number,
  halfStraight: number,
  wheelPositions: { z: number; radius: number; width: number }[]
): void {
  const sign = Math.sign(side);
  const outerX = side + sign * (trackW / 2 + 0.012);

  // Subtle tread blocks along top and bottom runs. These replace the old tall vertical
  // separators, which looked odd because they did not align with the wheels.
  const treadCount = 12;
  for (let i = 0; i < treadCount; i++) {
    const z = -halfStraight + ((i + 0.5) / treadCount) * (halfStraight * 2);
    addBoxDetail(group, [0.032, 0.028, 0.085], [outerX, halfH * 1.82, -z], matMetal, [0, 0, sign * 0.1]);
    addBoxDetail(group, [0.032, 0.028, 0.085], [outerX, 0.035, -z], matMetal, [0, 0, -sign * 0.1]);
  }

  // Hub caps and suspension arms aligned to the actual wheel centres.
  for (const wp of wheelPositions) {
    const hubX = side + sign * (wp.width / 2 + 0.02);
    addCylinderDetail(
      group,
      wp.radius * 0.38,
      wp.radius * 0.38,
      0.028,
      8,
      [hubX, halfH, wp.z],
      matDark,
      'x'
    );

    // Short vertical suspension bracket directly above each wheel, so every upright
    // has an obvious mechanical relationship with the wheel below it.
    const bracketY = halfH + wp.radius * 0.55;
    addBoxDetail(
      group,
      [0.035, Math.max(0.08, wp.radius * 0.9), 0.045],
      [outerX, bracketY, wp.z],
      matDark
    );

    // Small diagonal damper from hull/skirt down toward the hub.
    const damper = addCylinderDetail(
      group,
      0.012,
      0.012,
      wp.radius * 1.1,
      6,
      [outerX, bracketY + wp.radius * 0.12, wp.z + 0.025],
      matMetal,
      'y'
    );
    damper.rotation.x = 0.35;
    damper.rotation.z = sign * 0.22;
  }

  // A continuous dark return rail above the wheel line ties the suspension together.
  addBoxDetail(group, [0.04, 0.035, halfStraight * 1.75], [outerX, halfH * 1.55, 0], matDark);
}

function addWheeledCageArmour(group: THREE.Group, level: number, factionHex?: string): void {
  const cageColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
  const cageMat = new THREE.MeshStandardMaterial({ color: cageColor, roughness: 0.5, metalness: 0.5 });

  // Non-linear scaling makes armour upgrades read clearly: low armour stays close
  // to the hull, while high armour becomes a much larger external cope cage.
  const cageScale = Math.pow(THREE.MathUtils.clamp((level - 1) / 4, 0, 1), 1.35);
  const sideX = 0.82 + cageScale * 0.26;
  const frontZ = -0.76 - cageScale * 0.28;
  const rearZ = 0.78 + cageScale * 0.24;
  const railCount = level >= 5 ? 4 : level >= 3 ? 3 : level >= 2 ? 2 : 1;
  const railYs = railCount === 1 ? [0.63] : railCount === 2 ? [0.6, 0.79] : railCount === 3 ? [0.56, 0.76, 0.96] : [0.52, 0.7, 0.89, 1.08];
  const postCount = Math.min(9, 2 + level * 2);
  const railRadius = 0.013 + cageScale * 0.018;

  for (const side of [-1, 1]) {
    const x = side * sideX;

    // Standoff brackets keep the cage clear of the hull and preserve the tank silhouette.
    for (let i = 0; i < postCount; i++) {
      const z = frontZ + (i / (postCount - 1)) * (rearZ - frontZ);
      addBoxDetail(group, [0.1 + cageScale * 0.08, 0.026 + cageScale * 0.018, 0.03 + cageScale * 0.018], [side * 0.78, 0.57 + cageScale * 0.04, z], cageMat);
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.28 + cageScale * 0.32, 6, [x, 0.68 + cageScale * 0.18, z], cageMat, 'y');
    }

    // Horizontal slat rails.
    for (const y of railYs) {
      addCylinderDetail(group, railRadius, railRadius, rearZ - frontZ, 6, [x, y, (frontZ + rearZ) / 2], cageMat, 'z');
    }

    // Angled front/rear cage returns at higher armour levels.
    if (level >= 3) {
      for (const z of [frontZ, rearZ]) {
        addCylinderDetail(group, railRadius * 0.9, railRadius * 0.9, 0.36 + cageScale * 0.34, 6, [side * (0.62 + cageScale * 0.06), 0.72 + cageScale * 0.12, z], cageMat, 'x');
      }
    }
  }

  // Front guard rails, narrow enough to avoid the gun line and add-on mounts.
  if (level >= 3) {
    for (const y of railYs.slice(0, 2)) {
      addCylinderDetail(group, railRadius * 0.9, railRadius * 0.9, 1.08 + cageScale * 0.35, 6, [0, y, frontZ - 0.06], cageMat, 'x');
    }
  }

  // Level 5 gets a partial rear deck cage, deliberately behind the turret/add-on cluster.
  if (level >= 5) {
    for (const x of [-0.5, 0, 0.5]) {
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.64 + cageScale * 0.28, 6, [x, 1.06 + cageScale * 0.08, 0.6], cageMat, 'z');
    }
    for (const z of [0.32, 0.6, 0.88]) {
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 1.0 + cageScale * 0.32, 6, [0, 1.06 + cageScale * 0.08, z], cageMat, 'x');
    }
  }
}

function addLimbedHullDetails(group: THREE.Group, bom: BoltOnMaterials): void {
  // Low, dark/mechanical details that stay clear of the turret roof and weapon add-ons.
  // The spider body has less flat area than the tank, so details are broad and shallow.
  for (const side of [-1, 1]) {
    const sx = side * 0.53;
    const faceX = sx + side * 0.018;

    // Side armour rail and three inset service panels.
    addBoxDetail(group, [0.036, 0.06, 1.02], [sx, 0.78, 0], matDark);
    addBoxDetail(group, [0.044, 0.024, 0.92], [faceX, 0.89, 0], matMetal);
    for (const z of [-0.34, 0, 0.34]) {
      addBoxDetail(group, [0.052, 0.13, 0.2], [faceX + side * 0.006, 0.72, z], bom.metal);
      addBoxDetail(group, [0.058, 0.018, 0.16], [faceX + side * 0.014, 0.79, z], matDark);
      addBoltHead(group, [faceX + side * 0.02, 0.67, z - 0.075], bom.metal, 'x', 0.018);
      addBoltHead(group, [faceX + side * 0.02, 0.79, z + 0.075], bom.metal, 'x', 0.018);
    }

    // Leg root sockets make the eight legs read as mechanical joints instead of rods.
    for (const z of [-0.46, -0.16, 0.16, 0.46]) {
      addCylinderDetail(group, 0.055, 0.055, 0.035, 10, [side * 0.57, 0.49, z], bom.metal, 'x');
      addBoxDetail(group, [0.05, 0.08, 0.08], [side * 0.53, 0.52, z], matDark);
    }
  }

  // Front sensor/cheek details below the main weapon line.
  addBoxDetail(group, [0.42, 0.08, 0.035], [0, 0.68, -0.64], matDark);
  for (const x of [-0.18, 0.18]) {
    addCylinderDetail(group, 0.035, 0.035, 0.02, 10, [x, 0.69, -0.67], bom.antenna, 'z');
  }

  // Rear service panel and vents, kept low so repair flags/AA mounts remain readable.
  addBoxDetail(group, [0.46, 0.16, 0.035], [0, 0.69, 0.63], matDark);
  addBoxDetail(group, [0.32, 0.026, 0.045], [0, 0.78, 0.66], bom.metal);
  for (const x of [-0.18, -0.06, 0.06, 0.18]) {
    addBoxDetail(group, [0.055, 0.11, 0.028], [x, 0.68, 0.665], bom.metal, [0.18, 0, 0]);
  }

  // Turret/dome detail stays around the base so roof-mounted add-ons, especially AA missiles,
  // have a clean mounting area and do not clash with a hatch on top of the dome.
  const turretBaseRing = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.028, 8, 20), matDark);
  turretBaseRing.rotation.x = Math.PI / 2;
  turretBaseRing.position.set(0, 0.98, -0.05);
  group.add(turretBaseRing);

  const turretInnerRing = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.014, 6, 18), bom.metal);
  turretInnerRing.rotation.x = Math.PI / 2;
  turretInnerRing.position.set(0, 1.02, -0.05);
  group.add(turretInnerRing);

  for (const angle of [-0.85, -0.42, 0.42, 0.85]) {
    const x = Math.sin(angle) * 0.43;
    const z = -0.05 - Math.cos(angle) * 0.34;
    addBoxDetail(group, [0.1, 0.05, 0.06], [x, 1.02, z], matDark, [0, angle * 0.35, 0]);
  }

  addBoxDetail(group, [0.08, 0.055, 0.11], [-0.24, 1.05, -0.31], matDark, [0, -0.25, 0]);
  addBoxDetail(group, [0.08, 0.055, 0.11], [0.24, 1.05, -0.31], matDark, [0, 0.25, 0]);
}

function addLimbedCageArmour(group: THREE.Group, level: number, factionHex?: string): void {
  const cageColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
  const cageMat = new THREE.MeshStandardMaterial({ color: cageColor, roughness: 0.5, metalness: 0.5 });

  const cageScale = Math.pow(THREE.MathUtils.clamp((level - 1) / 4, 0, 1), 1.35);
  const sideX = 0.62 + cageScale * 0.24;
  const frontZ = -0.5 - cageScale * 0.25;
  const rearZ = 0.5 + cageScale * 0.22;
  const railCount = level >= 5 ? 4 : level >= 3 ? 3 : level >= 2 ? 2 : 1;
  const railYs = railCount === 1 ? [0.88] : railCount === 2 ? [0.8, 1.0] : railCount === 3 ? [0.74, 0.95, 1.16] : [0.7, 0.88, 1.08, 1.28];
  const postCount = Math.min(8, 2 + level * 2);
  const railRadius = 0.012 + cageScale * 0.016;

  for (const side of [-1, 1]) {
    const x = side * sideX;

    for (let i = 0; i < postCount; i++) {
      const z = frontZ + (i / (postCount - 1)) * (rearZ - frontZ);
      // Short standoffs from the hull; positioned between leg sockets and above the knees.
      addBoxDetail(group, [0.08 + cageScale * 0.08, 0.024 + cageScale * 0.016, 0.026 + cageScale * 0.016], [side * 0.55, 0.79 + cageScale * 0.05, z], cageMat);
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.26 + cageScale * 0.32, 6, [x, 0.88 + cageScale * 0.2, z], cageMat, 'y');
    }

    for (const y of railYs) {
      addCylinderDetail(group, railRadius, railRadius, rearZ - frontZ, 6, [x, y, (frontZ + rearZ) / 2], cageMat, 'z');
    }

    if (level >= 3) {
      for (const z of [frontZ, rearZ]) {
        addCylinderDetail(group, railRadius * 0.9, railRadius * 0.9, 0.3 + cageScale * 0.28, 6, [side * (0.43 + cageScale * 0.05), 0.94 + cageScale * 0.14, z], cageMat, 'x');
      }
    }
  }

  if (level >= 3) {
    for (const y of railYs.slice(0, 2)) {
      addCylinderDetail(group, railRadius * 0.9, railRadius * 0.9, 0.82 + cageScale * 0.3, 6, [0, y, frontZ - 0.06], cageMat, 'x');
    }
  }

  if (level >= 5) {
    for (const x of [-0.32, 0, 0.32]) {
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.38 + cageScale * 0.2, 6, [x, 1.22 + cageScale * 0.08, 0.32], cageMat, 'z');
    }
    for (const z of [0.16, 0.34, 0.52]) {
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.68 + cageScale * 0.26, 6, [0, 1.22 + cageScale * 0.08, z], cageMat, 'x');
    }
  }
}

function addFlightHullDetails(group: THREE.Group, bom: BoltOnMaterials): void {
  // Keep drone details shallow and close to the payload/arms so roof-mounted weapons,
  // the repair flag and AA launcher still have a clean silhouette.
  for (const side of [-1, 1]) {
    const x = side * 0.33;
    const faceX = x + side * 0.016;

    // Side service rails and small access panels on the payload pod.
    addBoxDetail(group, [0.032, 0.05, 0.52], [x, 0.76, 0], matDark);
    addBoxDetail(group, [0.038, 0.024, 0.42], [faceX, 0.87, 0.02], bom.metal);
    for (const z of [-0.18, 0.16]) {
      addBoxDetail(group, [0.044, 0.09, 0.13], [faceX + side * 0.006, 0.72, z], bom.metal);
      addBoltHead(group, [faceX + side * 0.018, 0.765, z - 0.045], bom.metal, 'x', 0.014);
      addBoltHead(group, [faceX + side * 0.018, 0.675, z + 0.045], bom.metal, 'x', 0.014);
    }

    // Light braces where the cross arms meet the payload body.
    addBoxDetail(group, [0.16, 0.035, 0.045], [side * 0.24, 0.82, -0.24], matDark, [0, side * 0.52, 0]);
    addBoxDetail(group, [0.16, 0.035, 0.045], [side * 0.24, 0.82, 0.24], matDark, [0, -side * 0.52, 0]);
  }

  // Underside electronics tray, deliberately above the cage footprint and below the sensor.
  addBoxDetail(group, [0.38, 0.035, 0.18], [0, 0.535, 0.16], matDark);
  for (const x of [-0.12, 0.12]) {
    addBoxDetail(group, [0.09, 0.025, 0.12], [x, 0.512, 0.16], bom.metal);
  }

  // Front/rear seams on the pod, low enough to avoid the gun and AA mounts.
  addBoxDetail(group, [0.34, 0.03, 0.028], [0, 0.82, -0.37], matDark);
  addBoxDetail(group, [0.34, 0.03, 0.028], [0, 0.82, 0.37], matDark);
}

function addFlightRotorDetails(
  group: THREE.Group,
  tip: { x: number; z: number },
  bladeLen: number,
  bladeWidth: number,
  motorSize: number,
  bom: BoltOnMaterials
): void {
  // Hub cap and retaining ring make the rotor assembly read as mechanical rather than
  // two plain rectangles. These stay tight to the motor so blade clearance is preserved.
  addCylinderDetail(group, motorSize * 0.72, motorSize * 0.72, 0.028, 10, [tip.x, 0.905, tip.z], bom.metal, 'y');
  const hubRing = new THREE.Mesh(new THREE.TorusGeometry(motorSize * 1.05, 0.008, 6, 12), matDark);
  hubRing.rotation.x = Math.PI / 2;
  hubRing.position.set(tip.x, 0.895, tip.z);
  group.add(hubRing);

  // Small raised blade-root cuffs and contrasting blade tips. They are thin and sit on top
  // of the existing blades, so the rotor disc size does not grow or clash with neighbours.
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    addBoxDetail(group, [bladeLen * 0.28, 0.012, bladeWidth * 1.15], [tip.x, 0.895, tip.z], matDark, [0, rot, 0]);

    const dx = Math.cos(rot) * bladeLen * 0.43;
    const dz = -Math.sin(rot) * bladeLen * 0.43;
    addBoxDetail(group, [bladeLen * 0.11, 0.012, bladeWidth * 1.08], [tip.x + dx, 0.902, tip.z + dz], bom.metal, [0, rot, 0]);
    addBoxDetail(group, [bladeLen * 0.11, 0.012, bladeWidth * 1.08], [tip.x - dx, 0.902, tip.z - dz], bom.metal, [0, rot, 0]);
  }
}

function addFlightCageArmour(group: THREE.Group, level: number, factionHex?: string): void {
  const cageColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
  const cageMat = new THREE.MeshStandardMaterial({ color: cageColor, roughness: 0.5, metalness: 0.5 });

  const cageScale = Math.pow(THREE.MathUtils.clamp((level - 1) / 4, 0, 1), 1.35);
  const xSide = 0.3 + cageScale * 0.18;
  const frontZ = -0.34 - cageScale * 0.22;
  const rearZ = 0.34 + cageScale * 0.22;
  const lowerY = 0.36 - cageScale * 0.16;
  const upperY = 0.46 + cageScale * 0.08;
  const midY = (lowerY + upperY) / 2;
  const postCount = Math.min(8, 2 + level * 2);
  const railCount = level >= 5 ? 4 : level >= 3 ? 3 : level >= 2 ? 2 : 1;
  const sideRailYs = railCount === 1 ? [midY] : railCount === 2 ? [lowerY + 0.035, upperY - 0.03] : railCount === 3 ? [lowerY + 0.03, midY, upperY - 0.03] : [lowerY + 0.025, lowerY + (upperY - lowerY) * 0.35, lowerY + (upperY - lowerY) * 0.68, upperY - 0.025];
  const railRadius = 0.011 + cageScale * 0.012;

  // Short standoffs attach the cage to the pod underside. The cage sits under the payload,
  // below the sensor and well inside the rotors, repair pole, gun and AA launcher envelope.
  for (const x of [-0.2, 0, 0.2]) {
    addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.08 + cageScale * 0.08, 6, [x, 0.5, frontZ * 0.45], cageMat, 'y');
    addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.08 + cageScale * 0.08, 6, [x, 0.5, rearZ * 0.45], cageMat, 'y');
  }

  for (const side of [-1, 1]) {
    const x = side * xSide;
    for (let i = 0; i < postCount; i++) {
      const z = frontZ + (i / (postCount - 1)) * (rearZ - frontZ);
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, upperY - lowerY, 6, [x, midY, z], cageMat, 'y');
      addBoxDetail(group, [0.06 + cageScale * 0.06, 0.02 + cageScale * 0.014, 0.024 + cageScale * 0.014], [side * 0.28, upperY, z], cageMat);
    }

    for (const y of sideRailYs) {
      addCylinderDetail(group, railRadius, railRadius, rearZ - frontZ, 6, [x, y, 0], cageMat, 'z');
    }
  }

  // Front and rear returns complete the cope-cage box without rising into other equipment.
  for (const z of [frontZ, rearZ]) {
    for (const y of sideRailYs) {
      addCylinderDetail(group, railRadius, railRadius, xSide * 2, 6, [0, y, z], cageMat, 'x');
    }
  }

  // Bottom grate: visible from oblique camera angles, but still below the drone body.
  if (level >= 3) {
    const grateZs = [-0.28, -0.1, 0.1, 0.28];
    for (const z of grateZs) {
      addCylinderDetail(group, railRadius * 0.75, railRadius * 0.75, xSide * 1.65, 6, [0, lowerY, z], cageMat, 'x');
    }
    for (const x of [-0.18, 0.18]) {
      addCylinderDetail(group, railRadius * 0.75, railRadius * 0.75, rearZ - frontZ, 6, [x, lowerY, 0], cageMat, 'z');
    }
  }
}



// ---------------------------------------------------------------------------
// Chassis builders
// ---------------------------------------------------------------------------

function buildWheeledChassis(group: THREE.Group, movement: number, bom: BoltOnMaterials, factionHex?: string): TurretInfo {
  const m = movement / 5;
  const hullGeo = createChamferedWedgeHull(1.4, 0.5, 2.0, 0.55, 0.07, 0.35);
  const hull = new THREE.Mesh(hullGeo, matHull);
  hull.position.y = 0.35;
  group.add(hull);

  addWheeledHullDetails(group, bom);

  // Turret uses a darkened faction colour (no texture) so it reads as a distinct armoured mass
  const turretColor = factionHex
    ? hexToColor(factionHex).multiplyScalar(0.55)
    : new THREE.Color(0x9aba9a).multiplyScalar(0.55);
  const turretMat = new THREE.MeshStandardMaterial({ color: turretColor, roughness: 0.55, metalness: 0.4 });
  const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.675, 0.5, 8), turretMat);
  turretBase.position.set(0, 0.75, -0.1);
  group.add(turretBase);

  // --- Escape hatch on turret top (positioned toward the rear of the turret) ---
  // Recessed ring (the hatch surround / coaming)
  const hatchRingOuter = 0.28;
  const hatchRingInner = 0.22;
  const hatchRingH = 0.04;
  const hatchRingGeo = new THREE.CylinderGeometry(hatchRingOuter, hatchRingOuter, hatchRingH, 16);
  const hatchRing = new THREE.Mesh(hatchRingGeo, matDark);
  hatchRing.position.set(0, 1.02, 0.16);
  group.add(hatchRing);

  // Hatch cover — slightly smaller disc sitting inside the coaming, slightly raised
  const hatchCoverGeo = new THREE.CylinderGeometry(hatchRingInner, hatchRingInner, 0.025, 16);
  const hatchCoverMat = new THREE.MeshStandardMaterial({ color: 0x6a7a6a, roughness: 0.65, metalness: 0.35 });
  const hatchCover = new THREE.Mesh(hatchCoverGeo, hatchCoverMat);
  hatchCover.position.set(0, 1.055, 0.16);
  group.add(hatchCover);

  // Hinge — small box at the rear edge of the hatch
  const hingeGeo = new THREE.BoxGeometry(0.1, 0.03, 0.025);
  const hinge = new THREE.Mesh(hingeGeo, matMetal);
  hinge.position.set(0, 1.07, 0.16 + hatchRingInner - 0.01);
  group.add(hinge);

  // Latch handle — thin bar across the front half of the hatch
  const handleGeo = new THREE.BoxGeometry(0.12, 0.025, 0.025);
  const handle = new THREE.Mesh(handleGeo, matMetal);
  handle.position.set(0, 1.07, 0.16 - hatchRingInner * 0.5);
  group.add(handle);

  // --- Track belt (loops around wheels with rounded ends) ---
  const trackH = 0.2 + m * 0.2;    // total height of the track loop
  const trackW = 0.18 + m * 0.12;   // belt width (X-axis thickness)
  // Track length now scales non-linearly with movement so fast tanks read as
  // having a longer, more aggressive running gear silhouette without making
  // low-movement tanks sprawl. Movement 1 stays compact; movement 5 is much longer.
  const trackLengthScale = THREE.MathUtils.clamp((movement - 1) / 4, 0, 1);
  const trackLen = 1.9 + Math.pow(trackLengthScale, 1.35) * 0.85; // total length front-to-back
  const beltThick = 0.035;           // thickness of the belt material
  const halfH = trackH / 2;
  const r = halfH;                   // semicircle radius at each end
  const halfStraight = (trackLen - 2 * r) / 2; // half of flat top/bottom length

  // Keep the tracks outside the hull even as movement makes them wider/longer.
  // This positions each belt by its inner face instead of a fixed centreline,
  // avoiding overlap with the chamfered hull at high movement values.
  const trackSideX = 0.76 + trackW / 2 + trackLengthScale * 0.05;
  const trackSides = [-trackSideX, trackSideX];

  for (const side of trackSides) {
    // Outer boundary — stadium / discorectangle shape
    const shape = new THREE.Shape();
    shape.moveTo(-halfStraight, halfH);
    shape.lineTo(halfStraight, halfH);
    shape.absarc(halfStraight, 0, r, Math.PI / 2, -Math.PI / 2, true);
    shape.lineTo(-halfStraight, -halfH);
    shape.absarc(-halfStraight, 0, r, -Math.PI / 2, Math.PI / 2, true);

    // Inner hole — hollows out the belt leaving just the track skin
    const innerR = r - beltThick;
    const innerHalfH = halfH - beltThick;
    const hole = new THREE.Path();
    hole.moveTo(-halfStraight, innerHalfH);
    hole.lineTo(halfStraight, innerHalfH);
    hole.absarc(halfStraight, 0, innerR, Math.PI / 2, -Math.PI / 2, true);
    hole.lineTo(-halfStraight, -innerHalfH);
    hole.absarc(-halfStraight, 0, innerR, -Math.PI / 2, Math.PI / 2, true);
    shape.holes.push(hole);

    const trackGeo = new THREE.ExtrudeGeometry(shape, { depth: trackW, bevelEnabled: false });
    trackGeo.translate(0, 0, -trackW / 2); // centre extrusion on origin
    const track = new THREE.Mesh(trackGeo, matDark);
    // Rotate so shape-X → world-Z (length), extrude-Z → world-X (width)
    track.rotation.y = Math.PI / 2;
    track.position.set(side, halfH, 0);
    group.add(track);
  }

  // --- Drive sprocket + idler wheel at track ends ---
  const trackWheelDetails: Record<number, { z: number; radius: number; width: number }[]> = { [-trackSideX]: [], [trackSideX]: [] };

  // Wheels grow with movement, but clamp within the open track window. Scaling the
  // radius/width after the max calculation made max-movement tracks read as a single grey block.
  const wheelScale = 1 + 0.08 * movement;
  const endWheelMaxR = (halfH - beltThick) * 0.82;
  const endWheelRadius = Math.min(endWheelMaxR, r * 0.56 * wheelScale);
  const endWheelWidth = Math.min(trackW * 0.5, trackW * 0.34 * wheelScale);
  for (const side of trackSides) {
    for (const z of [-halfStraight, halfStraight]) {
      const sprocket = new THREE.Mesh(
        new THREE.CylinderGeometry(endWheelRadius, endWheelRadius, endWheelWidth, 10), bom.metal
      );
      sprocket.rotation.z = Math.PI / 2;
      sprocket.position.set(side, halfH, -z);
      group.add(sprocket);
      trackWheelDetails[side].push({ z: -z, radius: endWheelRadius, width: endWheelWidth });
    }
  }

  // --- Road wheels (visible through the open track loop) ---
  // Dynamically space wheels so they never overlap regardless of movement level
  const straightLen = halfStraight * 2; // usable length between sprockets
  const roadWheelMaxR = (halfH - beltThick) * 0.68;
  const numWheels = Math.max(2, Math.min(5, Math.floor(straightLen / 0.3)));
  const spacing = straightLen / (numWheels + 1);
  // Cap radius so adjacent wheels retain visible gaps at high movement values.
  const wheelRadius = Math.min(roadWheelMaxR, spacing * 0.38, (0.055 + 0.014 * movement));
  const wheelWidth = Math.min(trackW * 0.56, trackW * 0.38 * wheelScale);
  for (const side of trackSides) {
    for (let i = 1; i <= numWheels; i++) {
      const z = -halfStraight + i * spacing;
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 12), bom.metal
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side, halfH, -z);
      group.add(wheel);
      trackWheelDetails[side].push({ z: -z, radius: wheelRadius, width: wheelWidth });
    }
  }

  for (const side of trackSides) {
    addTrackFaceDetail(group, side, trackW, halfH, halfStraight, trackWheelDetails[side]);
  }

  return { turretY: 0.8, turretZ: -0.1, turretFrontZ: -0.75 };
}

function buildLimbedChassis(group: THREE.Group, movement: number, bom: BoltOnMaterials, factionHex?: string): TurretInfo {
  const m = movement / 5;
  // Movement values are 1-5 in normal unit data. Use that full range for the
  // leg mechanics so movement 1 reads compact/stubby and movement 5 reads long,
  // fast and spider-like, instead of starting part-way through the scale.
  const legScale = THREE.MathUtils.clamp((movement - 1) / 4, 0, 1);
  const bodyGeo = createChamferedWedgeHull(1.0, 0.6, 1.2, 0.5, 0.06, 0.3);
  const body = new THREE.Mesh(bodyGeo, matHull);
  body.position.y = 0.7;
  group.add(body);

  addLimbedHullDetails(group, bom);

  // Dome (turret) uses faction colour (no texture) so it stands out as a faction identifier.
  const domeColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x9aba9a);
  const domeMat = new THREE.MeshStandardMaterial({ color: domeColor, roughness: 0.5, metalness: 0.35 });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat
  );
  dome.position.set(0, 0.95, -0.05);
  group.add(dome);

  const legThick = 0.024 + legScale * 0.086;
  const hipJointSize = 0.04 + legScale * 0.095;
  const kneeSize = 0.032 + legScale * 0.078;
  const ankleSize = 0.024 + legScale * 0.058;

  // Eight spider legs: four per side, fanned evenly in plan view.
  // Side profile: upper leg rises outward at 30 degrees, lower leg drops away at
  // roughly a right angle to it (about 60 degrees downward from horizontal).
  const hipY = 0.49;
  const ankleY = 0.12;
  const upperIncline = THREE.MathUtils.degToRad(30);
  const lowerDecline = THREE.MathUtils.degToRad(60);
  const upperHoriz = 0.16 + legScale * 0.59;
  const kneeY = hipY + Math.tan(upperIncline) * upperHoriz;
  const lowerHoriz = Math.max(0.16 + legScale * 0.1, (kneeY - ankleY) / Math.tan(lowerDecline));
  const footForward = 0.035 + legScale * 0.12;

  const yawFromDirection = (dir: THREE.Vector3): number => Math.atan2(-dir.z, dir.x);
  const directionFromYaw = (yaw: number): THREE.Vector3 => new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  const legPositions = [
    { side: -1, z: -0.48, spreadDeg: -30 - legScale * 14 },
    { side: -1, z: -0.18, spreadDeg: -10 - legScale * 5 },
    { side: -1, z: 0.18, spreadDeg: 10 + legScale * 5 },
    { side: -1, z: 0.48, spreadDeg: 30 + legScale * 14 },
    { side: 1, z: -0.48, spreadDeg: -30 - legScale * 14 },
    { side: 1, z: -0.18, spreadDeg: -10 - legScale * 5 },
    { side: 1, z: 0.18, spreadDeg: 10 + legScale * 5 },
    { side: 1, z: 0.48, spreadDeg: 30 + legScale * 14 },
  ];

  for (const lp of legPositions) {
    const side = lp.side;
    const fan = THREE.MathUtils.degToRad(lp.spreadDeg);
    const outward = new THREE.Vector3(side * Math.cos(fan), 0, Math.sin(fan)).normalize();
    const yaw = yawFromDirection(outward);

    const hip = new THREE.Vector3(side * 0.55, hipY, lp.z);
    const knee = new THREE.Vector3(
      hip.x + outward.x * upperHoriz,
      kneeY,
      hip.z + outward.z * upperHoriz
    );
    const ankle = new THREE.Vector3(
      knee.x + outward.x * lowerHoriz,
      ankleY,
      knee.z + outward.z * lowerHoriz
    );
    const footCentre = new THREE.Vector3(
      ankle.x + outward.x * footForward,
      0.035,
      ankle.z + outward.z * footForward
    );

    const hipJoint = new THREE.Mesh(new THREE.SphereGeometry(hipJointSize, 10, 8), bom.metal);
    hipJoint.position.copy(hip);
    group.add(hipJoint);

    addCylinderBetween(group, hip, knee, legThick, legThick * 0.82, 6, bom.leg);

    const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(kneeSize, 10, 8), bom.metal);
    kneeJoint.position.copy(knee);
    group.add(kneeJoint);

    addCylinderBetween(group, knee, ankle, legThick * 0.82, legThick * 0.62, 6, bom.leg);

    const ankleJoint = new THREE.Mesh(new THREE.SphereGeometry(ankleSize, 8, 6), matDark);
    ankleJoint.position.copy(ankle);
    group.add(ankleJoint);

    // Short wrist link makes the foot visibly attached even when the leg is at max movement.
    addCylinderBetween(
      group,
      ankle,
      new THREE.Vector3(footCentre.x, 0.065, footCentre.z),
      legThick * 0.5,
      legThick * 0.42,
      6,
      bom.leg
    );

    // Compact foot pad aligned with the lower leg, with toes pointing in the same
    // direction and only slightly splayed so the top-down silhouette stays coherent.
    addBoxDetail(
      group,
      [0.08 + legScale * 0.13, 0.024 + legScale * 0.022, 0.046 + legScale * 0.052],
      [footCentre.x, 0.035, footCentre.z],
      matDark,
      [0, yaw, 0]
    );

    const toeSplay = 0.16 + legScale * 0.08;
    const toeLen = 0.07 + legScale * 0.14;
    const toeSpacing = 0.022 + legScale * 0.038;
    for (const toe of [-1, 1]) {
      const toeYaw = yaw + toe * toeSplay;
      const toeDir = directionFromYaw(toeYaw);
      const sideOffset = new THREE.Vector3(-outward.z, 0, outward.x).multiplyScalar(toe * toeSpacing);
      const toePos = footCentre.clone()
        .add(outward.clone().multiplyScalar(0.03 + legScale * 0.07))
        .add(toeDir.clone().multiplyScalar(toeLen * 0.42))
        .add(sideOffset);

      addBoxDetail(
        group,
        [toeLen, 0.026, 0.03],
        [toePos.x, 0.028, toePos.z],
        bom.metal,
        [0, toeYaw, 0]
      );
    }

    // Small rear stabiliser, kept inline with the foot rather than crossing the toes.
    const rearPos = footCentre.clone().add(outward.clone().multiplyScalar(-0.075));
    addBoxDetail(
      group,
      [0.035 + legScale * 0.065, 0.018 + legScale * 0.012, 0.024 + legScale * 0.026],
      [rearPos.x, 0.028, rearPos.z],
      bom.metal,
      [0, yaw + Math.PI, 0]
    );
  }

  return { turretY: 1.0, turretZ: -0.1, turretFrontZ: -0.55 };
}

function buildFlightChassis(group: THREE.Group, movement: number, bom: BoltOnMaterials): TurretInfo {
  const m = movement / 5;

  const beamLen = 2.2;
  const beamGeo = new THREE.BoxGeometry(0.06, 0.04, beamLen);

  const beam1 = new THREE.Mesh(beamGeo, matDark);
  beam1.rotation.y = Math.PI / 4;
  beam1.position.y = 0.8;
  group.add(beam1);

  const beam2 = new THREE.Mesh(beamGeo, matDark);
  beam2.rotation.y = -Math.PI / 4;
  beam2.position.y = 0.8;
  group.add(beam2);

  const payloadGeo = createFlightPayloadHull(0.6, 0.4, 0.7, 0.6, 0.25);
  const payload = new THREE.Mesh(payloadGeo, matHull);
  payload.position.set(0, 0.75, 0);
  group.add(payload);

  const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), matDark);
  sensor.position.set(0, 0.62, -0.05);
  group.add(sensor);

  addFlightHullDetails(group, bom);

  const bladeLen = 0.4 + m * 0.68;
  const bladeThick = 0.02 + m * 0.02;   // rotor thickness scales with movement
  const bladeWidth = 0.06 + m * 0.04;   // rotor width scales with movement
  const motorSize = 0.04 + m * 0.03;

  const armTips = [
    { x: -0.78, z: -0.78 },
    { x: 0.78, z: -0.78 },
    { x: -0.78, z: 0.78 },
    { x: 0.78, z: 0.78 },
  ];

  for (const tip of armTips) {
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(motorSize, motorSize, 0.06, 8), matDark);
    motor.position.set(tip.x, 0.83, tip.z);
    group.add(motor);

    const bladeGeo = new THREE.BoxGeometry(bladeLen, bladeThick, bladeWidth);
    const blade1 = new THREE.Mesh(bladeGeo, bom.rotor);
    blade1.position.set(tip.x, 0.87, tip.z);
    blade1.rotation.y = Math.PI / 4;
    group.add(blade1);

    const blade2 = new THREE.Mesh(bladeGeo, bom.rotor);
    blade2.position.set(tip.x, 0.87, tip.z);
    blade2.rotation.y = -Math.PI / 4;
    group.add(blade2);

    addFlightRotorDetails(group, tip, bladeLen, bladeWidth, motorSize, bom);
  }

  return { turretY: 0.75, turretZ: -0.15, turretFrontZ: -0.35 };
}

// ---------------------------------------------------------------------------
// Attribute component builders
// ---------------------------------------------------------------------------

/**
 * Combined gun barrel — a single barrel whose length is driven by rangeAttack
 * and whose diameter is driven by attack.  If either stat is > 0 the barrel
 * renders; the other dimension falls back to a visible minimum.
 */
function addGunBarrel(
  group: THREE.Group, attack: number, rangeAttack: number,
  turretY: number, turretZ: number, turretFrontZ: number, bom: BoltOnMaterials
): void {
  if (attack === 0) return;

  const tAtk = attack / 5;
  const tRng = rangeAttack / 5;

  // Diameter driven by attack (min baseline so barrel is visible even at 0 attack)
  const radius = attack > 0 ? 0.04 + tAtk * 0.06 : 0.025;

  // Length driven by range (min baseline so barrel is visible even at 0 range)
  const length = rangeAttack > 0 ? 0.6 + tRng * 1.4 : 0.4;

  // Barrel starts at the front face of the turret/body and extends forward.
  // A short root mantlet overlaps the turret face so there is no visible gap on rounded domes.
  const barrelStartZ = turretFrontZ;
  const mantlet = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.55, radius * 1.75, 0.16, 10), matDark
  );
  mantlet.rotation.x = Math.PI / 2;
  mantlet.position.set(0, turretY, barrelStartZ + 0.02);
  group.add(mantlet);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.05, length, 8), bom.metal
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, turretY, barrelStartZ - length / 2);
  group.add(barrel);

  // Muzzle brake for high attack
  if (attack >= 4) {
    const muzzle = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.8, radius * 1.5, 0.1, 8), matDark
    );
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, turretY, barrelStartZ - length);
    group.add(muzzle);
  }

  // Scope for range (mounted on top of the barrel)
  if (rangeAttack > 0) {
    const scopeLen = 0.15 + tRng * 0.25;
    const scope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, scopeLen, 6), matDark
    );
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, turretY + radius + 0.06, barrelStartZ - length * 0.3);
    group.add(scope);

    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.02, 8), bom.antenna
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, turretY + radius + 0.06, barrelStartZ - length * 0.3 - scopeLen / 2);
    group.add(lens);
  }
}

function addSplashAttack(
  group: THREE.Group,
  level: number,
  rangeAttack: number,
  turretY: number,
  turretFrontZ: number,
  chassisType: ChassisType,
  bom: BoltOnMaterials
): void {
  if (level === 0) return;

  // Render splash launcher bulk one level smaller than the actual splash value.
  // This keeps missiles visible without changing the unit's gameplay attributes.
  const visualLevel = Math.max(0, level - 1);
  const tPower = THREE.MathUtils.clamp(visualLevel / 5, 0, 1);
  const tRange = THREE.MathUtils.clamp(rangeAttack / 5, 0, 1);

  // Splash power controls the visual bulk of the launcher; range controls missile
  // length. Keep a visible baseline so short-range splash units still read clearly.
  const launcherLength = 0.42 + tRange * 0.78;
  // The dark bounding pod only covers the rear half of the launcher so the missiles
  // protrude and remain visible instead of being hidden inside a long box.
  const podLength = launcherLength * 0.5;
  const podSize = 0.24 + tPower * 0.26;
  const wall = 0.035 + tPower * 0.018;
  const tubeRadius = 0.032 + tPower * 0.03;
  const tubeSpacing = podSize * 0.27;

  let baseY: number;
  let baseZ: number;

  switch (chassisType) {
    case 'wheeled':
      // Pedestal bottom sits on the turret roof instead of floating above it.
      baseY = turretY + 0.18;
      baseZ = turretFrontZ + 0.08;
      break;
    case 'limbed':
      // The spider dome is curved at the launcher mount point; keep the mount low
      // enough to touch the dome while still clearing the front detail.
      baseY = turretY + 0.08;
      baseZ = turretFrontZ + 0.08;
      break;
    case 'flight':
      // Drones have no turret, so mount the splash pod directly on the hull roof.
      baseY = turretY + 0.12;
      baseZ = turretFrontZ + 0.08;
      break;
  }
  const pedestalHeight = 0.16 + tPower * 0.1;
  const pedestalRadius = 0.045 + tPower * 0.035;

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(pedestalRadius * 0.8, pedestalRadius * 1.15, pedestalHeight, 8),
    matDark
  );
  pedestal.position.set(0, baseY + pedestalHeight / 2, baseZ);
  group.add(pedestal);

  // Local +Y is the launch direction. Rotate it so the pod points forward and
  // 30 degrees upward from horizontal.
  const elevation = THREE.MathUtils.degToRad(30);
  const launchDirection = new THREE.Vector3(0, Math.sin(elevation), -Math.cos(elevation)).normalize();
  const launcherGroup = new THREE.Group();
  launcherGroup.position.set(0, baseY + pedestalHeight, baseZ);
  launcherGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), launchDirection);

  // Rear pivot block makes the angled launcher feel physically attached to the turret.
  const pivot = new THREE.Mesh(new THREE.BoxGeometry(podSize * 0.75, wall * 1.6, podSize * 0.75), matDark);
  pivot.position.set(0, -wall * 0.4, 0);
  launcherGroup.add(pivot);

  // Four long wall plates create a square, hollow missile-launcher silhouette.
  const half = podSize / 2;
  const sideWallSize: [number, number, number] = [wall, podLength, podSize];
  const capWallSize: [number, number, number] = [podSize, podLength, wall];
  for (const x of [-half + wall / 2, half - wall / 2]) {
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(sideWallSize[0], sideWallSize[1], sideWallSize[2]), matDark);
    sideWall.position.set(x, podLength / 2, 0);
    launcherGroup.add(sideWall);
  }
  for (const z of [-half + wall / 2, half - wall / 2]) {
    const capWall = new THREE.Mesh(new THREE.BoxGeometry(capWallSize[0], capWallSize[1], capWallSize[2]), matDark);
    capWall.position.set(0, podLength / 2, z);
    launcherGroup.add(capWall);
  }

  // 2x2 launcher tubes inside the square pod.  Their radius grows with splash power,
  // while the tube length follows range.
  for (const x of [-tubeSpacing, tubeSpacing]) {
    for (const z of [-tubeSpacing, tubeSpacing]) {
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(tubeRadius, tubeRadius, launcherLength * 0.92, 10, 1, true),
        bom.metal
      );
      tube.position.set(x, launcherLength * 0.5, z);
      launcherGroup.add(tube);

      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(tubeRadius, tubeRadius * 0.18, 6, 10), bom.metal);
      muzzle.rotation.x = Math.PI / 2;
      muzzle.position.set(x, launcherLength, z);
      launcherGroup.add(muzzle);

      const rocketNose = new THREE.Mesh(
        new THREE.ConeGeometry(tubeRadius * 0.8, 0.055 + tPower * 0.035, 8),
        matDark
      );
      rocketNose.position.set(x, launcherLength + 0.02, z);
      launcherGroup.add(rocketNose);
    }
  }

  group.add(launcherGroup);
}

function addArmour(group: THREE.Group, level: number, chassisType: ChassisType, factionHex?: string): void {
  if (level === 0) return;

  // Faction-coloured spike material (falls back to a default tint if no faction)
  const spikeColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
  const spikeMat = new THREE.MeshStandardMaterial({ color: spikeColor, roughness: 0.5, metalness: 0.45 });

  // --- Flight chassis: bottom-mounted cope cage, kept below the payload and equipment ---
  if (chassisType === 'flight') {
    addFlightCageArmour(group, level, factionHex);
    return;
  }

  if (chassisType === 'wheeled') {
    addWheeledCageArmour(group, level, factionHex);
    return;
  }

  if (chassisType === 'limbed') {
    addLimbedCageArmour(group, level, factionHex);
    return;
  }

  // --- Fallback chassis armour: horizontal outward-pointing spikes ---
  const width = chassisType === 'limbed' ? 1.0 : 1.4;
  const depth = chassisType === 'limbed' ? 1.1 : 1.9;
  const t = level / 5;

  // Spike dimensions scale with armour level (doubled for visibility)
  const spikeHeight = 0.16 + t * 0.44;   // how tall spikes protrude outward
  const spikeRadius = 0.06 + t * 0.08;   // base radius of each spike cone
  const spikeCount = Math.max(3, level + 2); // more spikes at higher levels

  // Y position: flush against the hull, must not overlap locomotion components.
  // Wheeled: hull top ~0.55, immediately above tracks
  // Limbed: body bottom ~0.45, immediately above leg hip joints (0.42)
  let spikeY: number;
  switch (chassisType) {
    case 'wheeled': spikeY = 0.55; break;
    case 'limbed': spikeY = 0.48 + spikeRadius * 2; break;
    default: spikeY = 0.55; break;
  }

  const spacing = depth / (spikeCount + 1);

  // Side spikes — along left and right hull edges, pointing outward
  for (const side of [-1, 1]) {
    const spikeX = side * (width / 2 + spikeHeight / 2);

    for (let i = 1; i <= spikeCount; i++) {
      const spikeZ = -depth / 2 + i * spacing;

      // For wheeled chassis, follow the bonnet slope downward at the front.
      let spikePosY = spikeY;
      if (chassisType === 'wheeled') {
        const halfDepth = depth / 2;
        const slopeStart = halfDepth * 0.1; // Z threshold where slope begins (towards -Z)
        if (spikeZ < slopeStart) {
          const t_slope = (slopeStart - spikeZ) / (slopeStart + halfDepth); // 0 at threshold, 1 at front tip
          const bonnetDrop = 0.5 * 0.35; // hull height * drop fraction
          spikePosY = spikeY - bonnetDrop * t_slope;
        }
      }

      const spikeGeo = new THREE.ConeGeometry(spikeRadius, spikeHeight, 6);
      const spike = new THREE.Mesh(spikeGeo, spikeMat);

      // Rotate cone so it points outward (left spikes point -X, right point +X)
      spike.rotation.z = side * -Math.PI / 2;
      spike.position.set(spikeX, spikePosY, spikeZ);
      group.add(spike);
    }
  }

  // Front edge spikes — pointing forward (-Z), spread across the hull width
  if (level >= 3) {
    const frontSpikeCount = Math.max(2, Math.floor(spikeCount * 0.6));
    const frontSpacing = width / (frontSpikeCount + 1);
    const frontZ = -(depth / 2 + spikeHeight / 2);
    // Wheeled front spikes sit one spike diameter lower to clear the bonnet slope
    const frontSpikeY = chassisType === 'wheeled' ? spikeY - spikeRadius * 2 : spikeY;

    for (let i = 1; i <= frontSpikeCount; i++) {
      const sx = -width / 2 + i * frontSpacing;
      const spikeGeo = new THREE.ConeGeometry(spikeRadius * 0.9, spikeHeight * 0.85, 6);
      const spike = new THREE.Mesh(spikeGeo, spikeMat);

      // Tip points -Z (outward from front face)
      spike.rotation.x = -Math.PI / 2;
      spike.position.set(sx, frontSpikeY, frontZ);
      group.add(spike);
    }
  }

  // Rear edge spikes — pointing backward (+Z)
  if (level >= 5) {
    const rearSpikeCount = Math.max(2, Math.floor(spikeCount * 0.5));
    const rearSpacing = width / (rearSpikeCount + 1);
    const rearZ = depth / 2 + spikeHeight / 2;

    for (let i = 1; i <= rearSpikeCount; i++) {
      const sx = -width / 2 + i * rearSpacing;
      const spikeGeo = new THREE.ConeGeometry(spikeRadius * 0.85, spikeHeight * 0.75, 6);
      const spike = new THREE.Mesh(spikeGeo, spikeMat);

      // Tip points +Z (outward from rear face)
      spike.rotation.x = Math.PI / 2;
      spike.position.set(sx, spikeY, rearZ);
      group.add(spike);
    }
  }
}

function createRadarDishGeometry(radius: number, depth: number): THREE.BufferGeometry {
  // A shallow parabolic bowl with its open face pointing along local +Z.
  // The rear surface is also modelled, with a thin rim wall, so the dish reads
  // as a solid object instead of disappearing when viewed from behind.
  const radialSegments = 18;
  const ringSegments = 5;
  const shellThickness = Math.max(0.012, radius * 0.08);
  const positions: number[] = [];
  const indices: number[] = [];

  // Front concave surface.
  for (let r = 0; r <= ringSegments; r++) {
    const frac = r / ringSegments;
    const ringRadius = radius * frac;
    const z = -depth * (1 - frac * frac);

    for (let s = 0; s < radialSegments; s++) {
      const angle = (s / radialSegments) * Math.PI * 2;
      positions.push(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, z);
    }
  }

  // Back convex surface, offset just behind the bowl.
  const backOffset = (ringSegments + 1) * radialSegments;
  for (let r = 0; r <= ringSegments; r++) {
    const frac = r / ringSegments;
    const ringRadius = radius * frac;
    const z = -depth * (1 - frac * frac) - shellThickness;

    for (let s = 0; s < radialSegments; s++) {
      const angle = (s / radialSegments) * Math.PI * 2;
      positions.push(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, z);
    }
  }

  for (let r = 0; r < ringSegments; r++) {
    for (let s = 0; s < radialSegments; s++) {
      const a = r * radialSegments + s;
      const b = r * radialSegments + ((s + 1) % radialSegments);
      const c = (r + 1) * radialSegments + s;
      const d = (r + 1) * radialSegments + ((s + 1) % radialSegments);

      // Front bowl.
      indices.push(a, c, b);
      indices.push(b, c, d);

      // Rear shell, with reversed winding so it is visible from behind.
      const ab = backOffset + a;
      const bb = backOffset + b;
      const cb = backOffset + c;
      const db = backOffset + d;
      indices.push(ab, bb, cb);
      indices.push(bb, db, cb);
    }
  }

  // Close the outer rim between front and back surfaces.
  const rimRing = ringSegments * radialSegments;
  const backRimRing = backOffset + rimRing;
  for (let s = 0; s < radialSegments; s++) {
    const a = rimRing + s;
    const b = rimRing + ((s + 1) % radialSegments);
    const c = backRimRing + s;
    const d = backRimRing + ((s + 1) % radialSegments);
    indices.push(a, b, c);
    indices.push(b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function addDefence(group: THREE.Group, level: number, turretY: number, chassisType: ChassisType, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const t = level / 5;

  // Rear positions only: the two front radar columns were visually noisy, while the
  // rear pair gives a clear EW silhouette without crowding weapons on the front line.
  let rearCorners: { x: number; z: number }[];
  let baseY: number;

  switch (chassisType) {
    case 'wheeled':
      rearCorners = [
        { x: -0.78, z: 0.9 },
        { x: 0.78, z: 0.9 },
      ];
      baseY = 0.6;
      break;
    case 'limbed':
      rearCorners = [
        { x: -0.54, z: 0.5 },
        { x: 0.54, z: 0.5 },
      ];
      baseY = 1.0;
      break;
    case 'flight':
      rearCorners = [
        { x: -0.28, z: 0.22 },
        { x: 0.28, z: 0.22 },
      ];
      baseY = 0.75;
      break;
  }

  // Pole is fixed at the old EW=3 height so EW value changes read through dish size,
  // not through taller masts.
  const fixedEW3T = 3 / 5;
  const mastHeight = 0.2 + fixedEW3T * 0.3;
  const mastRadius = 0.015 + fixedEW3T * 0.008;

  // Match the repair cross' full horizontal span at the same level:
  // repair cross uses crossWidth * 2, where crossWidth = 0.08 + t * 0.25.
  const dishDiameter = (0.08 + t * 0.25) * 2;
  const dishRadius = dishDiameter / 2;
  const dishDepth = dishRadius * 0.34;
  const rimRadius = 0.008 + t * 0.008;
  const feedLen = dishRadius * 0.55;
  const dishOffset = dishDepth + mastRadius * 3.0;
  const dishCentreZ = dishOffset - dishDepth;
  const receiverZ = dishOffset + feedLen;

  for (const corner of rearCorners) {
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(mastRadius * 0.7, mastRadius, mastHeight, 6), bom.antenna
    );
    mast.position.set(corner.x, baseY + mastHeight / 2, corner.z);
    group.add(mast);

    const dishGroup = new THREE.Group();
    // Anchor the dish assembly at the mast top.  The dish itself is then offset
    // forward along its own normal, so the vertical mast does not pierce the bowl.
    dishGroup.position.set(corner.x, baseY + mastHeight, corner.z);

    // Face the dish outward from the vehicle centre and upward at 45 degrees.
    const outward = new THREE.Vector3(corner.x, 0, corner.z).normalize();
    const dishNormal = new THREE.Vector3(outward.x, 1, outward.z).normalize();
    dishGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dishNormal);

    const support = new THREE.Mesh(
      new THREE.CylinderGeometry(rimRadius * 0.45, rimRadius * 0.55, Math.max(dishCentreZ, 0.001), 5),
      bom.antenna
    );
    support.rotation.x = Math.PI / 2;
    support.position.set(0, 0, dishCentreZ / 2);
    dishGroup.add(support);

    const dishMat = bom.antenna.clone();
    dishMat.side = THREE.DoubleSide;
    const dish = new THREE.Mesh(createRadarDishGeometry(dishRadius, dishDepth), dishMat);
    dish.position.set(0, 0, dishOffset);
    dishGroup.add(dish);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(dishRadius, rimRadius, 6, 18), bom.antenna);
    rim.position.set(0, 0, dishOffset);
    dishGroup.add(rim);

    // Feed arm now starts exactly at the centre of the dish and runs outward along
    // the dish normal, so it meets the bowl instead of floating off-centre.
    const feed = new THREE.Mesh(
      new THREE.CylinderGeometry(rimRadius * 0.6, rimRadius, receiverZ - dishCentreZ, 5), matDark
    );
    feed.rotation.x = Math.PI / 2;
    feed.position.set(0, 0, (dishCentreZ + receiverZ) / 2);
    dishGroup.add(feed);

    const receiver = new THREE.Mesh(new THREE.SphereGeometry(rimRadius * 1.7, 6, 5), matDark);
    receiver.position.set(0, 0, receiverZ);
    dishGroup.add(receiver);

    group.add(dishGroup);
  }
}

function addRepair(group: THREE.Group, level: number, chassisType: ChassisType, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const yBase = chassisType === 'limbed' ? 0.7 : chassisType === 'flight' ? 0.8 : 0.35;
  const t = level / 5;

  // Hull rear Z per chassis (back edge of the body)
  const hullRearZ = chassisType === 'limbed' ? 0.55 : chassisType === 'flight' ? 0.35 : 0.95;

  // Flagpole — centred (X=0), at the very back of the hull.
  // Pole height is fixed per chassis to meet the top of the level-5 armour cage;
  // only the red cross scales with repair value.
  const targetPoleTopY = chassisType === 'limbed' ? 1.45 : chassisType === 'flight' ? 1.12 : 1.24;
  const poleRadius = 0.026;
  const poleX = 0;
  const poleZ = chassisType === 'flight' ? 0.72 : hullRearZ;
  const poleBaseY = yBase;
  const poleHeight = targetPoleTopY - poleBaseY;
  const poleTopY = poleBaseY + poleHeight;

  // On drones the rear EW dishes occupy the pod roof, so the repair marker is carried
  // behind them on a short horizontal boom before the vertical pole rises.
  if (chassisType === 'flight') {
    const boomLength = poleZ - hullRearZ;
    const boom = new THREE.Mesh(
      new THREE.CylinderGeometry(poleRadius * 0.85, poleRadius, boomLength, 6), bom.metal
    );
    boom.rotation.x = Math.PI / 2;
    boom.position.set(poleX, poleBaseY, hullRearZ + boomLength / 2);
    group.add(boom);
  }

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleRadius * 0.7, poleRadius, poleHeight, 6), bom.metal
  );
  pole.position.set(poleX, poleBaseY + poleHeight / 2, poleZ);
  group.add(pole);

  // Red cross sits on top of the fixed-height pole; only the cross size scales.
  const crossWidth = 0.08 + t * 0.25;
  const crossHeight = 0.08 + t * 0.19;
  const crossThick = 0.04 + t * 0.025;
  const crossY = poleTopY + crossHeight;
  const crossMat = new THREE.MeshStandardMaterial({ color: 0xdd2222, roughness: 0.4, metalness: 0.2 });

  // Horizontal bar of cross
  const crossH = new THREE.Mesh(
    new THREE.BoxGeometry(crossWidth * 2, crossThick, crossThick), crossMat
  );
  crossH.position.set(poleX, crossY, poleZ);
  group.add(crossH);

  // Vertical bar of cross
  const crossV = new THREE.Mesh(
    new THREE.BoxGeometry(crossThick, crossHeight * 2, crossThick), crossMat
  );
  crossV.position.set(poleX, crossY, poleZ);
  group.add(crossV);
}

/**
 * Anti-Air missile launcher — a tubular launcher housing tilted at 75° from
 * horizontal, with a missile visible inside. Centred on the chassis.
 * The missile size scales with the 1–5 attribute level, starting chunky at level 1.
 *
 * For wheeled chassis: mounted on top of the turret, immediately behind the splash weapon.
 * For other chassis: mounted on top of the body centre (same layout as drone which works well).
 */
function addAntiAir(
  group: THREE.Group,
  level: number,
  rangeAttack: number,
  turretY: number,
  turretFrontZ: number,
  chassisType: ChassisType,
  bom: BoltOnMaterials
): void {
  if (level === 0) return;

  const tPower = THREE.MathUtils.clamp(level / 5, 0, 1);
  const tRange = THREE.MathUtils.clamp(rangeAttack / 5, 0, 1);

  // Position depends on chassis:
  // Wheeled: on top of turret, behind splash.
  // Limbed/Flight: on top of body centre.
  let baseY: number;
  let baseZ: number;

  switch (chassisType) {
    case 'wheeled':
      baseY = 1.02;
      baseZ = turretFrontZ + 0.45;
      break;
    case 'limbed':
      baseY = 1.05;
      baseZ = 0;
      break;
    case 'flight':
      baseY = 0.95;
      baseZ = 0;
      break;
  }

  // Tilt angle: 75° from horizontal = 15° from vertical.
  const tiltAngle = (75 * Math.PI) / 180;

  // AA power controls thickness/bulk; range controls missile and launcher length.
  const missileRadius = 0.05 + tPower * 0.055;
  const missileHeight = 0.45 + tRange * 0.75;
  const noseConeHeight = missileHeight * 0.22;

  const launcherRadius = missileRadius + 0.025 + tPower * 0.01;
  const launcherLength = 0.32 + tRange * 0.52;

  const missileMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4, metalness: 0.3 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xdd3333, roughness: 0.35, metalness: 0.4 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.5, metalness: 0.5 });
  const launcherMat = new THREE.MeshStandardMaterial({ color: 0x4a5a4a, roughness: 0.6, metalness: 0.4 });

  const launcherGroup = new THREE.Group();
  launcherGroup.position.set(0, baseY, baseZ);

  // --- Launcher base / pedestal (stays upright) ---
  const pedestalH = 0.1 + tPower * 0.08;
  const pedestalR = launcherRadius * (1.15 + tPower * 0.35);
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(pedestalR, pedestalR * 1.2, pedestalH, 10), bom.metal
  );
  pedestal.position.set(0, pedestalH / 2, 0);
  launcherGroup.add(pedestal);

  const pivotY = pedestalH;
  const pivotR = launcherRadius * (0.65 + tPower * 0.25);
  const pivot = new THREE.Mesh(new THREE.SphereGeometry(pivotR, 8, 6), bom.metal);
  pivot.position.set(0, pivotY, 0);
  launcherGroup.add(pivot);

  // --- Tilted sub-group (launcher tube + missile) rotated 75° from horizontal ---
  const tiltedGroup = new THREE.Group();
  tiltedGroup.position.set(0, pivotY, 0);
  tiltedGroup.rotation.x = -(Math.PI / 2 - tiltAngle);

  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(launcherRadius, launcherRadius, launcherLength, 12, 1, true), launcherMat
  );
  tube.position.set(0, launcherLength / 2, 0);
  tiltedGroup.add(tube);

  const capThickness = 0.02 + tPower * 0.01;
  const topCap = new THREE.Mesh(new THREE.TorusGeometry(launcherRadius, capThickness, 6, 12), launcherMat);
  topCap.rotation.x = Math.PI / 2;
  topCap.position.set(0, launcherLength, 0);
  tiltedGroup.add(topCap);

  const bottomCap = new THREE.Mesh(new THREE.TorusGeometry(launcherRadius, capThickness, 6, 12), launcherMat);
  bottomCap.rotation.x = Math.PI / 2;
  bottomCap.position.set(0, 0, 0);
  tiltedGroup.add(bottomCap);

  const missileBaseY = launcherLength * 0.15;
  const missileBody = new THREE.Mesh(
    new THREE.CylinderGeometry(missileRadius, missileRadius * 1.08, missileHeight, 8), missileMat
  );
  missileBody.position.set(0, missileBaseY + missileHeight / 2, 0);
  tiltedGroup.add(missileBody);

  const noseCone = new THREE.Mesh(new THREE.ConeGeometry(missileRadius, noseConeHeight, 8), noseMat);
  noseCone.position.set(0, missileBaseY + missileHeight + noseConeHeight / 2, 0);
  tiltedGroup.add(noseCone);

  const finHeight = missileHeight * (0.16 + tPower * 0.05);
  const finWidth = missileRadius * (2.0 + tPower * 0.7);
  const finThick = 0.016 + tPower * 0.012;

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const finGeo = new THREE.BoxGeometry(finThick, finHeight, finWidth);
    const fin = new THREE.Mesh(finGeo, finMat);
    const fx = Math.cos(angle) * (missileRadius + finWidth * 0.25);
    const fz = Math.sin(angle) * (missileRadius + finWidth * 0.25);
    fin.position.set(fx, missileBaseY + finHeight / 2, fz);
    fin.rotation.y = angle;
    tiltedGroup.add(fin);
  }

  launcherGroup.add(tiltedGroup);
  group.add(launcherGroup);
}

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
    ? createTintedMaterials(factionHex)
    : { metal: matMetal, antenna: matAntenna, rotor: matRotor, leg: matLeg };

  const group = new THREE.Group();
  const modelRoot = attrs.chassis === 'limbed' ? new THREE.Group() : group;

  let turretInfo: TurretInfo;
  switch (attrs.chassis) {
    case 'wheeled': turretInfo = buildWheeledChassis(modelRoot, attrs.movement, bom, factionHex); break;
    case 'limbed': turretInfo = buildLimbedChassis(modelRoot, attrs.movement, bom, factionHex); break;
    case 'flight': turretInfo = buildFlightChassis(modelRoot, attrs.movement, bom); break;
  }

  const { turretY, turretZ, turretFrontZ } = turretInfo;

  addGunBarrel(modelRoot, attrs.attack, attrs.rangeAttack, turretY, turretZ, turretFrontZ, bom);
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
