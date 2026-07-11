/**
 * Transportation_Unit procedural models for the Oil Logistics System.
 *
 * `buildTransportModel(tier, factionHex)` returns a detailed multi-part
 * THREE.Group for one of the three escalating Transport_Tiers — Small_Van,
 * Truck, Juggernaut (Req 14.3, 14.4). Each tier differs in chassis
 * length/width, axle & wheel count (2 → 3 → 4 axles), cab size, and cargo-body
 * volume so the tier is recognisable at a glance. The `tier` argument is the
 * transport's current `tier` field (derived from its upgrade count via
 * `transportTier()`), so a tier-changing upgrade swaps the rendered model
 * (Req 14.5).
 *
 * Mirrors the `client/unitModel*` family conventions: `import * as THREE`,
 * `MeshStandardMaterial`, a multi-part `THREE.Group`, and faction tinting via
 * `client/unitModelHelpers.ts` (`createTintedMaterials`, `hexToColor`).
 *
 * STRICTLY-INCREASING SIZE GUARANTEE (Req 14.4 / Property 30):
 * Every tier's geometry is driven by a per-tier `TierSpec` whose overall
 * axis-aligned envelope is strictly increasing on all three axes
 * (van < truck < juggernaut in X, Y and Z). All detail parts are kept strictly
 * inside that envelope — wheels sit within the cargo-body width, bumpers within
 * the chassis length, and nothing rises above the cargo-body top. Faction
 * tinting only changes material colour, never geometry, so the `THREE.Box3`
 * bounding-box ordering holds for any tint.
 */

import * as THREE from 'three';
import { createTintedMaterials, hexToColor, addBoxDetail, addCylinderDetail, addBoltHead } from './unitModelHelpers.js';
import type { TransportTier } from '../shared/logisticsConstants.js';

/**
 * Per-tier geometry specification. The derived overall envelope is:
 *   width  (X) = bodyWidth               (wheels kept inside this)
 *   length (Z) = chassisLength           (cab + body + wheels kept inside)
 *   height (Y) = chassisTopY + bodyHeight (wheels bottom at Y = 0)
 * All three grow strictly from van → truck → juggernaut.
 */
interface TierSpec {
  chassisLength: number;
  chassisWidth: number;
  chassisHeight: number;
  chassisTopY: number;
  cabLength: number;
  cabHeight: number;
  bodyLength: number;
  bodyWidth: number;
  bodyHeight: number;
  axleCount: number;
  wheelRadius: number;
  wheelWidth: number;
  trackHalf: number; // |x| of each wheel centre
}

const TIER_SPECS: Record<TransportTier, TierSpec> = {
  // Envelope ≈ X 1.00, Y 1.45, Z 2.20
  van: {
    chassisLength: 2.2,
    chassisWidth: 0.8,
    chassisHeight: 0.22,
    chassisTopY: 0.5,
    cabLength: 0.7,
    cabHeight: 0.55,
    bodyLength: 1.25,
    bodyWidth: 1.0,
    bodyHeight: 0.95,
    axleCount: 2,
    wheelRadius: 0.28,
    wheelWidth: 0.16,
    trackHalf: 0.36,
  },
  // Envelope ≈ X 1.40, Y 2.05, Z 3.40
  truck: {
    chassisLength: 3.4,
    chassisWidth: 1.1,
    chassisHeight: 0.3,
    chassisTopY: 0.7,
    cabLength: 1.0,
    cabHeight: 0.85,
    bodyLength: 2.0,
    bodyWidth: 1.4,
    bodyHeight: 1.35,
    axleCount: 3,
    wheelRadius: 0.34,
    wheelWidth: 0.22,
    trackHalf: 0.5,
  },
  // Envelope ≈ X 1.90, Y 2.75, Z 5.00
  juggernaut: {
    chassisLength: 5.0,
    chassisWidth: 1.5,
    chassisHeight: 0.4,
    chassisTopY: 0.95,
    cabLength: 1.4,
    cabHeight: 1.2,
    bodyLength: 3.0,
    bodyWidth: 1.9,
    bodyHeight: 1.8,
    axleCount: 4,
    wheelRadius: 0.44,
    wheelWidth: 0.28,
    trackHalf: 0.7,
  },
};

