/**
 * Oil Well 3D Model Builder — a procedural pump-jack (nodding-donkey) derrick
 * with a walking beam, horse head, counterweight crank, pitman arm, and an
 * adjacent storage tank on a concrete pad.
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
 * Build the oil-well pump-jack model.
 *
 * @param factionHex Optional faction color (#RRGGBB) tinting the metal parts.
 */
export function buildWellModel(factionHex?: string): THREE.Group {
  const group = new THREE.Group();

  // Neutral structural/accent material (untinted joints & bolts).
  const matDark = new THREE.MeshStandardMaterial({ color: 0x3f3f3f, roughness: 0.75, metalness: 0.3 });

  // Faction-tinted bolt-on metals, or neutral defaults.
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
  const matTank = new THREE.MeshStandardMaterial({ color: 0x6f7a74, roughness: 0.55, metalness: 0.45 });
  const matRust = new THREE.MeshStandardMaterial({ color: 0x7c4a2e, roughness: 0.85, metalness: 0.2 });

  // ── Concrete pad ───────────────────────────────────────────────────────────
  addBoxDetail(group, [2.0, 0.12, 1.5], [0, 0.06, 0], matConcrete);

  // ── Skid base under the pump-jack (steel I-beam frame) ──────────────────────
  const skid = new THREE.Group();
  skid.position.set(-0.35, 0.12, 0);
  group.add(skid);
  addBoxDetail(skid, [1.1, 0.1, 0.7], [0, 0.05, 0], matDark);
  addBoxDetail(skid, [1.1, 0.06, 0.08], [0, 0.11, 0.28], bom.metal);
  addBoxDetail(skid, [1.1, 0.06, 0.08], [0, 0.11, -0.28], bom.metal);

  // ── Sampson post: an A-frame tower that supports the walking beam pivot ─────
  const pivotX = -0.15;
  const pivotY = 1.15;
  const legFootHalf = 0.28;
  // Two pairs of angled legs (front & back), meeting near the pivot.
  for (const z of [0.26, -0.26]) {
    addCylinderBetween(
      skid,
      new THREE.Vector3(pivotX - legFootHalf, 0.1, z),
      new THREE.Vector3(pivotX, pivotY - 0.12, 0),
      0.03,
      0.045,
      8,
      bom.metal
    );
    addCylinderBetween(
      skid,
      new THREE.Vector3(pivotX + legFootHalf, 0.1, z),
      new THREE.Vector3(pivotX, pivotY - 0.12, 0),
      0.03,
      0.045,
      8,
      bom.metal
    );
  }
  // Cross-brace between the two A-frames.
  addCylinderBetween(
    skid,
    new THREE.Vector3(pivotX, pivotY - 0.35, 0.24),
    new THREE.Vector3(pivotX, pivotY - 0.35, -0.24),
    0.025,
    0.025,
    6,
    matDark
  );

  // ── Pivot bearing (saddle) at the top of the Sampson post ───────────────────
  addCylinderDetail(skid, 0.07, 0.07, 0.32, 12, [pivotX, pivotY - 0.1, 0], matDark, 'z');
  addBoltHead(skid, [pivotX, pivotY - 0.1, 0.17], bom.dark, 'z', 0.03);
  addBoltHead(skid, [pivotX, pivotY - 0.1, -0.17], bom.dark, 'z', 0.03);

  // ── Walking beam (the "nodding" beam), tilted slightly nose-down ────────────
  const beam = new THREE.Group();
  beam.position.set(pivotX, pivotY - 0.1, 0);
  beam.rotation.z = -0.12; // slight nod toward the well head (horse-head side)
  skid.add(beam);
  addBoxDetail(beam, [1.5, 0.14, 0.12], [0.15, 0.12, 0], bom.metal); // main beam member
  addBoxDetail(beam, [1.5, 0.05, 0.16], [0.15, 0.2, 0], matDark);    // top flange
  // Lightening holes suggested by dark inset blocks along the web.
  for (const x of [-0.2, 0.1, 0.4, 0.7]) {
    addBoxDetail(beam, [0.12, 0.08, 0.13], [x, 0.12, 0], matDark);
  }

  // ── Horse head (curved counter at the well-head end) + bridle & polished rod ─
  const headX = 0.95;
  addBoxDetail(beam, [0.18, 0.34, 0.12], [headX, 0.02, 0], matDark);
  addCylinderDetail(beam, 0.17, 0.17, 0.12, 16, [headX, 0.12, 0], matDark, 'z');
  // Bridle cables down to the polished-rod carrier bar.
  addCylinderBetween(
    beam,
    new THREE.Vector3(headX + 0.12, 0.1, 0.05),
    new THREE.Vector3(headX + 0.12, -0.55, 0.05),
    0.012,
    0.012,
    6,
    bom.antenna
  );
  addCylinderBetween(
    beam,
    new THREE.Vector3(headX + 0.12, 0.1, -0.05),
    new THREE.Vector3(headX + 0.12, -0.55, -0.05),
    0.012,
    0.012,
    6,
    bom.antenna
  );
  // Carrier bar + polished rod entering the well head.
  addBoxDetail(skid, [0.14, 0.05, 0.2], [pivotX + 1.1, 0.66, 0], matDark);
  addCylinderDetail(skid, 0.03, 0.03, 0.7, 8, [pivotX + 1.1, 0.35, 0], bom.antenna);

  // ── Well head (Christmas tree valve stack) at the pad ───────────────────────
  const wellHeadX = pivotX + 1.1;
  addCylinderDetail(skid, 0.09, 0.11, 0.16, 12, [wellHeadX, 0.08, 0], matRust);
  addCylinderDetail(skid, 0.05, 0.05, 0.12, 10, [wellHeadX, 0.2, 0], bom.metal);
  addBoxDetail(skid, [0.22, 0.05, 0.05], [wellHeadX, 0.16, 0], matRust); // side valve wheel arm
  addCylinderDetail(skid, 0.06, 0.06, 0.02, 10, [wellHeadX + 0.13, 0.16, 0], bom.metal, 'x');

  // ── Crank + counterweight + pitman arm (drive side, opposite the horse head) ─
  const crankX = pivotX - 0.55;
  const crankBaseY = 0.55;
  // Gearbox / prime-mover housing on the skid.
  addBoxDetail(skid, [0.42, 0.34, 0.5], [crankX, crankBaseY - 0.18, 0], matDark);
  addBoxDetail(skid, [0.44, 0.06, 0.52], [crankX, crankBaseY, 0], bom.metal);
  // Crank discs on each side with heavy counterweights.
  for (const z of [0.28, -0.28]) {
    addCylinderDetail(skid, 0.18, 0.18, 0.05, 16, [crankX, crankBaseY, z], bom.rotor, 'z');
    addBoxDetail(skid, [0.16, 0.3, 0.06], [crankX + 0.02, crankBaseY - 0.13, z], matDark); // counterweight
  }
  // Pitman arms linking the crank pin up to the rear of the walking beam.
  addCylinderBetween(
    skid,
    new THREE.Vector3(crankX + 0.02, crankBaseY - 0.13, 0.28),
    new THREE.Vector3(pivotX - 0.6, pivotY - 0.05, 0.28),
    0.02,
    0.02,
    6,
    bom.metal
  );
  addCylinderBetween(
    skid,
    new THREE.Vector3(crankX + 0.02, crankBaseY - 0.13, -0.28),
    new THREE.Vector3(pivotX - 0.6, pivotY - 0.05, -0.28),
    0.02,
    0.02,
    6,
    bom.metal
  );

  // ── Storage tank on the far side of the pad, with domed roof & ladder ───────
  const tank = new THREE.Group();
  tank.position.set(0.68, 0.12, 0);
  group.add(tank);
  addCylinderDetail(tank, 0.42, 0.42, 0.9, 24, [0, 0.45, 0], matTank);
  // Ribbed courses (banding) around the tank wall.
  for (const y of [0.2, 0.45, 0.7]) {
    addCylinderDetail(tank, 0.435, 0.435, 0.03, 24, [0, y, 0], matDark);
  }
  // Domed roof.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    matTank
  );
  dome.position.set(0, 0.9, 0);
  tank.add(dome);
  // Roof vent.
  addCylinderDetail(tank, 0.05, 0.05, 0.12, 10, [0, 1.02, 0], bom.metal);
  // External access ladder + safety cage rails.
  addBoxDetail(tank, [0.04, 0.9, 0.04], [-0.42, 0.45, 0.08], matDark);
  addBoxDetail(tank, [0.04, 0.9, 0.04], [-0.42, 0.45, -0.08], matDark);
  for (const y of [0.15, 0.3, 0.45, 0.6, 0.75]) {
    addBoxDetail(tank, [0.04, 0.02, 0.2], [-0.42, y, 0], bom.antenna);
  }
  // Outlet pipe from tank toward the well head.
  addCylinderBetween(
    tank,
    new THREE.Vector3(-0.42, 0.14, 0),
    new THREE.Vector3(-1.1, 0.14, 0),
    0.035,
    0.035,
    8,
    bom.metal
  );

  return group;
}
