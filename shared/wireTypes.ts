/**
 * Wire-format types — single source of truth for the compact JSON exchanged
 * between server and client.
 *
 * Previously these were duplicated in two places:
 *   src/world/compact.ts      — CompactTile / CompactUnit / CompactBuilding
 *   client/worldData.ts       — TileData / UnitData / BuildingData / CityData
 *
 * Both halves described the same shapes under different names. Any field
 * rename required a synchronised edit in both files with no compiler safety.
 * This module is the authoritative definition; both sides import from here.
 *
 * ── Field-name mapping (authoritative model → wire field) ───────────────────
 *   Tile (src/world/types.ts)       → WireTile (here)
 *     index            → idx
 *     sides            → s
 *     neighbours       → n
 *     position3d {x,y,z} → pos [x,y,z]
 *     boundary [{x,y,z}] → b  [[x,y,z]]
 *     terrainType      → terrain
 *     height           → h
 *     forested         → f            (omitted when false)
 *     riverTo          → rv           (omitted when absent)
 *     cityId           → city         (omitted when absent)
 *     resourceType     → resourceType (identical name; omitted when absent)
 *
 *   Unit (src/world/units.ts)       → WireUnit (here)
 *     (all field names are identical to the authoritative model)
 *
 *   Building (src/world/types.ts)   → WireBuilding (here)
 *     (all field names are identical to the authoritative model)
 *
 * ── Runtime-only client fields ───────────────────────────────────────────────
 * Some fields exist only in the client's working copy of a tile and are NOT
 * part of the wire format. They are added by the client after loading:
 *   bridge?: boolean   — set when a player engineer has built a bridge here
 *
 * ── Save format ──────────────────────────────────────────────────────────────
 * The compact save format (CompactSave) omits tiles entirely — the client
 * regenerates them from the seed via POST /api/world-tiles. Only
 * cities + units + buildings + metadata travel in a save.
 */

import type { UnitAttributes } from './unitTypes.js';
import type { LogisticsState } from './logisticsTypes.js';

// ─── Tile ─────────────────────────────────────────────────────────────────────

/** Compact tile as sent over the wire or stored in world.json. */
export interface WireTile {
  idx: number;
  s: 5 | 6;
  n: number[];
  pos: [number, number, number];
  /** Ordered boundary polygon vertices [[x,y,z], ...] */
  b: [number, number, number][];
  terrain: string;
  /** Discrete terrain height 0–11. Omitted when 0 (ocean/sea-level). */
  h?: number;
  /** Whether this tile has forest cover. Omitted when false. */
  f?: boolean;
  /** Downstream neighbour tile index a river flows toward (toward the sea). Omitted when absent. */
  rv?: number;
  /** City id for tiles that are the capital of a city. Omitted when absent. */
  city?: string;
  /**
   * Resource marker for the authoritative `Tile.resourceType`. `"oil"` marks an
   * Oil_Deposit (Req 1.3), which the logistics renderer draws pre-drill. Field
   * name matches the authoritative model (like WireUnit/WireBuilding), so the
   * client reads it with no remap. Omitted when absent.
   */
  resourceType?: string;
  /**
   * Per-segment steepness in radians (segSteep). One entry per side. Values are
   * rounded to 4 decimals on the wire. Omitted only for tiles that have no
   * computed steepness (never the case for generated worlds).
   */
  ss?: number[];
}

// ─── Unit ─────────────────────────────────────────────────────────────────────

/** Compact unit as sent over the wire. Field names match the authoritative Unit model. */
export interface WireUnit {
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: 0 | 1 | 2 | 3 | 4 | 5;
  facing: 0 | 1 | 2 | 3 | 4 | 5;
  attributes: UnitAttributes;
  currentHealth: number;
}

// ─── Building ─────────────────────────────────────────────────────────────────

/**
 * Compact building as sent over the wire.
 * An immobile full-segment occupant on a city hex.
 */
export interface WireBuilding {
  id: string;
  ownerId: string;
  tileIndex: number;
  segment: 0 | 1 | 2 | 3 | 4 | 5;
  /**
   * Optional equipment loadout. Only combat/support attributes apply
   * (movement and engineering are ignored for buildings). Omitted when absent.
   */
  attributes?: UnitAttributes;
}

