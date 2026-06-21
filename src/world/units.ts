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

export type { UnitAttributes } from '../../shared/unitTypes.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';

// ---------------------------------------------------------------------------
// Segment positioning
// ---------------------------------------------------------------------------

/** Triangular segment index within a hex (0–5, clockwise from neighbour 0). */
export type HexSegment = 0 | 1 | 2 | 3 | 4 | 5;

/** Maximum number of units that can occupy a single tile (one segment must stay free). */
export const MAX_UNITS_PER_TILE = 5;

/** Each size point equals this many health units for damage calculation. */
export const HP_PER_POINT = 10;

// ---------------------------------------------------------------------------
// Attribute ranges & validation
// ---------------------------------------------------------------------------

/** Allowed [min, max] for each attribute. */
export const ATTRIBUTE_RANGES: Record<keyof UnitAttributes, [min: number, max: number]> = {
  size: [1, 5],
  kinetic: [0, 5],
  armour: [0, 5],
  defence: [0, 5],
  splashAttack: [0, 5],
  rangeAttack: [0, 5],
  wheeledMovement: [0, 5],
  limbMovement: [0, 5],
  flightMovement: [0, 5],
  repair: [0, 5],
  antiAir: [0, 5],
  engineer: [0, 5],
};

export { MOVEMENT_ATTRIBUTES } from '../../shared/movementConstants.js';
import { MOVEMENT_ATTRIBUTES } from '../../shared/movementConstants.js';

/**
 * Attributes whose value may not exceed the unit's `size`. It is unrealistic
 * to fit heavy weapons/armour/EW/repair systems on a small frame. `rangeAttack`,
 * movement attributes, and `engineer` are intentionally NOT capped by size.
 */
export const SIZE_CAPPED_ATTRIBUTES: (keyof UnitAttributes)[] = [
  'kinetic', 'splashAttack', 'antiAir', 'armour', 'defence', 'repair',
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

  // Size acts as a ceiling on the size of weapons/armour/EW/repair that can be
  // fitted (unrealistic to fit heavy systems on a tiny frame). rangeAttack,
  // movement, and engineer are NOT capped by size.
  const size = attrs.size ?? 1;
  for (const key of SIZE_CAPPED_ATTRIBUTES) {
    const value = attrs[key] ?? 0;
    if (value > size) {
      errors.push(`${key}: ${value} exceeds size ceiling of ${size}`);
    }
  }

  // Drones (flight chassis) attack adjacent only — they have no rangeAttack.
  if ((attrs.flightMovement ?? 0) > 0 && (attrs.rangeAttack ?? 0) > 0) {
    errors.push('rangeAttack is not available to drones (flight chassis attack adjacent only)');
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
  /** Current health in health units (≤ attributes.size * HP_PER_POINT). */
  currentHealth: number;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

import { buildUnitNameParts } from '../../shared/unitNaming.js';

/**
 * Generate a unit name from its attributes.
 *
 * Format: "[Top1 Word] [Top2 Word] [Speed Word] [Type Word] (stat string)"
 * - Speed comes from the movement value (1–5)
 * - Type comes from the movement category (Tank / Drone / Spider)
 * - Top two words come from the two highest non-movement attributes
 */
export function generateUnitName(attrs: UnitAttributes): string {
  const { movementKey, speedWord, typeWord, descriptors } = buildUnitNameParts(attrs);

  const parts = [...descriptors, speedWord, typeWord];

  const mov = attrs[movementKey as keyof UnitAttributes] as number ?? 0;
  const att = attrs.kinetic ?? 0;
  const rng = attrs.rangeAttack ?? 0;
  const spl = attrs.splashAttack ?? 0;
  const aa = attrs.antiAir ?? 0;
  const arm = attrs.armour ?? 0;
  const ew = attrs.defence ?? 0;
  const rep = attrs.repair ?? 0;

  return `${parts.join(' ')} (Mov ${mov}, Kin ${att}, Rng ${rng}, Spl ${spl}, AA ${aa}, Arm ${arm}, EW ${ew}, Rep ${rep})`;
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
