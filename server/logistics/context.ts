/**
 * Shared helpers for the logistics intent appliers (Oil Logistics System — server side).
 *
 * Every applier module in `server/logistics/` depends on these: building the
 * read-only engine context, resolving the acting faction's Home_City stock,
 * detecting main-game building collisions the pure engine cannot see, resolving
 * the acting engineer unit, and resolving a route endpoint descriptor from a
 * structure id. Also holds the entity-init constants shared by multiple appliers
 * and the uniform `LogisticsApplyResult` shape + id generator.
 *
 * Layering: `server/` may import from `src/` and `shared/` (only the client is
 * forbidden from importing `src/`/`server/`).
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import type { Tile } from '../../src/world/types.js';
import { TRANSPORT_CARGO_MAX } from '../../shared/logisticsConstants.js';
import type { MatchState } from '../../shared/matchTypes.js';
import type {
  EngineerUnitRef,
  HomeStock,
  LogisticsContext,
} from '../../shared/logisticsTypes.js';
import { canAfford, chargeConstruction } from '../../src/world/logistics/production.js';
import type { RouteEndpoint, RouteEndpointKind } from '../../src/world/logistics/routes.js';

// ---------------------------------------------------------------------------
// Structure/transport initialisation constants
//
// These are entity-init values (not Construction_Cost, and not balance-formula
// outputs), so they live here as named constants rather than pinned literals.
// ---------------------------------------------------------------------------

/**
 * Hit points every applier-built structure (well/refinery/hub) starts with. Kept
 * within the combat HP domain `[1, 50]` that `applyDamage` clamps into (see
 * docs/architecture/known-issues.md and `src/world/logisticsSeed.ts`), so a value
 * `> 50` would be silently clamped on the first hit. Matches `SEED_STRUCTURE_HP`.
 */
export const STRUCTURE_MAX_HIT_POINTS = 40;

/** A freshly purchased Transportation_Unit's cargo capacity (`TRANSPORT_CARGO_MIN..MAX`). */
export const INITIAL_TRANSPORT_CARGO_CAPACITY = TRANSPORT_CARGO_MAX;
/** A freshly purchased Transportation_Unit's movement speed (upgradeable, Req 8.4). */
export const INITIAL_TRANSPORT_SPEED = 1;
/** A freshly purchased Transportation_Unit's defensive strength (upgradeable, Req 8.4). */
export const INITIAL_TRANSPORT_DEFENCE = 1;

// ---------------------------------------------------------------------------
// Applier result + id generation
// ---------------------------------------------------------------------------

/**
 * The uniform applier return shape (mirrors `matchApi.ts`'s appliers): an `error`
 * string means the intent was rejected and no state was changed.
 */
export interface LogisticsApplyResult {
  error?: string;
}

let idCounter = 0;

/** Generate a process-unique id for a new logistics entity/task. */
export function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the read-only engine context from authoritative tiles + logistics state. */
export function makeCtx(state: MatchState, tiles: Tile[]): LogisticsContext {
  return { tiles, state: state.logistics };
}

/**
 * The acting faction's Home_City stock, or a fresh zero-stock when it has none yet.
 * Non-mutating: never writes into `state.logistics.home`, so calling it during a
 * rejection path leaves state untouched. Callers store the charged result back
 * explicitly on the success path.
 */
export function getHome(state: MatchState, faction: string): HomeStock {
  return state.logistics.home[faction] ?? { factionId: faction, refinedProduct: 0, oil: 0 };
}

/** Server-controlled policy for paid logistics construction and upgrades. */
export interface ConstructionCostPolicy {
  readonly waiveRefinedProductCosts: boolean;
}

/** Normal gameplay economics: construction requires and spends Refined_Product. */
export const ENFORCE_CONSTRUCTION_COSTS: ConstructionCostPolicy = { waiveRefinedProductCosts: false };

/** Development God Mode economics: paid logistics actions preserve home stock. */
export const WAIVE_CONSTRUCTION_COSTS: ConstructionCostPolicy = { waiveRefinedProductCosts: true };

