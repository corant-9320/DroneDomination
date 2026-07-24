/**
 * Combat Integration — structures & transports gain hit points (Req 12.4–12.8).
 *
 * Logistics structures (Oil_Well, Refinery, Distribution_Hub, Road, Bridge) carry
 * a Hit_Points pool and ARE destroyed at zero HP (Req 12.4, 12.6) — unlike main-game
 * buildings, which take component damage and are never destroyed. The Req 12 glossary
 * defines Hit_Points as "the integer amount of combat damage a destroyable structure
 * can absorb before it is destroyed, tracked and reduced by the existing unit combat
 * model", so a structure's HP shares the unit combat model's HP domain and is reduced
 * with the very same `applyDamage` primitive that reduces a unit's health.
 *
 * Combat pipeline reuse (design §4): the attacker→structure damage magnitude is
 * produced by the SAME `computeDamage` pipeline used for units — armour and
 * EW/terrain read from the structure's `attributes` and its tile — before it reaches
 * this module. That computation needs a full `CombatContext` (units/tiles/buildings)
 * which is not available to a bare, pure structure attack, so the server combat
 * resolver (the caller) runs `computeDamage(...)` with the structure's `attributes`
 * and passes the resulting `damage` number here. `attackStructure` then applies that
 * damage to the HP pool via the combat model's own `applyDamage`, so the numbers stay
 * consistent with the unit combat rules and are never re-derived with pinned balance
 * values (there are no balance numbers in this module).
 *
 * `applyDamage` (src/world/combat.ts → combatFormula.ts) enforces exactly the two
 * combat-model HP invariants a structure needs: a minimum of 1 applied damage (a weak
 * hit is never wasted) and HP never dropping below 0. It also clamps into the unit
 * combat HP domain of [0, 50]; per the glossary a structure's Hit_Points live in that
 * same domain, so a structure's `maxHitPoints` must be a positive integer within
 * [1, 50] (see the enduring gotcha recorded in docs/architecture/known-issues.md).
 *
 * Every function here is PURE: it never mutates its inputs and always returns new
 * values, matching the rest of this engine. Destruction *consequences* (Req 12.7,
 * 12.8) are returned as data / applied by companion pure helpers, so the orchestrator
 * (task 9.1) applies them to `LogisticsState` without this module touching global
 * state.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { applyDamage } from '../combat.js';
import type { UnitAttributes } from '../../../shared/unitTypes.js';
import type {
  DistributionHub,
  LogisticsRoute,
  OilWell,
  Refinery,
} from '../../../shared/logisticsTypes.js';

/**
 * A destroyable logistics structure with a Hit_Points pool (design §4, verbatim):
 * an Oil_Well, a Refinery, a Distribution_Hub, a Road, or a Bridge (Req 12.4).
 *
 * `attributes` carries the optional armour/defence the damage formula reads; it is
 * consumed by the caller's `computeDamage` pass (which needs the full combat context)
 * rather than by `attackStructure`, which applies the already-computed damage to the
 * HP pool. `segment` identifies the occupied segment for wells/refinery-segments and
 * is absent for a whole-tile Road/Bridge.
 */
export interface HpStructure {           // Oil_Well, Refinery, Distribution_Hub, Road, Bridge
  id: string;
  kind: 'well' | 'refinery' | 'hub' | 'road' | 'bridge';
  ownerId: string;                        // Structure_Owner (Req 12.1)
  tileIndex: number;
  segment?: number;                       // wells/refinery-segments; absent for whole-tile road/bridge
  hitPoints: number;                      // current HP, integer > 0 while alive (Req 12.4)
  maxHitPoints: number;
  attributes?: UnitAttributes;            // optional armour/defence for the damage formula
}

/**
 * Apply combat damage to a structure using the existing unit combat model
 * (Req 12.5, 12.6).
 *
 * Reduces the structure's Hit_Points by the incoming `damage` using the combat
 * model's own `applyDamage` (re-exported from `src/world/combat.ts`, defined in
 * `combatFormula.ts`) — the SAME primitive that reduces a unit's health. This keeps
 * structure damage consistent with unit combat (minimum 1 applied damage, HP clamped
 * to `>= 0`) and re-derives no balance numbers: the `damage` argument is the output of
 * the caller's `computeDamage` pass (armour/EW/terrain from the structure's
 * `attributes` and tile — see the module note above). The structure is destroyed when
 * its Hit_Points reach zero (Req 12.6); the orchestrator then removes it from play and
 * applies the destruction consequence for its `kind` (Req 12.7/12.8 — see
 * {@link dropWellResources}/{@link dropRefineryResources}/{@link dropHubResources} and
 * {@link markRoutesInoperable}).
 *
 * Pure — returns a new structure and never mutates the input.
 *
 * @param struct The structure being attacked.
 * @param damage The already-computed incoming damage (from the unit combat pipeline).
 * @returns `{ struct, destroyed }` — a new structure with reduced Hit_Points and the
 *   destroyed flag (`true` iff Hit_Points reached zero).
 */
