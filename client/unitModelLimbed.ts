/**
 * Limbed (spider) chassis builder for Drone Domination unit models.
 * Exports a single buildLimbedModel() entry point consumed by unitModel.ts.
 */

import * as THREE from 'three';
import {
  BoltOnMaterials,
  addBoxDetail,
  addCylinderDetail,
  addCylinderBetween,
  addBoltHead,
  hexToColor,
} from './unitModelHelpers.js';
import type { UnitModelAttrs } from './unitModel.js';
import type { TurretInfo } from './unitModelTypes.js';

// Shared material references — set by initLimbedMaterials() called from unitModel.ts
let matHull: THREE.MeshStandardMaterial;
let matDark: THREE.MeshStandardMaterial;
let matMetal: THREE.MeshStandardMaterial;

export function initLimbedMaterials(
  hull: THREE.MeshStandardMaterial,
  dark: THREE.MeshStandardMaterial,
  metal: THREE.MeshStandardMaterial
): void {
  matHull = hull;
  matDark = dark;
  matMetal = metal;
}

// ---------------------------------------------------------------------------
// Hull geometry (reuses the same chamfered wedge as wheeled, different params)
// ---------------------------------------------------------------------------

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

function addLimbedHullDetails(group: THREE.Group, bom: BoltOnMaterials): void {
  for (const side of [-1, 1]) {
    const sx = side * 0.53;
    const faceX = sx + side * 0.018;

    addBoxDetail(group, [0.036, 0.06, 1.02], [sx, 0.78, 0], matDark);
    addBoxDetail(group, [0.044, 0.024, 0.92], [faceX, 0.89, 0], matMetal);
    for (const z of [-0.34, 0, 0.34]) {
      addBoxDetail(group, [0.052, 0.13, 0.2], [faceX + side * 0.006, 0.72, z], bom.metal);
      addBoxDetail(group, [0.058, 0.018, 0.16], [faceX + side * 0.014, 0.79, z], matDark);
      addBoltHead(group, [faceX + side * 0.02, 0.67, z - 0.075], bom.metal, 'x', 0.018);
      addBoltHead(group, [faceX + side * 0.02, 0.79, z + 0.075], bom.metal, 'x', 0.018);
    }

    for (const z of [-0.46, -0.16, 0.16, 0.46]) {
      addCylinderDetail(group, 0.055, 0.055, 0.035, 10, [side * 0.57, 0.49, z], bom.metal, 'x');
      addBoxDetail(group, [0.05, 0.08, 0.08], [side * 0.53, 0.52, z], matDark);
    }
  }

  addBoxDetail(group, [0.42, 0.08, 0.035], [0, 0.68, -0.64], matDark);
  for (const x of [-0.18, 0.18]) {
    addCylinderDetail(group, 0.035, 0.035, 0.02, 10, [x, 0.69, -0.67], bom.antenna, 'z');
  }

  addBoxDetail(group, [0.46, 0.16, 0.035], [0, 0.69, 0.63], matDark);
  addBoxDetail(group, [0.32, 0.026, 0.045], [0, 0.78, 0.66], bom.metal);
  for (const x of [-0.18, -0.06, 0.06, 0.18]) {
    addBoxDetail(group, [0.055, 0.11, 0.028], [x, 0.68, 0.665], bom.metal, [0.18, 0, 0]);
  }

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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type { TurretInfo } from './unitModelTypes.js';

export function buildLimbedModel(
  attrs: UnitModelAttrs,
  bom: BoltOnMaterials,
  factionHex?: string
): { group: THREE.Group; turretInfo: TurretInfo } {
  const group = new THREE.Group();
  const movement = attrs.movement;
  const legScale = THREE.MathUtils.clamp((movement - 1) / 4, 0, 1);

  const bodyGeo = createChamferedWedgeHull(1.0, 0.6, 1.2, 0.5, 0.06, 0.3);
  const body = new THREE.Mesh(bodyGeo, matHull);
  body.position.y = 0.7;
  group.add(body);

  addLimbedHullDetails(group, bom);

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

    addCylinderBetween(
      group,
      ankle,
      new THREE.Vector3(footCentre.x, 0.065, footCentre.z),
      legThick * 0.5,
      legThick * 0.42,
      6,
      bom.leg
    );

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

    const rearPos = footCentre.clone().add(outward.clone().multiplyScalar(-0.075));
    addBoxDetail(
      group,
      [0.035 + legScale * 0.065, 0.018 + legScale * 0.012, 0.024 + legScale * 0.026],
      [rearPos.x, 0.028, rearPos.z],
      bom.metal,
      [0, yaw + Math.PI, 0]
    );
  }

  // Cage armour
  if (attrs.armour > 0) {
    addLimbedCageArmour(group, attrs.armour, factionHex);
  }

  return {
    group,
    turretInfo: { turretY: 1.0, turretZ: -0.1, turretFrontZ: -0.55 },
  };
}
