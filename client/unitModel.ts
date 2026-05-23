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

  // Load unit texture for hull/armour surfaces — adds visual detail at all zoom levels
  const loader = new THREE.TextureLoader();
  loader.load('data/unit-texture.jpg', (tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    tex.anisotropy = 4;
    hullTexture = tex;
    matHull.map = tex;
    matHull.needsUpdate = true;
    matArmour.map = tex;
    matArmour.needsUpdate = true;
  });

  matHull = new THREE.MeshStandardMaterial({ color: 0x7a9a7a, roughness: 0.7, metalness: 0.3 });
  matDark = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.8, metalness: 0.4 });
  matMetal = new THREE.MeshStandardMaterial({ color: 0x8a8a9a, roughness: 0.4, metalness: 0.7 });
  matArmour = new THREE.MeshStandardMaterial({ color: 0x5a6a4a, roughness: 0.6, metalness: 0.5 });
  matAntenna = new THREE.MeshStandardMaterial({ color: 0x8a8a9a, roughness: 0.3, metalness: 0.8 });
  matRotor = new THREE.MeshStandardMaterial({ color: 0x5a5a6a, roughness: 0.5, metalness: 0.6 });
  matLeg = new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.6, metalness: 0.5 });
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
 * Mix ratio: 45% faction, 55% base — gives a clear tint without losing detail.
 */
function tintColor(baseHex: number, factionColor: THREE.Color): THREE.Color {
  const base = new THREE.Color(baseHex);
  return base.lerp(factionColor, 0.45);
}

/**
 * Create a set of faction-tinted bolt-on materials.
 * These are disposable (created per model build) since each faction gets different tints.
 */
function createTintedMaterials(factionHex: string) {
  const fc = hexToColor(factionHex);
  return {
    metal: new THREE.MeshStandardMaterial({ color: tintColor(0x8a8a9a, fc), roughness: 0.4, metalness: 0.7 }),
    antenna: new THREE.MeshStandardMaterial({ color: tintColor(0x8a8a9a, fc), roughness: 0.3, metalness: 0.8 }),
    rotor: new THREE.MeshStandardMaterial({ color: tintColor(0x5a5a6a, fc), roughness: 0.5, metalness: 0.6 }),
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
 * Returns true when the hull texture has finished loading.
 * Used by the renderer to know when to re-render sprites with texture applied.
 */
export function isTextureReady(): boolean {
  return hullTexture !== null;
}

// ---------------------------------------------------------------------------
// Chassis types
// ---------------------------------------------------------------------------

export type ChassisType = 'wheeled' | 'limbed' | 'flight';

export interface UnitModelAttrs {
  attack: number;
  rangeAttack: number;
  splashAttack: number;
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

// ---------------------------------------------------------------------------
// Chassis builders
// ---------------------------------------------------------------------------

function buildWheeledChassis(group: THREE.Group, movement: number, bom: BoltOnMaterials): TurretInfo {
  const m = movement / 5;
  const hullGeo = createChamferedWedgeHull(1.4, 0.5, 2.0, 0.55, 0.07, 0.35);
  const hull = new THREE.Mesh(hullGeo, matHull);
  hull.position.y = 0.35;
  group.add(hull);

  const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.675, 0.5, 8), matHull);
  turretBase.position.set(0, 0.75, -0.1);
  group.add(turretBase);

  // --- Track belt (loops around wheels with rounded ends) ---
  const trackH = 0.2 + m * 0.2;    // total height of the track loop
  const trackW = 0.18 + m * 0.12;   // belt width (X-axis thickness)
  const trackLen = 2.1;              // total length front-to-back
  const beltThick = 0.035;           // thickness of the belt material
  const halfH = trackH / 2;
  const r = halfH;                   // semicircle radius at each end
  const halfStraight = (trackLen - 2 * r) / 2; // half of flat top/bottom length

  for (const side of [-0.8, 0.8]) {
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
  // Wheels scale 10% larger per movement attribute point
  const wheelScale = 1 + 0.1 * movement;
  const endWheelMaxR = (halfH - beltThick) * 0.85;
  const endWheelRadius = Math.min(endWheelMaxR, r * 0.7) * wheelScale;
  const endWheelWidth = trackW * 0.4 * wheelScale;
  for (const side of [-0.8, 0.8]) {
    for (const z of [-halfStraight, halfStraight]) {
      const sprocket = new THREE.Mesh(
        new THREE.CylinderGeometry(endWheelRadius, endWheelRadius, endWheelWidth, 10), bom.metal
      );
      sprocket.rotation.z = Math.PI / 2;
      sprocket.position.set(side, halfH, -z);
      group.add(sprocket);
    }
  }

  // --- Road wheels (visible through the open track loop) ---
  // Dynamically space wheels so they never overlap regardless of movement level
  const straightLen = halfStraight * 2; // usable length between sprockets
  const roadWheelMaxR = (halfH - beltThick) * 0.75;
  const numWheels = Math.max(2, Math.min(5, Math.floor(straightLen / 0.3)));
  const spacing = straightLen / (numWheels + 1);
  // Cap radius so adjacent wheels don't touch (must be < half the gap)
  const wheelRadius = Math.min(roadWheelMaxR, spacing * 0.45) * wheelScale;
  const wheelWidth = trackW * 0.55 * wheelScale;
  for (const side of [-0.8, 0.8]) {
    for (let i = 1; i <= numWheels; i++) {
      const z = -halfStraight + i * spacing;
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 12), bom.metal
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side, halfH, -z);
      group.add(wheel);
    }
  }

  return { turretY: 0.8, turretZ: -0.1, turretFrontZ: -0.75 };
}