/** Normalise a faction color given as a number (0xRRGGBB) or string to `#RRGGBB`. */
function normalizeHex(factionHex: number | string): string {
  if (typeof factionHex === 'number') {
    return '#' + (factionHex & 0xffffff).toString(16).padStart(6, '0');
  }
  return factionHex.startsWith('#') ? factionHex : '#' + factionHex;
}

interface TransportMaterials {
  body: THREE.MeshStandardMaterial;   // faction-tinted cargo body / cab shell
  metal: THREE.MeshStandardMaterial;  // faction-tinted trim / frame
  dark: THREE.MeshStandardMaterial;   // neutral structural (chassis rails, bumpers)
  tyre: THREE.MeshStandardMaterial;   // neutral rubber
  glass: THREE.MeshStandardMaterial;  // windows
}

function createMaterials(factionHex: number | string): TransportMaterials {
  const hex = normalizeHex(factionHex);
  const fc = hexToColor(hex);

  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.7, metalness: 0.4 });
  const bom = createTintedMaterials(hex, dark);

  // Body is strongly faction-tinted for at-a-glance ownership recognition.
  const bodyColor = new THREE.Color(0xb8bcc0).lerp(fc, 0.6);
  const body = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.55, metalness: 0.35 });

  return {
    body,
    metal: bom.metal,
    dark,
    tyre: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.85, metalness: 0.15 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1e2833, roughness: 0.25, metalness: 0.6 }),
  };
}

/** Add one wheel (tyre + hub + bolt ring) centred at (x, wheelRadius, z), axle along X. */
function addWheel(group: THREE.Group, spec: TierSpec, x: number, z: number, mats: TransportMaterials): void {
  const { wheelRadius: r, wheelWidth: w } = spec;
  const y = r; // bottom of the tyre rests on Y = 0

  const tyre = addCylinderDetail(group, r, r, w, 16, [x, y, z], mats.tyre, 'x');
  void tyre;

  // Hub cap
  const sign = Math.sign(x) || 1;
  const hubX = x + sign * (w / 2 + 0.01);
  addCylinderDetail(group, r * 0.42, r * 0.42, 0.04, 12, [hubX, y, z], mats.metal, 'x');
  addCylinderDetail(group, r * 0.16, r * 0.16, 0.05, 8, [hubX, y, z], mats.dark, 'x');

  // Lug bolts around the hub
  const bolts = 5;
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2;
    addBoltHead(
      group,
      [hubX, y + Math.cos(a) * r * 0.28, z + Math.sin(a) * r * 0.28],
      mats.metal,
      'x',
      r * 0.05,
    );
  }
}

/**
 * Build a Transportation_Unit model for the given tier.
 *
 * @param tier        The transport's current Transport_Tier ('van' | 'truck' | 'juggernaut').
 * @param factionHex  Faction color as `0xRRGGBB` number or `#RRGGBB`/`RRGGBB` string.
 * @returns A multi-part THREE.Group centred on X/Z with wheels resting on Y = 0.
 */
