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

export const EXTRACTION_RATE = 10;              // Req 3.1
export const WELL_STORAGE_CAPACITY = 100;       // Req 3.2
export const REFINERY_THROUGHPUT_RATE = 20;     // Req 4.4  (per segment per turn)
export const CONVERSION_RATIO = 0.5;            // Req 4.5  (2 oil -> 1 product)
export const HUB_STORAGE_CAPACITY = 500;        // Req 11.3
export const DEPOSIT_SPACING = 20;              // Req 1.2  (shortest-path hexes; Maximal_Deposit_Fill)
export const HOME_CITY_REFINED_PRODUCT_MAX = 100000; // Req 5.4–5.7
export const ROUTE_CAPACITY_MIN = 100;          // Req 6.4
export const ROUTE_CAPACITY_MAX = 1000;         // Req 6.5
export const ROUTE_CAPACITY_STEP = 100;         // Req 6.7
export const TRANSPORT_CARGO_MIN = 1;           // Req 8.3
export const TRANSPORT_CARGO_MAX = 1000;        // Req 8.3
export const MAX_TRANSPORTS_PER_ROUTE = 3;      // Req 8.11–8.12
export const ENGINEER_TASK_BASE = 6;            // duration = 6 - engineer (Req 2.6, 9.3, 10.1)

/**
 * The single known development/test seed. `generateWorld` seeds the example
 * logistics network ONLY when its seed equals this value (Req 13.1, 13.10).
 * Chosen as a fixed constant so the Default_Test_World is reproducible; every
 * other (arbitrary) seed gets standard deposit placement and nothing else.
 */
export const DEFAULT_SEED = 4242;               // Req 13.1, 13.9, 13.10

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
