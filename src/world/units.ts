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
 *   attack:         0–5
 *   armour:         0–5
 *   defence:        0–5
 *   splashAttack:   0–5
 *   rangeAttack:    0–5
 *   wheeledMovement:0–5
 *   limbMovement:   0–5
 *   flightMovement: 0–5
 *   repair:         0–5
 *
 * A unit MUST have at least 1 point in one movement category
 * (wheeledMovement, limbMovement, or flightMovement).
 */
export interface UnitAttributes {
  /** Maximum hit points (1–5). */
  maxHealth?: number;
  /** Base attack power — determines gun length in icon (0–5). */
  attack?: number;
  /** Damage reduction from incoming attacks (0–5). */
  armour?: number;
  /** Chance to avoid or deflect a hit entirely (0–5). */
  defence?: number;
  /** Base splash damage dealt in adjacent combat (0–5). */
  splashAttack?: number;
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
}

// ---------------------------------------------------------------------------
// Attribute ranges & validation
// ---------------------------------------------------------------------------

/** Allowed [min, max] for each attribute. */
export const ATTRIBUTE_RANGES: Record<keyof UnitAttributes, [min: number, max: number]> = {
  maxHealth: [1, 5],
  attack: [0, 5],
  armour: [0, 5],
  defence: [0, 5],
  splashAttack: [0, 5],
  rangeAttack: [0, 5],
  wheeledMovement: [0, 5],
  limbMovement: [0, 5],
  flightMovement: [0, 5],
  repair: [0, 5],
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

  // A unit must have exactly one movement type with at least 1 point.
  const activeMovement = MOVEMENT_ATTRIBUTES.filter((k) => (attrs[k] ?? 0) >= 1);
  if (activeMovement.length === 0) {
    errors.push(
      'Unit must have at least 1 point in a movement attribute (wheeledMovement, limbMovement, or flightMovement)',
    );
  } else if (activeMovement.length > 1) {
    errors.push(
      `Unit can only have one movement type, but has points in: ${activeMovement.join(', ')}`,
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
  /** Direction the unit is facing (0–5), set by last movement direction. */
  facing: HexSegment;
  /** The unit's attribute profile — defines what it can do. */
  attributes: UnitAttributes;
  /** Current health (≤ attributes.maxHealth). */
  currentHealth: number;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Movement speed words by level (1–5). */
const SPEED_NAMES: Record<number, string> = {
  1: 'Loitering',
  2: 'Plodder',
  3: 'Walker',
  4: 'Runner',
  5: 'Sprinter',
};

/** Movement type words by movement attribute. */
const TYPE_NAMES: Record<string, string> = {
  wheeledMovement: 'Tank',
  flightMovement: 'Drone',
  limbMovement: 'Spider',
};

/** Attribute column words by level (1–5). */
const ATTRIBUTE_NAMES: Record<string, Record<number, string>> = {
  attack: { 1: 'Harasser', 2: 'Raider', 3: 'Striker', 4: 'Breaker', 5: 'Executioner' },
  armour: { 1: 'Flyweight', 2: 'Bantamweight', 3: 'Welterweight', 4: 'Middleweight', 5: 'Heavyweight' },
  defence: { 1: 'Listener', 2: 'Scrambler', 3: 'Jammer', 4: 'Disruptor', 5: 'Nullifier' },
  splashAttack: { 1: 'Popper', 2: 'Blaster', 3: 'Bombardier', 4: 'Demolisher', 5: 'Devastator' },
  rangeAttack: { 1: 'Melee', 2: 'Short', 3: 'Medium', 4: 'Long', 5: 'Distance' },
  repair: { 1: 'Tinkerer', 2: 'Mechanic', 3: 'Engineer', 4: 'Restorer', 5: 'Fabricator' },
};

/** Non-movement attribute keys eligible for naming. */
const NAMING_ATTRIBUTES: (keyof UnitAttributes)[] = [
  'attack', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair',
];

/**
 * Generate a unit name from its attributes.
 *
 * Format: "[Top1 Word] [Top2 Word] [Speed Word] [Type Word]"
 * - Speed comes from the movement value (1–5)
 * - Type comes from the movement category (Tank / Drone / Spider)
 * - Top two words come from the two highest non-movement attributes
 */
export function generateUnitName(attrs: UnitAttributes): string {
  // Determine movement type and speed
  const movementKey = MOVEMENT_ATTRIBUTES.find((k) => (attrs[k] ?? 0) >= 1) ?? 'wheeledMovement';
  const speed = attrs[movementKey] ?? 1;
  const speedWord = SPEED_NAMES[Math.min(Math.max(speed, 1), 5)];
  const typeWord = TYPE_NAMES[movementKey];

  // Rank non-movement attributes by value (descending), pick top two
  const ranked = NAMING_ATTRIBUTES
    .map((key) => ({ key, value: attrs[key] ?? 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const top1 = ranked[0];
  const top2 = ranked[1];

  const parts: string[] = [];
  if (top1) parts.push(ATTRIBUTE_NAMES[top1.key]![Math.min(Math.max(top1.value, 1), 5)]);
  if (top2) parts.push(ATTRIBUTE_NAMES[top2.key]![Math.min(Math.max(top2.value, 1), 5)]);
  parts.push(speedWord, typeWord);

  const mov = attrs[movementKey] ?? 0;
  const att = attrs.attack ?? 0;
  const rng = attrs.rangeAttack ?? 0;
  const spl = attrs.splashAttack ?? 0;
  const arm = attrs.armour ?? 0;
  const ew = attrs.defence ?? 0;
  const rep = attrs.repair ?? 0;

  return `${parts.join(' ')} (Mov ${mov}, Att ${att}, Rng ${rng}, Spl ${spl}, Arm ${arm}, EW ${ew}, Rep ${rep})`;
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