function buildLimbedChassis(group: THREE.Group, movement: number, bom: BoltOnMaterials): TurretInfo {
  const m = movement / 5;
  const bodyGeo = createChamferedWedgeHull(1.0, 0.6, 1.2, 0.5, 0.06, 0.3);
  const body = new THREE.Mesh(bodyGeo, matHull);
  body.position.y = 0.7;
  group.add(body);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), matHull
  );
  dome.position.set(0, 0.95, -0.05);
  group.add(dome);

  const legThick = 0.04 + m * 0.04;
  const legScale = 0.7 + m * 0.5;
  const footSize = 0.04 + m * 0.04;
  const hipJointSize = 0.06 + m * 0.05; // ball joint at hip
  const kneeSize = 0.05 + m * 0.04;     // smaller joint at knee

  // Ant-like legs: upper leg 45° UP and outward, lower leg at right angles
  // (90° knee bend) angling 45° down to ground.
  const legPositions = [
    { x: -0.5, z: -0.4, zLean: -0.25 },  // front-left
    { x: 0.5, z: -0.4, zLean: -0.25 },   // front-right
    { x: -0.55, z: 0.4, zLean: 0.25 },   // rear-left
    { x: 0.55, z: 0.4, zLean: 0.25 },    // rear-right
  ];

  for (const lp of legPositions) {
    const upperLen = 0.25 * legScale;

    // Hip attachment on body edge
    const hipX = lp.x;
    const hipY = 0.65;
    const hipZ = lp.z;

    // Ball joint at hip (where leg joins hull)
    const hipJoint = new THREE.Mesh(
      new THREE.SphereGeometry(hipJointSize, 8, 6), bom.metal
    );
    hipJoint.position.set(hipX, hipY, hipZ);
    group.add(hipJoint);

    // Upper leg: 45° UP and OUTWARD from hull (ant-like raised knee)
    // Angle from vertical (straight down) = 135° = 3π/4
    const upperAngleZ = lp.x > 0 ? (3 * Math.PI / 4) : -(3 * Math.PI / 4);
    const upperAngleX = lp.zLean * 0.4; // forward/backward lean

    const upperDx = (upperLen / 2) * Math.sin(upperAngleZ);
    const upperDy = -(upperLen / 2) * Math.cos(upperAngleZ);
    const upperDz = (upperLen / 2) * Math.sin(upperAngleX);

    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(legThick, legThick * 0.85, upperLen, 6), bom.leg
    );
    upper.position.set(hipX + upperDx, hipY + upperDy, hipZ + upperDz);
    upper.rotation.z = upperAngleZ;
    upper.rotation.x = upperAngleX;
    group.add(upper);

    // Knee position — end of upper leg (above and outward from hip)
    const kneeX = hipX + upperLen * Math.sin(upperAngleZ);
    const kneeY = hipY - upperLen * Math.cos(upperAngleZ);
    const kneeZ = hipZ + upperLen * Math.sin(upperAngleX);

    // Ball joint at knee
    const kneeJoint = new THREE.Mesh(
      new THREE.SphereGeometry(kneeSize, 8, 6), bom.metal
    );
    kneeJoint.position.set(kneeX, kneeY, kneeZ);
    group.add(kneeJoint);

    // Lower leg: at right angles to upper (90° bend), 45° down to ground
    // Angle from vertical = 45° = π/4, going outward and down
    const lowerAngleZ = lp.x > 0 ? (Math.PI / 4) : -(Math.PI / 4);
    const lowerAngleX = -upperAngleX * 0.3;

    // Calculate lower leg length to reach the ground (Y=0)
    const lowerLen = Math.max(0.4, kneeY / Math.cos(Math.PI / 4));

    const lowerDx = (lowerLen / 2) * Math.sin(lowerAngleZ);
    const lowerDy = -(lowerLen / 2) * Math.cos(lowerAngleZ);
    const lowerDz = (lowerLen / 2) * Math.sin(lowerAngleX);

    const lower = new THREE.Mesh(
      new THREE.CylinderGeometry(legThick * 0.85, legThick * 0.7, lowerLen, 6), bom.leg
    );
    lower.position.set(kneeX + lowerDx, kneeY + lowerDy, kneeZ + lowerDz);
    lower.rotation.z = lowerAngleZ;
    lower.rotation.x = lowerAngleX;
    group.add(lower);

    // Foot at bottom of lower leg
    const footX = kneeX + lowerLen * Math.sin(lowerAngleZ);
    const footY = Math.max(0, kneeY - lowerLen * Math.cos(lowerAngleZ));
    const footZ = kneeZ + lowerLen * Math.sin(lowerAngleX);

    const foot = new THREE.Mesh(new THREE.SphereGeometry(footSize, 6, 4), matDark);
    foot.position.set(footX, footY, footZ);
    group.add(foot);
  }

  return { turretY: 1.0, turretZ: -0.1, turretFrontZ: -0.55 };
}

