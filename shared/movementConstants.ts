/**
 * Shared movement constants and pure movement helpers.
 *
 * Used by both:
 *   - src/world/movement.ts  (server-side movement resolution)
 *   - client/aiTurn.ts       (client-side AI pathfinding cost estimation)
 *
 * These functions operate only on attribute data and tile metadata that is
 * available on both sides of the wire — no src/ or server/ types are imported.
 *
 * ─── SEGMENT-BASED COST MODEL ────────────────────────────────────────────────
 *
 * Every move is one segment step — either to an adjacent segment within the
 * same hex, or across the hex border to the facing segment in the adjacent hex.
 * Cost is determined by the destination segment's tile terrain + movement mode.
 *
 *   Drone (flight):  0.25 per step always. Can fly over ocean but cannot
 *                    finish a turn on ocean (enforced at turn-state level).
 *   Spider (limb):   0.50 per step always. Forbidden: mountain, ocean.
 *   Tank (wheeled):  0.25 on flat/clear.
 *                    0.75 on hills.
 *                    Forbidden: forest, ocean.
 *
 * ─── STEEPNESS GATE ──────────────────────────────────────────────────────────
 *
 * Each hex segment carries a precomputed `segSteep` (radians), computed at
 * world generation and delivered over the wire as `ss`. A ground unit may step
 * onto a destination segment only if its steepness is within the chassis limit:
 *   MAX_STEEP_WHEELED for tanks, MAX_STEEP_LIMB (larger) for spiders.
 * Drones (flight) ignore steepness entirely.
 *
 * The gate is on the *destination* segment — independent of the origin — so
 * any sub-path of a reachable path is itself reachable (path composability).
 * The old tile-level height-delta gate (MAX_CLIMB_WHEELED/LIMB) is removed.
 */

import type { UnitAttributes } from './unitTypes.js';

// ---------------------------------------------------------------------------
// Movement mode
// ---------------------------------------------------------------------------

export type MovementMode = 'wheeled' | 'limb' | 'flight';

/** The attribute keys that count as movement categories. */
export const MOVEMENT_ATTRIBUTES: (keyof UnitAttributes)[] = [
  'wheeledMovement',
  'limbMovement',
  'flightMovement',
];

/**
 * Determine a unit's movement mode from its attributes.
 * Accepts any object that has the three movement attribute fields.
 */
export function getMovementMode(attrs: UnitAttributes): MovementMode {
  if ((attrs.flightMovement ?? 0) >= 1) return 'flight';
  if ((attrs.limbMovement ?? 0) >= 1) return 'limb';
  return 'wheeled';
}

// ---------------------------------------------------------------------------
// Tile shape needed for segment cost
// ---------------------------------------------------------------------------

/**
 * Minimal tile shape required by segmentCost.
 * Both TileData (client) and Tile (src/world/types.ts) satisfy this.
 */
export interface MovementTile {
  /** Terrain type string — 'ocean' | 'plains' | … */
  terrainType?: string;
  /** Terrain type as used in the compact/client wire format. */
  terrain?: string;
  /** Whether this tile has forest cover. */
  forested?: boolean;
  /** Forest flag as used in the compact/client wire format. */
  f?: boolean;
  /** Discrete terrain height 0–11 (authoritative server field). */
  height?: number;
  /** Discrete terrain height 0–11 as used in the compact/client wire format. */
  h?: number;
  /** Runtime flag: a bridge has been built on this (river/ocean) tile. */
  bridge?: boolean;
  /** Bridge flag as used in the compact/client wire format. */
  br?: boolean;
  /**
   * Per-segment steepness in radians (authoritative server field, from segSteep).
   * Present on Tile after world-gen; absent on old/test tiles (treated as flat).
   */
  segSteep?: number[];
  /**
   * Per-segment steepness in radians (compact/client wire field, from ss).
   * Present on TileData after loading world.json or /api/world-tiles.
   */
  ss?: number[];
}

// ---------------------------------------------------------------------------
// Terrain helpers
// ---------------------------------------------------------------------------

