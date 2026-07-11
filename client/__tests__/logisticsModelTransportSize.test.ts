// Feature: oil-logistics-system, Property 30: strictly-increasing transport model size
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { buildTransportModel } from '../logisticsModelTransport.js';
import type { TransportTier } from '../../shared/logisticsConstants.js';

/**
 * Property 30: for any faction tint, the THREE.Box3 size of
 * `buildTransportModel('van')` < `buildTransportModel('truck')` <
 * `buildTransportModel('juggernaut')` on every axis (X, Y, Z).
 *
 * Validates: Requirement 14.4
 *
 * The implementation drives each tier's geometry from a per-tier `TierSpec`
 * whose overall envelope grows strictly on all three axes, and keeps every
 * detail part inside that envelope. Faction tinting only changes material
 * colour, never geometry, so the bounding-box ordering must hold for any tint.
 * Three.js builds BufferGeometry without a WebGL renderer, so `Box3` bounds are
 * exact in the plain node test environment.
 */

const TIERS: readonly TransportTier[] = ['van', 'truck', 'juggernaut'];

/** Overall bounding-box size of a Group as a THREE.Vector3. */
function boundingSize(group: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
}

/** Assert strict ordering a < b < c on every axis. */
function expectStrictlyIncreasing(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(a[axis]).toBeLessThan(b[axis]);
    expect(b[axis]).toBeLessThan(c[axis]);
  }
}

describe('buildTransportModel — Property 30: strictly-increasing model size', () => {
  it('van < truck < juggernaut on all axes for a representative tint', () => {
    const [van, truck, juggernaut] = TIERS.map((tier) =>
      boundingSize(buildTransportModel(tier, 0xff0000)),
    );
    expectStrictlyIncreasing(van, truck, juggernaut);
  });

  it('holds for every faction tint (fast-check, >= 100 iterations)', () => {
    const factionHexArb = fc.oneof(
      fc.integer({ min: 0x000000, max: 0xffffff }),
      fc
        .integer({ min: 0x000000, max: 0xffffff })
        .map((n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')),
      fc
        .integer({ min: 0x000000, max: 0xffffff })
        .map((n) => (n & 0xffffff).toString(16).padStart(6, '0')),
    );

    fc.assert(
      fc.property(factionHexArb, (factionHex) => {
        const [van, truck, juggernaut] = TIERS.map((tier) =>
          boundingSize(buildTransportModel(tier, factionHex)),
        );
        expectStrictlyIncreasing(van, truck, juggernaut);
      }),
      { numRuns: 200 },
    );
  });
});
