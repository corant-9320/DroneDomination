import { describe, it, expect } from 'vitest';
import type { WorldData, UnitData, TileData } from '../worldData.js';
import { computeMovementRange } from '../movementRange.js';
import {
  computeMovementCostRoute,
  computeContextualAttackRoute,
  computeMovementTowardTile,
  computeMovementRouteForDestination,
  extractMovePlan,
  type MovementCostRoute,
} from '../movementRoute.js';

/**
 * Characterization safety-net for the route functions (P3 refactor).
 *
 * These tests lock the OBSERVABLE BEHAVIOR of the live route entry points on a
 * controlled flat hex grid so the consolidation refactor can be verified to
 * preserve behavior. They assert structural invariants (contiguity, MP bounds,
 * zone ordering, preview/plan agreement) plus golden snapshots of the produced
 * hop sequences. If the refactor changes any route, a snapshot diff flags it.
 */

// ─── Hex-grid fixture ──────────────────────────────────────────────────────────

/** Axial neighbour directions; index = segment / neighbour-array order. */
const DIRS: [number, number][] = [
  [+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1],
];

const hexDistance = (q: number, r: number) =>
  (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

/**
 * Build a hexagon-shaped patch of flat plains tiles of the given axial radius.
 * Interior tiles have all 6 neighbours in DIRS order.
 *
 * Positions are projected onto the UNIT SPHERE near the north pole. This is
 * required because shared/rangeCheck.ts normalizes segment centroids onto the
 * unit sphere — a flat plane far from the origin would collapse all distances.
 * A small planar scale keeps the patch locally flat while living on the sphere,
 * so segment-distance ≈ hop count (threshold 2.0 ≈ 2 hexes).
 */
function buildHexGrid(radius: number): { tiles: TileData[]; at: (q: number, r: number) => number } {
  const SCALE = 0.08; // planar units → small offset from the pole
  const onSphere = (px: number, py: number): [number, number, number] => {
    const v: [number, number, number] = [px * SCALE, py * SCALE, 1];
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  };

  const coords: [number, number][] = [];
  const indexMap = new Map<string, number>();
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (hexDistance(q, r) <= radius) {
        indexMap.set(`${q},${r}`, coords.length);
        coords.push([q, r]);
      }
    }
  }

  const at = (q: number, r: number) => indexMap.get(`${q},${r}`) ?? -1;

  const tiles: TileData[] = coords.map(([q, r], idx) => {
    const cx = q + r * 0.5;
    const cy = r * 0.8660254;
    const n: number[] = [];
    for (const [dq, dr] of DIRS) {
      const ni = at(q + dq, r + dr);
      if (ni >= 0) n.push(ni);
    }
    const b: [number, number, number][] = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      b.push(onSphere(cx + 0.5 * Math.cos(a), cy + 0.5 * Math.sin(a)));
    }
    return {
      idx,
      s: 6,
      n,
      pos: onSphere(cx, cy),
      b,
      terrain: 'plains',
      h: 1,
    };
  });

  return { tiles, at };
}

function makeWorld(tiles: TileData[], units: UnitData[]): WorldData {
  return {
    seed: 1,
    tileCount: tiles.length,
    pentagonCount: 0,
    hexCount: tiles.length,
    pentagonIndices: [],
    cities: [],
    tiles,
    units,
    buildings: [],
  };
}

function makeUnit(tileIndex: number, overrides: Partial<UnitData> = {}): UnitData {
  return {
    id: overrides.id ?? 'u_player',
    label: overrides.label ?? 'Tank',
    ownerId: overrides.ownerId ?? 'player',
    tileIndex,
    segment: overrides.segment ?? 0,
    facing: overrides.facing ?? 0,
    attributes: overrides.attributes ?? { size: 3, wheeledMovement: 2, rangeAttack: 2, kinetic: 2 },
    currentHealth: overrides.currentHealth ?? 30,
  };
}