/** Number of discrete terrain height levels (0 … HEIGHT_LEVELS-1). */
export const HEIGHT_LEVELS = 12;

/** Discrete terrain height 0–11 for a tile. */
export function tileHeight(tile: MovementTile): number {
  if (typeof tile.height === 'number') return tile.height;
  if (typeof tile.h === 'number') return tile.h;
  return 0;
}

/**
 * Maximum traversable segment steepness (radians) per chassis.
 * Spiders climb steeper than tanks. Drones ignore steepness.
 *
 * Values are calibrated outputs (scripts/calibrateSteepness.ts).
 * Seed 1 calibration: wheeled blocked fraction ≈ old gate's blocked fraction.
 */
export const MAX_STEEP_WHEELED = 0.44; // ~25° — calibrated
export const MAX_STEEP_LIMB = 0.79;    // ~45° — calibrated, > wheeled

/**
 * @deprecated Height-delta climb limits replaced by steepness gate.
 * Kept only for legacy test code that hasn't been migrated. Do not use.
 */
export const MAX_CLIMB_WHEELED = 3;
/**
 * @deprecated Height-delta climb limits replaced by steepness gate.
 * Kept only for legacy test code that hasn't been migrated. Do not use.
 */
export const MAX_CLIMB_LIMB = 8;

/** Whether a tile is ocean. */
function isOcean(tile: MovementTile): boolean {
  const terrain = tile.terrainType ?? tile.terrain ?? '';
  return terrain === 'ocean';
}

/** Whether a tile has forest cover. */
function isForested(tile: MovementTile): boolean {
  return (tile.forested ?? tile.f) === true;
}

/** Whether a bridge has been built on this tile (makes water passable). */
function isBridged(tile: MovementTile): boolean {
  return (tile.bridge ?? tile.br) === true;
}

// ---------------------------------------------------------------------------
// Segment-based cost constants
// ---------------------------------------------------------------------------

/** Cost per segment step for drone (flight). */
export const COST_DRONE = 0.25;

/** Cost per segment step for spider (limb). */
export const COST_SPIDER = 0.50;

/** Cost per segment step for tank on flat/clear terrain. */
export const COST_TANK_FLAT = 0.25;

/** Cost per segment step for tank on hills. @deprecated Hills surcharge removed — tanks pay flat everywhere now. */
export const COST_TANK_HILLS = 0.75;

/**
 * Flat MP cost to rotate (change facing), charged once per unit per turn.
 * Terrain-independent. After the fee is paid, all further facing changes that
 * turn are free — this lets the player freely correct orientation mistakes
 * without extra cost. Changing which segment a unit occupies is movement, not
 * rotation, and is charged per segment step via segmentCost().
 */
export const ROTATION_FEE = 0.25;

/**
 * Base intra-hex pivot cost per segment step for a given movement mode.
 * Tanks use their flat cost (they're already on the tile, terrain doesn't change).
 */
export function pivotStepCost(mode: MovementMode): number {
  switch (mode) {
    case 'flight': return COST_DRONE;
    case 'limb': return COST_SPIDER;
    case 'wheeled': return COST_TANK_FLAT;
  }
}

// ---------------------------------------------------------------------------
// Steepness helpers
// ---------------------------------------------------------------------------

/**
 * Steepness (radians) of a destination segment. Returns 0 (flat) for tiles
 * that lack segSteep/ss data (legacy tiles, test mocks) so behaviour degrades
 * gracefully to "steepness never blocks" rather than crashing.
 *
 * Reads `tile.segSteep` (server/Tile) or `tile.ss` (wire/client TileData).
 */
export function segmentSteepness(tile: MovementTile, segment: number): number {
  const ss = tile.segSteep ?? tile.ss;
  if (!ss || segment < 0 || segment >= ss.length) return 0;
  return ss[segment];
}

// ---------------------------------------------------------------------------
// Exported top-level helpers (used by client + server)
// ---------------------------------------------------------------------------

/**
 * Get the maximum movement points for a unit from its attributes.
 * Returns at least 1 so every unit can move.
 */
