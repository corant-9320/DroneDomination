/**
 * Compatibility helpers for legacy logistics state.
 *
 * These helpers are client-safe and non-mutating, so the same migration is
 * applied when compact saves are expanded and when the server adopts a match.
 */

import type { LogisticsState } from './logisticsTypes.js';

/** Remove routes, transports, and hub route references that lose any endpoint. */
export function removeDependentLogisticsRoutes(
  logistics: LogisticsState,
  structureIds: ReadonlySet<string>,
): LogisticsState {
  if (structureIds.size === 0) return logistics;

  const routeIds = new Set(
    logistics.routes
      .filter((route) => structureIds.has(route.fromStructureId) || structureIds.has(route.toStructureId))
      .map((route) => route.id),
  );
  if (routeIds.size === 0) return logistics;

  return {
    ...logistics,
    routes: logistics.routes.filter((route) => !routeIds.has(route.id)),
    transports: logistics.transports.filter((transport) => !routeIds.has(transport.routeId)),
    hubs: logistics.hubs.map((hub) => ({
      ...hub,
      routeIds: hub.routeIds.filter((routeId) => !routeIds.has(routeId)),
    })),
  };
}

/** Remove legacy storage hubs inside city footprints and clean their dependencies. */
export function sanitizeCityDistributionHubs(
  logistics: LogisticsState,
  cityTileIndices: ReadonlySet<number>,
): LogisticsState {
  const invalidHubIds = new Set(
    logistics.hubs.filter((hub) => cityTileIndices.has(hub.tileIndex)).map((hub) => hub.id),
  );
  if (invalidHubIds.size === 0) return logistics;

  return removeDependentLogisticsRoutes({
    ...logistics,
    hubs: logistics.hubs.filter((hub) => !invalidHubIds.has(hub.id)),
  }, invalidHubIds);
}
