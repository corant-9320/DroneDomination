/**
 * Refinery 3D Model Builder — procedural distillation towers, interconnecting
 * piping, and a flare stack on a concrete slab. The model grows visually with
 * `segmentCount`: each segment adds a distillation column (with escalating
 * height) plus its own drum/heat-exchanger detail, and the slab widens to hold
 * them, so a larger refinery reads as physically larger.
 *
 * Returns a detailed multi-part `THREE.Group` meeting or exceeding the
 * Unit_Model_Standard (Req 14.1, 14.2). Reuses `client/unitModelHelpers.ts`
 * (`BoltOnMaterials`, `createTintedMaterials`) for faction tinting and follows
 * the `MeshStandardMaterial`/`Group` conventions of `client/buildingModel.ts`.
 *
 * Centred on X/Z at the origin, sitting on the ground (Y from 0 up), Y-up.
 * Client layering: no `src/`/`server/` imports; `.js` extensions; named exports.
 */

import * as THREE from 'three';
import {
  BoltOnMaterials,
  createTintedMaterials,
  addBoxDetail,
  addCylinderDetail,
  addCylinderBetween,
  addBoltHead,
} from './unitModelHelpers.js';

/**
 * Build the refinery model.
 *
 * @param segmentCount Number of refinery segments (>= 1). Drives tower count and
 *                     overall footprint so the refinery grows with size.
 * @param factionHex   Optional faction color (#RRGGBB) tinting the metal parts.
 */