export function getMaxMovement(attrs: UnitAttributes): number {
  return Math.max(
    attrs.wheeledMovement ?? 0,
    attrs.limbMovement ?? 0,
    attrs.flightMovement ?? 0,
    1,
  );
}

/**
 * Whether a terrain type string is impassable for ground units.
 * Matches the client's TileData.terrain / MapViewInterface signature.
 */
export function isImpassableTerrain(terrain: string): boolean {
  return terrain === 'mountain' || terrain === 'ocean';
}

// ---------------------------------------------------------------------------
// Segment step cost (unified model)
// ---------------------------------------------------------------------------

/**
 * Cost to move one segment step onto `toSegment` of `toTile`, given the unit's
 * movement mode.
 *
 * The gate is on the **destination segment** only — independent of the origin —
 * so any sub-path of a finite-cost path is itself finite-cost (path composability).
 *
 * Returns Infinity when forbidden (ocean, steepness over chassis limit, or
 * forest for tanks). Otherwise returns a flat base cost.
 *
 * Drones can traverse ocean segments but cannot end a turn there — that
 * restriction is enforced at the turn-state level, not here.
 *
 * **Migration note**: call sites that previously passed `(tile, mode, fromTile?)`
 * must now pass the destination segment index. For a border crossing the arrival
 * segment is `destTile.neighbours.indexOf(fromTileIndex)`. For intra-hex pivots
 * it is the target segment. See the `hexEntryCost` deprecated forwarder below.
 */
export function segmentCost(
  toTile: MovementTile,
  toSegment: number,
  mode: MovementMode,
): number {
  // Drones: unaffected by terrain steepness or ground blocks.
  if (mode === 'flight') return COST_DRONE;

  const bridged = isBridged(toTile);

  // Ground units cannot enter ocean unless bridged.
  if (isOcean(toTile) && !bridged) return Infinity;

  // Steepness gate on the destination segment. A bridged tile bypasses this
  // (the bridge deck is flat regardless of the underlying terrain).
  if (!bridged) {
    const steep = segmentSteepness(toTile, toSegment);
    const limit = mode === 'limb' ? MAX_STEEP_LIMB : MAX_STEEP_WHEELED;
    if (steep > limit) return Infinity;
  }

  // Spider: flat cost on any passable segment.
  if (mode === 'limb') return COST_SPIDER;

  // Tank: forbidden from forest (a bridge deck is clear).
  if (!bridged && isForested(toTile)) return Infinity;

  // Tank: flat cost everywhere (hills surcharge removed — steepness is the gate now).
  return COST_TANK_FLAT;
}

// ---------------------------------------------------------------------------
// Legacy hex entry cost (deprecated — forwards to segmentCost)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use segmentCost(tile, segment, mode) instead.
 * This forwarder uses segment 0 as the representative destination segment.
 * It no longer models the old height-delta border gate — it applies the new
 * destination-segment steepness gate using segment 0, which may give a
 * different result than using the true arrival segment. Kept for call sites
 * that have not yet been migrated to the new signature.
 */
export function hexEntryCost(
  tile: MovementTile,
  mode: MovementMode,
  _isFirstHex: boolean,
): number {
  return segmentCost(tile, 0, mode);
}

// ---------------------------------------------------------------------------
// Convenience constants and helpers
// ---------------------------------------------------------------------------

/**
 * Compute the MP cost to traverse from one segment to another within the same hex.
 * Uses the shortest arc (min clockwise vs counter-clockwise distance).
 * Returns 0 if segments are identical.
 *
 * NOTE: Intra-hex steps are now steepness-gated via segmentCost. This function
 * returns a lower-bound arc cost (COST_DRONE per step) without a steepness
 * check. Use segmentCost(tile, targetSeg, mode) for the authoritative
 * terrain-aware cost on each intermediate and target segment.
 */
export function segmentStepCost(fromSegment: number, toSegment: number): number {
  if (fromSegment === toSegment) return 0;
  const diff = Math.abs(toSegment - fromSegment);
  const steps = Math.min(diff, 6 - diff);
  return steps * COST_DRONE;
}
