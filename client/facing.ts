/**
 * facing.ts — THE single source of truth for unit-facing conversions.
 *
 * Facing is the #1 footgun in this codebase because three *different* things
 * are all integers 0–5 and look interchangeable but are NOT:
 *
 *   ┌────────────────────┬──────────────────────────────────────────────────┐
 *   │ NeighbourFacing     │ Index into `tile.neighbours[]`. TILE-RELATIVE —   │
 *   │ (what unit.facing   │ the same integer means a different world          │
 *   │  stores)            │ direction on every tile. Combat math reads it as  │
 *   │                     │ `tile.neighbours[facing]` (see combatFacing.ts).  │
 *   ├────────────────────┼──────────────────────────────────────────────────┤
 *   │ ScreenAngle         │ Radians, north-clockwise (0 = screen-up,          │
 *   │                     │ +π/3 per 60° step). Continuous, view-dependent.   │
 *   ├────────────────────┼──────────────────────────────────────────────────┤
 *   │ SpriteFacing        │ Index 0–5 into the pre-rendered isometric sprites.│
 *   │                     │ FIXED screen mapping: 0 = up, +60° clockwise per  │
 *   │                     │ step. This is what the sprite renderer expects.   │
 *   └────────────────────┴──────────────────────────────────────────────────┘
 *
 * RULE: no other file may do raw `.neighbours.indexOf()`, `(facing ± n) % 6`,
 * or screen-angle→index math for facing. Route everything through here so the
 * coordinate frame of every value is explicit and tested in one place.
 *
 * Past bugs this module exists to prevent:
 *   - Using a NeighbourFacing computed for tile A as if it were valid on tile B
 *     (unit faced backward after a move).
 *   - Storing a SpriteFacing into unit.facing (wrong frame entirely).
 *
 * See also: .kiro/steering/ui-defaults.md § "Unit Facing & Rendering".
 */

// ─── Branded-ish type aliases (documentation only; all are number at runtime) ──

/** Index 0–5 into a tile's neighbour array. What `unit.facing` stores. */
export type NeighbourFacing = 0 | 1 | 2 | 3 | 4 | 5;

/** Index 0–5 into the pre-rendered sprite set. Fixed screen mapping (0 = up). */
export type SpriteFacing = 0 | 1 | 2 | 3 | 4 | 5;

// ─── Minimal structural shapes (avoid coupling to TileData / FlatTile) ─────────

/** A tile with the fields facing math needs: 3D position and neighbour list. */
export interface FacingTile {
  pos: [number, number, number];
  n: number[];
}

/** A projected flat tile with the fields facing math needs. */
export interface FacingFlatTile {
  tileIndex: number;
  cx: number;
  cy: number;
  poly: { x: number; y: number }[];
}

// ─── Discrete rotation ─────────────────────────────────────────────────────────

/**
 * Rotate a hex index (facing or segment) by `delta` steps, wrapping 0–5.
 * Positive = clockwise. Use instead of raw `(x + delta + 6) % 6`.
 */
export function rotateHexIndex(index: number, delta: number): NeighbourFacing {
  return (((index + delta) % 6) + 6) % 6 as NeighbourFacing;
}

// ─── NeighbourFacing from movement ─────────────────────────────────────────────

/**
 * Compute the NeighbourFacing a unit should have after travelling from
 * `prevTile` to `destTile` — i.e. the neighbour of *destTile* that lies most
 * in the direction of travel (so the unit faces "forward", away from where it
 * came).
 *
 * Returns a neighbour index valid for `destTile` (NOT `prevTile`). This is the
 * value to store in `unit.facing` after the move.
 *
 * Uses 3D dot products on the unit sphere — no pole/antimeridian edge cases.
 */
export function facingFromTravel(
  prevTileIndex: number,
  destTileIndex: number,
  tiles: FacingTile[],
): NeighbourFacing {
  const destPos = tiles[destTileIndex].pos;
  const fromPos = tiles[prevTileIndex].pos;

  // Travel direction vector (prevTile → destTile).
  const tx = destPos[0] - fromPos[0];
  const ty = destPos[1] - fromPos[1];
  const tz = destPos[2] - fromPos[2];

  const neighbours = tiles[destTileIndex].n;
  let bestDir = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < neighbours.length; i++) {
    const nPos = tiles[neighbours[i]].pos;
    // Offset from dest toward this neighbour, aligned against travel direction.
    const dot =
      (nPos[0] - destPos[0]) * tx +
      (nPos[1] - destPos[1]) * ty +
      (nPos[2] - destPos[2]) * tz;
    if (dot > bestDot) {
      bestDot = dot;
      bestDir = i;
    }
  }
  return bestDir as NeighbourFacing;
}

