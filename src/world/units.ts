/**
 * Units — attribute-based entities positioned in hex segments.
 *
 * There are no fixed unit "types". Each unit is defined entirely by its
 * combination of optional attributes, allowing freeform composition.
 *
 * A hex (tile) is subdivided into 6 triangular segments (0–5), each of
 * which can hold at most one unit. Segment 0 is the triangle whose outer
 * edge faces neighbour[0], and they proceed clockwise.
 *
 * However, only 5 of the 6 segments may be occupied simultaneously —
 * one segment must always remain free. This keeps hex tiles consistent
 * with pentagon tiles (which have exactly 5 segments) and simplifies
 * game rules across both tile shapes.
 */

// ---------------------------------------------------------------------------
// Segment positioning
// ---------------------------------------------------------------------------

/** Triangular segment index within a hex (0–5, clockwise from neighbour 0). */
export type HexSegment = 0 | 1 | 2 | 3 | 4 | 5;

/** Maximum number of units that can occupy a single tile (one segment must stay free). */
export const MAX_UNITS_PER_TILE = 5;

// ---------------------------------------------------------------------------
// Unit attributes
// ---------------------------------------------------------------------------

/**
 * The full set of attributes a unit *may* have.
 * All fields are optional — a unit only carries the attributes relevant to it.
 *
 * All values are integers within a fixed range:
 *   maxHealth:      1–5  (must be at least 1 if present)
 *   armour:         0–5
 *   meleeAttack:    0–5
 *   rangeAttack:    0–5
 *   wheeledMovement:0–5
 *   limbMovement:   0–5
 *   flightMovement: 0–5
 *   repair:         0–5
 *   initiative:     0–5
 *
 * A unit MUST have at least 1 point in one movement category
 * (wheeledMovement, limbMovement, or flightMovement).
 */
export interface UnitAttributes {
  /** Maximum hit points (1–5). */
  maxHealth?: number;
  /** Damage reduction from incoming attacks (0–5). */
  armour?: number;
  /** Base damage dealt in melee combat (0–5). */
  meleeAttack?: number;
  /** Base damage dealt at range (0–5). */
  rangeAttack?: number;
  /** Movement points for wheeled/vehicle traversal (0–5). */
  wheeledMovement?: number;
  /** Movement points for organic/legged traversal (0–5). */
  limbMovement?: number;
  /** Movement points for aerial traversal (0–5). */
  flightMovement?: number;
  /** Repair capability — points of health restored per action (0–5). */
  repair?: number;
  /** Determines action order within a turn; higher goes first (0–5). */
  initiative?: number;
}

// ---------------------------------------------------------------------------
// Attribute ranges & validation
// ---------------------------------------------------------------------------

/** Allowed [min, max] for each attribute. */
export const ATTRIBUTE_RANGES: Record<keyof UnitAttributes, [min: number, max: number]> = {
  maxHealth: [1, 5],
  armour: [0, 5],
  meleeAttack: [0, 5],
  rangeAttack: [0, 5],
  wheeledMovement: [0, 5],
  limbMovement: [0, 5],
  flightMovement: [0, 5],
  repair: [0, 5],
  initiative: [0, 5],
};

/** The attribute keys that count as movement categories. */
export const MOVEMENT_ATTRIBUTES: (keyof UnitAttributes)[] = [
  'wheeledMovement',
  'limbMovement',
  'flightMovement',
];

/** Validate a single attribute value against its allowed range. */
export function isValidAttribute(key: keyof UnitAttributes, value: number): boolean {
  const [min, max] = ATTRIBUTE_RANGES[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Validate all attributes on a unit. Returns a list of error messages (empty = valid). */
export function validateAttributes(attrs: UnitAttributes): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(attrs) as [keyof UnitAttributes, number][]) {
    if (value === undefined) continue;
    if (!isValidAttribute(key, value)) {
      const [min, max] = ATTRIBUTE_RANGES[key];
      errors.push(`${key}: ${value} is out of range [${min}, ${max}]`);
    }
  }

  // A unit must have at least 1 point in one movement category.
  const hasMovement = MOVEMENT_ATTRIBUTES.some((k) => (attrs[k] ?? 0) >= 1);
  if (!hasMovement) {
    errors.push(
      'Unit must have at least 1 point in a movement attribute (wheeledMovement, limbMovement, or flightMovement)',
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Unit entity
// ---------------------------------------------------------------------------

/** A single unit instance on the map. */
export interface Unit {
  /** Globally unique identifier. */
  id: string;
  /** Human-readable label (e.g. "Scout Alpha", "Siege Tank #3"). */
  label: string;
  /** Owning player / faction id. */
  ownerId: string;
  /** Index of the tile this unit currently occupies. */
  tileIndex: number;
  /** Which triangular segment within the tile the unit sits in. */
  segment: HexSegment;
  /** The unit's attribute profile — defines what it can do. */
  attributes: UnitAttributes;
  /** Current health (≤ attributes.maxHealth). */
  currentHealth: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the effective movement budget for a unit (best of all movement modes). */
export function getMovement(unit: Unit): number {
  const { wheeledMovement, limbMovement, flightMovement } = unit.attributes;
  return Math.max(wheeledMovement ?? 0, limbMovement ?? 0, flightMovement ?? 0);
}

/** Check whether a tile has room for another unit. */
export function canPlaceUnit(
  occupiedSegments: HexSegment[],
): boolean {
  return occupiedSegments.length < MAX_UNITS_PER_TILE;
}

/** Find the first unoccupied segment in a tile, or undefined if full. */
export function firstFreeSegment(
  occupiedSegments: HexSegment[],
): HexSegment | undefined {
  const all: HexSegment[] = [0, 1, 2, 3, 4, 5];
  return all.find((s) => !occupiedSegments.includes(s));
}
