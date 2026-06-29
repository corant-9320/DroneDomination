/**
 * localMapMovement.ts — Barrel re-export.
 *
 * Split into three focused modules:
 *   movementRange.ts  — pure compute (Dijkstra flood fill, weapon range)
 *   movementRoute.ts  — route math + MovePlan types
 *   movementDraw.ts   — all canvas draw* functions
 *
 * All callers (localMap.ts, mapInput.ts) continue to import from this file
 * without any changes needed.
 */

export {
  getRangeTiles,
  weaponRangeInTileHops,
  isInWeaponRange,
  buildEnemySegmentSet,
  computeMovementRange,
  type MovementRangeResult,
} from './movementRange.js';

export {
  computeMovementCostRoute,
  computeContextualAttackRoute,
  computeMovementTowardTile,
  computeMovementRouteForDestination,
  extractMovePlan,
  extractMovePath,
  type RouteHopZone,
  type MovementRouteHop,
  type MovementCostRoute,
  type MovePlan,
} from './movementRoute.js';

export {
  drawMovementRange,
  drawZoneBoundary,
  drawTileOverlay,
  drawReachableSegments,
  drawAttackRangeRings,
  drawMovementCostRoute,
} from './movementDraw.js';