// ─── ScreenAngle helpers ────────────────────────────────────────────────────────

/**
 * Screen angle (radians, north-clockwise: 0 = up, increases clockwise) for the
 * direction from one tile to another, using their projected positions in the
 * current flat view. Falls back to 3D world positions when either tile is not
 * currently in the flat view.
 */
export function screenAngleBetweenTiles(
  fromTileIndex: number,
  toTileIndex: number,
  flatTiles: FacingFlatTile[],
  tiles: FacingTile[],
): number {
  let fromX = 0, fromY = 0, toX = 0, toY = 0;
  let foundFrom = false, foundTo = false;

  for (const ft of flatTiles) {
    if (ft.tileIndex === fromTileIndex) {
      fromX = ft.cx; fromY = ft.cy;
      foundFrom = true;
    }
    if (ft.tileIndex === toTileIndex) {
      toX = ft.cx; toY = ft.cy;
      foundTo = true;
    }
    if (foundFrom && foundTo) break;
  }

  if (foundFrom && foundTo) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    // worldToScreen flips Y (wy → -sy), so screen-up = +dy in world space.
    // atan2(dx, -dy) gives the north-clockwise angle (up = 0, CW positive).
    return Math.atan2(dx, -dy);
  }

  // Fallback: use 3D positions from world data.
  const fromPos = tiles[fromTileIndex].pos;
  const toPos = tiles[toTileIndex].pos;
  const dx = toPos[0] - fromPos[0];
  const dz = toPos[2] - fromPos[2];
  return Math.atan2(dx, dz);
}

/**
 * Quantize a ScreenAngle (north-clockwise radians) to the nearest SpriteFacing.
 * Sprite 0 faces up; each step is +60° clockwise.
 */
export function screenAngleToSpriteFacing(angle: number): SpriteFacing {
  // spriteAngle(i) = -π/2 + i·(π/3)  →  invert: i = (angle + π/2) / (π/3)
  let idx = (angle + Math.PI / 2) / (Math.PI / 3);
  idx = ((idx % 6) + 6) % 6;
  return (Math.round(idx) % 6) as SpriteFacing;
}

// ─── NeighbourFacing → SpriteFacing (the render bridge) ─────────────────────────

/**
 * Convert a unit's NeighbourFacing into the SpriteFacing to draw.
 *
 * On a sphere `tile.neighbours[facing]` can sit at any screen angle, so the
 * stored neighbour index does NOT line up with the fixed sprite mapping. This
 * computes the actual screen angle toward the faced hex edge (from the tile's
 * projected polygon) and picks the nearest pre-rendered sprite — preserving the
 * isometric perspective (never apply 2D canvas rotation to these sprites).
 *
 * @param facing  The unit's NeighbourFacing (unit.facing).
 * @param ft      The unit's projected flat tile.
 * @param wts     worldToScreen bound to the current view params.
 */
export function spriteFacingForRender(
  facing: number,
  ft: FacingFlatTile,
  wts: (wx: number, wy: number) => [number, number],
): SpriteFacing {
  if (ft.poly.length < 6) return (facing % 6) as SpriteFacing;

  const [cx, cy] = wts(ft.cx, ft.cy);

  // Midpoint of the faced boundary edge (facing → facing+1).
  const v0 = ft.poly[facing % 6];
  const v1 = ft.poly[(facing + 1) % 6];
  const [ex, ey] = wts((v0.x + v1.x) / 2, (v0.y + v1.y) / 2);

  // Actual screen angle from tile centre to faced edge midpoint, then quantize.
  const angle = Math.atan2(ex - cx, -(ey - cy));
  const normalised = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return (Math.round(normalised / (Math.PI / 3)) % 6) as SpriteFacing;
}

// ─── NeighbourFacing → continuous world direction (3D views) ───────────────────

/**
 * World-space (X, Z) direction a NeighbourFacing points in, derived from the
 * midpoint of the faced boundary edge in the flat projection. Mapping to 3D is
 * (px, py) → (px, -py), matching the first-person projection's `toWorld`.
 *
 * Unlike {@link spriteFacingForRender} this stays continuous (no quantization to
 * one of six pre-rendered sprites) because 3D models rotate freely. Used to
 * orient unit/building models and to aim the first-person camera along a facing.
 */
export function facingDirection(ft: FacingFlatTile, facing: number): { x: number; z: number } {
  const n = ft.poly.length;
  const v0 = ft.poly[facing % n];
  const v1 = ft.poly[(facing + 1) % n];
  const ex = (v0.x + v1.x) / 2 - ft.cx;
  const ey = (v0.y + v1.y) / 2 - ft.cy;
  const len = Math.sqrt(ex * ex + ey * ey) || 1;
  return { x: ex / len, z: -ey / len };
}
