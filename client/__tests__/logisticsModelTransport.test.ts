// Feature: oil-logistics-system, Property 29 (client part): transport tier→model mapping
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { buildTransportModel } from '../logisticsModelTransport.js';
import type { TransportTier } from '../../shared/logisticsConstants.js';

/**
 * Property 29 (client part): for each `tier` in {van, truck, juggernaut},
 * `buildTransportModel(tier, factionHex)` returns a non-empty THREE.Group
 * (>= 1 mesh descendant) and the three tiers' Groups are pairwise distinct.
 *
 * Validates: Requirements 14.1, 14.3, 14.5
 *
 * These are geometry-only assertions — Three.js builds BufferGeometry without a
 * WebGL renderer, so mesh counting and Box3 bounds work in the plain node test
 * environment. Faction tinting only changes material colour, never geometry, so
 * the structural signature is invariant across tints.
 */

const TIERS: readonly TransportTier[] = ['van', 'truck', 'juggernaut'];

/** Count Mesh descendants of a Group by traversing its subtree. */
function countMeshes(group: THREE.Object3D): number {
  let n = 0;
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) n++;
  });
  return n;
}

/** Overall bounding-box size of a Group as a THREE.Vector3. */
function boundingSize(group: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
}

/**
 * Structural signature: mesh count plus the overall bounding-box dimensions
 * (rounded to avoid float noise). Two tiers with the same signature would be
 * structurally indistinguishable; the property asserts they never are.
 */
function signature(group: THREE.Object3D): string {
  const n = countMeshes(group);
  const s = boundingSize(group);
  const r = (v: number) => v.toFixed(3);
  return `${n}|${r(s.x)}|${r(s.y)}|${r(s.z)}`;
}

describe('buildTransportModel — Property 29 (client part): tier→model mapping', () => {
  it('each tier returns a non-empty THREE.Group with >= 1 mesh descendant', () => {
    for (const tier of TIERS) {
      const group = buildTransportModel(tier, 0xff0000);
      expect(group).toBeInstanceOf(THREE.Group);
      expect(countMeshes(group)).toBeGreaterThan(0);
    }
  });

  it('the three tiers are pairwise distinct by structural signature', () => {
    const sigs = TIERS.map((tier) => signature(buildTransportModel(tier, 0x3366cc)));
    const unique = new Set(sigs);
    expect(unique.size).toBe(TIERS.length);
  });

  it('holds for every faction tint: non-empty groups + pairwise-distinct tiers (fast-check)', () => {
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
        const groups = TIERS.map((tier) => buildTransportModel(tier, factionHex));

        // Every tier's Group is a non-empty THREE.Group (Req 14.1, 14.3).
        for (const group of groups) {
          expect(group).toBeInstanceOf(THREE.Group);
          expect(countMeshes(group)).toBeGreaterThan(0);
        }

        // The three tiers are pairwise distinct for this tint (Req 14.3, 14.5).
        const sigs = groups.map(signature);
        expect(new Set(sigs).size).toBe(TIERS.length);
      }),
      { numRuns: 200 },
    );
  });
});
