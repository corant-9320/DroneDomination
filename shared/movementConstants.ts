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
 * Elevation is a discrete height 0–11 (HEIGHT_LEVELS). Units are NOT blocked by
 * absolute height — a tank can stand on the highest peak if it climbed a gentle
 * ramp to get there. They are blocked by the *step* between two adjacent hexes:
 * crossing a border whose |height delta| exceeds the chassis climb limit is
 * forbidden. Drones (flight) ignore steepness entirely. This is why segmentCost
 * takes an optional `fromTile` — the cost of a step depends on the edge, not
 * just the destination cell.
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
  /** Elevation type string — 'mountain' | 'hills' | 'flat' | … */
  elevationType?: string;
  /** Terrain type string — 'ocean' | 'plains' | … */
  terrainType?: string;
  /** Elevation type as used in the compact/client wire format. */
  elevType?: string;
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
}

// ---------------------------------------------------------------------------
// Terrain helpers
// ---------------------------------------------------------------------------

/** Whether a tile counts as "hill" for movement purposes. */
function isHill(tile: MovementTile): boolean {
  const elev = tile.elevationType ?? tile.elevType ?? '';
  return elev === 'hills';
}

/** Number of discrete terrain height levels (0 … HEIGHT_LEVELS-1). */
export const HEIGHT_LEVELS = 12;

/**
 * Representative height for an elevation band, used as a fallback when a tile
 * carries no explicit `height`/`h` (e.g. test mocks or legacy data). Bands span
 * the 0–11 range in even thirds: flat 0–2, rolling 3–5, hills 6–8, mountain 9–11.
 */
export function bandToHeight(band: string | undefined): number {
  switch (band) {
    case 'mountain': return 10;
    case 'hills':    return 7;
    case 'rolling':  return 4;
    case 'flat':     return 1;
    default:         return 1;
  }
}

/** Derive the 4-way elevation band from a discrete height 0–11. */
export function heightToBand(height: number): 'flat' | 'rolling' | 'hills' | 'mountain' {
  if (height >= 9) return 'mountain';
  if (height >= 6) return 'hills';
  if (height >= 3) return 'rolling';
  return 'flat';
}

/** Discrete terrain height 0–11 for a tile, with band fallback when absent. */
export function tileHeight(tile: MovementTile): number {
  if (typeof tile.height === 'number') return tile.height;
  if (typeof tile.h === 'number') return tile.h;
  return bandToHeight(tile.elevationType ?? tile.elevType);
}

/**
 * Maximum climbable step (|height delta|) per movement mode. Crossing a border
 * steeper than this is forbidden. Tanks are limited to gentle grades; spiders
 * can scale almost any slope; drones (flight) are unaffected.
 */
export const MAX_CLIMB_WHEELED = 4;
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

// ---------------------------------------------------------------------------
// Segment-based cost constants
// ---------------------------------------------------------------------------

/** Cost per segment step for drone (flight). */
export const COST_DRONE = 0.25;

/** Cost per segment step for spider (limb). */
export const COST_SPIDER = 0.50;

/** Cost per segment step for tank on flat/clear terrain. */
export const COST_TANK_FLAT = 0.25;

/** Cost per segment step for tank on hills. */
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
 * Cost to move one segment step into a destination tile, given the unit's
 * movement mode. The destination tile's terrain determines the base cost; the
 * step (delta) between `fromTile` and `tile` determines whether the move is
 * climbable at all.
 *
 * For intra-hex moves (same tile), omit `fromTile` (or pass the same tile) —
 * there is no height delta within a hex.
 *
 * Returns Infinity if the destination is forbidden for this movement mode, or
 * if the border step is too steep for the chassis.
 *
 * Drones can traverse ocean segments but cannot end a turn there — that
 * restriction is enforced at the turn-state level, not here.
 */
export function segmentCost(
  tile: MovementTile,
  mode: MovementMode,
  fromTile?: MovementTile,
): number {
  // Drones can go anywhere (ocean end-of-turn restriction is separate) and are
  // unaffected by terrain steepness.
  if (mode === 'flight') {
    return COST_DRONE;
  }

  // Ground units cannot enter ocean. Mountains are no longer impassable by
  // height alone — only the steepness gate below can block a high tile.
  if (isOcean(tile)) return Infinity;

  // Steepness gate: a border step taller than the chassis climb limit is
  // impassable, regardless of the absolute elevation involved.
  if (fromTile) {
    const delta = Math.abs(tileHeight(tile) - tileHeight(fromTile));
    const limit = mode === 'limb' ? MAX_CLIMB_LIMB : MAX_CLIMB_WHEELED;
    if (delta > limit) return Infinity;
  }

  // Spider: constant cost, any non-ocean terrain within the climb limit
  if (mode === 'limb') {
    return COST_SPIDER;
  }

  // Tank (wheeled): forbidden from forest
  if (isForested(tile)) return Infinity;

  // Tank: hills
  if (isHill(tile)) {
    return COST_TANK_HILLS;
  }

  // Tank: flat/clear
  return COST_TANK_FLAT;
}

// ---------------------------------------------------------------------------
// Legacy hex entry cost (deprecated — forwards to segmentCost)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use segmentCost() instead. Kept for call sites not yet migrated.
 */
export function hexEntryCost(
  tile: MovementTile,
  mode: MovementMode,
  _isFirstHex: boolean,
): number {
  return segmentCost(tile, mode);
}

// ---------------------------------------------------------------------------
// Convenience constants and helpers
// ---------------------------------------------------------------------------

/**
 * Compute the MP cost to traverse from one segment to another within the same hex.
 * Uses the shortest arc (min clockwise vs counter-clockwise distance).
 * Returns 0 if segments are identical.
 *
 * NOTE: This uses COST_DRONE (0.25) per step as a lower bound. For the actual
 * terrain-aware intra-hex cost, use pivotStepCost(mode) per step.
 */
export function segmentStepCost(fromSegment: number, toSegment: number): number {
  if (fromSegment === toSegment) return 0;
  const diff = Math.abs(toSegment - fromSegment);
  const steps = Math.min(diff, 6 - diff);
  return steps * COST_DRONE;
}
