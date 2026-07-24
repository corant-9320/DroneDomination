/**
 * Extraction, refining & economy — Oil Logistics System (Req 3, 4.4–4.7, 5, 6.9).
 *
 * Every function here is PURE: it never mutates its input and always returns a
 * new object. Stored Oil is an integer >= 0, bounded above by the well's fixed
 * WELL_STORAGE_CAPACITY (Req 3.2, 3.6). Refined_Product is the sole construction
 * currency (Req 5.1) and is bounded to [0, HOME_CITY_REFINED_PRODUCT_MAX] (Req 5.5);
 * delivered raw Oil accrues separately with no stated maximum (Req 6.9).
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import {
  CONVERSION_RATIO,
  EXTRACTION_RATE,
  HOME_CITY_REFINED_PRODUCT_MAX,
  REFINERY_THROUGHPUT_RATE,
  WELL_STORAGE_CAPACITY,
} from '../../../shared/logisticsConstants.js';
import type { HomeStock, OilWell, Refinery } from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Extraction & storage (Req 3)
// ---------------------------------------------------------------------------

/**
 * Run one turn of extraction for an operational Oil_Well (Req 3.1, 3.2, 3.3).
 *
 * Increases the well's stored Oil by EXTRACTION_RATE, clamping the result to the
 * fixed WELL_STORAGE_CAPACITY so it never overflows: once storage reaches the cap
 * the well holds at the cap and accrues nothing further until Oil is removed
 * (Req 3.3). Pure — returns a new well and never mutates the input (Req 3.6).
 *
 * @param well The operational well extracting this turn.
 * @returns A new well with `storedOil` increased by EXTRACTION_RATE, clamped to
 *          WELL_STORAGE_CAPACITY.
 */
export function extract(well: OilWell): OilWell {
  const storedOil = Math.min(well.storedOil + EXTRACTION_RATE, WELL_STORAGE_CAPACITY);
  return { ...well, storedOil };
}

/**
 * Remove Oil from an Oil_Well for transport (Req 3.4, 3.5).
 *
 * For a valid request — `0 < qty <= well.storedOil` — returns a success result:
 * a new well whose `storedOil` is decreased by `qty`, together with the `removed`
 * amount (Req 3.4).
 *
 * For an invalid request — `qty <= 0`, or `qty > well.storedOil` — returns an
 * `Error` (rather than throwing) so callers can branch, leaving the well's stored
 * Oil unchanged (Req 3.5). Returning an `Error` object matches the design's
 * declared `{ well: OilWell; removed: number } | Error` return type; callers use
 * `result instanceof Error` to detect the rejection.
 *
 * Pure — never mutates the input well.
 *
 * @param well The well to draw from.
 * @param qty The requested quantity to remove.
 * @returns `{ well, removed }` on success, or an `Error` on an invalid/insufficient
 *          request (well left unchanged).
 */
export function removeOil(
  well: OilWell,
  qty: number,
): { well: OilWell; removed: number } | Error {
  if (!Number.isFinite(qty) || qty <= 0) {
    return new Error(`Cannot remove a non-positive quantity of oil (requested ${qty}).`);
  }
  if (qty > well.storedOil) {
    return new Error(
      `Insufficient stored oil: requested ${qty} but only ${well.storedOil} available.`,
    );
  }
  return { well: { ...well, storedOil: well.storedOil - qty }, removed: qty };
}

// ---------------------------------------------------------------------------
// Refining (Req 4.4–4.7)
//
// Both functions are PURE: `refine` never mutates its input refinery and always
// returns a new object. Raw heldOil and refinedProductAvailable are integers >= 0.
// ---------------------------------------------------------------------------

/**
 * The maximum raw Oil a Refinery can process in one turn (its throughput), scaling
 * linearly with the number of Refinery_Segments it occupies (Req 4.4).
 *
 * Throughput = segmentCount * REFINERY_THROUGHPUT_RATE, so a one-segment refinery
 * processes REFINERY_THROUGHPUT_RATE oil/turn and each added segment raises the cap
 * by the same amount.
 *
 * @param segmentCount The number of Refinery_Segments (`refinery.segments.length`).
 * @returns The per-turn oil-processing capacity.
 */
export function refineryThroughput(segmentCount: number): number {
  return segmentCount * REFINERY_THROUGHPUT_RATE;
}

