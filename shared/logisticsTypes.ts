/**
 * Wire + authoritative entity shapes for the Oil Logistics System.
 *
 * This module is the single source of truth for logistics entity shapes. Because
 * wire shapes reuse the same field names as the authoritative shapes (exactly as
 * `WireUnit`/`WireBuilding` do in `wireTypes.ts`), serialization is a straight
 * field copy and `client/worldData.ts` can mirror these types directly.
 *
 * Import boundary (design goal — client renders/validates without importing `src/`):
 *   - `UnitAttributes` is imported from the shared authoritative module (`./unitTypes.js`).
 *   - `TransportTier` is imported from the shared constants (`./logisticsConstants.js`).
 *   - The tile shape is expressed as the client-safe structural `LogisticsTile`
 *     rather than importing `Tile` from `src/world/types.ts`. `tsconfig.client.json`
 *     only includes `client/**` + `shared/**`, so a `shared -> src` import would pull
 *     `src/` into the client typecheck graph and defeat the layering. `LogisticsTile`
 *     is a structural subset of the authoritative `Tile`, so an authoritative
 *     `Tile[]` is assignable to `LogisticsTile[]` at every server-side call site.
 *
 * All commodity quantities are non-negative integers (Req 3.6, 5.5, 5.6).
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { TransportTier } from './logisticsConstants.js';
import type { UnitAttributes } from './unitTypes.js';

// ─── Scalars ────────────────────────────────────────────────────────────────

/** Raw Oil / Refined_Product amounts are always integers >= 0. */
export type Amount = number;

/**
 * Client-safe structural view of the authoritative `Tile` (`src/world/types.ts`).
 *
 * Only the fields the logistics rules read are declared, so this stays decoupled
 * from `src/`. Field types are chosen to be supertypes of the authoritative
 * `Tile`'s fields (e.g. `terrainType: string` accepts `Tile.terrainType:
 * TerrainType`), guaranteeing an authoritative `Tile[]` is assignable to
 * `LogisticsTile[]`.
 */
export interface LogisticsTile {
  index: number;
  neighbours: number[];
  terrainType: string;
  height: number;
  forested: boolean;
  /** Per-segment steepness in radians; used by placement gates and travel time. */
  segSteep?: number[];
  /** `"oil"` marks an Oil_Deposit (Req 1.3, 2.4). */
  resourceType?: string;
  /** Owning faction id, when the tile is claimed. */
  ownerId?: string;
  /** City id when this tile is a city capital. */
  cityId?: string;
}

// ─── Structures ───────────────────────────────────────────────────────────────

/** Req 2, 3, 12 — a drilled well occupying exactly one segment. */
export interface OilWell {
  id: string;
  ownerId: string;                 // Structure_Owner (Req 12.1)
  tileIndex: number;
  segment: number;                 // exactly one segment (Req 2.8)
  storedOil: Amount;               // 0 <= storedOil <= WELL_STORAGE_CAPACITY (Req 3.2/3.6)
  hitPoints: number;               // Req 12.4
  maxHitPoints: number;
}

/** Req 4, 12 — a refinery covering a whole hex, composed of 1..sides segments. */
export interface Refinery {
  id: string;
  ownerId: string;
  tileIndex: number;
  segments: number[];              // occupied segment indices; length = segment count (Req 4.2/4.3)
  heldOil: Amount;                 // raw oil awaiting processing
  refinedProductAvailable: Amount; // produced, awaiting transport (Req 4.6)
  hitPoints: number;
  maxHitPoints: number;
}

/** Req 6, 7, 12 — a physical road/highway along a contiguous tile path. */
export interface LogisticsRoute {
  id: string;
  ownerId: string;
  fromStructureId: string;         // Oil_Well | Refinery | Home_City
  toStructureId: string;
  segments: number[];              // Route_Segment tile indices, pairwise adjacent (Req 6.1)
  capacity: number;                // ROUTE_CAPACITY_MIN..MAX (Req 6.4/6.5)
  tier: 'road' | 'highway';        // Req 6.7 render form
  travelTime: number;              // whole turns >= 1 (Req 7.3), = routeTravelTime(steepness)
  operable: boolean;               // false when a segment is destroyed (Req 12.8)
}

/** Req 8, 12, 14 — AI-driven transport; also a combat Unit (injected into CombatContext.units). */
export interface Transport {
  id: string;
  ownerId: string;
  routeId: string;                 // assigned route (Req 8.2)
  cargoType: 'oil' | 'product' | null;
  cargo: Amount;                   // 0 <= cargo <= cargoCapacity (Req 8.3)
  cargoCapacity: number;           // TRANSPORT_CARGO_MIN..MAX
  speed: number;                   // upgradeable (Req 8.4)
  defence: number;                 // upgradeable (Req 8.4)
  upgrades: number;                // cumulative upgrade count, integer >= 0 (Req 8.4, 14.5)
  tier: TransportTier;             // 'van' | 'truck' | 'juggernaut' = transportTier(upgrades) (Req 14.3–14.5)
  inTransit: boolean;
  turnsRemaining: number;          // countdown to delivery = travelTime at dispatch (Req 7.4)
  unitId: string;                  // id of the backing Unit used for combat (Req 8.5)
}

/** Req 11, 12 — buffers and balances flow across connected routes. */
export interface DistributionHub {
  id: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  buffer: Amount;                  // 0 <= buffer <= HUB_STORAGE_CAPACITY (Req 11.3)
  routeIds: string[];              // connected outgoing routes (Req 11.5)
  hitPoints: number;
  maxHitPoints: number;
}