// ─── City ─────────────────────────────────────────────────────────────────────

/** City descriptor as sent over the wire. */
export interface WireCity {
  id: string;
  label: string;
  tileIndex: number;
  neighbourCityIds: string[];
  /** True if this is the player's home city. Omitted when false. */
  isPlayerHome?: boolean;
  /** Owning faction id (defaults to the city's own id). */
  ownerId?: string;
  /** Hex indices this city owns (capital + every built-on hex). */
  ownedHexes?: number[];
}

// ─── Full world payload ───────────────────────────────────────────────────────

/** Full compact world payload sent over the wire (used for world.json). */
export interface WireWorld {
  seed: number;
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
  pentagonIndices: number[];
  cities: WireCity[];
  units: WireUnit[];
  buildings: WireBuilding[];
  tiles: WireTile[];
  /**
   * Oil Logistics System state overlay. Wire shapes === authoritative shapes
   * (straight field copy), so the payload is `LogisticsState` directly. Optional
   * so existing wire consumers and world.json without logistics still parse.
   * Mirrors the `bridges` overlay pattern in `CompactSave`.
   */
  logistics?: LogisticsState;
}

// ─── Compact save format ──────────────────────────────────────────────────────

/**
 * Current compact-save schema version (Phase 3 — versioned save contracts).
 *
 * Bump this, and add a migration step in `client/world/codec.ts`, whenever the
 * persisted shape changes in a way older saves can't be read as-is. Saves
 * written before this field existed are "legacy version 0" — an input-only
 * shape recognized and migrated by the codec, never written back out.
 */
export const COMPACT_SAVE_FORMAT_VERSION = 1 as const;

/**
 * Compact save format — omits tiles (regenerated from seed on load).
 * Used by localStorage saves and bundled battle scenarios.
 *
 * `formatVersion` is always present on saves this client writes. Legacy saves
 * on disk may omit it (implicit version 0); `client/world/codec.ts` migrates
 * them to this shape at load time — see `decodeCompactSave`.
 */
export interface CompactSaveV1 {
  format: 'compact';
  formatVersion: 1;
  seed: number;
  cities: WireCity[];
  units: WireUnit[];
  /** Buildings constructed in cities. */
  buildings?: WireBuilding[];
  /** Player-chosen faction color (hex string). */
  playerColor?: string;
  /**
   * Optional tile index to centre the camera on at startup.
   * Used by battle scenarios to focus on the gap between armies.
   */
  battleCentreTile?: number;
  /** Tile indices where the player has built bridges (re-applied after tile regen). */
  bridges?: number[];
  /**
   * Oil Logistics System state overlay (wells, refineries, routes, transports,
   * hubs, home stocks, tasks, and cleared-forest/bridge overlays). Wire shapes
   * === authoritative shapes, so the payload is `LogisticsState` directly.
   * Optional — mirrors the `bridges` overlay pattern — so existing saves without
   * logistics still load.
   */
  logistics?: LogisticsState;
}

/**
 * `CompactSave` names the *current* schema version, so existing imports of
 * `CompactSave` continue to mean "a valid, current-format save" without
 * callers needing to know a version number exists. There is no separate v0
 * interface — legacy input is validated/migrated dynamically by the codec
 * (`client/world/codec.ts::decodeCompactSave`), not typed here.
 */
export type CompactSave = CompactSaveV1;

// ─── Tile-regeneration response (POST /api/world-tiles) ───────────────────────

/**
 * Shape of the JSON response from `POST /api/world-tiles`, shared so the
 * server handler (`server/regenerate.ts`) and the client's runtime validator
 * (`client/world/tilesClient.ts`) stay statically in sync. Static typing here
 * does not replace the client's runtime validation of the actual response.
 */
export interface WorldTilesResponse {
  tiles: WireTile[];
  pentagonIndices: number[];
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
  /** Cities as generated (before any filtering by scenario). Not currently consumed by the client. */
  cities?: { id: string; label: string; tileIndex: number; neighbourCityIds: string[] }[];
}