export function buildTransportModel(tier: TransportTier, factionHex: number | string): THREE.Group {
  const spec = TIER_SPECS[tier];
  const mats = createMaterials(factionHex);
  const group = new THREE.Group();

  const halfLen = spec.chassisLength / 2;

  // --- Chassis frame: two longitudinal rails + cross-members (neutral dark) ---
  const railInset = spec.chassisWidth / 2 - 0.06;
  const frameY = spec.chassisTopY - spec.chassisHeight / 2;
  for (const side of [-1, 1]) {
    addBoxDetail(
      group,
      [0.1, spec.chassisHeight, spec.chassisLength * 0.94],
      [side * railInset, frameY, 0],
      mats.dark,
    );
  }
  const crossCount = spec.axleCount + 1;
  for (let i = 0; i < crossCount; i++) {
    const z = -halfLen * 0.85 + (i / (crossCount - 1)) * halfLen * 1.7;
    addBoxDetail(group, [spec.chassisWidth - 0.02, spec.chassisHeight * 0.6, 0.1], [0, frameY, z], mats.dark);
  }

  // --- Cab at the front (−Z) ---
  const cabZ = -halfLen + spec.cabLength / 2 + 0.05;
  const cabY = spec.chassisTopY + spec.cabHeight / 2;
  const cabWidth = spec.bodyWidth * 0.92;
  addBoxDetail(group, [cabWidth, spec.cabHeight, spec.cabLength], [0, cabY, cabZ], mats.body);

  // Windshield (front-facing, slightly inset so it never exceeds the cab envelope)
  const windY = spec.chassisTopY + spec.cabHeight * 0.62;
  addBoxDetail(
    group,
    [cabWidth * 0.82, spec.cabHeight * 0.42, 0.05],
    [0, windY, cabZ - spec.cabLength / 2 + 0.03],
    mats.glass,
  );
  // Side windows
  for (const side of [-1, 1]) {
    addBoxDetail(
      group,
      [0.05, spec.cabHeight * 0.36, spec.cabLength * 0.5],
      [side * (cabWidth / 2 - 0.02), windY, cabZ],
      mats.glass,
    );
  }

  // Headlights + front bumper (kept inside the chassis length)
  for (const side of [-1, 1]) {
    addBoxDetail(
      group,
      [cabWidth * 0.16, spec.cabHeight * 0.18, 0.05],
      [side * cabWidth * 0.3, spec.chassisTopY + spec.cabHeight * 0.2, cabZ - spec.cabLength / 2 + 0.02],
      mats.metal,
    );
  }
  addBoxDetail(
    group,
    [spec.bodyWidth * 0.9, spec.chassisHeight * 0.7, 0.12],
    [0, frameY, -halfLen + 0.06],
    mats.dark,
  );

  // --- Cargo body behind the cab (defines the height + width envelope) ---
  const bodyZ = -halfLen + spec.cabLength + spec.bodyLength / 2 + 0.1;
  const bodyY = spec.chassisTopY + spec.bodyHeight / 2;
  addBoxDetail(group, [spec.bodyWidth, spec.bodyHeight, spec.bodyLength], [0, bodyY, bodyZ], mats.body);

  // Corner posts + roof/floor rails (faction metal trim)
  const bx = spec.bodyWidth / 2;
  const bzF = bodyZ - spec.bodyLength / 2;
  const bzR = bodyZ + spec.bodyLength / 2;
  for (const side of [-1, 1]) {
    for (const z of [bzF, bzR]) {
      addBoxDetail(group, [0.08, spec.bodyHeight, 0.08], [side * (bx - 0.04), bodyY, z], mats.metal);
    }
  }

  // Vertical ribs along each side of the cargo body
  const ribCount = Math.max(3, Math.round(spec.bodyLength / 0.7));
  for (const side of [-1, 1]) {
    for (let i = 0; i < ribCount; i++) {
      const z = bzF + ((i + 0.5) / ribCount) * spec.bodyLength;
      addBoxDetail(group, [0.04, spec.bodyHeight * 0.9, 0.06], [side * (bx + 0.01), bodyY, z], mats.metal);
    }
  }

  // Rear door seam + handles
  addBoxDetail(group, [spec.bodyWidth * 0.94, spec.bodyHeight * 0.9, 0.04], [0, bodyY, bzR + 0.01], mats.metal);
  for (const side of [-1, 1]) {
    addBoxDetail(group, [0.06, spec.bodyHeight * 0.2, 0.06], [side * bx * 0.35, bodyY, bzR + 0.03], mats.dark);
  }

  // --- Wheels: `axleCount` axles, two wheels each, spaced along the chassis ---
  const firstAxleZ = -halfLen + spec.chassisLength * 0.2;
  const lastAxleZ = halfLen - spec.chassisLength * 0.1;
  for (let a = 0; a < spec.axleCount; a++) {
    const z =
      spec.axleCount === 1
        ? (firstAxleZ + lastAxleZ) / 2
        : firstAxleZ + (a / (spec.axleCount - 1)) * (lastAxleZ - firstAxleZ);
    // Axle rod (neutral)
    addCylinderDetail(group, spec.wheelRadius * 0.14, spec.wheelRadius * 0.14, spec.trackHalf * 2, 8, [0, spec.wheelRadius, z], mats.dark, 'x');
    addWheel(group, spec, -spec.trackHalf, z, mats);
    addWheel(group, spec, spec.trackHalf, z, mats);
  }

  // Exhaust stack alongside the cab (kept within the body width + chassis length)
  addCylinderDetail(
    group,
    spec.wheelRadius * 0.12,
    spec.wheelRadius * 0.12,
    spec.bodyHeight * 0.6,
    8,
    [bx - 0.08, spec.chassisTopY + spec.bodyHeight * 0.3, bzF + 0.1],
    mats.metal,
    'y',
  );

  return group;
}