export function buildRefineryModel(segmentCount: number, factionHex?: string): THREE.Group {
  const group = new THREE.Group();

  const segments = Math.max(1, Math.floor(segmentCount));

  const matDark = new THREE.MeshStandardMaterial({ color: 0x3f3f3f, roughness: 0.75, metalness: 0.3 });
  const bom: BoltOnMaterials = factionHex
    ? createTintedMaterials(factionHex, matDark)
    : {
        metal: new THREE.MeshStandardMaterial({ color: 0x889090, roughness: 0.4, metalness: 0.7 }),
        antenna: new THREE.MeshStandardMaterial({ color: 0x889090, roughness: 0.3, metalness: 0.8 }),
        rotor: new THREE.MeshStandardMaterial({ color: 0x586060, roughness: 0.5, metalness: 0.6 }),
        leg: new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.6, metalness: 0.5 }),
        dark: matDark,
      };

  const matConcrete = new THREE.MeshStandardMaterial({ color: 0x8a877e, roughness: 0.95, metalness: 0.05 });
  const matTower = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.45, metalness: 0.55 });
  const matDrum = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.5 });
  const matFlame = new THREE.MeshStandardMaterial({
    color: 0xff7a1a,
    roughness: 0.4,
    metalness: 0.0,
    emissive: 0xff5a00,
    emissiveIntensity: 0.9,
  });

  // ── Concrete slab (widens with segment count) ──────────────────────────────
  const towerSpacing = 0.62;
  const slabW = Math.max(2.2, segments * towerSpacing + 1.4);
  addBoxDetail(group, [slabW, 0.12, 1.9], [0, 0.06, 0], matConcrete);
  // Curb edge.
  addBoxDetail(group, [slabW, 0.06, 0.08], [0, 0.15, 0.91], matDark);
  addBoxDetail(group, [slabW, 0.06, 0.08], [0, 0.15, -0.91], matDark);

  // ── Distillation towers, one per segment, front row on the slab ─────────────
  const startX = -((segments - 1) * towerSpacing) / 2;
  const towerZ = 0.15;
  const towerTops: THREE.Vector3[] = [];

  for (let i = 0; i < segments; i++) {
    const x = startX + i * towerSpacing;
    // Escalating heights so a bigger refinery is visibly taller/denser.
    const h = 1.3 + (i % 3) * 0.35;
    const r = 0.2;
    const baseY = 0.12;

    // Column shell.
    addCylinderDetail(group, r, r * 1.05, h, 20, [x, baseY + h / 2, towerZ], matTower);
    // Domed top cap.
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      matTower
    );
    cap.position.set(x, baseY + h, towerZ);
    group.add(cap);
    // Tray bands up the column.
    const bands = 5;
    for (let b = 1; b <= bands; b++) {
      const by = baseY + (h * b) / (bands + 1);
      addCylinderDetail(group, r * 1.06, r * 1.06, 0.03, 20, [x, by, towerZ], matDark);
    }
    // Skirt base + anchor bolts.
    addCylinderDetail(group, r * 1.15, r * 1.2, 0.14, 20, [x, baseY + 0.07, towerZ], matDark);
    for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      addBoltHead(group, [x + Math.cos(a) * r * 1.1, baseY + 0.02, towerZ + Math.sin(a) * r * 1.1], bom.dark);
    }
    // Spiral access platform ring near the top.
    addCylinderDetail(group, r * 1.35, r * 1.35, 0.03, 20, [x, baseY + h * 0.78, towerZ], bom.metal);
    // Top nozzle/relief pipe feeding the header.
    addCylinderDetail(group, 0.03, 0.03, 0.25, 8, [x, baseY + h + 0.12, towerZ], bom.metal);
    towerTops.push(new THREE.Vector3(x, baseY + h + 0.24, towerZ));

    // Paired horizontal drum / heat exchanger behind each column (back row).
    addCylinderDetail(group, 0.13, 0.13, 0.5, 16, [x, 0.32, -0.45], matDrum, 'x');
    addCylinderDetail(group, 0.14, 0.14, 0.03, 16, [x - 0.25, 0.32, -0.45], matDark, 'x');
    addCylinderDetail(group, 0.14, 0.14, 0.03, 16, [x + 0.25, 0.32, -0.45], matDark, 'x');
    // Drum support saddles.
    addBoxDetail(group, [0.1, 0.2, 0.16], [x - 0.16, 0.22, -0.45], matDark);
    addBoxDetail(group, [0.1, 0.2, 0.16], [x + 0.16, 0.22, -0.45], matDark);
  }

  // ── Overhead pipe header linking every tower top ────────────────────────────
  const headerY = 0.12 + 1.72;
  addCylinderBetween(
    group,
    new THREE.Vector3(startX - 0.1, headerY, towerZ),
    new THREE.Vector3(startX + (segments - 1) * towerSpacing + 0.1, headerY, towerZ),
    0.04,
    0.04,
    10,
    bom.metal
  );
  for (const top of towerTops) {
    addCylinderBetween(group, top, new THREE.Vector3(top.x, headerY, towerZ), 0.028, 0.028, 8, bom.metal);
  }
  // Down-comer from header to the drum row.
  addCylinderBetween(
    group,
    new THREE.Vector3(startX + (segments - 1) * towerSpacing + 0.1, headerY, towerZ),
    new THREE.Vector3(startX + (segments - 1) * towerSpacing + 0.1, 0.32, -0.45),
    0.032,
    0.032,
    8,
    bom.metal
  );

  // ── Flare stack (always present), off to one edge of the slab ──────────────
  const flareX = slabW / 2 - 0.3;
  const flareBaseY = 0.12;
  const flareH = 2.1;
  // Lattice-ish stack: central pipe + three guy legs.
  addCylinderDetail(group, 0.06, 0.08, flareH, 12, [flareX, flareBaseY + flareH / 2, -0.4], matDark);
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    addCylinderBetween(
      group,
      new THREE.Vector3(flareX + Math.cos(a) * 0.28, flareBaseY, -0.4 + Math.sin(a) * 0.28),
      new THREE.Vector3(flareX, flareBaseY + flareH * 0.75, -0.4),
      0.02,
      0.02,
      6,
      bom.metal
    );
  }
  // Flare tip + flame plume.
  addCylinderDetail(group, 0.09, 0.06, 0.18, 12, [flareX, flareBaseY + flareH, -0.4], matDark);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.34, 12), matFlame);
  flame.position.set(flareX, flareBaseY + flareH + 0.24, -0.4);
  group.add(flame);

  // ── Pipe rack running along the front of the slab ───────────────────────────
  const rackX0 = startX - 0.35;
  const rackX1 = startX + (segments - 1) * towerSpacing + 0.35;
  for (const px of [rackX0, rackX1]) {
    addBoxDetail(group, [0.06, 0.5, 0.06], [px, 0.37, 0.72], matDark);
  }
  for (const ry of [0.42, 0.54]) {
    addCylinderBetween(
      group,
      new THREE.Vector3(rackX0, ry, 0.72),
      new THREE.Vector3(rackX1, ry, 0.72),
      0.022,
      0.022,
      6,
      bom.metal
    );
  }

  return group;
}
