import { describe, it, expect } from 'vitest';
import {
  PlacementContext,
  BuildSegTile,
  OccupantPos,
  validateBuildingPlacement,
  chooseFoundingSegment,
  findOrphanedPockets,
  segKey,
} from '../buildings.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

type TileSpec = { sides?: number; neighbours: number[]; groundPassable?: boolean };

function makeCtx(opts: {
  tiles: Record<number, TileSpec>;
  buildings?: OccupantPos[];
  units?: OccupantPos[];
  cityHexes: number[];
  factionId?: string;
}): PlacementContext {
  const tileMap = new Map<number, BuildSegTile>();
  for (const [k, spec] of Object.entries(opts.tiles)) {
    const index = Number(k);
    tileMap.set(index, {
      index,
      sides: spec.sides ?? 6,
      neighbours: spec.neighbours,
      groundPassable: spec.groundPassable ?? true,
    });
  }
  return {
    getTile: (i) => tileMap.get(i),
    buildings: opts.buildings ?? [],
    units: opts.units ?? [],
    factionId: opts.factionId ?? 'f0',
    cityHexes: opts.cityHexes,
  };
}

/** A hex (tile 0) whose six neighbours (1..6) are all passable land. */
function loneCapital(extra: Record<number, TileSpec> = {}): Record<number, TileSpec> {
  const tiles: Record<number, TileSpec> = {
    0: { neighbours: [1, 2, 3, 4, 5, 6] },
  };
  for (let n = 1; n <= 6; n++) tiles[n] = { neighbours: [0] };
  return { ...tiles, ...extra };
}

// ---------------------------------------------------------------------------
// Founding (Requirement 1)
// ---------------------------------------------------------------------------

describe('founding', () => {
  it('chooses a segment that keeps a through-street', () => {
    const ctx = makeCtx({ tiles: loneCapital(), cityHexes: [0] });
    const seg = chooseFoundingSegment(ctx, 0);
    expect(seg).not.toBeNull();
    const result = validateBuildingPlacement(ctx, { tileIndex: 0, segment: seg! }, { founding: true });
    expect(result.legal).toBe(true);
  });

  it('founding bypasses the adjacency requirement', () => {
    const ctx = makeCtx({ tiles: loneCapital(), cityHexes: [0] });
    // No existing buildings — only legal because founding skips adjacency.
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 0 }, { founding: true }).legal).toBe(true);
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 0 }).reason).toBe('not-adjacent-to-city');
  });
});

// ---------------------------------------------------------------------------
// Occupancy + legality (Requirement 3)
// ---------------------------------------------------------------------------

describe('placement legality', () => {
  it('rejects a segment occupied by a unit', () => {
    const ctx = makeCtx({
      tiles: loneCapital(),
      buildings: [{ tileIndex: 0, segment: 0, ownerId: 'f0' }],
      units: [{ tileIndex: 0, segment: 1, ownerId: 'f0' }],
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 1 }).reason).toBe('segment-occupied-unit');
  });

  it('rejects a segment occupied by a building', () => {
    const ctx = makeCtx({
      tiles: loneCapital(),
      buildings: [{ tileIndex: 0, segment: 0, ownerId: 'f0' }],
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 0 }).reason).toBe('segment-occupied-building');
  });

  it('rejects a hex not adjacent to any faction building', () => {
    const tiles = loneCapital({ 99: { neighbours: [50] }, 50: { neighbours: [99] } });
    const ctx = makeCtx({
      tiles,
      buildings: [{ tileIndex: 0, segment: 0, ownerId: 'f0' }],
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 99, segment: 0 }).reason).toBe('not-adjacent-to-city');
  });

  it('rejects building on an impassable (ocean) tile', () => {
    const ctx = makeCtx({
      tiles: loneCapital({ 0: { neighbours: [1, 2, 3, 4, 5, 6], groundPassable: false } }),
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 0 }, { founding: true }).reason).toBe('impassable-tile');
  });

  it('accepts contiguous growth onto an adjacent hex', () => {
    const tiles = loneCapital({ 1: { neighbours: [0, 7, 8, 9, 10, 11] } });
    for (const n of [7, 8, 9, 10, 11]) tiles[n] = { neighbours: [1] };
    const ctx = makeCtx({
      tiles,
      buildings: [{ tileIndex: 0, segment: 0, ownerId: 'f0' }],
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 1, segment: 3 }).legal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Through-street invariant (Requirement 4)
// ---------------------------------------------------------------------------

describe('through-street invariant', () => {
  it('rejects a placement that fragments the open segments into singletons', () => {
    // Buildings on 0 and 2 already; adding 4 leaves open {1,3,5}, each an
    // isolated single-segment run with only one external face.
    const ctx = makeCtx({
      tiles: loneCapital(),
      buildings: [
        { tileIndex: 0, segment: 0, ownerId: 'f0' },
        { tileIndex: 0, segment: 2, ownerId: 'f0' },
      ],
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 4 }).reason).toBe('breaks-through-street');
  });

  it('does not count a face onto an impassable neighbour as a street opening', () => {
    // Only segment 0 faces land (tile 1); all other faces are ocean. A single
    // building leaves an arc of open segments but only ONE passable face, so no
    // through-street remains.
    const tiles: Record<number, TileSpec> = {
      0: { neighbours: [1, 2, 3, 4, 5, 6] },
      1: { neighbours: [0] },
    };
    for (let n = 2; n <= 6; n++) tiles[n] = { neighbours: [0], groundPassable: false };
    const ctx = makeCtx({ tiles, cityHexes: [0] });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 3 }, { founding: true }).reason).toBe('breaks-through-street');
  });
});

// ---------------------------------------------------------------------------
// External reachability / no-courtyard invariant (Requirement 5)
// ---------------------------------------------------------------------------

describe('external reachability', () => {
  it('flags a two-hex city sealed from the outside as orphaned', () => {
    // Tiles 0 and 1 are city hexes joined at segment 0↔0; every other face is
    // off-map / ocean, so there is no exit to the outside world.
    const ctx = makeCtx({
      tiles: {
        0: { neighbours: [1, 90, 91, 92, 93, 94] },
        1: { neighbours: [0, 95, 96, 97, 98, 99] },
      },
      cityHexes: [0, 1],
    });
    const orphaned = findOrphanedPockets(ctx, [0, 1], new Set());
    expect(orphaned.sort()).toEqual([0, 1]);
  });

  it('reports no orphan when at least one open face exits to passable land', () => {
    const ctx = makeCtx({
      tiles: {
        0: { neighbours: [1, 90, 91, 92, 93, 94] },
        1: { neighbours: [0, 95, 96, 97, 98, 99] },
        90: { neighbours: [0] }, // passable exterior land = exit
      },
      cityHexes: [0, 1],
    });
    expect(findOrphanedPockets(ctx, [0, 1], new Set())).toEqual([]);
  });
});
