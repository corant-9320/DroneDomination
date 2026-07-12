/**
 * Buildings — shared geometry + pure placement validation.
 *
 * A building is a full-segment occupant identified by `(tileIndex, segment)`,
 * exactly like a unit but immobile. Buildings belong to a faction and sit on
 * that faction's city hexes.
 *
 * Placement inside a buildable cluster (city or refinery) is otherwise
 * unrestricted: a player may build on any eligible segment, even if it seals
 * off or isolates other segments. Unit movement (shared/segmentGraph.ts) is a
 * segment-to-segment occupancy model that simply can't enter an occupied
 * segment — an unreachable pocket is the player's own mistake, not an illegal
 * build (Segment-Based Movement spec). This module used to also enforce a
 * per-tile through-street invariant and whole-city external reachability;
 * both were removed — see that spec for the rationale.
 *
 * The module operates on a small abstract view of the world (see
 * `BuildSegTile` / `PlacementContext`) that both the authoritative server
 * `Tile`/`World` and the client `TileData`/`WorldData` can cheaply build,
 * mirroring the pattern used by `movementConstants.ts`.
 */

// ---------------------------------------------------------------------------
// Building placement steepness limit
// ---------------------------------------------------------------------------

/**
 * Maximum segment steepness (radians) for building placement.
 * A building may not be placed on a segment steeper than this.
 * Calibrated to roughly align with MAX_STEEP_WHEELED (you shouldn't be able
 * to build where a tank cannot stand).
 *
 * Value is a calibrated output (scripts/calibrateSteepness.ts).
 */
export const MAX_BUILD_STEEPNESS = 0.44; // ~25° — same as MAX_STEEP_WHEELED

// ---------------------------------------------------------------------------
// Abstract world view
// ---------------------------------------------------------------------------

/** Minimal tile shape needed to reason about segments and streets. */
export interface BuildSegTile {
  /** Tile index in the world graph. */
  index: number;
  /** Number of triangular segments (6 for hex, 5 for pentagon). */
  sides: number;
  /** Neighbour tile indices, one per side (segment N faces neighbours[N]). */
  neighbours: number[];
  /**
   * Whether a ground chassis could enter this tile under existing movement
   * rules. At tile granularity this means "not ocean" (steepness is an
   * edge/chassis concern handled by the movement system, not the street
   * invariant). Set by the caller.
   */
  groundPassable: boolean;
  /**
   * Per-segment steepness in radians (from tile.segSteep or tile.ss).
   * Defaults to a zero-filled array when absent so legacy/mock tiles are
   * treated as flat/buildable.
   */
  segSteep?: number[];
}

/** A full-segment occupant position (building or unit). */
export interface OccupantPos {
  tileIndex: number;
  segment: number;
  ownerId: string;
}