// ─── Faction stock & in-progress tasks ─────────────────────────────────────────

/** Req 5 — per-faction home city commodity stock. */
export interface HomeStock {
  factionId: string;
  refinedProduct: Amount;          // 0..HOME_CITY_REFINED_PRODUCT_MAX (Req 5.5/5.7)
  oil: Amount;                     // delivered raw oil (Req 6.9)
}

/** Req 2, 9, 10 — an in-progress engineer task with a countdown. */
export interface EngineerTask {
  id: string;
  kind: 'well' | 'clearForest' | 'bridge';
  unitId: string;                  // constructing engineer
  tileIndex: number;
  segment?: number;                // for 'well'
  turnsRemaining: number;          // decremented each turn, clamp >= 0 (Req 2.7)
  ownerId: string;
}

/**
 * Minimal reference to the Engineer_Unit driving a construction task, carrying the
 * shared `UnitAttributes` (the `engineer` value gates well/bridge/clear work and
 * sets task duration = ENGINEER_TASK_BASE - engineer). Structural subset of the
 * authoritative Unit, kept client-safe. (Req 2.1, 2.6)
 */
export interface EngineerUnitRef {
  id: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  attributes: UnitAttributes;
}

// ─── Aggregate state ────────────────────────────────────────────────────────────

/** The whole mutable logistics state, held on MatchState.logistics. */
export interface LogisticsState {
  wells: OilWell[];
  refineries: Refinery[];
  routes: LogisticsRoute[];
  transports: Transport[];
  hubs: DistributionHub[];
  home: Record<string, HomeStock>;  // keyed by factionId
  tasks: EngineerTask[];
  clearedForests: number[];         // tile indices no longer forested (overlay, Req 9.4)
  bridges: number[];                // tile indices with a completed bridge (overlay, Req 10.3)
}

/**
 * Read-only context passed to pure validators and `resolveLogisticsTurn`: the
 * authoritative tiles (as the client-safe `LogisticsTile`) plus current state.
 * Mirrors how `PlacementContext` bundles tiles for `shared/buildings.ts`.
 */
export interface LogisticsContext {
  tiles: LogisticsTile[];
  state: LogisticsState;
}

// ─── Validation results ─────────────────────────────────────────────────────────

/**
 * Discriminated rejection reasons returned by every construction/upgrade/transport
 * validator (mirrors `PlacementValidation` in `shared/buildings.ts`). The subsystem
 * never throws for expected rejections.
 */
export type LogisticsRejectionReason =
  | 'lacks-engineer'        // Req 2.2, 9.6, 10.6
  | 'too-steep'             // Req 2.3, 4.11
  | 'no-deposit'            // Req 2.4
  | 'in-city'               // wells/refineries may not be built inside a city
  | 'segment-occupied'      // Req 2.5
  | 'outside-refinery-tile' // Req 4.8
  | 'refinery-at-capacity'  // Req 4.9
  | 'ineligible-tile'       // Req 4.10, 4.12
  | 'insufficient-product'  // Req 5.3
  | 'invalid-endpoints'     // Req 6.2
  | 'path-not-traversable'  // Req 6.3, 9.2, 10.5
  | 'route-at-max-capacity' // Req 6.8
  | 'cargo-exceeds-capacity'// Req 8.3
  | 'route-transport-full'  // Req 8.12
  | 'owned-by-other-player' // Req 12.3
  | 'invalid-placement';    // Req 11.2

/** Result of a pure logistics validator. `legal: true` means the action may proceed. */
export interface LogisticsValidation {
  legal: boolean;
  reason?: LogisticsRejectionReason;
  message?: string;          // human-readable, surfaced in the UI
  offendingTiles?: number[];
}

// ─── Per-turn events ─────────────────────────────────────────────────────────────

/**
 * A per-turn logistics outcome forwarded from `resolveLogisticsTurn` to the client
 * for animation/notification, exactly as combat results are forwarded today. Shapes
 * are inferred (not spelled out verbatim in the design); all quantity fields are
 * integer `Amount`s.
 */
export type LogisticsEventKind =
  | 'well-completed'        // an engineer task produced an operational well (Req 2.8)
  | 'extracted'             // a well added oil this turn (Req 3.1)
  | 'refined'               // a refinery produced Refined_Product (Req 4.5)
  | 'dispatched'            // a transport departed a source endpoint (Req 8.1)
  | 'delivered'             // cargo arrived at an endpoint (Req 7.4, 8.9)
  | 'transport-destroyed'   // a transport was destroyed in transit; cargo lost (Req 7.5, 8.6)
  | 'structure-destroyed'   // a well/refinery/hub/road/bridge was destroyed (Req 12.6)
  | 'route-inoperable'      // a route lost a segment and is no longer operable (Req 12.8)
  | 'storage-full';         // storage/home clamp discarded excess (Req 3.3, 5.7, 8.8, 11.6)

export interface LogisticsEvent {
  kind: LogisticsEventKind;
  factionId?: string;              // affected faction
  entityId?: string;               // well/refinery/route/transport/hub id
  routeId?: string;                // route involved, when applicable
  tileIndex?: number;              // tile the event occurred on, when applicable
  cargoType?: 'oil' | 'product';   // commodity involved, when applicable
  amount?: Amount;                 // integer quantity moved/produced/lost, when applicable
  message?: string;                // human-readable summary for notifications
}
