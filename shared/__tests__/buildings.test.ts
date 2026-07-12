import { describe, it, expect } from 'vitest';
import {
  PlacementContext,
  BuildSegTile,
  OccupantPos,
  validateBuildingPlacement,
  chooseFoundingSegment,
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
// Founding (Requirement 1 / A3)
// ---------------------------------------------------------------------------

describe('founding', () => {
  it('chooses the first A2-legal segment (no through-street preference)', () => {
    const ctx = makeCtx({ tiles: loneCapital(), cityHexes: [0] });
    const seg = chooseFoundingSegment(ctx, 0);
    expect(seg).toBe(0);
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
// Occupancy + legality (Requirement 3 / A2)
// ---------------------------------------------------------------------------

describe('placement legality (A2 rejections still fire)', () => {
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
// Unrestricted in-cluster building (Requirement A1) — placements that used to
// be rejected as breaks-through-street / orphans-street-network are now legal.
// ---------------------------------------------------------------------------

describe('unrestricted in-cluster building', () => {
  it('allows a placement that fragments the open segments into singletons', () => {
    // Buildings on 0 and 2 already; adding 4 leaves open {1,3,5}, each an
    // isolated single-segment run. Previously rejected as breaks-through-street;
    // now legal — sealing off segments is the player's own call.
    const ctx = makeCtx({
      tiles: loneCapital(),
      buildings: [
        { tileIndex: 0, segment: 0, ownerId: 'f0' },
        { tileIndex: 0, segment: 2, ownerId: 'f0' },
      ],
      cityHexes: [0],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 4 }).legal).toBe(true);
  });

  it('allows founding on a hex with only one passable face (no through-street)', () => {
    // Only segment 0 faces land (tile 1); all other faces are ocean. Previously
    // rejected as breaks-through-street; now legal.
    const tiles: Record<number, TileSpec> = {
      0: { neighbours: [1, 2, 3, 4, 5, 6] },
      1: { neighbours: [0] },
    };
    for (let n = 2; n <= 6; n++) tiles[n] = { neighbours: [0], groundPassable: false };
    const ctx = makeCtx({ tiles, cityHexes: [0] });
    expect(validateBuildingPlacement(ctx, { tileIndex: 0, segment: 3 }, { founding: true }).legal).toBe(true);
  });

  it('allows sealing a two-hex city off from the outside world entirely', () => {
    // Tiles 0 and 1 are city hexes joined at segment 0↔0; every other face is
    // off-map / ocean. Previously rejected as orphans-street-network; now legal
    // — an unreachable pocket is the player's problem, not an illegal build.
    const ctx = makeCtx({
      tiles: {
        0: { neighbours: [1, 90, 91, 92, 93, 94] },
        1: { neighbours: [0, 95, 96, 97, 98, 99] },
      },
      buildings: [{ tileIndex: 1, segment: 1, ownerId: 'f0' }],
      cityHexes: [0, 1],
    });
    expect(validateBuildingPlacement(ctx, { tileIndex: 1, segment: 2 }).legal).toBe(true);
  });
});
