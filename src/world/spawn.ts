/**
 * Unit spawning — places initial units around cities.
 *
 * Shared between the CLI generator (src/generateCli.ts) and the
 * API handler (server/generateApi.ts).
 */

import { Tile } from './types.js';
import { Unit, HexSegment, HP_PER_POINT, generateUnitName } from './units.js';

/** Unit template used for initial spawning. */
interface SpawnTemplate {
  attrs: Unit['attributes'];
}

/**
 * The 6 unit templates spawned around each city:
 * 3 Splash (2 wheeled + 1 legged) + 3 Ranged (2 wheeled + 1 legged).
 * All have maxHealth 1 and attack 1.
 */
const INITIAL_TEMPLATES: SpawnTemplate[] = [
  { attrs: { maxHealth: 1, kinetic: 1, splashAttack: 1, wheeledMovement: 1 } },
  { attrs: { maxHealth: 1, kinetic: 1, splashAttack: 1, wheeledMovement: 1 } },
  { attrs: { maxHealth: 1, kinetic: 1, splashAttack: 1, limbMovement: 1, engineer: 1 } },
  { attrs: { maxHealth: 1, kinetic: 1, rangeAttack: 1, wheeledMovement: 1 } },
  { attrs: { maxHealth: 1, kinetic: 1, rangeAttack: 1, wheeledMovement: 1 } },
  { attrs: { maxHealth: 1, kinetic: 1, rangeAttack: 1, limbMovement: 1 } },
];

/**
 * Spawn 6 initial units around each city:
 * - Placed in 3 alternating neighbour hexes (indices 0, 2, 4)
 * - 2 units per neighbour tile, in outward-facing segments
 */
export function spawnInitialUnits(
  tiles: Tile[],
  cities: { id: string; tileIndex: number }[],
): Unit[] {
  const units: Unit[] = [];
  let unitCounter = 0;

  for (const city of cities) {
    const cityTile = tiles[city.tileIndex];
    const neighbours = cityTile.neighbours;

    const selectedNeighbours = [
      neighbours[0],
      neighbours[2 % neighbours.length],
      neighbours[4 % neighbours.length],
    ];

    for (let i = 0; i < 3; i++) {
      const tileIndex = selectedNeighbours[i];
      const tile = tiles[tileIndex];
      const outwardSegment = findOutwardSegment(tiles, tileIndex, city.tileIndex);
      const seg1 = outwardSegment;
      const seg2 = ((outwardSegment + 1) % tile.sides) as HexSegment;

      const t1 = INITIAL_TEMPLATES[i * 2];
      const t2 = INITIAL_TEMPLATES[i * 2 + 1];

      units.push({
        id: `unit_${unitCounter++}`,
        label: generateUnitName(t1.attrs),
        ownerId: city.id,
        tileIndex,
        segment: seg1,
        facing: seg1,
        attributes: { ...t1.attrs },
        currentHealth: t1.attrs.maxHealth! * HP_PER_POINT,
      });

      units.push({
        id: `unit_${unitCounter++}`,
        label: generateUnitName(t2.attrs),
        ownerId: city.id,
        tileIndex,
        segment: seg2,
        facing: seg2,
        attributes: { ...t2.attrs },
        currentHealth: t2.attrs.maxHealth! * HP_PER_POINT,
      });
    }
  }

  return units;
}

/**
 * Find the segment index that faces away from a reference tile (the city centre).
 * The outward segment is opposite to the neighbour direction pointing toward the city.
 */
export function findOutwardSegment(
  tiles: Tile[],
  tileIndex: number,
  cityTileIndex: number,
): HexSegment {
  const tile = tiles[tileIndex];
  const cityDir = tile.neighbours.indexOf(cityTileIndex);
  if (cityDir === -1) return 0;
  const outward = (cityDir + Math.floor(tile.sides / 2)) % tile.sides;
  return outward as HexSegment;
}
