/**
 * Logistics 3D Model Builder — procedural Three.js geometry for logistics entities.
 *
 * Mirrors the unit model pipeline (`client/unitModel.ts::buildUnitModel`): this
 * orchestrator routes a logistics entity to its per-entity builder and lets each
 * builder apply the shared `MeshStandardMaterial` conventions and faction tint via
 * `client/unitModelHelpers.ts` (`BoltOnMaterials`, `createTintedMaterials`).
 *
 * Every builder returns a detailed multi-part `THREE.Group` meeting or exceeding
 * the Unit_Model_Standard (Req 14.1, 14.2) — never a low-poly placeholder.
 *
 * Per-entity builders live in sibling files, matching the `unitModel*` family:
 *   - logisticsModelWell.ts      → buildWellModel(factionHex)
 *   - logisticsModelRefinery.ts  → buildRefineryModel(segmentCount, factionHex)
 *   - logisticsModelHub.ts       → buildHubModel(factionHex)
 *   - logisticsModelBridge.ts    → buildBridgeModel(factionHex?)
 *
 * Transport (logisticsModelTransport.ts) and roads (logisticsModelRoad.ts) are
 * built by their own dedicated entry points and are not routed through here.
 *
 * Client layering: no imports from `src/` or `server/`. Shared types come from
 * `shared/*.js` only. All imports use `.js` extensions; named exports only.
 */

import * as THREE from 'three';
import { buildWellModel } from './logisticsModelWell.js';
import { buildRefineryModel } from './logisticsModelRefinery.js';
import { buildHubModel } from './logisticsModelHub.js';
import { buildBridgeModel } from './logisticsModelBridge.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The static logistics entities routed through this orchestrator. Transport
 * (`buildTransportModel`) and roads (`buildRoadMesh`/`buildHighwayMesh`) have
 * their own dedicated builders and are intentionally excluded here.
 */
export type LogisticsModelKind = 'well' | 'refinery' | 'hub' | 'bridge';

/** Optional per-entity build parameters. */
export interface LogisticsModelOpts {
  /**
   * Number of refinery segments (1..hex sides). Drives how visually large the
   * refinery grows. Ignored by other entity kinds. Defaults to 1.
   */
  segmentCount?: number;
}

/**
 * Build a complete logistics entity 3D model as a `THREE.Group`, delegating to
 * the per-entity builder for `kind`. The group is centred on X/Z at the origin
 * and sits on the ground (Y from 0 up), Y-up — matching the unit/building models
 * so it can share the same offscreen renderer camera.
 *
 * @param kind        Which static logistics entity to build.
 * @param factionHex  Optional faction color (#RRGGBB) to tint bolt-on parts. When
 *                     omitted the neutral default materials are used.
 * @param opts        Optional per-entity parameters (e.g. refinery segmentCount).
 */
export function buildLogisticsModel(
  kind: LogisticsModelKind,
  factionHex?: string,
  opts?: LogisticsModelOpts
): THREE.Group {
  switch (kind) {
    case 'well':
      return buildWellModel(factionHex);
    case 'refinery':
      return buildRefineryModel(opts?.segmentCount ?? 1, factionHex);
    case 'hub':
      return buildHubModel(factionHex);
    case 'bridge':
      return buildBridgeModel(factionHex);
  }
}
