/**
 * Barrel — Oil Logistics System intent appliers (server side).
 *
 * Re-exports every symbol from the split logistics applier modules for importers
 * that need several appliers at once. Prefer importing the owning module directly
 * when you only need one or two symbols — it takes the next reader straight to
 * the implementation. See the individual modules for documentation:
 *
 *   - context.ts             Shared helpers, entity-init constants, applier result shape
 *   - wells.ts                applyBuildOilWellIntent
 *   - bridgesAndForest.ts     applyBuildBridgeIntent, applyClearForestIntent
 *   - refineries.ts           applyBuildRefineryIntent, applyAddRefinerySegmentIntent
 *   - routes.ts               applyBuildRouteIntent, applyUpgradeRouteIntent
 *   - hubs.ts                 applyBuildDistributionHubIntent
 *   - transport.ts            applyPurchaseTransportIntent, applyUpgradeTransportIntent
 *   - shuttle.ts              applyCreateShuttleTransportIntent, applyStopShuttleTransportIntent
 *   - dispatch.ts             LogisticsIntentKind, LogisticsIntent, isLogisticsIntent,
 *                             applyLogisticsIntent
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

export * from './context.js';
export * from './wells.js';
export * from './bridgesAndForest.js';
export * from './refineries.js';
export * from './structures.js';
export * from './routes.js';
export * from './hubs.js';
export * from './transport.js';
export * from './shuttle.js';
export * from './dispatch.js';