function buildFlightChassis(group: THREE.Group, movement: number, bom: BoltOnMaterials): TurretInfo {
  const m = movement / 5;

  const beamLen = 1.6;
  const beamGeo = new THREE.BoxGeometry(0.06, 0.04, beamLen);

  const beam1 = new THREE.Mesh(beamGeo, matDark);
  beam1.rotation.y = Math.PI / 4;
  beam1.position.y = 0.8;
  group.add(beam1);

  const beam2 = new THREE.Mesh(beamGeo, matDark);
  beam2.rotation.y = -Math.PI / 4;
  beam2.position.y = 0.8;
  group.add(beam2);

  const payloadGeo = createChamferedWedgeHull(0.6, 0.4, 0.7, 0.6, 0.03, 0.25);
  const payload = new THREE.Mesh(payloadGeo, matHull);
  payload.position.set(0, 0.75, 0);
  group.add(payload);

  const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), matDark);
  sensor.position.set(0, 0.62, -0.05);
  group.add(sensor);

  const bladeLen = 0.4 + m * 0.5;
  const motorSize = 0.04 + m * 0.03;

  const armTips = [
    { x: -0.55, z: -0.55 },
    { x: 0.55, z: -0.55 },
    { x: -0.55, z: 0.55 },
    { x: 0.55, z: 0.55 },
  ];

  for (const tip of armTips) {
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(motorSize, motorSize, 0.06, 8), matDark);
    motor.position.set(tip.x, 0.83, tip.z);
    group.add(motor);

    const bladeGeo = new THREE.BoxGeometry(bladeLen, 0.01, 0.04);
    const blade1 = new THREE.Mesh(bladeGeo, bom.rotor);
    blade1.position.set(tip.x, 0.87, tip.z);
    group.add(blade1);

    const blade2 = new THREE.Mesh(bladeGeo, bom.rotor);
    blade2.position.set(tip.x, 0.87, tip.z);
    blade2.rotation.y = Math.PI / 2;
    group.add(blade2);
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
  if (attack === 0 && rangeAttack === 0) return;

  const tAtk = attack / 5;
  const tRng = rangeAttack / 5;

  // Diameter driven by attack (min baseline so barrel is visible even at 0 attack)
  const radius = attack > 0 ? 0.04 + tAtk * 0.06 : 0.025;

  // Length driven by range (min baseline so barrel is visible even at 0 range)
  const length = rangeAttack > 0 ? 0.6 + tRng * 1.4 : 0.4;

  // Barrel starts at the front face of the turret/body and extends forward
  const barrelStartZ = turretFrontZ;
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

