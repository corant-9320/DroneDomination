/**
 * Transport lifecycle — Oil Logistics System (Req 6.6, 8.1–8.4, 8.7–8.13, 14.3, 14.5).
 *
 * A Transportation_Unit is an AI-driven vehicle assigned to one Logistics_Route
 * that physically carries Oil or Refined_Product between the route's endpoints.
 * Every helper here is PURE: it never mutates its inputs and always returns new
 * values, so the same inputs always resolve the same way. Commodity quantities
 * are non-negative integers; each helper clamps to `>= 0` defensively so a bad
 * caller value can never drive a stored/carried amount negative.
 *
 * Division of labour (mirrors the placement/route notes): these helpers implement
 * the field-level rules (per-turn capacity limit, load/deliver clamps, upgrade,
 * tier derivation, assignment cap, source retention). The orchestrator
 * (`resolveLogisticsTurn`, task 9.1) and the server appliers (task 13.2) wire them
 * into the turn loop — deciding *when* to load/dispatch/deliver and choosing the
 * commodity type — while these functions decide *how much* moves and stays put.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import {
  MAX_TRANSPORTS_PER_ROUTE,
  TRANSPORT_CARGO_MAX,
  TRANSPORT_TIER_THRESHOLDS,
} from '../../../shared/logisticsConstants.js';
import type { TransportTier } from '../../../shared/logisticsConstants.js';
import type { LogisticsRoute, Transport } from '../../../shared/logisticsTypes.js';

/**
 * Limit the cargo moved along a Logistics_Route in a single turn to that route's
 * Route_Capacity (Req 6.6, 8.1).
 *
 * Returns `min(cargo, capacity)`, clamped to a minimum of `0`. Any excess above the
 * route capacity is *not* returned here — the caller retains it at the source
 * structure (see {@link retainAtSource}), so a route never carries more than its
 * capacity per turn. Pure: reads only its arguments.
 *
 * @param cargo The quantity the source would like to send this turn (`>= 0`).
 * @param capacity The route's current Route_Capacity.
 * @returns The permitted per-turn quantity: `max(0, min(cargo, capacity))`.
 */
export function clampTransport(cargo: number, capacity: number): number {
  return Math.max(0, Math.min(cargo, capacity));
}

/**
 * Load a Transportation_Unit from a source's available `supply` (Req 8.2, 8.3, 8.9).
 *
 * Accepts only what fits: the loaded amount is bounded by both the transport's
 * remaining free capacity (`cargoCapacity - cargo`) and the available `supply`, so
 * a load can never push `cargo` above `cargoCapacity` (Req 8.3 — reject/limit an
 * over-capacity load) and can never take more than the source holds. The returned
 * `loaded` is `max(0, min(remainingCapacity, supply))`.
 *
 * The optional `cargoType` lets the orchestrator record what commodity was loaded
 * (a raw `supply: number` alone cannot carry that). When a positive amount is
 * loaded and `cargoType` is supplied, the transport's `cargoType` is set to it;
 * otherwise the transport's existing `cargoType` is preserved. The design's
 * declared shape `loadTransport(t, supply)` is preserved — `cargoType` is an
 * optional third argument, so existing two-argument call sites are unaffected.
 *
 * Pure — returns a new transport and never mutates the input.
 *
 * @param t The transport being loaded.
 * @param supply The quantity available at the source this turn (`>= 0`).
 * @param cargoType Optional commodity to stamp on the transport when it takes on cargo.
 * @returns `{ t, loaded }` — the updated transport (cargo increased, cargoType set
 *   when supplied) and the amount actually loaded.
 */
export function loadTransport(
  t: Transport,
  supply: number,
  cargoType?: 'oil' | 'product',
): { t: Transport; loaded: number } {
  const remaining = Math.max(0, t.cargoCapacity - t.cargo);
  const loaded = Math.max(0, Math.min(remaining, supply));
  const nextCargoType = loaded > 0 && cargoType !== undefined ? cargoType : t.cargoType;
  return {
    t: { ...t, cargo: t.cargo + loaded, cargoType: nextCargoType },
    loaded,
  };
}

/**
 * A minimal storage destination for {@link deliver}: something that holds a bounded
 * `stored` quantity up to a `capacity`. Both the Home_City and a Distribution_Hub
 * (and a well/refinery acting as a delivery target) present this shape, so the
 * orchestrator (task 9.1) can deliver into any of them uniformly.
 */
export interface StorageLike {
  /** Currently stored quantity (`0 <= stored <= capacity`). */
  stored: number;
  /** The destination's Storage_Capacity. */
  capacity: number;
}

/**
 * Deliver `cargo` into a storage destination, clamping to its Storage_Capacity and
 * returning the undelivered remainder (Req 8.9, 8.10).
 *
 * Accepts `max(0, min(freeSpace, cargo))` where `freeSpace = capacity - stored`, so
 * the destination never overflows (Req 8.9). Any cargo that does not fit is returned
 * as `remainder` — the caller keeps it on the Transportation_Unit (Req 8.10) rather
 * than discarding it. Pure — returns a new `StorageLike` and never mutates the input.
 *
 * @param dest The destination store (`{ stored, capacity }`).
 * @param cargo The quantity the transport is trying to deliver (`>= 0`).
 * @returns `{ dest, remainder }` — the updated store (clamped to capacity) and the
 *   quantity that did not fit (retained on the transport).
 */
export function deliver(
  dest: StorageLike,
  cargo: number,
): { dest: StorageLike; remainder: number } {
  const wanted = Math.max(0, cargo);
  const freeSpace = Math.max(0, dest.capacity - dest.stored);
  const accepted = Math.min(freeSpace, wanted);
  const remainder = wanted - accepted;
  return { dest: { ...dest, stored: dest.stored + accepted }, remainder };
}