/** Everything the validator needs about the current world, faction-agnostic. */
export interface PlacementContext {
  /** Resolve a tile by index (city hexes AND their neighbours must resolve). */
  getTile(index: number): BuildSegTile | undefined;
  /** All buildings on the map (every faction). */
  buildings: readonly OccupantPos[];
  /** All units on the map (every faction). */
  units: readonly OccupantPos[];
  /** The faction the proposed building belongs to. */
  factionId: string;
  /** Hex indices currently owned by the faction's city. */
  cityHexes: readonly number[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PlacementRejectionReason =
  | 'invalid-tile'
  | 'invalid-segment'
  | 'impassable-tile'
  | 'too-steep'
  | 'segment-occupied-unit'
  | 'segment-occupied-building'
  | 'tile-full'
  | 'not-adjacent-to-city';

export interface PlacementValidation {
  legal: boolean;
  reason?: PlacementRejectionReason;
  /** Human-readable explanation, suitable for surfacing in the UI. */
  message?: string;
  /** Hexes implicated in an invariant failure. */
  offendingTiles?: number[];
}

// ---------------------------------------------------------------------------
// Segment adjacency helpers
// ---------------------------------------------------------------------------

/** Segment key used in occupancy / network sets. */
export function segKey(tileIndex: number, segment: number): string {
  return `${tileIndex}:${segment}`;
}

/** The two intra-hex neighbours of a segment (N±1, wrapping by tile.sides). */
export function intraHexNeighbours(sides: number, segment: number): [number, number] {
  return [(segment + 1) % sides, (segment - 1 + sides) % sides];
}

/**
 * Given a tile and one of its segments, find the segment on the neighbouring
 * tile that shares the same external face. Returns null if the neighbour does
 * not exist or does not list this tile back (graph asymmetry / off-map).
 */
export function facingNeighbourSegment(
  ctx: PlacementContext,
  tile: BuildSegTile,
  segment: number,
): { tileIndex: number; segment: number } | null {
  const neighbourIndex = tile.neighbours[segment];
  if (neighbourIndex === undefined) return null;
  const neighbour = ctx.getTile(neighbourIndex);
  if (!neighbour) return null;
  const facing = neighbour.neighbours.indexOf(tile.index);
  if (facing < 0) return null;
  return { tileIndex: neighbourIndex, segment: facing };
}

// ---------------------------------------------------------------------------
// Occupancy helpers
// ---------------------------------------------------------------------------

function buildingSet(ctx: PlacementContext): Set<string> {
  const s = new Set<string>();
  for (const b of ctx.buildings) s.add(segKey(b.tileIndex, b.segment));
  return s;
}

function unitSet(ctx: PlacementContext): Set<string> {
  const s = new Set<string>();
  for (const u of ctx.units) s.add(segKey(u.tileIndex, u.segment));
  return s;
}

// ---------------------------------------------------------------------------
// Placement validation (Requirement 6.2)
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /**
   * Founding placement (the city's first, free building). Skips the
   * adjacency-to-existing-building check (Requirement 1.2 / 3.1).
   */
  founding?: boolean;
}

/**
 * Pure validation: given a world view and a proposed placement, decide whether
 * it is legal and, if not, why (and which hexes are implicated).
 *
 * Used by the client (build UI), the construction commit path, and world
 * integrity checking (`npm run validate`) so the rules never diverge.
 */
export function validateBuildingPlacement(
  ctx: PlacementContext,
  placement: { tileIndex: number; segment: number },
  options: ValidateOptions = {},
): PlacementValidation {
  const tile = ctx.getTile(placement.tileIndex);
  if (!tile) {
    return { legal: false, reason: 'invalid-tile', message: `Tile ${placement.tileIndex} does not exist.` };
  }
  if (placement.segment < 0 || placement.segment >= tile.sides || !Number.isInteger(placement.segment)) {
    return { legal: false, reason: 'invalid-segment', message: `Segment ${placement.segment} is out of range for tile ${tile.index}.` };
  }
  if (!tile.groundPassable) {
    return { legal: false, reason: 'impassable-tile', message: 'Cannot build on an impassable tile.' };
  }

  // Steepness gate: reject placement on a segment steeper than the build limit.
  // Falls back to 0 (flat/passable) when segSteep is absent — preserves
  // existing behaviour for test mocks and legacy tiles that predate this field.
  const segSteepVal = tile.segSteep ? (tile.segSteep[placement.segment] ?? 0) : 0;
  if (segSteepVal > MAX_BUILD_STEEPNESS) {
    return { legal: false, reason: 'too-steep', message: 'Cannot build on a slope this steep.' };
  }

  const units = unitSet(ctx);
  if (units.has(segKey(placement.tileIndex, placement.segment))) {
    return { legal: false, reason: 'segment-occupied-unit', message: 'A unit already occupies that segment.' };
  }

  const buildings = buildingSet(ctx);
  if (buildings.has(segKey(placement.tileIndex, placement.segment))) {
    return { legal: false, reason: 'segment-occupied-building', message: 'A building already occupies that segment.' };
  }

  // Capacity: buildings + units must never exceed the tile's segment count.
  let occupiedOnTile = 0;
  for (let s = 0; s < tile.sides; s++) {
    const k = segKey(tile.index, s);
    if (buildings.has(k) || units.has(k)) occupiedOnTile++;
  }
  if (occupiedOnTile >= tile.sides) {
    return { legal: false, reason: 'tile-full', message: 'No free segment on this tile.' };
  }

  // Contiguous growth (Requirement 3.1): the target hex must be, or be adjacent
  // to, a hex already holding a building owned by the same faction.
  if (!options.founding) {
    const factionBuildingTiles = new Set<number>();
    for (const b of ctx.buildings) {
      if (b.ownerId === ctx.factionId) factionBuildingTiles.add(b.tileIndex);
    }
    const adjacent =
      factionBuildingTiles.has(placement.tileIndex) ||
      tile.neighbours.some((n) => factionBuildingTiles.has(n));
    if (!adjacent) {
      return {
        legal: false,
        reason: 'not-adjacent-to-city',
        message: 'A building must extend an existing building of your faction.',
      };
    }
  }

  // No through-street or external-reachability gate: placement inside a
  // buildable cluster is otherwise unrestricted (Segment-Based Movement spec,
  // Requirement A1). A placement that isolates or seals off other segments is
  // legal — unit movement (shared/segmentGraph.ts) simply cannot enter an
  // occupied segment, so an unreachable pocket is the player's own mistake.
  return { legal: true };
}

// ---------------------------------------------------------------------------
// Founding helper (Requirement 1.4)
// ---------------------------------------------------------------------------

/**
 * Choose a segment on the capital hex for the free founding building.
 * Returns the first segment that passes the A2 placement rules (no
 * through-street preference — Requirement A3), or null if (degenerately)
 * none exists.
 */
export function chooseFoundingSegment(
  ctx: PlacementContext,
  tileIndex: number,
): number | null {
  const tile = ctx.getTile(tileIndex);
  if (!tile) return null;
  for (let s = 0; s < tile.sides; s++) {
    const result = validateBuildingPlacement(ctx, { tileIndex, segment: s }, { founding: true });
    if (result.legal) return s;
  }
  return null;
}