/** Server-controlled policy for every authoritative logistics intent. */
export interface LogisticsIntentPolicy extends ConstructionCostPolicy {
  readonly allowRemoteTerrainTasks: boolean;
}

/** Normal gameplay policy: charge costs and require a real engineer. */
export const ENFORCE_LOGISTICS_POLICY: LogisticsIntentPolicy = {
  waiveRefinedProductCosts: false,
  allowRemoteTerrainTasks: false,
};

/** Development God Mode: free construction and terrain tasks without a unit. */
export const GOD_MODE_LOGISTICS_POLICY: LogisticsIntentPolicy = {
  waiveRefinedProductCosts: true,
  allowRemoteTerrainTasks: true,
};

/**
 * Validate and charge a paid construction action without mutating its input.
 * Undefined means the player cannot afford it under the supplied server policy.
 */
export function chargeConstructionCost(
  home: HomeStock,
  cost: number,
  policy: ConstructionCostPolicy,
): HomeStock | undefined {
  if (policy.waiveRefinedProductCosts) return home;
  if (!canAfford(home, cost)) return undefined;
  return chargeConstruction(home, cost);
}

/** Whether an ordinary main-game building occupies `tileIndex:segment`. */
export function buildingOccupies(state: MatchState, tileIndex: number, segment: number): boolean {
  return state.buildings.some((b) => b.tileIndex === tileIndex && b.segment === segment);
}

/** Whether any main-game building sits on `tileIndex` (any segment). */
export function buildingOnTile(state: MatchState, tileIndex: number): boolean {
  return state.buildings.some((b) => b.tileIndex === tileIndex);
}

/** Resolve the acting engineer unit and adapt it to the engine's `EngineerUnitRef`. */
export function resolveEngineer(
  state: MatchState,
  unitId: string,
  activeFaction: string,
): { ref: EngineerUnitRef } | { error: string } {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { error: 'Acting unit not found' };
  if (unit.ownerId !== activeFaction) return { error: "Not this faction's unit" };
  return {
    ref: {
      id: unit.id,
      ownerId: unit.ownerId,
      tileIndex: unit.tileIndex,
      segment: unit.segment,
      attributes: unit.attributes,
    },
  };
}

/** Whether a unit's attributes make it an Engineer_Unit (engineer 1..5). Req 2.2/9.6/10.6. */
export function hasEngineer(ref: EngineerUnitRef): boolean {
  const engineer = ref.attributes.engineer ?? 0;
  return Number.isInteger(engineer) && engineer >= 1 && engineer <= 5;
}

/** Resolve a route endpoint descriptor from a structure id (well/refinery/home-city). */
export function resolveEndpoint(
  state: MatchState,
  tiles: Tile[],
  structureId: string,
): RouteEndpoint | null {
  const well = state.logistics.wells.find((w) => w.id === structureId);
  if (well) {
    return { structureId, kind: 'well', tileIndex: well.tileIndex, ownerId: well.ownerId };
  }
  const refinery = state.logistics.refineries.find((r) => r.id === structureId);
  if (refinery) {
    return {
      structureId,
      kind: 'refinery',
      tileIndex: refinery.tileIndex,
      ownerId: refinery.ownerId,
    };
  }
  const hub = state.logistics.hubs.find((h) => h.id === structureId);
  if (hub) {
    return { structureId, kind: 'hub', tileIndex: hub.tileIndex, ownerId: hub.ownerId };
  }
  // Home_City: the tile carrying this city id (set by placeCities). Its owner is
  // the tile's ownerId, defaulting to the structure id (a city id == faction id).
  const cityTileIndex = tiles.findIndex((t) => t && t.cityId === structureId);
  if (cityTileIndex >= 0) {
    const kind: RouteEndpointKind = 'home-city';
    return {
      structureId,
      kind,
      tileIndex: cityTileIndex,
      ownerId: tiles[cityTileIndex].ownerId ?? structureId,
    };
  }
  return null;
}