/**
 * Map a Transportation_Unit's cumulative upgrade count to its visual Transport_Tier
 * (Req 14.3, 14.5).
 *
 * Total and monotonic over `upgrades >= 0` using {@link TRANSPORT_TIER_THRESHOLDS}
 * as inclusive lower bounds: `>= 4` → `'juggernaut'`, `2..3` → `'truck'`, `0..1` →
 * `'van'`. Because the thresholds are checked from highest to lowest, every
 * non-negative upgrade count maps to exactly one tier, and increasing `upgrades`
 * never lowers the tier (monotonic). A negative/fractional count is treated by the
 * same inclusive comparisons (e.g. a negative value falls through to `'van'`). Pure.
 *
 * @param upgrades The transport's cumulative upgrade count (`>= 0`).
 * @returns The derived `TransportTier` (`'van' | 'truck' | 'juggernaut'`).
 */
export function transportTier(upgrades: number): TransportTier {
  if (upgrades >= TRANSPORT_TIER_THRESHOLDS.juggernaut) return 'juggernaut';
  if (upgrades >= TRANSPORT_TIER_THRESHOLDS.truck) return 'truck';
  return 'van';
}

/**
 * Positive per-upgrade increments for each upgradeable Transportation_Unit stat
 * (Req 8.4). Cargo gains one unit at a time and never exceeds the five-unit
 * transport maximum; speed and defence grow one point at a time.
 */
export const TRANSPORT_UPGRADE_INCREMENT: {
  readonly cargo: number;
  readonly speed: number;
  readonly defence: number;
} = {
  cargo: 1,
  speed: 1,
  defence: 1,
};

/**
 * Apply one upgrade to a Transportation_Unit, strictly improving exactly one stat
 * (Req 8.4, 14.5).
 *
 * Increases the chosen `stat` — `cargo` → `cargoCapacity`, `speed`, or `defence` —
 * by its positive {@link TRANSPORT_UPGRADE_INCREMENT}, increments the cumulative
 * `upgrades` count, and recomputes `tier = transportTier(upgrades)` so the rendered
 * model swaps when the tier changes (Req 14.5). The other two stats and — crucially
 * — the assigned Logistics_Route's Route_Capacity are left untouched (Req 8.4): this
 * function only ever returns a new Transport and never touches any route. `cargo`
 * upgrades clamp to `TRANSPORT_CARGO_MAX` to keep `cargoCapacity` within its bound
 * (Req 8.3); below the cap the improvement is strictly positive.
 *
 * Pure — returns a new Transport and never mutates the input.
 *
 * @param t The transport to upgrade.
 * @param stat Which single stat to improve (`'cargo' | 'speed' | 'defence'`).
 * @returns A new Transport with one stat raised, `upgrades` incremented, and `tier`
 *   recomputed; route capacity unchanged.
 */
export function upgradeTransport(t: Transport, stat: 'cargo' | 'speed' | 'defence'): Transport {
  const upgrades = t.upgrades + 1;
  const next: Transport = { ...t, upgrades, tier: transportTier(upgrades) };
  switch (stat) {
    case 'cargo':
      next.cargoCapacity = Math.min(
        TRANSPORT_CARGO_MAX,
        t.cargoCapacity + TRANSPORT_UPGRADE_INCREMENT.cargo,
      );
      break;
    case 'speed':
      next.speed = t.speed + TRANSPORT_UPGRADE_INCREMENT.speed;
      break;
    case 'defence':
      next.defence = t.defence + TRANSPORT_UPGRADE_INCREMENT.defence;
      break;
  }
  return next;
}

/**
 * Whether another Transportation_Unit may be assigned to `route` without exceeding
 * the per-route cap (Req 8.11, 8.12, 8.13).
 *
 * Counts the transports in `transports` already assigned to the route
 * (`routeId === route.id`) and returns `true` iff that count is below
 * `MAX_TRANSPORTS_PER_ROUTE`. The caller rejects the assignment/purchase with the
 * `route-transport-full` reason when this returns `false` (Req 8.12). Pure: reads
 * only its arguments.
 *
 * @param route The target Logistics_Route.
 * @param transports All transports currently in play (any owner/route).
 * @returns `true` when the route has fewer than `MAX_TRANSPORTS_PER_ROUTE` assigned.
 */
export function canAssignTransport(
  route: LogisticsRoute,
  transports: readonly Transport[],
): boolean {
  let assigned = 0;
  for (const t of transports) {
    if (t.routeId === route.id) assigned++;
  }
  return assigned < MAX_TRANSPORTS_PER_ROUTE;
}

/**
 * Retain undelivered cargo at a source structure within its Storage_Capacity
 * (Req 8.7, 8.8).
 *
 * When a Logistics_Route has no operational Transportation_Unit to carry cargo (or
 * the route capacity clamps a load), the undelivered quantity stays at the source.
 * Returns `min(capacity, stored + undelivered)`, clamped to `>= 0`: the source holds
 * up to its Storage_Capacity and any excess beyond the capacity is discarded, not
 * accrued (Req 8.8). Pure: reads only its arguments.
 *
 * @param stored The source's currently stored quantity.
 * @param capacity The source's Storage_Capacity.
 * @param undelivered The quantity that could not be shipped this turn (`>= 0`).
 * @returns The new stored quantity: `max(0, min(capacity, stored + undelivered))`.
 */
export function retainAtSource(stored: number, capacity: number, undelivered: number): number {
  return Math.max(0, Math.min(capacity, stored + undelivered));
}
