/**
 * Empty Logistics State factory — Oil Logistics System.
 *
 * `generateWorld` attaches an empty `LogisticsState` to every world so
 * `World.logistics` is always present. No world seed ever ships with pre-built
 * oil infrastructure (wells, refineries, hubs, routes, transports) — every seed,
 * including any development/test seed, starts with an empty logistics state.
 * Oil_Deposit tiles are placed unconditionally by `logisticsGen.ts` regardless
 * of seed; only built structures are excluded.
 *
 * Named exports only — no default export.
 */

import type { LogisticsState } from '../../shared/logisticsTypes.js';

/** A fresh, empty `LogisticsState`. */
export function createEmptyLogisticsState(): LogisticsState {
  return {
    wells: [],
    refineries: [],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}