function addSplashAttack(group: THREE.Group, level: number, turretY: number, turretFrontZ: number, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const barrelCount = Math.max(2, level);
  const t = level / 5;
  const length = 0.35 + t * 0.45;
  const radius = 0.04 + t * 0.02;
  const spread = 0.06 + t * 0.06;

  // Raise the splash cluster well above the turret so it clears the rangefinder/scope
  const splashY = turretY + 0.45;

  // Small stand/pylon connecting the turret to the splash cluster so it doesn't hover
  const standHeight = splashY - turretY;
  const standRadius = 0.04 + t * 0.02;
  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(standRadius * 0.8, standRadius, standHeight, 6), matDark
  );
  stand.position.set(0, turretY + standHeight / 2, turretFrontZ + 0.05);
  group.add(stand);

  for (let i = 0; i < barrelCount; i++) {
    const angle = (i / barrelCount) * Math.PI * 2;
    const ox = Math.cos(angle) * spread;
    const oy = Math.sin(angle) * spread;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 6), bom.metal);
    b.rotation.x = Math.PI / 2;
    b.position.set(ox, splashY + oy, turretFrontZ - length / 2);
    group.add(b);
  }

  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(spread + radius + 0.03, spread + radius + 0.05, 0.12, 10), matDark
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, splashY, turretFrontZ + 0.05);
  group.add(collar);
}

function addArmour(group: THREE.Group, level: number, chassisType: ChassisType): void {
  if (level === 0) return;
  const yBase = chassisType === 'limbed' ? 0.7 : chassisType === 'flight' ? 0.55 : 0.35;
  const width = chassisType === 'limbed' ? 1.0 : chassisType === 'flight' ? 0.6 : 1.4;
  const height = chassisType === 'limbed' ? 0.5 : chassisType === 'flight' ? 0.25 : 0.45;
  const depth = chassisType === 'limbed' ? 1.1 : chassisType === 'flight' ? 1.3 : 1.9;
  const t = level / 5;
  const thickness = 0.04 + t * 0.1;

  // Side plates run the full depth so they meet front and rear plates at the corners
  for (const side of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(thickness, height * 0.8, depth), matArmour);
    plate.position.set(side * (width / 2 + thickness / 2), yBase + height * 0.1, 0);
    group.add(plate);
  }

  // Front and rear plates span the full outer width (side-plate edge to side-plate edge)
  const outerWidth = width + thickness * 2;

  const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(outerWidth, height * 0.6, thickness), matArmour);
  frontPlate.position.set(0, yBase + height * 0.15, -(depth / 2 + thickness / 2));
  frontPlate.rotation.x = -0.15;
  group.add(frontPlate);

  const rearPlate = new THREE.Mesh(new THREE.BoxGeometry(outerWidth, height * 0.7, thickness), matArmour);
  rearPlate.position.set(0, yBase + height * 0.1, depth / 2 + thickness / 2);
  group.add(rearPlate);

  if (level >= 4) {
    const blockCount = Math.floor(level / 2) + 1;
    for (let i = 0; i < blockCount; i++) {
      for (const side of [-1, 1]) {
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.15), matDark);
        block.position.set(side * (width / 2 + thickness + 0.04), yBase + height * 0.1, -0.4 + i * 0.35);
        group.add(block);
      }
    }
  }
}

