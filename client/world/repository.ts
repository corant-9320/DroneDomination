/**
 * World cache, load-source selection, session-storage handoff, and reload.
 *
 * Owns the module-level world cache, `getWorld`/`loadWorld`, the
 * session-storage handoff, the default-scenario fetch, `applyNewWorld`, and
 * publishing a successfully expanded world. `cachedWorld` is assigned only
 * after decode, validation, regeneration, and expansion all succeed — no
 * failed load ever publishes a partial `WorldData`, and no second world
 * cache exists anywhere else in the client.
 */

import { dbg } from '../debug.js';
import type { WorldData } from './model.js';
import type { CompactSaveV1 } from '../../shared/wireTypes.js';
import { decodeCompactSave, decodeWorldInput, projectCompactSave, ValidationError } from './codec.js';
import { expandCompactSave } from './expand.js';

const SESSION_STORAGE_KEY = 'drone-domination-world';

let cachedWorld: WorldData | null = null;

/** Returns the currently loaded world, or null if not yet loaded. */
export function getWorld(): WorldData | null {
  return cachedWorld;
}

/**
 * Returns a canonical version-1 compact save representation of the current
 * world state, or null if no world is loaded. Omits tiles (they can be
 * regenerated from the seed). Includes the complete logistics state (Phase 3
 * fix — previously omitted, losing logistics on every save).
 */
export function getCompactSave(): CompactSaveV1 | null {
  if (!cachedWorld) return null;
  return projectCompactSave(cachedWorld);
}

async function loadFromSessionStorage(stored: string): Promise<WorldData> {
  dbg.world.log('Loading world from sessionStorage');
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch (e) {
    throw new Error(`Corrupt session-storage world handoff (invalid JSON): ${e instanceof Error ? e.message : e}`);
  }
  // The handoff is written exclusively by applyNewWorld below, which already
  // normalizes through decodeWorldInput — but decode again defensively so a
  // malformed handoff (e.g. from an older client version) fails loudly with a
  // clear error instead of corrupting the world or looping reloads forever.
  const decoded = decodeCompactSave(raw);
  const data = await expandCompactSave(decoded);
  dbg.world.log('Loaded from sessionStorage:', {
    seed: data.seed,
    tiles: data.tileCount,
    cities: data.cities.length,
    units: data.units.length,
  });
  return data;
}

async function loadDefaultScenario(): Promise<WorldData> {
  dbg.world.log('Fetching /default-scenario.json from server');
  const response = await fetch('/default-scenario.json?v=' + Date.now());
  if (!response.ok) {
    dbg.world.error('Failed to load /default-scenario.json, status:', response.status);
    throw new Error(`Failed to load default-scenario.json: ${response.status}`);
  }
  const raw: unknown = await response.json();
  // The bundled default scenario may be a legacy unversioned compact save, a
  // version-1 compact save, or (in principle) a full bootstrap payload —
  // decodeWorldInput recognizes and normalizes any of those shapes.
  const decoded = decodeWorldInput(raw);
  const data = await expandCompactSave(decoded);

  dbg.world.log('Loaded world:', {
    seed: data.seed,
    tiles: data.tileCount,
    pentagons: data.pentagonCount,
    cities: data.cities.length,
    units: data.units.length,
  });
  return data;
}

/**
 * Load the world: returns the cached world if present, otherwise consumes a
 * fresh-world session-storage handoff if one exists, otherwise fetches the
 * bundled default scenario. `cachedWorld` is only assigned once the entire
 * decode → validate → regenerate → expand pipeline has succeeded.
 */
export async function loadWorld(): Promise<WorldData> {
  if (cachedWorld) {
    dbg.world.log('Returning cached world');
    return cachedWorld;
  }

  const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
  const data = stored ? await loadFromSessionStorage(stored) : await loadDefaultScenario();

  cachedWorld = data;
  return cachedWorld;
}

/** Store a new world and reload the page so all views reinitialize.
 *
 * A full page reload is intentional here. The Three.js GlobeView and the
 * Canvas 2D LocalMapView both build their geometry once at construction time
 * from the world data. There is no hot-swap path — reinitializing them in
 * place would require tearing down and rebuilding all WebGL buffers, event
 * listeners, and cached tile projections. A reload is simpler and more
 * reliable. The new world is passed via sessionStorage so it survives the
 * reload without a round-trip to the server.
 *
 * `data` is decoded and normalized to the canonical version-1 compact shape
 * BEFORE being written to session storage, so a malformed caller input fails
 * immediately (before the reload) rather than writing garbage that would
 * fail on the next load and potentially loop. The `format`/`formatVersion`
 * dispatch inside `decodeWorldInput` recognizes both a persisted compact save
 * and a generated-world bootstrap payload.
 */
export function applyNewWorld(data: unknown): void {
  dbg.world.log('applyNewWorld called, decoding before storing to sessionStorage');
  let decoded;
  try {
    decoded = decodeWorldInput(data);
  } catch (e) {
    const message = e instanceof ValidationError ? e.message : String(e);
    dbg.world.error('applyNewWorld: rejected invalid input:', message);
    throw new Error(`Cannot apply new world — invalid data: ${message}`);
  }
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(decoded));
  window.location.reload();
}
