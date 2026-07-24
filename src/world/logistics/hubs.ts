/**
 * Distribution hubs — Oil Logistics System (Req 11.1, 11.3, 11.4, 11.5, 11.6, 11.7).
 *
 * A Distribution_Hub buffers Oil/Refined_Product and balances flow across the
 * two-or-more outgoing Logistics_Routes it connects. Every helper here is PURE:
 * it never mutates its inputs and always returns new values, so the same inputs
 * always resolve the same way.
 *
 * Division of labour (mirrors the transport/route notes): `distributeHub` decides
 * *how much* moves onto each outgoing route, *how much* is buffered, and *how
 * much* is left upstream this turn; the orchestrator (`resolveLogisticsTurn`,
 * task 9.1) decides *which* commodity flows, sources the per-turn `inflow`, and
 * applies the returned buffer/amounts back to state. All quantities are treated as
 * combined Oil + Refined_Product units (a hub's buffer is a single combined pool,
 * Req 11.3), and every helper clamps to `>= 0` defensively so a bad caller value
 * can never drive a stored/distributed amount negative.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { HUB_STORAGE_CAPACITY } from '../../../shared/logisticsConstants.js';
import type { DistributionHub } from '../../../shared/logisticsTypes.js';

/**
 * Caller-supplied initialisation for a newly-placed Distribution_Hub (Req 11.1).
 * The `id`, owner, location (`tileIndex`/`segment`), connected `routeIds`, and
 * hit-point pool are provided by the caller (the orchestrator/applier), kept out
 * of the pure engine so no balance value (max hit points) is pinned here. A newly
 * placed hub always starts with an empty buffer (`buffer === 0`, Req 11.1) and at
 * full health.
 */
export interface HubCreationInit {
  id: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  /** The connected outgoing Logistics_Route ids (Req 11.5). */
  routeIds: string[];
  maxHitPoints: number;
}

/**
 * Create a newly-placed Distribution_Hub with an initial buffered quantity of zero
 * (Req 11.1). Pure: reads only `init`, copies `routeIds` into a fresh array (no
 * aliasing of the caller's array), and mutates nothing.
 *
 * The caller is responsible for validating the placement first (task 8.x —
 * `invalid-placement`, Req 11.2); `createHub` itself does no validation and simply
 * builds the entity. The new hub starts empty (`buffer === 0`, Req 11.1) and at
 * full health (`hitPoints === maxHitPoints`).
 *
 * @param init The caller-supplied id, owner, location, connected routes, and
 *   hit-point pool.
 * @returns A new `DistributionHub` with `buffer === 0` and full hit points.
 */
export function createHub(init: HubCreationInit): DistributionHub {
  return {
    id: init.id,
    ownerId: init.ownerId,
    tileIndex: init.tileIndex,
    segment: init.segment,
    buffer: 0,
    routeIds: [...init.routeIds],
    hitPoints: init.maxHitPoints,
    maxHitPoints: init.maxHitPoints,
  };
}

/**
 * The outcome of resolving one turn of flow through a Distribution_Hub
 * (see {@link distributeHub}). Every quantity is a combined Oil + Refined_Product
 * amount (`>= 0`).
 */
export interface HubDistribution {
  /**
   * Per-outgoing-route quantity dispatched this turn, aligned index-for-index to
   * the `outgoingCaps` passed to {@link distributeHub}. Each entry is `<= its cap`
   * (Req 11.5) and the entries sum to {@link HubDistribution.distributedTotal}.
   */
  amounts: number[];
  /**
   * The total quantity dispatched across all outgoing routes this turn, equal to
   * `min(available, Σ outgoingCaps)` where `available = buffer + inflow`
   * (Req 11.4).
   */
  distributedTotal: number;
  /**
   * The hub's buffered quantity carried into the next turn, `0 <= newBuffer <=
   * HUB_STORAGE_CAPACITY` (Req 11.3, 11.6): the available quantity that exceeded
   * the combined outgoing capacity, held up to the Storage_Capacity.
   */
  newBuffer: number;
  /**
   * The quantity that could be neither distributed nor buffered (buffer full) and
   * is therefore left at the upstream source rather than discarded (Req 11.7).
   */
  leftUpstream: number;
}

