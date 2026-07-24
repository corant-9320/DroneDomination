/**
 * Client runtime world model — pure types + model-only helpers.
 *
 * No fetch calls, no storage access, no mutable singleton state, no JSON
 * parsing, no save migration. This module may import from `shared/**` only,
 * never `src/**` or `server/**` (enforced by `tsconfig.client.json` +
 * dependency-cruiser).
 *
 * The interfaces below mirror `shared/wireTypes.ts`, which is the single
 * source of truth for all compact wire shapes (WireTile, WireUnit,
 * WireBuilding, WireCity, CompactSave). Client-only runtime extensions to the
 * wire types (e.g. `bridge?: boolean` on tiles) are added via intersection
 * types below.
 */

import type {
  WireTile,
  WireUnit,
  WireBuilding,
  WireCity,
} from '../../shared/wireTypes.js';
import type {
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
} from '../../shared/logisticsTypes.js';

// ─── Public type aliases (preserve the existing names callers use) ────────────

/**
 * A tile in the client's working copy. Extends the wire shape with a runtime
 * `bridge` flag that is NOT part of the wire format — set by the client when
 * a player engineer builds a bridge over a river hex.
 */
export interface TileData extends WireTile {
  /** Runtime flag: a completed bridge task has made this tile crossable. */
  bridge?: boolean;
  /**
   * Runtime flag: this tile's forest has been cleared by a logistics engineer
   * task (Req 9.4). NOT part of the wire format — applied by the client from
   * `logistics.clearedForests` after loading, exactly as `bridge` is applied
   * from `save.bridges`. Lets the renderer draw the hex as cleared.
   */
  clearedForest?: boolean;
  /**
   * Oil deposit marker. `"oil"` marks an Oil_Deposit (Req 1.3), which the
   * logistics renderer draws pre-drill. Mirrors the authoritative
   * `Tile.resourceType` (`src/world/types.ts`) and is carried on the wire under
   * the identical field name (`WireTile.resourceType`), so it arrives with no
   * remap via `src/world/compact.ts::toCompactTile` and the `/api/world-tiles`
   * regeneration path. The renderer reads `tile.resourceType === 'oil'`.
   */
  resourceType?: string;
}

/** A unit in the client's working copy. Identical to the wire shape. */
export type UnitData = WireUnit;

/** A building in the client's working copy. Identical to the wire shape. */
export type BuildingData = WireBuilding;

/** A city in the client's working copy. Identical to the wire shape. */
export type CityData = WireCity;

// ─── Logistics mirror aliases ─────────────────────────────────────────────────
//
// The Oil Logistics System's wire shapes ARE its authoritative shapes (a straight
// field copy, exactly like WireUnit/WireBuilding), so the client mirrors them by
// re-exporting the shared types directly rather than re-declaring them here. The
// renderer reads these off `WorldData.logistics`. `Transport` carries its `tier`
// ('van' | 'truck' | 'juggernaut') for model selection (Req 14).
export type {
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
};

export interface WorldData {
  seed: number;
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
  pentagonIndices: number[];
  cities: CityData[];
  tiles: TileData[];
  units: UnitData[];
  /** Buildings constructed in cities. */
  buildings: BuildingData[];
  /**
   * Planned (not-yet-built) buildings from the City Design planner. Runtime
   * only — rendered greyed out. Persisted separately per seed via cityPlan.ts,
   * not part of the authoritative save.
   */
  plannedBuildings?: BuildingData[];
  /** Player-chosen faction color (hex string). */
  playerColor?: string;
  /**
   * Optional tile index to centre the camera on at startup.
   * Used by battle scenarios to focus on the gap between armies.
   */
  battleCentreTile?: number;
  /**
   * Oil Logistics System state overlay (wells, refineries, routes, transports,
   * hubs, home stocks, tasks, and terrain/standalone-road overlays). Copied
   * straight through from `CompactSave.logistics` on load — wire shapes ===
   * authoritative shapes, so no field remapping is needed. Optional so saves
   * without logistics still load. The logistics renderer reads its entities
   * from here; the `logistics.bridges`/`logistics.clearedForests` index
   * overlays are additionally applied onto tiles by `client/world/expand.ts`.
   */
  logistics?: LogisticsState;
}

/**
 * Create a synthetic UnitData from a BuildingData for use in combat preview
 * and attack resolution. Buildings are treated as stationary "units" with
 * size 1, full health, and their own weapon/defence attributes.
 */
export function buildingAsAttackerUnit(building: BuildingData): UnitData {
  const attrs = building.attributes ?? {};
  return {
    id: building.id,
    label: `Building #${building.id.replace(/^building_/, '')}`,
    ownerId: building.ownerId,
    tileIndex: building.tileIndex,
    segment: building.segment,
    facing: building.segment, // buildings face outward from their segment
    attributes: { ...attrs, size: attrs.size ?? 1 },
    currentHealth: (attrs.size ?? 1) * 10, // buildings are always "full health" for attack purposes
  };
}
