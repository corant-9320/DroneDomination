/**
 * Distribution Hub 3D Model Builder — a clustered silo/tank farm spanned by a
 * steel gantry with a walkway and support legs, on a concrete pad.
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
 * Build the distribution-hub model.
 *
 * @param factionHex Optional faction color (#RRGGBB) tinting the metal parts.
 */
export function buildHubModel(factionHex?: string): THREE.Group {
  const group = new THREE.Group();

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
  const matSilo = new THREE.MeshStandardMaterial({ color: 0xcdd2d6, roughness: 0.4, metalness: 0.5 });
  const matSiloAlt = new THREE.MeshStandardMaterial({ color: 0xb0b6bc, roughness: 0.45, metalness: 0.5 });

  // ── Concrete pad ───────────────────────────────────────────────────────────
  addBoxDetail(group, [2.4, 0.12, 2.0], [0, 0.06, 0], matConcrete);
  addBoxDetail(group, [2.4, 0.05, 0.08], [0, 0.14, 0.96], matDark);
  addBoxDetail(group, [2.4, 0.05, 0.08], [0, 0.14, -0.96], matDark);

  // ── Silo cluster: a 2x2 grid of large tanks plus one taller centre silo ─────
  const siloPositions: Array<{ x: number; z: number; h: number; r: number; alt: boolean }> = [
    { x: -0.6, z: 0.45, h: 1.25, r: 0.34, alt: false },
    { x: 0.6, z: 0.45, h: 1.1, r: 0.34, alt: true },
    { x: -0.6, z: -0.45, h: 1.15, r: 0.34, alt: true },
    { x: 0.6, z: -0.45, h: 1.3, r: 0.34, alt: false },
    { x: 0.0, z: 0.0, h: 1.6, r: 0.3, alt: false },
  ];

  const siloTops: Array<{ x: number; z: number; y: number }> = [];
  const baseY = 0.12;

  for (const s of siloPositions) {
    const mat = s.alt ? matSiloAlt : matSilo;
    // Cylindrical body.
    addCylinderDetail(group, s.r, s.r, s.h, 24, [s.x, baseY + s.h / 2, s.z], mat);
    // Banding courses.
    for (const frac of [0.28, 0.55, 0.82]) {
      addCylinderDetail(group, s.r * 1.02, s.r * 1.02, 0.03, 24, [s.x, baseY + s.h * frac, s.z], matDark);
    }
    // Conical roof.
    const roof = new THREE.Mesh(new THREE.ConeGeometry(s.r * 1.05, 0.32, 24), mat);
    roof.position.set(s.x, baseY + s.h + 0.16, s.z);
    group.add(roof);
    // Roof finial / vent.
    addCylinderDetail(group, 0.04, 0.04, 0.12, 8, [s.x, baseY + s.h + 0.38, s.z], bom.metal);
    // Base ring + anchor bolts.
    addCylinderDetail(group, s.r * 1.08, s.r * 1.12, 0.1, 24, [s.x, baseY + 0.05, s.z], matDark);
    for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      addBoltHead(group, [s.x + Math.cos(a) * s.r, baseY + 0.02, s.z + Math.sin(a) * s.r], bom.dark);
    }
    siloTops.push({ x: s.x, z: s.z, y: baseY + s.h + 0.32 });
  }

  // Interconnecting manifold pipes near the silo bases.
  addCylinderBetween(
    group,
    new THREE.Vector3(-0.6, 0.28, 0.45),
    new THREE.Vector3(0.6, 0.28, 0.45),
    0.03,
    0.03,
    8,
    bom.metal
  );
  addCylinderBetween(
    group,
    new THREE.Vector3(-0.6, 0.28, -0.45),
    new THREE.Vector3(0.6, 0.28, -0.45),
    0.03,
    0.03,
    8,
    bom.metal
  );
  addCylinderBetween(
    group,
    new THREE.Vector3(0.0, 0.28, 0.45),
    new THREE.Vector3(0.0, 0.28, -0.45),
    0.03,
    0.03,
    8,
    bom.metal
  );

  // ── Gantry: a portal frame spanning the cluster with a top walkway ─────────
  const gantry = new THREE.Group();
  group.add(gantry);
  const gantryTopY = baseY + 2.0;
  const legX = 1.05;
  const legZ = 0.8;
  // Four vertical legs.
  for (const lx of [-legX, legX]) {
    for (const lz of [-legZ, legZ]) {
      addBoxDetail(gantry, [0.08, gantryTopY - baseY, 0.08], [lx, baseY + (gantryTopY - baseY) / 2, lz], bom.metal);
    }
  }
  // Diagonal bracing on the two long faces.
  for (const lz of [-legZ, legZ]) {
    addCylinderBetween(
      gantry,
      new THREE.Vector3(-legX, baseY + 0.1, lz),
      new THREE.Vector3(legX, gantryTopY - 0.1, lz),
      0.02,
      0.02,
      6,
      matDark
    );
    addCylinderBetween(
      gantry,
      new THREE.Vector3(legX, baseY + 0.1, lz),
      new THREE.Vector3(-legX, gantryTopY - 0.1, lz),
      0.02,
      0.02,
      6,
      matDark
    );
  }
  // Top chords (both long sides) + cross-beams.
  for (const lz of [-legZ, legZ]) {
    addBoxDetail(gantry, [2 * legX + 0.1, 0.09, 0.09], [0, gantryTopY, lz], bom.metal);
  }
  for (const lx of [-legX, 0, legX]) {
    addBoxDetail(gantry, [0.08, 0.08, 2 * legZ], [lx, gantryTopY, 0], bom.metal);
  }
  // Walkway deck along the gantry top + guard rails.
  addBoxDetail(gantry, [2 * legX, 0.03, 0.34], [0, gantryTopY + 0.06, 0], matDark);
  for (const rz of [-0.17, 0.17]) {
    addBoxDetail(gantry, [2 * legX, 0.03, 0.02], [0, gantryTopY + 0.22, rz], bom.antenna);
    for (const rx of [-legX + 0.1, -0.35, 0.35, legX - 0.1]) {
      addBoxDetail(gantry, [0.02, 0.16, 0.02], [rx, gantryTopY + 0.14, rz], bom.antenna);
    }
  }
  // Loading spouts dropping from the gantry down toward each silo roof.
  for (const t of siloTops) {
    addCylinderBetween(
      gantry,
      new THREE.Vector3(t.x, gantryTopY, t.z),
      new THREE.Vector3(t.x, t.y, t.z),
      0.022,
      0.03,
      8,
      bom.metal
    );
  }

  return group;
}
