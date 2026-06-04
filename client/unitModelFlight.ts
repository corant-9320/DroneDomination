/**
 * Flight (drone) chassis builder for Drone Domination unit models.
 * Exports a single buildFlightModel() entry point consumed by unitModel.ts.
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

// Shared material references — set by initFlightMaterials() called from unitModel.ts
let matHull: THREE.MeshStandardMaterial;
let matDark: THREE.MeshStandardMaterial;

export function initFlightMaterials(
  hull: THREE.MeshStandardMaterial,
  dark: THREE.MeshStandardMaterial
): void {
  matHull = hull;
  matDark = dark;
}

// ---------------------------------------------------------------------------
// Hull geometry
// ---------------------------------------------------------------------------

/**
 * Drone payload hull with a flat square rear deck and a sloped trapezium bonnet.
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

  const rearRimY = topY - b;
  const frontRimY = frontTopY - b;

  const v = {
    roofRearL: [-hw + b, topY, rearZ - b] as [number, number, number],
    roofRearR: [hw - b, topY, rearZ - b] as [number, number, number],
    roofTransL: [-hw + b, topY, transZ] as [number, number, number],
    roofTransR: [hw - b, topY, transZ] as [number, number, number],
    roofFrontL: [-fhw + b, frontTopY, frontZ + b] as [number, number, number],
    roofFrontR: [fhw - b, frontTopY, frontZ + b] as [number, number, number],

    rimRearL: [-hw, rearRimY, rearZ] as [number, number, number],
    rimRearR: [hw, rearRimY, rearZ] as [number, number, number],
    rimTransL: [-hw, rearRimY, transZ] as [number, number, number],
    rimTransR: [hw, rearRimY, transZ] as [number, number, number],
    rimFrontL: [-fhw, frontRimY, frontZ] as [number, number, number],
    rimFrontR: [fhw, frontRimY, frontZ] as [number, number, number],

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

  addQuad(v.roofRearL, v.roofRearR, v.roofTransR, v.roofTransL);
  addQuad(v.roofTransL, v.roofTransR, v.roofFrontR, v.roofFrontL);

  addQuad(v.rimRearL, v.rimRearR, v.roofRearR, v.roofRearL);
  addQuad(v.rimFrontL, v.roofFrontL, v.roofFrontR, v.rimFrontR);
  addQuad(v.rimRearL, v.roofRearL, v.roofTransL, v.rimTransL);
  addQuad(v.rimTransL, v.roofTransL, v.roofFrontL, v.rimFrontL);
  addQuad(v.rimRearR, v.rimTransR, v.roofTransR, v.roofRearR);
  addQuad(v.rimTransR, v.rimFrontR, v.roofFrontR, v.roofTransR);

  addQuad(v.bottomRearL, v.bottomRearR, v.rimRearR, v.rimRearL);
  addQuad(v.bottomFrontL, v.rimFrontL, v.rimFrontR, v.bottomFrontR);
  addQuad(v.bottomRearL, v.rimRearL, v.rimTransL, v.bottomTransL);
  addQuad(v.bottomTransL, v.rimTransL, v.rimFrontL, v.bottomFrontL);
  addQuad(v.bottomRearR, v.bottomTransR, v.rimTransR, v.rimRearR);
  addQuad(v.bottomTransR, v.bottomFrontR, v.rimFrontR, v.rimTransR);

  addQuad(v.bottomRearL, v.bottomTransL, v.bottomTransR, v.bottomRearR);
  addQuad(v.bottomTransL, v.bottomFrontL, v.bottomFrontR, v.bottomTransR);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Hull detail helpers
// ---------------------------------------------------------------------------

function addFlightHullDetails(group: THREE.Group, bom: BoltOnMaterials): void {
  for (const side of [-1, 1]) {
    const x = side * 0.33;
    const faceX = x + side * 0.016;

    addBoxDetail(group, [0.032, 0.05, 0.52], [x, 0.76, 0], matDark);
    addBoxDetail(group, [0.038, 0.024, 0.42], [faceX, 0.87, 0.02], bom.metal);
    for (const z of [-0.18, 0.16]) {
      addBoxDetail(group, [0.044, 0.09, 0.13], [faceX + side * 0.006, 0.72, z], bom.metal);
      addBoltHead(group, [faceX + side * 0.018, 0.765, z - 0.045], bom.metal, 'x', 0.014);
      addBoltHead(group, [faceX + side * 0.018, 0.675, z + 0.045], bom.metal, 'x', 0.014);
    }

    addBoxDetail(group, [0.16, 0.035, 0.045], [side * 0.24, 0.82, -0.24], matDark, [0, side * 0.52, 0]);
    addBoxDetail(group, [0.16, 0.035, 0.045], [side * 0.24, 0.82, 0.24], matDark, [0, -side * 0.52, 0]);
  }

  addBoxDetail(group, [0.38, 0.035, 0.18], [0, 0.535, 0.16], matDark);
  for (const x of [-0.12, 0.12]) {
    addBoxDetail(group, [0.09, 0.025, 0.12], [x, 0.512, 0.16], bom.metal);
  }

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
  addCylinderDetail(group, motorSize * 0.72, motorSize * 0.72, 0.028, 10, [tip.x, 0.905, tip.z], bom.metal, 'y');
  const hubRing = new THREE.Mesh(new THREE.TorusGeometry(motorSize * 1.05, 0.008, 6, 12), matDark);
  hubRing.rotation.x = Math.PI / 2;
  hubRing.position.set(tip.x, 0.895, tip.z);
  group.add(hubRing);

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

  for (const z of [frontZ, rearZ]) {
    for (const y of sideRailYs) {
      addCylinderDetail(group, railRadius, railRadius, xSide * 2, 6, [0, y, z], cageMat, 'x');
    }
  }

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
// Public entry point
// ---------------------------------------------------------------------------

export type { TurretInfo } from './unitModelTypes.js';

export function buildFlightModel(
  attrs: UnitModelAttrs,
  bom: BoltOnMaterials,
  _factionHex?: string
): { group: THREE.Group; turretInfo: TurretInfo } {
  const group = new THREE.Group();
  const movement = attrs.movement;
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
  const bladeThick = 0.02 + m * 0.02;
  const bladeWidth = 0.06 + m * 0.04;
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

  // Cage armour
  if (attrs.armour > 0) {
    addFlightCageArmour(group, attrs.armour, _factionHex);
  }

  return {
    group,
    turretInfo: { turretY: 0.75, turretZ: -0.15, turretFrontZ: -0.35 },
  };
}
