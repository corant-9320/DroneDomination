/**
 * Regenerate world tiles from a seed.
 *
 * Used when loading compact saves that omit the tiles array.
 * Returns the full tile data + cities (both are deterministic from the seed).
 */

import { generateWorld } from '../src/world/generate.js';
import { toCompactTile } from '../src/world/compact.js';
import type { WorldTilesResponse } from '../shared/wireTypes.js';

/**
 * `cities` is always populated by this handler (unlike the shared response
 * type, which marks it optional since the client doesn't currently read it).
 */
export type RegenerateResult = WorldTilesResponse & {
  cities: NonNullable<WorldTilesResponse['cities']>;
};

/**
 * Regenerate the full tile array and cities from a world seed.
 * The output is in compact wire format, ready to merge with a compact save.
 */
export function regenerateTiles(seed: number): RegenerateResult {
  console.time('[DD][regenerate] world from seed');
  const world = generateWorld(seed);
  console.timeEnd('[DD][regenerate] world from seed');

  return {
    tiles: world.tiles.map(toCompactTile),
    pentagonIndices: world.pentagonIndices,
    tileCount: world.tiles.length,
    pentagonCount: world.pentagonIndices.length,
    hexCount: world.tiles.length - world.pentagonIndices.length,
    cities: world.cities,
  };
}
