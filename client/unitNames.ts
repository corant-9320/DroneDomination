/**
 * Client-side unit name generation from attributes.
 * Mirrors the logic in src/world/units.ts generateUnitName().
 *
 * Format: "[Top1 Word] [Top2 Word] [Speed Word] [Type Word]"
 */

import { UnitData } from './worldData.js';

/** Movement speed words by level (1–5). */
const SPEED_NAMES: Record<number, string> = {
  1: 'Loitering',
  2: 'Plodder',
  3: 'Walker',
  4: 'Runner',
  5: 'Sprinter',
};

/** Movement type words by movement attribute key. */
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

/** Movement attribute keys in priority order. */
const MOVEMENT_ATTRIBUTES = ['wheeledMovement', 'flightMovement', 'limbMovement'] as const;

/** Non-movement attribute keys eligible for naming. */
const NAMING_ATTRIBUTES = ['attack', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair'] as const;

/**
 * Generate a readable name from unit attributes.
 * Returns a name like "Striker Middleweight Runner Tank".
 */
export function readableUnitName(unit: UnitData): string {
  const attrs = unit.attributes;

  // Determine movement type and speed
  const movementKey = MOVEMENT_ATTRIBUTES.find((k) => (attrs[k] ?? 0) >= 1) ?? 'wheeledMovement';
  const speed = attrs[movementKey] ?? 1;
  const speedWord = SPEED_NAMES[Math.min(Math.max(speed, 1), 5)];
  const typeWord = TYPE_NAMES[movementKey];

  // Rank non-movement attributes by value (descending), pick top two
  const ranked = NAMING_ATTRIBUTES
    .map((key) => ({ key, value: (attrs as Record<string, number | undefined>)[key] ?? 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const top1 = ranked[0];
  const top2 = ranked[1];

  const parts: string[] = [];
  if (top1) parts.push(ATTRIBUTE_NAMES[top1.key]![Math.min(Math.max(top1.value, 1), 5)]);
  if (top2) parts.push(ATTRIBUTE_NAMES[top2.key]![Math.min(Math.max(top2.value, 1), 5)]);
  parts.push(speedWord, typeWord);

  return parts.join(' ');
}
