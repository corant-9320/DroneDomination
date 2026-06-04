/**
 * Unit model add-on builders — attribute-driven attachments bolted onto chassis models.
 *
 * Each function adds geometry to an existing THREE.Group based on a single
 * unit attribute level (kinetic, splashAttack, armour, defence, repair, antiAir).
 * These are pure geometry builders — no module-level state.
 *
 * Extracted from unitModel.ts (P10 refactor).
 */

import * as THREE from 'three';
import type { BoltOnMaterials } from './unitModelHelpers.js';
import { hexToColor } from './unitModelHelpers.js';
import type { ChassisType } from './unitModel.js';

// ---------------------------------------------------------------------------
// Radar dish geometry helper (used by addDefence)
// ---------------------------------------------------------------------------

export function createRadarDishGeometry(radius: number, depth: number): THREE.BufferGeometry {
  const radialSegments = 18;
  const ringSegments = 5;
  const shellThickness = Math.max(0.012, radius * 0.08);
  const positions: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r <= ringSegments; r++) {
    const frac = r / ringSegments;
    const ringRadius = radius * frac;
    const z = -depth * (1 - frac * frac);
    for (let s = 0; s < radialSegments; s++) {
      const angle = (s / radialSegments) * Math.PI * 2;
      positions.push(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, z);
    }
  }

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
      indices.push(a, c, b);
      indices.push(b, c, d);
      const ab = backOffset + a;
      const bb = backOffset + b;
      const cb = backOffset + c;
      const db = backOffset + d;
      indices.push(ab, bb, cb);
      indices.push(bb, db, cb);
    }
  }

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

// ---------------------------------------------------------------------------
// Attribute component builders
// ---------------------------------------------------------------------------

/**
 * Combined gun barrel — a single barrel whose length is driven by rangeAttack
 * and whose diameter is driven by kinetic.
 */
export function addGunBarrel(
  group: THREE.Group, kinetic: number, rangeAttack: number,
  turretY: number, turretZ: number, turretFrontZ: number, bom: BoltOnMaterials
): void {
  if (kinetic === 0) return;

  const tAtk = kinetic / 5;
  const tRng = rangeAttack / 5;

  const radius = kinetic > 0 ? 0.04 + tAtk * 0.06 : 0.025;
  const length = rangeAttack > 0 ? 0.6 + tRng * 1.4 : 0.4;

  const barrelStartZ = turretFrontZ;
  const mantlet = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.55, radius * 1.75, 0.16, 10), bom.dark
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

  if (kinetic >= 4) {
    const muzzle = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.8, radius * 1.5, 0.1, 8), bom.dark
    );
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, turretY, barrelStartZ - length);
    group.add(muzzle);
  }

  if (rangeAttack > 0) {
    const scopeLen = 0.15 + tRng * 0.25;
    const scope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, scopeLen, 6), bom.dark
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

