/**
 * Wheeled chassis builder — tank/APC geometry for Drone Domination unit models.
 * Exports a single buildWheeledModel() entry point consumed by unitModel.ts.
 */

import * as THREE from 'three';
import {
  BoltOnMaterials,
  addBoxDetail,
  addCylinderDetail,
  addBoltHead,
  hexToColor,
} from './unitModelHelpers.js';
import type { UnitModelAttrs } from './unitModel.js';
import type { TurretInfo } from './unitModelTypes.js';

// Shared material references — set by initWheeledMaterials() called from unitModel.ts
let matHull: THREE.MeshStandardMaterial;
let matDark: THREE.MeshStandardMaterial;
let matMetal: THREE.MeshStandardMaterial;

export function initWheeledMaterials(
  hull: THREE.MeshStandardMaterial,
  dark: THREE.MeshStandardMaterial,
  metal: THREE.MeshStandardMaterial
): void {
  matHull = hull;
  matDark = dark;
  matMetal = metal;
}

// ---------------------------------------------------------------------------
// Hull geometry
// ---------------------------------------------------------------------------

/**
 * Builds a hull with chamfered edges, a wedge-shaped front (narrowing in X),
 * AND a sloped bonnet (front dips down in Y, like a car hood).
 */
function createChamferedWedgeHull(
  width: number, height: number, length: number,
  taper: number, chamfer: number, bonnetDrop: number = 0.35
): THREE.BufferGeometry {
  const hw = width / 2;
  const fhw = hw * taper;
  const hh = height / 2;
  const hl = length / 2;
  const drop = height * bonnetDrop;

  const transZ = hl * 0.35;

  const shape = new THREE.Shape();
  shape.moveTo(-fhw, -hl);
  shape.lineTo(fhw, -hl);
  shape.lineTo(hw, -transZ);
  shape.lineTo(hw, hl);
  shape.lineTo(-hw, hl);
  shape.lineTo(-hw, -transZ);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: chamfer,
    bevelSize: chamfer,
    bevelSegments: 2,
  });

  geo.rotateX(Math.PI / 2);

  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -cy, -cz);

  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const bb2 = geo.boundingBox!;
  const minZ = bb2.min.z;
  const maxZ = bb2.max.z;
  const minY = bb2.min.y;
  const maxY = bb2.max.y;
  const totalZ = maxZ - minZ;
  const totalY = maxY - minY;
  const frontZone = totalZ * 0.55;
  const frontThreshold = minZ + frontZone;

  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const y = pos.getY(i);

    if (z < frontThreshold && y > minY + totalY * 0.2) {
      const t = Math.min(1, (frontThreshold - z) / frontZone);
      const heightFrac = (y - minY) / totalY;
      const dropAmount = drop * t * heightFrac;
      pos.setY(i, y - dropAmount);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  return geo;
}

// ---------------------------------------------------------------------------
// Hull detail helpers
// ---------------------------------------------------------------------------

