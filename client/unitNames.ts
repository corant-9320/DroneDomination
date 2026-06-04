/**
 * Client-side unit name generation from attributes.
 * Delegates table lookups and ranking to shared/unitNaming.ts.
 *
 * Format: "[Top1 Word] [Top2 Word] [Speed Word] [Type Word]"
 */

import { UnitData } from './worldData.js';
import { buildUnitNameParts } from '../shared/unitNaming.js';

/**
 * Generate a readable name from unit attributes.
 * Returns a name like "Striker Middleweight Runner Tank".
 */
export function readableUnitName(unit: UnitData): string {
  const { speedWord, typeWord, descriptors } = buildUnitNameParts(unit.attributes);
  return [...descriptors, speedWord, typeWord].join(' ');
}