export function addSplashAttack(
  group: THREE.Group,
  level: number,
  rangeAttack: number,
  turretY: number,
  turretFrontZ: number,
  chassisType: ChassisType,
  bom: BoltOnMaterials
): void {
  if (level === 0) return;

  const visualLevel = Math.max(0, level - 1);
  const tPower = THREE.MathUtils.clamp(visualLevel / 5, 0, 1);
  const tRange = THREE.MathUtils.clamp(rangeAttack / 5, 0, 1);

  const launcherLength = 0.42 + tRange * 0.78;
  const podLength = launcherLength * 0.5;
  const podSize = 0.24 + tPower * 0.26;
  const wall = 0.035 + tPower * 0.018;
  const tubeRadius = 0.032 + tPower * 0.03;
  const tubeSpacing = podSize * 0.27;

  let baseY: number;
  let baseZ: number;

  switch (chassisType) {
    case 'wheeled':
      baseY = turretY + 0.18;
      baseZ = turretFrontZ + 0.08;
      break;
    case 'limbed':
      baseY = turretY + 0.08;
      baseZ = turretFrontZ + 0.08;
      break;
    case 'flight':
      baseY = turretY + 0.12;
      baseZ = turretFrontZ + 0.08;
      break;
  }
  const pedestalHeight = 0.16 + tPower * 0.1;
  const pedestalRadius = 0.045 + tPower * 0.035;

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(pedestalRadius * 0.8, pedestalRadius * 1.15, pedestalHeight, 8),
    bom.dark
  );
  pedestal.position.set(0, baseY + pedestalHeight / 2, baseZ);
  group.add(pedestal);

  const elevation = THREE.MathUtils.degToRad(30);
  const launchDirection = new THREE.Vector3(0, Math.sin(elevation), -Math.cos(elevation)).normalize();
  const launcherGroup = new THREE.Group();
  launcherGroup.position.set(0, baseY + pedestalHeight, baseZ);
  launcherGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), launchDirection);

  const pivot = new THREE.Mesh(new THREE.BoxGeometry(podSize * 0.75, wall * 1.6, podSize * 0.75), bom.dark);
  pivot.position.set(0, -wall * 0.4, 0);
  launcherGroup.add(pivot);

  const half = podSize / 2;
  const sideWallSize: [number, number, number] = [wall, podLength, podSize];
  const capWallSize: [number, number, number] = [podSize, podLength, wall];
  for (const x of [-half + wall / 2, half - wall / 2]) {
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(sideWallSize[0], sideWallSize[1], sideWallSize[2]), bom.dark);
    sideWall.position.set(x, podLength / 2, 0);
    launcherGroup.add(sideWall);
  }
  for (const z of [-half + wall / 2, half - wall / 2]) {
    const capWall = new THREE.Mesh(new THREE.BoxGeometry(capWallSize[0], capWallSize[1], capWallSize[2]), bom.dark);
    capWall.position.set(0, podLength / 2, z);
    launcherGroup.add(capWall);
  }

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
        bom.dark
      );
      rocketNose.position.set(x, launcherLength + 0.02, z);
      launcherGroup.add(rocketNose);
    }
  }

  group.add(launcherGroup);
}

export function addArmour(group: THREE.Group, level: number, chassisType: ChassisType, factionHex?: string): void {
  if (level === 0) return;

  // Cage armour is handled inside each chassis builder (wheeled/limbed/flight).
  // The fallback spike armour below is only reached if chassisType is unrecognised.
  if (chassisType === 'flight' || chassisType === 'wheeled' || chassisType === 'limbed') return;

  const spikeColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
  const spikeMat = new THREE.MeshStandardMaterial({ color: spikeColor, roughness: 0.5, metalness: 0.45 });

  const width = chassisType === 'limbed' ? 1.0 : 1.4;
  const depth = chassisType === 'limbed' ? 1.1 : 1.9;
  const t = level / 5;

  const spikeHeight = 0.16 + t * 0.44;
  const spikeRadius = 0.06 + t * 0.08;
  const spikeCount = Math.max(3, level + 2);

  let spikeY: number;
  switch (chassisType) {
    case 'wheeled': spikeY = 0.55; break;
    case 'limbed': spikeY = 0.48 + spikeRadius * 2; break;
    default: spikeY = 0.55; break;
  }

  const spacing = depth / (spikeCount + 1);

  for (const side of [-1, 1]) {
    const spikeX = side * (width / 2 + spikeHeight / 2);

    for (let i = 1; i <= spikeCount; i++) {
      const spikeZ = -depth / 2 + i * spacing;

      let spikePosY = spikeY;
      if (chassisType === 'wheeled') {
        const halfDepth = depth / 2;
        const slopeStart = halfDepth * 0.1;
        if (spikeZ < slopeStart) {
          const t_slope = (slopeStart - spikeZ) / (slopeStart + halfDepth);
          const bonnetDrop = 0.5 * 0.35;
          spikePosY = spikeY - bonnetDrop * t_slope;
        }
      }

      const spikeGeo = new THREE.ConeGeometry(spikeRadius, spikeHeight, 6);
      const spike = new THREE.Mesh(spikeGeo, spikeMat);
      spike.rotation.z = side * -Math.PI / 2;
      spike.position.set(spikeX, spikePosY, spikeZ);
      group.add(spike);
    }
  }

  if (level >= 3) {
    const frontSpikeCount = Math.max(2, Math.floor(spikeCount * 0.6));
    const frontSpacing = width / (frontSpikeCount + 1);
    const frontZ = -(depth / 2 + spikeHeight / 2);
    const frontSpikeY = chassisType === 'wheeled' ? spikeY - spikeRadius * 2 : spikeY;

    for (let i = 1; i <= frontSpikeCount; i++) {
      const sx = -width / 2 + i * frontSpacing;
      const spikeGeo = new THREE.ConeGeometry(spikeRadius * 0.9, spikeHeight * 0.85, 6);
      const spike = new THREE.Mesh(spikeGeo, spikeMat);
      spike.rotation.x = -Math.PI / 2;
      spike.position.set(sx, frontSpikeY, frontZ);
      group.add(spike);
    }
  }

  if (level >= 5) {
    const rearSpikeCount = Math.max(2, Math.floor(spikeCount * 0.5));
    const rearSpacing = width / (rearSpikeCount + 1);
    const rearZ = depth / 2 + spikeHeight / 2;

    for (let i = 1; i <= rearSpikeCount; i++) {
      const sx = -width / 2 + i * rearSpacing;
      const spikeGeo = new THREE.ConeGeometry(spikeRadius * 0.85, spikeHeight * 0.75, 6);
      const spike = new THREE.Mesh(spikeGeo, spikeMat);
      spike.rotation.x = Math.PI / 2;
      spike.position.set(sx, spikeY, rearZ);
      group.add(spike);
    }
  }
}