function addWheeledHullDetails(group: THREE.Group, bom: BoltOnMaterials): void {
  for (const side of [-1, 1]) {
    const x = side * 0.72;
    const faceX = x + side * 0.018;

    addBoxDetail(group, [0.04, 0.24, 1.62], [x, 0.39, 0.02], matDark);
    addBoxDetail(group, [0.048, 0.035, 1.5], [faceX, 0.52, 0.02], matMetal);
    addBoxDetail(group, [0.048, 0.03, 1.5], [faceX, 0.27, 0.02], matMetal);

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

  addBoxDetail(group, [0.86, 0.026, 0.035], [0, 0.555, -0.8], matDark);
  addBoxDetail(group, [0.62, 0.12, 0.035], [0, 0.41, -1.012], matDark);
  addBoxDetail(group, [0.5, 0.024, 0.045], [0, 0.48, -1.04], matMetal);

  for (const x of [-0.48, 0.48]) {
    addBoxDetail(group, [0.12, 0.09, 0.05], [x, 0.42, -1.045], matDark);
    addCylinderDetail(group, 0.04, 0.04, 0.022, 10, [x, 0.42, -1.077], matMetal, 'z');
    addCylinderDetail(group, 0.026, 0.026, 0.1, 8, [x * 0.55, 0.27, -1.065], matMetal, 'x');
  }

  addBoxDetail(group, [0.82, 0.018, 0.34], [0, 0.63, 0.68], matDark);
  for (const x of [-0.27, 0, 0.27]) {
    addBoxDetail(group, [0.18, 0.024, 0.24], [x, 0.65, 0.68], matMetal);
  }
  for (const z of [0.56, 0.64, 0.72, 0.8]) {
    addBoxDetail(group, [0.72, 0.026, 0.018], [0, 0.675, z], matDark);
  }

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

  const treadCount = 12;
  for (let i = 0; i < treadCount; i++) {
    const z = -halfStraight + ((i + 0.5) / treadCount) * (halfStraight * 2);
    addBoxDetail(group, [0.032, 0.028, 0.085], [outerX, halfH * 1.82, -z], matMetal, [0, 0, sign * 0.1]);
    addBoxDetail(group, [0.032, 0.028, 0.085], [outerX, 0.035, -z], matMetal, [0, 0, -sign * 0.1]);
  }

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

    const bracketY = halfH + wp.radius * 0.55;
    addBoxDetail(
      group,
      [0.035, Math.max(0.08, wp.radius * 0.9), 0.045],
      [outerX, bracketY, wp.z],
      matDark
    );

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

  addBoxDetail(group, [0.04, 0.035, halfStraight * 1.75], [outerX, halfH * 1.55, 0], matDark);
}

function addWheeledCageArmour(group: THREE.Group, level: number, factionHex?: string): void {
  const cageColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
  const cageMat = new THREE.MeshStandardMaterial({ color: cageColor, roughness: 0.5, metalness: 0.5 });

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

    for (let i = 0; i < postCount; i++) {
      const z = frontZ + (i / (postCount - 1)) * (rearZ - frontZ);
      addBoxDetail(group, [0.1 + cageScale * 0.08, 0.026 + cageScale * 0.018, 0.03 + cageScale * 0.018], [side * 0.78, 0.57 + cageScale * 0.04, z], cageMat);
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.28 + cageScale * 0.32, 6, [x, 0.68 + cageScale * 0.18, z], cageMat, 'y');
    }

    for (const y of railYs) {
      addCylinderDetail(group, railRadius, railRadius, rearZ - frontZ, 6, [x, y, (frontZ + rearZ) / 2], cageMat, 'z');
    }

    if (level >= 3) {
      for (const z of [frontZ, rearZ]) {
        addCylinderDetail(group, railRadius * 0.9, railRadius * 0.9, 0.36 + cageScale * 0.34, 6, [side * (0.62 + cageScale * 0.06), 0.72 + cageScale * 0.12, z], cageMat, 'x');
      }
    }
  }

  if (level >= 3) {
    for (const y of railYs.slice(0, 2)) {
      addCylinderDetail(group, railRadius * 0.9, railRadius * 0.9, 1.08 + cageScale * 0.35, 6, [0, y, frontZ - 0.06], cageMat, 'x');
    }
  }

  if (level >= 5) {
    for (const x of [-0.5, 0, 0.5]) {
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 0.64 + cageScale * 0.28, 6, [x, 1.06 + cageScale * 0.08, 0.6], cageMat, 'z');
    }
    for (const z of [0.32, 0.6, 0.88]) {
      addCylinderDetail(group, railRadius * 0.82, railRadius * 0.82, 1.0 + cageScale * 0.32, 6, [0, 1.06 + cageScale * 0.08, z], cageMat, 'x');
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type { TurretInfo } from './unitModelTypes.js';

export function buildWheeledModel(
  attrs: UnitModelAttrs,
  bom: BoltOnMaterials,
  factionHex?: string
): { group: THREE.Group; turretInfo: TurretInfo } {
  const group = new THREE.Group();
  const movement = attrs.movement;
  const m = movement / 5;

  const hullGeo = createChamferedWedgeHull(1.4, 0.5, 2.0, 0.55, 0.07, 0.35);
  const hull = new THREE.Mesh(hullGeo, matHull);
  hull.position.y = 0.35;
  group.add(hull);

  addWheeledHullDetails(group, bom);

  const turretColor = factionHex
    ? hexToColor(factionHex).multiplyScalar(0.55)
    : new THREE.Color(0x9aba9a).multiplyScalar(0.55);
  const turretMat = new THREE.MeshStandardMaterial({ color: turretColor, roughness: 0.55, metalness: 0.4 });
  const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.675, 0.5, 8), turretMat);
  turretBase.position.set(0, 0.75, -0.1);
  group.add(turretBase);

  // Escape hatch on turret top
  const hatchRingOuter = 0.28;
  const hatchRingInner = 0.22;
  const hatchRingH = 0.04;
  const hatchRingGeo = new THREE.CylinderGeometry(hatchRingOuter, hatchRingOuter, hatchRingH, 16);
  const hatchRing = new THREE.Mesh(hatchRingGeo, matDark);
  hatchRing.position.set(0, 1.02, 0.16);
  group.add(hatchRing);

  const hatchCoverGeo = new THREE.CylinderGeometry(hatchRingInner, hatchRingInner, 0.025, 16);
  const hatchCoverMat = new THREE.MeshStandardMaterial({ color: 0x6a7a6a, roughness: 0.65, metalness: 0.35 });
  const hatchCover = new THREE.Mesh(hatchCoverGeo, hatchCoverMat);
  hatchCover.position.set(0, 1.055, 0.16);
  group.add(hatchCover);

  const hingeGeo = new THREE.BoxGeometry(0.1, 0.03, 0.025);
  const hinge = new THREE.Mesh(hingeGeo, matMetal);
  hinge.position.set(0, 1.07, 0.16 + hatchRingInner - 0.01);
  group.add(hinge);

  const handleGeo = new THREE.BoxGeometry(0.12, 0.025, 0.025);
  const handle = new THREE.Mesh(handleGeo, matMetal);
  handle.position.set(0, 1.07, 0.16 - hatchRingInner * 0.5);
  group.add(handle);

  // Track belt
  const trackH = 0.2 + m * 0.2;
  const trackW = 0.18 + m * 0.12;
  const trackLengthScale = THREE.MathUtils.clamp((movement - 1) / 4, 0, 1);
  const trackLen = 1.9 + Math.pow(trackLengthScale, 1.35) * 0.85;
  const beltThick = 0.035;
  const halfH = trackH / 2;
  const r = halfH;
  const halfStraight = (trackLen - 2 * r) / 2;

  const trackSideX = 0.76 + trackW / 2 + trackLengthScale * 0.05;
  const trackSides = [-trackSideX, trackSideX];

  for (const side of trackSides) {
    const shape = new THREE.Shape();
    shape.moveTo(-halfStraight, halfH);
    shape.lineTo(halfStraight, halfH);
    shape.absarc(halfStraight, 0, r, Math.PI / 2, -Math.PI / 2, true);
    shape.lineTo(-halfStraight, -halfH);
    shape.absarc(-halfStraight, 0, r, -Math.PI / 2, Math.PI / 2, true);

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
    trackGeo.translate(0, 0, -trackW / 2);
    const track = new THREE.Mesh(trackGeo, matDark);
    track.rotation.y = Math.PI / 2;
    track.position.set(side, halfH, 0);
    group.add(track);
  }

  // Drive sprocket + idler wheel
  const trackWheelDetails: Record<number, { z: number; radius: number; width: number }[]> = { [-trackSideX]: [], [trackSideX]: [] };

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

  // Road wheels
  const straightLen = halfStraight * 2;
  const roadWheelMaxR = (halfH - beltThick) * 0.68;
  const numWheels = Math.max(2, Math.min(5, Math.floor(straightLen / 0.3)));
  const spacing = straightLen / (numWheels + 1);
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

  // Cage armour
  if (attrs.armour > 0) {
    addWheeledCageArmour(group, attrs.armour, factionHex);
  }

  return {
    group,
    turretInfo: { turretY: 0.8, turretZ: -0.1, turretFrontZ: -0.75 },
  };
}
