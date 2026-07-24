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
import type { ChassisType } from './unitModelTypes.js';
import { buildSplashBomb, splashBombNormalizedSize } from './splashBombModel.js';

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

/**
 * Sling the splash bomb beneath a drone's belly on a short pylon. The bomb's
 * length grows with splash level (level 1 → ~0.55, level 5 → ~1.15 world
 * units). Returns false if the GLB model isn't loaded yet, so the caller can
 * fall back to the procedural launcher.
 *
 * Geometry reference (unitModelFlight.ts): the payload hull is centred at
 * y≈0.75 with height 0.4, so its belly sits at y≈0.55. The bomb hangs below it.
 *
 * The bomb's length and diameter are scaled independently (not by one
 * uniform factor): length always follows splashAttack level, but diameter is
 * clamped so the bomb's vertical extent can never exceed the belly-to-ground
 * clearance. Without this, a uniform scale grows the diameter in lockstep
 * with the length, and at high splash levels the bomb clips through the map
 * grid even though its top stays flush against the pylon at every level.
 */
function addSplashBombBeneathDrone(group: THREE.Group, level: number, bom: BoltOnMaterials): boolean {
  const bomb = buildSplashBomb();
  const size = splashBombNormalizedSize();
  if (!bomb || !size) return false;

  const t = THREE.MathUtils.clamp((level - 1) / 4, 0, 1);
  // Each splash tier is 50% larger than the former visual scale.
  const bombLength = (0.55 + t * 0.6) * 1.5; // 0.825 at level 1 → 1.725 at level 5

  const bellyY = 0.55;
  const pylonLength = 0.1;

  // Vertical room between the pylon's bottom and the ground plane (y=0). The
  // bomb's diameter (its vertical extent while hanging horizontally) must
  // never exceed this, or it clips through the map grid — independent of how
  // long the bomb gets. A uniform scale would grow diameter and length
  // together, so diameter is scaled separately and clamped to this budget.
  const clearance = bellyY - pylonLength;
  const groundMargin = 0.03; // keep a small visible gap above the grid
  const maxHalfHeight = (clearance - groundMargin) / 2;

  const desiredHalfHeight = (size.y * bombLength) / 2;
  const bombHalfHeight = Math.min(desiredHalfHeight, maxHalfHeight);
  const diameterScale = (bombHalfHeight * 2) / size.y;

  // X/Y (diameter) scaled independently from Z (length) — size.x === size.y
  // for this model (circular cross-section), so this keeps the bomb round.
  // IMPORTANT: the cloned template already carries a baked-in normalization
  // scale (1/maxDim, from normalizeTemplate) on bomb.scale — multiply into it
  // rather than overwriting with .set(), or the bomb renders far too small
  // while the position math (which uses the correctly-sized bombHalfHeight)
  // still places it as if it were full size, opening a visible gap.
  bomb.scale.x *= diameterScale;
  bomb.scale.y *= diameterScale;
  bomb.scale.z *= bombLength;
  // Imported template points +Z, while this model's forward muzzle faces -Z.
  bomb.rotation.y = Math.PI;

  const pylon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, pylonLength, 6),
    bom.dark,
  );
  pylon.position.set(0, bellyY - pylonLength / 2, 0);
  group.add(pylon);

  // Hang the bomb's centre below the pylon. bombTop == bellyY - pylonLength
  // always (independent of bombHalfHeight), so the bomb stays flush against
  // the pylon at every splash level and size.
  const bombY = bellyY - pylonLength - bombHalfHeight;
  bomb.position.set(0, bombY, 0);
  group.add(bomb);

  return true;
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

  // Drones carry a bomb slung beneath the airframe (GLB model) instead of the
  // procedural rocket-pod used by ground chassis. Size scales with splash level.
  // If the model hasn't loaded (e.g. headless tests), fall through to the
  // procedural launcher below.
  if (chassisType === 'flight' && addSplashBombBeneathDrone(group, level, bom)) {
    return;
  }

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
    case 'building':
      baseY = turretY;
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

  // Building armour — cage frames on the roof edge, similar to vehicle cage armour.
  // Rail count, post density, and cage outset all scale with level.
  if (chassisType === 'building') {
    const cageColor = factionHex ? hexToColor(factionHex) : new THREE.Color(0x7a8a6a);
    const cageMat = new THREE.MeshStandardMaterial({ color: cageColor, roughness: 0.5, metalness: 0.55 });

    // Building body constants — must match buildingModel.ts BODY_* values.
    const bodyW = 1.5;
    const bodyH = 1.2;
    const bodyD = 1.5;

    // How far the cage stands proud of the roof perimeter (grows with level).
    const t = (level - 1) / 4;  // 0 at level 1, 1 at level 5
    const outset   = 0.08 + t * 0.14;   // horizontal gap beyond wall face
    const cageH    = 0.18 + t * 0.22;   // height of the cage above roof plane
    const railR    = 0.014 + t * 0.016; // rail cylinder radius
    const postW    = 0.028 + t * 0.018; // vertical post cross-section
    const roofY    = bodyH;             // Y of the roof surface

    // Half-extents of the cage frame (outside of cage, from centreline)
    const hx = bodyW / 2 + outset;
    const hz = bodyD / 2 + outset;

    // ── Vertical post count along each edge (scales with level) ──────────
    // level 1 → just corners; level 2+ → intermediate posts added
    const postsPerEdge = level;   // 1..5 posts including corners for each edge run

    // Helper: place a thin box post at (x, y-centre, z)
    const addPost = (x: number, z: number) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(postW, cageH, postW),
        cageMat
      );
      mesh.position.set(x, roofY + cageH / 2, z);
      group.add(mesh);
    };

    // Helper: add a horizontal rail cylinder along an axis
    const addRailX = (z: number, y: number, length: number) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(railR, railR, length, 6),
        cageMat
      );
      mesh.rotation.z = Math.PI / 2;
      mesh.position.set(0, y, z);
      group.add(mesh);
    };
    const addRailZ = (x: number, y: number, length: number) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(railR, railR, length, 6),
        cageMat
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(x, y, 0);
      group.add(mesh);
    };

    // ── How many horizontal rail rows? (1 at level 1, up to 3 at level 5) ──
    const railRows = level <= 1 ? 1 : level <= 3 ? 2 : 3;
    const railYs: number[] = [];
    for (let r = 0; r < railRows; r++) {
      railYs.push(roofY + cageH * (r + 1) / (railRows + 1) + cageH * 0.1);
    }

    // ── Perimeter rails — four sides ─────────────────────────────────────
    const sideRailLen = bodyD + outset * 2;   // Z-running rails on ±X faces
    const frontRailLen = bodyW + outset * 2;  // X-running rails on ±Z faces
    for (const y of railYs) {
      addRailZ(-hx, y, sideRailLen);
      addRailZ( hx, y, sideRailLen);
      addRailX(-hz, y, frontRailLen);
      addRailX( hz, y, frontRailLen);
    }

    // ── Vertical posts along each edge ───────────────────────────────────
    // +X and -X edges: posts spaced along Z
    for (const x of [-hx, hx]) {
      for (let i = 0; i < postsPerEdge; i++) {
        const frac = postsPerEdge === 1 ? 0.5 : i / (postsPerEdge - 1);
        const z = -hz + frac * (hz * 2);
        addPost(x, z);
      }
    }
    // +Z and -Z edges: posts spaced along X (skip corners already placed)
    for (const z of [-hz, hz]) {
      const inner = postsPerEdge - 1;
      for (let i = 1; i < inner; i++) {
        const frac = i / inner;
        const x = -hx + frac * (hx * 2);
        addPost(x, z);
      }
    }

    // ── Cross-bracing rails on the roof interior (level 4+) ──────────────
    if (level >= 4) {
      const topY = roofY + cageH * 0.92;
      // Two rails running X across the roof
      for (const z of [-hz * 0.38, hz * 0.38]) {
        addRailX(z, topY, frontRailLen);
      }
    }
    // Full grid cross at level 5
    if (level >= 5) {
      const topY = roofY + cageH * 0.92;
      for (const x of [-hx * 0.38, hx * 0.38]) {
        addRailZ(x, topY, sideRailLen);
      }
    }

    return;
  }

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
    case 'building':
      rearCorners = [{ x: -0.6, z: 0.6 }, { x: 0.6, z: 0.6 }];
      baseY = 1.2;
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
  const yBase = chassisType === 'limbed' ? 0.7 : chassisType === 'flight' ? 0.8 : chassisType === 'building' ? 1.2 : 0.35;
  const t = level / 5;

  const hullRearZ = chassisType === 'limbed' ? 0.55 : chassisType === 'flight' ? 0.35 : chassisType === 'building' ? 0.5 : 0.95;

  const targetPoleTopY = chassisType === 'limbed' ? 1.45 : chassisType === 'flight' ? 1.12 : chassisType === 'building' ? 2.0 : 1.24;
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
    case 'building':
      baseY = turretY;
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
