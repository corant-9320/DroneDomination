/**
 * Bridge 3D Model Builder — a girder-deck river crossing with support piers,
 * cross-bracing, side railings, and a running road surface on the deck.
 *
 * Returns a detailed multi-part `THREE.Group` meeting or exceeding the
 * Unit_Model_Standard (Req 14.1, 14.2). Reuses `client/unitModelHelpers.ts`
 * (`BoltOnMaterials`, `createTintedMaterials`) for faction tinting and follows
 * the `MeshStandardMaterial`/`Group` conventions of `client/buildingModel.ts`.
 *
 * The span runs along the X axis, centred on X/Z at the origin, Y-up. The deck
 * sits at a raised Y so piers descend to the (river) ground below.
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
 * Build the bridge model.
 *
 * @param factionHex Optional faction color (#RRGGBB) tinting the metal parts.
 */
export function buildBridgeModel(factionHex?: string): THREE.Group {
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
  const matRoad = new THREE.MeshStandardMaterial({ color: 0x44464a, roughness: 0.9, metalness: 0.1 });

  const spanLen = 3.0;   // along X
  const deckWidth = 1.0; // along Z
  const deckY = 1.0;     // top of the roadway surface
  const deckThickness = 0.16;
  const halfSpan = spanLen / 2;
  const halfW = deckWidth / 2;

  // ── Main deck slab + running road surface ───────────────────────────────────
  addBoxDetail(group, [spanLen, deckThickness, deckWidth], [0, deckY - deckThickness / 2, 0], matConcrete);
  addBoxDetail(group, [spanLen, 0.02, deckWidth * 0.82], [0, deckY + 0.01, 0], matRoad);
  // Longitudinal edge girders under the deck (both sides).
  for (const gz of [-halfW + 0.08, halfW - 0.08]) {
    addBoxDetail(group, [spanLen, 0.14, 0.1], [0, deckY - deckThickness - 0.05, gz], bom.metal);
  }
  // Transverse floor beams under the deck.
  const beams = 7;
  for (let i = 0; i <= beams; i++) {
    const x = -halfSpan + (spanLen * i) / beams;
    addBoxDetail(group, [0.08, 0.1, deckWidth], [x, deckY - deckThickness - 0.03, 0], matDark);
  }

  // ── Support piers ───────────────────────────────────────────────────────────
  // Two intermediate pier lines plus abutment piers near each bank.
  const pierXs = [-halfSpan + 0.35, -0.7, 0.7, halfSpan - 0.35];
  for (const px of pierXs) {
    for (const pz of [-halfW + 0.18, halfW - 0.18]) {
      // Pier column down to the riverbed (Y=0).
      addCylinderDetail(group, 0.11, 0.14, deckY - deckThickness, 14, [px, (deckY - deckThickness) / 2, pz], matConcrete);
      // Footing.
      addBoxDetail(group, [0.32, 0.1, 0.32], [px, 0.05, pz], matDark);
    }
    // Pier cap beam tying the pair together.
    addBoxDetail(group, [0.34, 0.1, deckWidth - 0.1], [px, deckY - deckThickness - 0.12, 0], matConcrete);
    // Cross-bracing between the two columns of the pier.
    addCylinderBetween(
      group,
      new THREE.Vector3(px, 0.15, -halfW + 0.18),
      new THREE.Vector3(px, deckY - deckThickness - 0.2, halfW - 0.18),
      0.02,
      0.02,
      6,
      bom.metal
    );
    addCylinderBetween(
      group,
      new THREE.Vector3(px, 0.15, halfW - 0.18),
      new THREE.Vector3(px, deckY - deckThickness - 0.2, -halfW + 0.18),
      0.02,
      0.02,
      6,
      bom.metal
    );
  }

  // ── Approach abutments on each bank ─────────────────────────────────────────
  for (const ax of [-halfSpan - 0.12, halfSpan + 0.12]) {
    addBoxDetail(group, [0.24, deckY, deckWidth + 0.1], [ax, deckY / 2, 0], matConcrete);
  }

  // ── Side railings: top rail, mid rail, and posts along both edges ───────────
  const railTopY = deckY + 0.34;
  const railMidY = deckY + 0.18;
  for (const rz of [-halfW + 0.03, halfW - 0.03]) {
    // Continuous top & mid rails.
    addBoxDetail(group, [spanLen, 0.04, 0.03], [0, railTopY, rz], bom.antenna);
    addBoxDetail(group, [spanLen, 0.03, 0.02], [0, railMidY, rz], bom.antenna);
    // Vertical posts.
    const posts = 12;
    for (let i = 0; i <= posts; i++) {
      const x = -halfSpan + (spanLen * i) / posts;
      addBoxDetail(group, [0.03, 0.36, 0.03], [x, deckY + 0.18, rz], bom.metal);
    }
    // Kerb along the deck edge.
    addBoxDetail(group, [spanLen, 0.05, 0.04], [0, deckY + 0.025, rz], matDark);
  }

  // ── Decorative rivets on the abutment-side girder ends ──────────────────────
  for (const gz of [-halfW + 0.08, halfW - 0.08]) {
    for (const bx of [-halfSpan + 0.15, halfSpan - 0.15]) {
      addBoltHead(group, [bx, deckY - deckThickness - 0.05, gz], bom.dark);
    }
  }

  return group;
}