/** Serialize a route into a compact, snapshot-friendly shape. */
function dumpRoute(route: MovementCostRoute | null) {
  if (!route) return null;
  return {
    start: [route.startTile, route.startSegment],
    hops: route.hops.map((h) => [h.tileIndex, h.segment, h.cumulativeCost, h.zone]),
  };
}

// ─── Shared invariant assertions ────────────────────────────────────────────────

function assertRouteInvariants(route: MovementCostRoute | null, tiles: TileData[], remainingMP: number) {
  if (!route) return;
  const ZONE_ORDER = { attackReady: 0, moveOnly: 1, weaponRange: 2 };

  let prevZoneRank = -1;
  let prevCum = -Infinity;
  let prevTile = route.startTile;
  let prevWasMovement = true; // startTile counts as a movement anchor

  for (const h of route.hops) {
    const isMovement = h.zone !== 'weaponRange';
    // Contiguity for MOVEMENT hops: each is the same tile (intra-hex) or a
    // neighbour of the previous movement tile. weaponRange hops are excluded —
    // weapon fire "flies over" terrain and need not be step-adjacent to the
    // last moved-to tile.
    if (isMovement && prevWasMovement && h.tileIndex !== prevTile) {
      expect(tiles[prevTile].n).toContain(h.tileIndex);
    }
    // Zones never go backwards (attackReady → moveOnly → weaponRange).
    const rank = ZONE_ORDER[h.zone];
    expect(rank).toBeGreaterThanOrEqual(prevZoneRank);
    prevZoneRank = rank;
    // Movement hops stay within the MP budget; cumulative is non-decreasing.
    if (isMovement) {
      expect(h.cumulativeCost).toBeLessThanOrEqual(remainingMP + 1e-9);
      expect(h.cumulativeCost).toBeGreaterThanOrEqual(prevCum - 1e-9);
      prevCum = h.cumulativeCost;
    }
    prevTile = h.tileIndex;
    prevWasMovement = isMovement;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('movementRoute — characterization', () => {
  const { tiles, at } = buildHexGrid(5);
  const startTile = at(0, 0);
  const MP = 2; // wheeled, plains flat → 0.25/step → 8 segment steps

  it('computeMovementCostRoute: reachable destination — invariants + golden', () => {
    const unit = makeUnit(startTile);
    const dest = at(1, 0);
    const route = computeMovementCostRoute(makeWorld(tiles, [unit]), unit, null, 0, MP, dest);
    expect(route).not.toBeNull();
    assertRouteInvariants(route, tiles, MP);
    // Route ends at the requested destination tile.
    expect(route!.hops[route!.hops.length - 1].tileIndex).toBe(dest);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('computeMovementRouteForDestination: in-range destination matches computeMovementCostRoute', () => {
    const unit = makeUnit(startTile);
    const dest = at(2, 0);
    const world = makeWorld(tiles, [unit]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeMovementRouteForDestination(world, unit, dest, 0, MP, rangeResult);
    assertRouteInvariants(route, tiles, MP);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('computeMovementRouteForDestination: out-of-range destination routes toward it', () => {
    const unit = makeUnit(startTile);
    const dest = at(0, 5); // beyond move range; toward-routing yields a real path
    const world = makeWorld(tiles, [unit]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeMovementRouteForDestination(world, unit, dest, 0, MP, rangeResult);
    expect(route).not.toBeNull();
    assertRouteInvariants(route, tiles, MP);
    // Routes toward the target but stops short of the out-of-range tile.
    expect(route!.hops[route!.hops.length - 1].tileIndex).not.toBe(dest);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('computeMovementTowardTile: out-of-range tile yields a movement-only route', () => {
    const unit = makeUnit(startTile);
    const dest = at(0, 5);
    const world = makeWorld(tiles, [unit]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeMovementTowardTile(world, unit, dest, MP, rangeResult);
    expect(route).not.toBeNull();
    assertRouteInvariants(route, tiles, MP);
    // This helper only returns movement — never weapon-range hops.
    expect(route!.hops.every((h) => h.zone !== 'weaponRange')).toBe(true);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('computeMovementTowardTile: returns null when the nearest reachable tile is degenerate', () => {
    // Captured behavior: toward-routing hardcodes destSegment 0, so when segment 0
    // of the closest reachable tile costs more than the MP budget, it returns null.
    const unit = makeUnit(startTile);
    const dest = at(4, 0);
    const world = makeWorld(tiles, [unit]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeMovementTowardTile(world, unit, dest, MP, rangeResult);
    expect(route).toBeNull();
  });

  it('computeContextualAttackRoute: enemy already in range → single red hop, no movement', () => {
    const enemyTile = at(1, 0);
    const unit = makeUnit(startTile, { attributes: { size: 3, wheeledMovement: 2, rangeAttack: 3, kinetic: 2 } });
    const enemy = makeUnit(enemyTile, { id: 'e1', ownerId: 'enemy', segment: 3 });
    const world = makeWorld(tiles, [unit, enemy]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeContextualAttackRoute(world, unit, enemyTile, 3, MP, 3, rangeResult);
    expect(route).not.toBeNull();
    expect(route!.hops).toHaveLength(1);
    expect(route!.hops[0].zone).toBe('weaponRange');
    assertRouteInvariants(route, tiles, MP);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('computeContextualAttackRoute: enemy reachable this turn → move to firing position + red hop', () => {
    const enemyTile = at(3, 0);
    const unit = makeUnit(startTile);
    const enemy = makeUnit(enemyTile, { id: 'e2', ownerId: 'enemy', segment: 3 });
    const world = makeWorld(tiles, [unit, enemy]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeContextualAttackRoute(world, unit, enemyTile, 3, MP, 3, rangeResult);
    expect(route).not.toBeNull();
    assertRouteInvariants(route, tiles, MP);
    // Ends with a weapon-range hop onto the enemy, preceded by movement.
    const last = route!.hops[route!.hops.length - 1];
    expect(last.zone).toBe('weaponRange');
    expect(last.tileIndex).toBe(enemyTile);
    expect(route!.hops.some((h) => h.zone !== 'weaponRange')).toBe(true);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('computeContextualAttackRoute: distant enemy → full move (green+blue) + weapon-range extension', () => {
    const enemyTile = at(0, 5);
    const unit = makeUnit(startTile);
    const enemy = makeUnit(enemyTile, { id: 'e3', ownerId: 'enemy', segment: 3 });
    const world = makeWorld(tiles, [unit, enemy]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeContextualAttackRoute(world, unit, enemyTile, 3, MP, 3, rangeResult);
    expect(route).not.toBeNull();
    assertRouteInvariants(route, tiles, MP);
    // Exercises all three zones: attackReady, moveOnly, then weaponRange extension.
    const zones = new Set(route!.hops.map((h) => h.zone));
    expect(zones.has('attackReady')).toBe(true);
    expect(zones.has('moveOnly')).toBe(true);
    expect(zones.has('weaponRange')).toBe(true);
    expect(dumpRoute(route)).toMatchSnapshot();
  });

  it('extractMovePlan: ignores weapon-range hops and agrees with the route destination', () => {
    const unit = makeUnit(startTile);
    const dest = at(2, 0);
    const world = makeWorld(tiles, [unit]);
    const rangeResult = computeMovementRange(world, unit, MP);
    const route = computeMovementRouteForDestination(world, unit, dest, 0, MP, rangeResult);
    const plan = extractMovePlan(route, tiles);
    expect(plan).not.toBeNull();

    // The plan's destination is the last NON-weaponRange hop of the same route.
    const moveHops = route!.hops.filter((h) => h.zone !== 'weaponRange');
    const lastMove = moveHops[moveHops.length - 1];
    expect(plan!.destTile).toBe(lastMove.tileIndex);
    expect(plan!.destSegment).toBe(lastMove.segment);
    expect(plan!.mpCost).toBe(lastMove.cumulativeCost);
    expect(dumpRoute(route)).toMatchSnapshot();
  });
});
