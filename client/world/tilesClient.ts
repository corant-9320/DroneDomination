/**
 * Client for `POST /api/world-tiles` — regenerates tiles deterministically
 * from a trusted seed.
 *
 * Owns the HTTP request, status handling, JSON decoding from `unknown`,
 * response-shape validation, and actionable transport/contract errors. Does
 * NOT own world caching or storage — see `client/world/repository.ts`.
 */

import { dbg } from '../debug.js';
import type { WireTile } from '../../shared/wireTypes.js';
import {
  ValidationError,
  expectArray,
  expectArrayOf,
  expectFiniteNumber,
  expectInteger,
  expectNonNegativeInteger,
  expectNumberEnum,
  expectObject,
  expectString,
  fail,
  optional,
} from './validation.js';

/** Validated result of `POST /api/world-tiles`. */
export interface RegeneratedWorldTiles {
  tiles: WireTile[];
  pentagonIndices: number[];
  tileCount: number;
  pentagonCount: number;
  hexCount: number;
}

function decodeWireTile(value: unknown, path: string): WireTile {
  const o = expectObject(value, path);
  const idx = expectNonNegativeInteger(o.idx, `${path}.idx`);
  const s = expectNumberEnum(o.s, `${path}.s`, [5, 6] as const);
  const n = expectArrayOf(o.n, `${path}.n`, expectNonNegativeInteger);
  const posArr = expectArray(o.pos, `${path}.pos`);
  if (posArr.length !== 3) fail(`${path}.pos`, 'expected exactly 3 elements [x, y, z]');
  const pos = posArr.map((v, i) => expectFiniteNumber(v, `${path}.pos[${i}]`)) as [number, number, number];
  const bArr = expectArray(o.b, `${path}.b`);
  const b = bArr.map((v, i) => {
    const p = `${path}.b[${i}]`;
    const vertArr = expectArray(v, p);
    if (vertArr.length !== 3) fail(p, 'expected exactly 3 elements [x, y, z]');
    return vertArr.map((c, j) => expectFiniteNumber(c, `${p}[${j}]`)) as [number, number, number];
  });
  const terrain = expectString(o.terrain, `${path}.terrain`);
  const h = optional(o.h, `${path}.h`, expectNonNegativeInteger);
  const f = o.f === undefined ? undefined : Boolean(o.f);
  const rv = optional(o.rv, `${path}.rv`, expectNonNegativeInteger);
  const city = optional(o.city, `${path}.city`, expectString);
  const resourceType = optional(o.resourceType, `${path}.resourceType`, expectString);
  const ss = optional(o.ss, `${path}.ss`, (v, p) => expectArrayOf(v, p, expectFiniteNumber));

  return { idx, s, n, pos, b, terrain, h, f, rv, city, resourceType, ss };
}

/**
 * Validate the decoded `/api/world-tiles` response body. Checks tile/pentagon
 * count consistency, unique tile indexes, and that every neighbour index is
 * in range, so a malformed or truncated response fails loudly instead of
 * corrupting the world silently.
 */
export function decodeWorldTilesResponse(value: unknown): RegeneratedWorldTiles {
  const o = expectObject(value, '');
  const tiles = expectArrayOf(o.tiles, 'tiles', decodeWireTile);
  const pentagonIndices = expectArrayOf(o.pentagonIndices, 'pentagonIndices', expectNonNegativeInteger);
  const tileCount = expectNonNegativeInteger(o.tileCount, 'tileCount');
  const pentagonCount = expectNonNegativeInteger(o.pentagonCount, 'pentagonCount');
  const hexCount = expectNonNegativeInteger(o.hexCount, 'hexCount');

  if (tiles.length !== tileCount) {
    fail('tileCount', `tileCount (${tileCount}) does not match tiles.length (${tiles.length})`);
  }
  if (pentagonIndices.length !== pentagonCount) {
    fail(
      'pentagonCount',
      `pentagonCount (${pentagonCount}) does not match pentagonIndices.length (${pentagonIndices.length})`,
    );
  }
  if (pentagonCount + hexCount !== tileCount) {
    fail('hexCount', `pentagonCount (${pentagonCount}) + hexCount (${hexCount}) must equal tileCount (${tileCount})`);
  }

  const seen = new Set<number>();
  for (let i = 0; i < tiles.length; i++) {
    const idx = tiles[i].idx;
    if (idx !== i) fail(`tiles[${i}].idx`, `expected tile index ${i} at array position ${i}, got ${idx}`);
    if (seen.has(idx)) fail(`tiles[${i}].idx`, `duplicate tile index ${idx}`);
    seen.add(idx);
  }
  for (const pIdx of pentagonIndices) {
    if (pIdx < 0 || pIdx >= tiles.length) fail('pentagonIndices', `pentagon index ${pIdx} is out of range`);
  }
  for (let i = 0; i < tiles.length; i++) {
    for (const nIdx of tiles[i].n) {
      if (nIdx < 0 || nIdx >= tiles.length) {
        fail(`tiles[${i}].n`, `neighbour index ${nIdx} is out of range (tileCount=${tiles.length})`);
      }
    }
  }

  return { tiles, pentagonIndices, tileCount, pentagonCount, hexCount };
}

/**
 * Regenerate tiles from a seed by calling the server. Returns the full,
 * runtime-validated tile array in compact wire format.
 */
export async function regenerateTilesFromSeed(seed: number): Promise<RegeneratedWorldTiles> {
  dbg.world.log('Regenerating tiles from seed:', seed);
  dbg.world.time('regenerate');
  let response: Response;
  try {
    response = await fetch('/api/world-tiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed }),
    });
  } catch (e) {
    dbg.world.timeEnd('regenerate');
    throw new Error(`Failed to reach /api/world-tiles: ${e instanceof Error ? e.message : e}`);
  }
  if (!response.ok) {
    dbg.world.timeEnd('regenerate');
    throw new Error(`Failed to regenerate tiles: ${response.status}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (e) {
    dbg.world.timeEnd('regenerate');
    throw new Error(`Failed to parse /api/world-tiles response as JSON: ${e instanceof Error ? e.message : e}`);
  }

  let result: RegeneratedWorldTiles;
  try {
    result = decodeWorldTilesResponse(json);
  } catch (e) {
    dbg.world.timeEnd('regenerate');
    if (e instanceof ValidationError) {
      throw new Error(`Invalid /api/world-tiles response: ${e.message}`);
    }
    throw e;
  }

  dbg.world.timeEnd('regenerate');
  dbg.world.log('Regenerated', result.tileCount, 'tiles from seed', seed);
  return result;
}
