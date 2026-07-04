/**
 * Buildings — shared geometry + pure placement validation.
 *
 * A building is a full-segment occupant identified by `(tileIndex, segment)`,
 * exactly like a unit but immobile. Buildings belong to a faction and sit on
 * that faction's city hexes.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the two traversability
 * invariants and lives in `shared/` so the client can validate placement
 * without importing any server-only module (Requirement 7.3):
 *
 *   - Per-tile through-street (Requirement 4): every city hex must keep a
 *     connected run of open (unbuilt) segments with at least two external
 *     faces opening onto ground-passable neighbours, so a ground unit can
 *     enter one face and leave another.
 *
 *   - Whole-city external reachability (Requirement 5): the city's entire
 *     open-segment network must connect to the outside world. No sealed
 *     courtyard pockets, even if every individual tile still has a
 *     through-street.
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
  | 'not-adjacent-to-city'
  | 'breaks-through-street'
  | 'orphans-street-network';

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

/** Open segments of a tile (no building), given the post-placement building set. */
function openSegments(tile: BuildSegTile, buildings: Set<string>): number[] {
  const open: number[] = [];
  for (let s = 0; s < tile.sides; s++) {
    if (!buildings.has(segKey(tile.index, s))) open.push(s);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Invariant: per-tile through-street (Requirement 4)
// ---------------------------------------------------------------------------

/**
 * Does `tile` retain a valid through-street given the (post-placement) set of
 * occupied building segments? A valid through-street is a connected run of open
 * segments containing at least two segments whose external face opens onto a
 * ground-passable neighbour.
 */
export function hasThroughStreet(
  ctx: PlacementContext,
  tile: BuildSegTile,
  buildings: Set<string>,
): boolean {
  const open = openSegments(tile, buildings);
  if (open.length === 0) return false;
  const openSet = new Set(open);
  const seen = new Set<number>();

  for (const start of open) {
    if (seen.has(start)) continue;
    // Flood-fill this open-segment component within the hex.
    const stack = [start];
    seen.add(start);
    let passableFaces = 0;
    while (stack.length) {
      const seg = stack.pop()!;
      const neighbourTile = tile.neighbours[seg];
      const nt = neighbourTile === undefined ? undefined : ctx.getTile(neighbourTile);
      if (nt?.groundPassable) passableFaces++;
      for (const adj of intraHexNeighbours(tile.sides, seg)) {
        if (openSet.has(adj) && !seen.has(adj)) {
          seen.add(adj);
          stack.push(adj);
        }
      }
    }
    if (passableFaces >= 2) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Invariant: whole-city external reachability (Requirement 5)
// ---------------------------------------------------------------------------

/**
 * Is the city's open-segment network free of sealed pockets? Every connected
 * component of open segments across all city hexes must contain at least one
 * "exit" — an open segment whose external face opens onto a ground-passable
 * tile OUTSIDE the city.
 *
 * Returns the set of city hexes belonging to any pocket that cannot reach the
 * outside (empty when the city is fully reachable).
 */
export function findOrphanedPockets(
  ctx: PlacementContext,
  cityHexes: readonly number[],
  buildings: Set<string>,
): number[] {
  const cityHexSet = new Set(cityHexes);
  const seen = new Set<string>();
  const orphanedHexes = new Set<number>();

  for (const hexIndex of cityHexes) {
    const tile = ctx.getTile(hexIndex);
    if (!tile) continue;
    for (const seg of openSegments(tile, buildings)) {
      const startKey = segKey(hexIndex, seg);
      if (seen.has(startKey)) continue;

      // BFS over the open-segment graph for this component.
      const component: string[] = [];
      const stack = [{ tileIndex: hexIndex, segment: seg }];
      seen.add(startKey);
      let hasExit = false;

      while (stack.length) {
        const node = stack.pop()!;
        const nodeKey = segKey(node.tileIndex, node.segment);
        component.push(nodeKey);
        const tileA = ctx.getTile(node.tileIndex)!;

        // Intra-hex edges.
        for (const adj of intraHexNeighbours(tileA.sides, node.segment)) {
          const k = segKey(node.tileIndex, adj);
          if (!buildings.has(k) && !seen.has(k)) {
            seen.add(k);
            stack.push({ tileIndex: node.tileIndex, segment: adj });
          }
        }

        // External face: either a cross-hex edge (to another city hex) or an
        // exit to the outside world.
        const neighbourIndex = tileA.neighbours[node.segment];
        const neighbour = neighbourIndex === undefined ? undefined : ctx.getTile(neighbourIndex);
        if (!neighbour) continue;

        if (cityHexSet.has(neighbourIndex)) {
          // Shared face with another city hex — traverse if that segment open.
          const facing = neighbour.neighbours.indexOf(node.tileIndex);
          if (facing >= 0) {
            const k = segKey(neighbourIndex, facing);
            if (!buildings.has(k) && !seen.has(k)) {
              seen.add(k);
              stack.push({ tileIndex: neighbourIndex, segment: facing });
            }
          }
        } else if (neighbour.groundPassable) {
          // Open face onto a ground-passable tile outside the city = exit.
          hasExit = true;
        }
      }

      if (!hasExit) {
        for (const key of component) {
          orphanedHexes.add(Number(key.split(':')[0]));
        }
      }
    }
  }

  return [...orphanedHexes];
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

  // Simulate the placement.
  const afterBuildings = new Set(buildings);
  afterBuildings.add(segKey(placement.tileIndex, placement.segment));

  // Per-tile through-street invariant (Requirement 4) — only the affected hex
  // can lose a through-street; every other city hex is unchanged.
  if (!hasThroughStreet(ctx, tile, afterBuildings)) {
    return {
      legal: false,
      reason: 'breaks-through-street',
      message: 'This would block the only through-street on the hex.',
      offendingTiles: [tile.index],
    };
  }

  // Whole-city external reachability (Requirement 5). The placement may newly
  // own the target hex, so include it in the city set.
  const cityHexes = ctx.cityHexes.includes(placement.tileIndex)
    ? ctx.cityHexes
    : [...ctx.cityHexes, placement.tileIndex];
  const orphaned = findOrphanedPockets(ctx, cityHexes, afterBuildings);
  if (orphaned.length > 0) {
    return {
      legal: false,
      reason: 'orphans-street-network',
      message: 'This would seal off part of the city from the outside world.',
      offendingTiles: orphaned,
    };
  }

  return { legal: true };
}

// ---------------------------------------------------------------------------
// Founding helper (Requirement 1.4)
// ---------------------------------------------------------------------------

/**
 * Choose a segment on the capital hex for the free founding building such that
 * the hex retains a valid through-street. Returns the first legal segment, or
 * null if (degenerately) none exists.
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