export function attackStructure(
  struct: HpStructure,
  damage: number,
): { struct: HpStructure; destroyed: boolean } {
  const hitPoints = applyDamage(struct.hitPoints, damage);
  return { struct: { ...struct, hitPoints }, destroyed: hitPoints <= 0 };
}

/**
 * The Oil and Refined_Product a destroyed structure removes from play (Req 12.7).
 * Every field is a non-negative integer; unused fields are `0` for a given structure
 * kind (e.g. a well drops only raw `oil`). The orchestrator uses these amounts for
 * `structure-destroyed` events; the commodities are discarded, delivered nowhere.
 */
export interface DestroyedResourceDrop {
  /** Raw Oil removed from play (an Oil_Well's stored oil, a Refinery's held oil). */
  oil: number;
  /** Refined_Product removed from play (a Refinery's available product). */
  product: number;
  /** Combined Oil + Refined_Product removed from play (a Distribution_Hub's buffer, a single pool). */
  combined: number;
}

/**
 * Remove a destroyed Oil_Well's stored Oil from play (Req 12.7).
 *
 * Returns a new well with `storedOil === 0` and the dropped `oil` amount (the well's
 * former stored oil), so none of it is delivered anywhere. Pure — never mutates the
 * input well. The orchestrator calls this when {@link attackStructure} reports a
 * destroyed `well` before removing the well from state.
 */
export function dropWellResources(well: OilWell): { well: OilWell; dropped: DestroyedResourceDrop } {
  return {
    well: { ...well, storedOil: 0 },
    dropped: { oil: well.storedOil, product: 0, combined: well.storedOil },
  };
}

/**
 * Remove a destroyed Refinery's held raw Oil and available Refined_Product from play
 * (Req 12.7).
 *
 * Returns a new refinery with both `heldOil` and `refinedProductAvailable` zeroed and
 * the dropped amounts (`oil` = former held oil, `product` = former available product).
 * Pure — never mutates the input refinery.
 */
export function dropRefineryResources(
  refinery: Refinery,
): { refinery: Refinery; dropped: DestroyedResourceDrop } {
  return {
    refinery: { ...refinery, heldOil: 0, refinedProductAvailable: 0 },
    dropped: {
      oil: refinery.heldOil,
      product: refinery.refinedProductAvailable,
      combined: refinery.heldOil + refinery.refinedProductAvailable,
    },
  };
}

/**
 * Remove a destroyed Distribution_Hub's buffered commodities from play (Req 12.7).
 *
 * A hub's buffer is a single combined Oil + Refined_Product pool (Req 11.3), so the
 * dropped quantity is reported in `combined`; the `oil`/`product` split is not tracked
 * on the buffer and is therefore `0`. Returns a new hub with `buffer === 0`. Pure —
 * never mutates the input hub.
 */
export function dropHubResources(
  hub: DistributionHub,
): { hub: DistributionHub; dropped: DestroyedResourceDrop } {
  return {
    hub: { ...hub, buffer: 0 },
    dropped: { oil: 0, product: 0, combined: hub.buffer },
  };
}

/**
 * Mark every Logistics_Route that uses a destroyed Road/Bridge Route_Segment as
 * inoperable (Req 12.8).
 *
 * When a Road or Bridge on tile `destroyedTileIndex` is destroyed, every route whose
 * `segments` include that tile can no longer carry cargo until the segment is repaired
 * or the route is rerouted along an intact path. Returns a new routes array with those
 * routes' `operable` set to `false` (routes not using the tile, and already-inoperable
 * routes, are returned unchanged by reference) plus the ids of the routes that use the
 * destroyed segment (for `route-inoperable` events). Pure — never mutates the input
 * array or its routes.
 *
 * @param routes All Logistics_Routes in play.
 * @param destroyedTileIndex The tile index of the destroyed Road/Bridge Route_Segment.
 * @returns `{ routes, affectedRouteIds }` — the updated routes and the ids of every
 *   route that used the destroyed Route_Segment.
 */
export function markRoutesInoperable(
  routes: readonly LogisticsRoute[],
  destroyedTileIndex: number,
): { routes: LogisticsRoute[]; affectedRouteIds: string[] } {
  const affectedRouteIds: string[] = [];
  const next = routes.map((route) => {
    // Route segments are encoded keys (tileIndex * 6 + segment); decode to check tile.
    const uses = route.segments.some((key) => Math.floor(key / 6) === destroyedTileIndex);
    if (!uses) return route;
    affectedRouteIds.push(route.id);
    return route.operable ? { ...route, operable: false } : route;
  });
  return { routes: next, affectedRouteIds };
}