/**
 * Run one turn of refining for a Refinery (Req 4.5, 4.6, 4.7).
 *
 * Consumes `min(throughput, heldOil)` raw Oil this turn — where `throughput =
 * refineryThroughput(refinery.segments.length)` — decrementing `heldOil` by the
 * consumed amount and adding `floor(consumed * CONVERSION_RATIO)` to
 * `refinedProductAvailable` (Req 4.5, 4.6). The `floor` keeps Refined_Product an
 * integer.
 *
 * When `heldOil === 0` the consumed amount is 0, so this is a no-op: `heldOil`
 * stays at 0 and zero product is produced (Req 4.7).
 *
 * Pure — returns a new Refinery and never mutates the input.
 *
 * @param refinery The refinery processing this turn.
 * @returns A new refinery with `heldOil` reduced and `refinedProductAvailable`
 *          increased by the floored conversion of the consumed oil.
 */
export function refine(refinery: Refinery): Refinery {
  const throughput = refineryThroughput(refinery.segments.length);
  const consumed = Math.min(throughput, refinery.heldOil);
  return {
    ...refinery,
    heldOil: refinery.heldOil - consumed,
    refinedProductAvailable:
      refinery.refinedProductAvailable + Math.floor(consumed * CONVERSION_RATIO),
  };
}

// ---------------------------------------------------------------------------
// Economy: construction charging & home accrual (Req 5, 6.9)
//
// All four helpers are PURE: they never mutate the input HomeStock and always
// return a new object. Refined_Product is the sole construction currency (Req 5.1)
// and is bounded to [0, HOME_CITY_REFINED_PRODUCT_MAX] (Req 5.5); delivered raw
// Oil accrues separately with no stated maximum (Req 6.9).
// ---------------------------------------------------------------------------

/**
 * Whether the Home_City holds enough Refined_Product to pay `cost` (Req 5.2, 5.3).
 *
 * Concrete Construction_Costs are integers >= 1 (Req 5.6); a cost of `0` is the
 * special no-charge case (clearing a Forest_Tile costs only turns, Req 5.9), which
 * is always affordable. Affordability is therefore `cost <= home.refinedProduct`,
 * which is trivially true for `cost === 0`.
 *
 * Pure — reads only the stock and the cost.
 *
 * @param home The paying faction's Home_City stock.
 * @param cost The item's Construction_Cost in Refined_Product units.
 * @returns `true` iff the cost can be paid from stored Refined_Product.
 */
export function canAfford(home: HomeStock, cost: number): boolean {
  return cost <= home.refinedProduct;
}

/**
 * Debit exactly `cost` Refined_Product from the Home_City to pay for a construction
 * or upgrade (Req 5.1, 5.2, 5.3). Only `refinedProduct` is charged — raw Oil is
 * never a construction currency (Req 5.1).
 *
 * Assumes the caller has already checked `canAfford`; as a defensive measure the
 * result is clamped to `>= 0` so an over-charge can never drive the stock negative
 * (Req 5.5 — stored Refined_Product is always an integer >= 0). Pure — returns a
 * new HomeStock and never mutates the input.
 *
 * @param home The paying faction's Home_City stock.
 * @param cost The Construction_Cost to debit.
 * @returns A new HomeStock with `refinedProduct` reduced by `cost`, clamped to `>= 0`.
 */
export function chargeConstruction(home: HomeStock, cost: number): HomeStock {
  return { ...home, refinedProduct: Math.max(0, home.refinedProduct - cost) };
}

/**
 * Accrue delivered Refined_Product at the Home_City (Req 5.4, 5.5, 5.7).
 *
 * Adds `qty` to stored Refined_Product, clamping the result to the
 * HOME_CITY_REFINED_PRODUCT_MAX ceiling and discarding any overflow — arriving
 * product that would raise the stock above the maximum is dropped, not retained
 * (Req 5.7). Pure — returns a new HomeStock and never mutates the input.
 *
 * @param home The receiving faction's Home_City stock.
 * @param qty The arriving quantity of Refined_Product (integer >= 0).
 * @returns A new HomeStock with `refinedProduct` increased by `qty`, clamped to
 *          HOME_CITY_REFINED_PRODUCT_MAX.
 */
export function accrueRefinedProduct(home: HomeStock, qty: number): HomeStock {
  const refinedProduct = Math.min(home.refinedProduct + qty, HOME_CITY_REFINED_PRODUCT_MAX);
  return { ...home, refinedProduct };
}

/**
 * Accrue delivered raw Oil at the Home_City (Req 6.9).
 *
 * Adds `qty` to stored Oil. Unlike Refined_Product there is no stated Home_City
 * maximum on raw Oil, so this is a simple non-negative add. Pure — returns a new
 * HomeStock and never mutates the input.
 *
 * @param home The receiving faction's Home_City stock.
 * @param qty The arriving quantity of raw Oil (integer >= 0).
 * @returns A new HomeStock with `oil` increased by `qty`.
 */
export function accrueOil(home: HomeStock, qty: number): HomeStock {
  return { ...home, oil: home.oil + qty };
}