function addDefence(group: THREE.Group, level: number, turretY: number, chassisType: ChassisType, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const t = level / 5;

  // Corner positions sized to the hull footprint of each chassis
  let corners: { x: number; z: number }[];
  let baseY: number;

  switch (chassisType) {
    case 'wheeled':
      corners = [
        { x: -0.65, z: -0.9 },
        { x: 0.65, z: -0.9 },
        { x: -0.65, z: 0.9 },
        { x: 0.65, z: 0.9 },
      ];
      baseY = 0.6;
      break;
    case 'limbed':
      corners = [
        { x: -0.45, z: -0.5 },
        { x: 0.45, z: -0.5 },
        { x: -0.45, z: 0.5 },
        { x: 0.45, z: 0.5 },
      ];
      baseY = 1.0;
      break;
    case 'flight':
      corners = [
        { x: -0.22, z: -0.22 },
        { x: 0.22, z: -0.22 },
        { x: -0.22, z: 0.22 },
        { x: 0.22, z: 0.22 },
      ];
      baseY = 0.75;
      break;
  }

  const mastHeight = 0.2 + t * 0.3;
  const mastRadius = 0.015 + t * 0.008;
  const dishSize = 0.05 + t * 0.08;

  for (const corner of corners) {
    // Antenna mast
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(mastRadius * 0.7, mastRadius, mastHeight, 6), bom.antenna
    );
    mast.position.set(corner.x, baseY + mastHeight / 2, corner.z);
    group.add(mast);

    // Radar dish — scales with EW level
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(dishSize, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), bom.antenna
    );
    dish.position.set(corner.x, baseY + mastHeight + dishSize * 0.3, corner.z);
    // Face the dish outward from centre
    const angle = Math.atan2(corner.x, corner.z);
    dish.rotation.set(-Math.PI / 4, angle, 0);
    group.add(dish);

    // Small feed-horn on the dish for detail
    const feedLen = dishSize * 0.6;
    const feed = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.012, feedLen, 4), matDark
    );
    feed.position.set(corner.x, baseY + mastHeight + dishSize * 0.3 + feedLen * 0.3, corner.z);
    group.add(feed);
  }
}

function addRepair(group: THREE.Group, level: number, chassisType: ChassisType, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const yBase = chassisType === 'limbed' ? 0.7 : chassisType === 'flight' ? 0.8 : 0.35;
  const t = level / 5;

  // Flagpole — height and thickness scale with repair level
  const poleHeight = 0.4 + t * 0.3;
  const poleRadius = 0.02 + t * 0.01;
  const poleX = 0.35;
  const poleZ = 0.4;

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleRadius * 0.7, poleRadius, poleHeight, 6), bom.metal
  );
  pole.position.set(poleX, yBase + poleHeight / 2, poleZ);
  group.add(pole);

  // Red cross at the top of the flagpole — width scales more than height
  const crossWidth = 0.08 + t * 0.25;
  const crossHeight = 0.08 + t * 0.19;
  const crossThick = 0.04 + t * 0.025;
  const crossY = yBase + poleHeight + crossHeight * 0.5;
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

  let turretInfo: TurretInfo;
  switch (attrs.chassis) {
    case 'wheeled': turretInfo = buildWheeledChassis(group, attrs.movement, bom); break;
    case 'limbed': turretInfo = buildLimbedChassis(group, attrs.movement, bom); break;
    case 'flight': turretInfo = buildFlightChassis(group, attrs.movement, bom); break;
  }

  const { turretY, turretZ, turretFrontZ } = turretInfo;

  addGunBarrel(group, attrs.attack, attrs.rangeAttack, turretY, turretZ, turretFrontZ, bom);
  addSplashAttack(group, attrs.splashAttack, turretY, turretFrontZ, bom);
  addArmour(group, attrs.armour, attrs.chassis);
  addDefence(group, attrs.defence, turretY, attrs.chassis, bom);
  addRepair(group, attrs.repair, attrs.chassis, bom);

  return group;
}
