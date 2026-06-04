/**
 * Shared unit naming tables and core name-building logic.
 *
 * Used by both:
 *   - src/world/units.ts::generateUnitName()  (appends a stat string)
 *   - client/unitNames.ts::readableUnitName() (returns name only)
 *
 * The two callers may format the final string differently, but they share
 * the underlying table lookups and ranking logic here.
 */

import type { UnitAttributes } from './unitTypes.js';

// ---------------------------------------------------------------------------
// Naming tables
// ---------------------------------------------------------------------------

/** Movement speed words by level (1–5). */
export const SPEED_NAMES: Record<number, string> = {
  1: 'Loitering',
  2: 'Plodder',
  3: 'Walker',
  4: 'Runner',
  5: 'Sprinter',
};

/** Movement type words by movement attribute key. */
export const TYPE_NAMES: Record<string, string> = {
  wheeledMovement: 'Tank',
  flightMovement: 'Drone',
  limbMovement: 'Spider',
};

/** Attribute column words by level (1–5). */
export const ATTRIBUTE_NAMES: Record<string, Record<number, string>> = {
  kinetic:      { 1: 'Harasser',    2: 'Raider',       3: 'Striker',     4: 'Breaker',     5: 'Executioner' },
  armour:       { 1: 'Flyweight',   2: 'Bantamweight', 3: 'Welterweight',4: 'Middleweight', 5: 'Heavyweight' },
  defence:      { 1: 'Listener',    2: 'Scrambler',    3: 'Jammer',      4: 'Disruptor',   5: 'Nullifier' },
  splashAttack: { 1: 'Popper',      2: 'Blaster',      3: 'Bombardier',  4: 'Demolisher',  5: 'Devastator' },
  rangeAttack:  { 1: 'Melee',       2: 'Short',        3: 'Medium',      4: 'Long',        5: 'Distance' },
  repair:       { 1: 'Tinkerer',    2: 'Mechanic',     3: 'Engineer',    4: 'Restorer',    5: 'Fabricator' },
  antiAir:      { 1: 'Spotter',     2: 'Tracker',      3: 'Interceptor', 4: 'Skyhunter',   5: 'Annihilator' },
};

/** Movement attribute keys in priority order (flight > limb > wheeled). */
const MOVEMENT_KEYS = ['flightMovement', 'limbMovement', 'wheeledMovement'] as const;

/** Non-movement attribute keys eligible for naming. */
const NAMING_ATTRIBUTES: (keyof UnitAttributes)[] = [
  'kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair', 'antiAir',
];

// ---------------------------------------------------------------------------
// Core name parts builder
// ---------------------------------------------------------------------------

export interface UnitNameParts {
  /** The movement attribute key that drives type/speed words. */
  movementKey: string;
  /** Speed word derived from movement level. */
  speedWord: string;
  /** Type word derived from movement category. */
  typeWord: string;
  /** Up to two descriptor words from the top non-movement attributes. */
  descriptors: string[];
}

/**
 * Derive the name parts for a unit from its attributes.
 *
 * Both generateUnitName() and readableUnitName() call this, then format
 * the parts differently.
 */
export function buildUnitNameParts(attrs: UnitAttributes): UnitNameParts {
  // Determine movement type and speed
  const movementKey =
    MOVEMENT_KEYS.find((k) => (attrs[k] ?? 0) >= 1) ?? 'wheeledMovement';
  const speed = attrs[movementKey as keyof UnitAttributes] as number ?? 1;
  const speedWord = SPEED_NAMES[Math.min(Math.max(speed, 1), 5)];
  const typeWord = TYPE_NAMES[movementKey];

  // Rank non-movement attributes by value (descending), pick top two
  const ranked = NAMING_ATTRIBUTES
    .map((key) => ({ key, value: attrs[key] ?? 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const descriptors: string[] = [];
  for (const entry of ranked.slice(0, 2)) {
    const word = ATTRIBUTE_NAMES[entry.key]?.[Math.min(Math.max(entry.value, 1), 5)];
    if (word) descriptors.push(word);
  }

  return { movementKey, speedWord, typeWord, descriptors };
}