export function addDefence(group: THREE.Group, level: number, turretY: number, chassisType: ChassisType, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const t = level / 5;

  let rearCorners: { x: number; z: number }[];
  let baseY: number;

  switch (chassisType) {
    case 'wheeled':
      rearCorners = [{ x: -0.78, z: 0.9 }, { x: 0.78, z: 0.9 }];
      baseY = 0.6;
      break;
    case 'limbed':
      rearCorners = [{ x: -0.54, z: 0.5 }, { x: 0.54, z: 0.5 }];
      baseY = 1.0;
      break;
    case 'flight':
      rearCorners = [{ x: -0.28, z: 0.22 }, { x: 0.28, z: 0.22 }];
      baseY = 0.75;
      break;
  }

  const fixedEW3T = 3 / 5;
  const mastHeight = 0.2 + fixedEW3T * 0.3;
  const mastRadius = 0.015 + fixedEW3T * 0.008;

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
    dishGroup.position.set(corner.x, baseY + mastHeight, corner.z);

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

    const feed = new THREE.Mesh(
      new THREE.CylinderGeometry(rimRadius * 0.6, rimRadius, receiverZ - dishCentreZ, 5), bom.dark
    );
    feed.rotation.x = Math.PI / 2;
    feed.position.set(0, 0, (dishCentreZ + receiverZ) / 2);
    dishGroup.add(feed);

    const receiver = new THREE.Mesh(new THREE.SphereGeometry(rimRadius * 1.7, 6, 5), bom.dark);
    receiver.position.set(0, 0, receiverZ);
    dishGroup.add(receiver);

    group.add(dishGroup);
  }
}

export function addRepair(group: THREE.Group, level: number, chassisType: ChassisType, bom: BoltOnMaterials): void {
  if (level === 0) return;
  const yBase = chassisType === 'limbed' ? 0.7 : chassisType === 'flight' ? 0.8 : 0.35;
  const t = level / 5;

  const hullRearZ = chassisType === 'limbed' ? 0.55 : chassisType === 'flight' ? 0.35 : 0.95;

  const targetPoleTopY = chassisType === 'limbed' ? 1.45 : chassisType === 'flight' ? 1.12 : 1.24;
  const poleRadius = 0.026;
  const poleX = 0;
  const poleZ = chassisType === 'flight' ? 0.72 : hullRearZ;
  const poleBaseY = yBase;
  const poleHeight = targetPoleTopY - poleBaseY;
  const poleTopY = poleBaseY + poleHeight;

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

  const crossWidth = 0.08 + t * 0.25;
  const crossHeight = 0.08 + t * 0.19;
  const crossThick = 0.04 + t * 0.025;
  const crossY = poleTopY + crossHeight;
  const crossMat = new THREE.MeshStandardMaterial({ color: 0xdd2222, roughness: 0.4, metalness: 0.2 });

  const crossH = new THREE.Mesh(
    new THREE.BoxGeometry(crossWidth * 2, crossThick, crossThick), crossMat
  );
  crossH.position.set(poleX, crossY, poleZ);
  group.add(crossH);

  const crossV = new THREE.Mesh(
    new THREE.BoxGeometry(crossThick, crossHeight * 2, crossThick), crossMat
  );
  crossV.position.set(poleX, crossY, poleZ);
  group.add(crossV);
}

export function addAntiAir(
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

  const tiltAngle = (75 * Math.PI) / 180;

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