/**
 * Resolve one turn of flow through a Distribution_Hub
 * (Req 11.3, 11.4, 11.5, 11.6, 11.7).
 *
 * The available quantity this turn is the hub's carried-over `buffer` plus the
 * `inflow` arriving from upstream (Req 11.4). It is disposed of by the following
 * policy, in order:
 *
 *   1. **Distribute across outgoing routes.** The total distributed is
 *      `min(available, Σ outgoingCaps)` (Req 11.4). That total is filled onto the
 *      outgoing routes **in order**, each route taking up to (but never more than)
 *      its own capacity (Req 11.5), until the distributed total is exhausted. The
 *      returned `amounts` are aligned index-for-index to `outgoingCaps`, each
 *      `<= its cap`, and sum to `distributedTotal`.
 *   2. **Buffer the remainder.** Whatever of `available` was not distributed
 *      (because combined capacity was the binding constraint) is held in the hub's
 *      buffer up to `HUB_STORAGE_CAPACITY`, so `newBuffer <= HUB_STORAGE_CAPACITY`
 *      (Req 11.3, 11.6).
 *   3. **Leave the rest upstream.** Anything that fits neither a route nor the
 *      buffer (the buffer is full) is left at the upstream source and is *not*
 *      discarded (Req 11.7).
 *
 * Conservation is exact — every unit of `buffer + inflow` is accounted for as
 * exactly one of distributed, buffered, or left upstream:
 *   `distributedTotal + newBuffer + leftUpstream === buffer + inflow` (Req 11.7).
 *
 * Defensive clamping: `inflow`, the carried `buffer`, and each entry of
 * `outgoingCaps` are floored at `0`, so a negative caller value cannot corrupt the
 * accounting (a negative cap contributes `0` capacity and receives `0`). Pure:
 * reads only its arguments and returns a fresh `amounts` array; mutates nothing.
 *
 * @param hub The hub being resolved (its `buffer` is the carried-over quantity).
 * @param inflow The quantity arriving from upstream this turn (`>= 0`).
 * @param outgoingCaps The current Route_Capacity of each connected outgoing route,
 *   in the order the caller wants them filled.
 * @returns A {@link HubDistribution}: per-route `amounts`, `distributedTotal`,
 *   `newBuffer`, and `leftUpstream`, satisfying the Req 11 constraints above.
 */
export function distributeHub(
  hub: DistributionHub,
  inflow: number,
  outgoingCaps: number[],
): HubDistribution {
  const caps = outgoingCaps.map((c) => Math.max(0, c));
  const available = Math.max(0, hub.buffer) + Math.max(0, inflow);
  const totalCapacity = caps.reduce((acc, c) => acc + c, 0);

  // Req 11.4 — distribute min(available, Σ caps) across the outgoing routes.
  const distributedTotal = Math.min(available, totalCapacity);

  // Fill routes in order, each up to its own capacity (Req 11.5).
  let remainingToDistribute = distributedTotal;
  const amounts = caps.map((cap) => {
    const amount = Math.min(cap, remainingToDistribute);
    remainingToDistribute -= amount;
    return amount;
  });

  // Req 11.6 — buffer whatever was not distributed, up to HUB_STORAGE_CAPACITY.
  const undistributed = available - distributedTotal;
  const newBuffer = Math.min(undistributed, HUB_STORAGE_CAPACITY);

  // Req 11.7 — leave anything that fits neither a route nor the buffer upstream.
  const leftUpstream = undistributed - newBuffer;

  return { amounts, distributedTotal, newBuffer, leftUpstream };
}
