/**
 * Shared constants for the Oil Logistics System.
 *
 * All resolved numeric values from the requirements Glossary live here as named
 * exports, so tests assert against symbols. Per the "no pinned formula values"
 * testing rule these are *specification constants* (not balance-formula outputs)
 * and may be asserted exactly.
 *
 * Imported directly by both sides of the wire (no duplication):
 *   - src/world/logistics.ts, logisticsGen.ts, logisticsSeed.ts (server-side rules)
 *   - server/logisticsApi.ts (intent appliers)
 *   - client/logisticsController.ts, logisticsPanel.ts, worldData.ts (UI + mirror)
 *
 * Named exports only — no default export.
 */

export const EXTRACTION_RATE = 1;               // one Oil per well per turn
export const WELL_STORAGE_CAPACITY = 5;         // well's local buffer
export const REFINERY_THROUGHPUT_RATE = 5;      // per refinery segment per turn
export const CONVERSION_RATIO = 1;              // 5 Oil -> 5 Petrol
export const HUB_STORAGE_CAPACITY = 5;          // one storage segment
export const DEPOSIT_SPACING = 20;              // Req 1.2  (shortest-path hexes; Maximal_Deposit_Fill)
export const HOME_CITY_REFINED_PRODUCT_MAX = 100000; // Req 5.4–5.7
export const ROUTE_CAPACITY_MIN = 100;          // Req 6.4
export const ROUTE_CAPACITY_MAX = 1000;         // Req 6.5
export const ROUTE_CAPACITY_STEP = 100;         // Req 6.7
export const TRANSPORT_CARGO_MIN = 1;           // Req 8.3
export const TRANSPORT_CARGO_MAX = 5;           // one transport carries at most five units
export const MAX_TRANSPORTS_PER_ROUTE = 3;      // Req 8.11–8.12
export const ENGINEER_TASK_BASE = 6;            // duration = 6 - engineer (Req 2.6, 9.3, 10.1)

/**
 * The fixed development/test/default seed, used to produce a reproducible
 * Default_Test_World for the committed world artifact and tests. No seed —
 * including this one — ships with pre-built oil infrastructure; every world
 * starts with an empty LogisticsState and only standard Oil_Deposit tile
 * placement (which runs for every seed).
 */
export const DEFAULT_SEED = 4242;

/**
 * Transport_Tier is derived from a Transportation_Unit's cumulative upgrade
 * count via transportTier() (Req 14.3–14.5). Thresholds are inclusive lower
 * bounds; the mapping is total and monotonic over upgrades >= 0.
 */
export const TRANSPORT_TIER_THRESHOLDS = {
  van: 0,        // 0–1 upgrades
  truck: 2,      // 2–3 upgrades
  juggernaut: 4, // 4+ upgrades
} as const;
export type TransportTier = 'van' | 'truck' | 'juggernaut';

/** Construction_Cost in Refined_Product units (Req 5.8, 5.9). */
export const CONSTRUCTION_COST = {
  oilWell: 50,
  refineryFirstSegment: 150,
  refineryAdditionalSegment: 100,
  routeRoadPerSegment: 40,
  routeUpgradePerSegment: 60,
  distributionHub: 200,
  bridge: 80,
  transportUnit: 30,
  transportUpgrade: 45,
  forestClear: 0,   // Req 5.9 — turns only, no product
} as const;
