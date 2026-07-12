/**
 * cityPlan.ts — persistence for the City Design planner.
 *
 * A "plan" is a set of planned (not-yet-built) building segments per city. It
 * lets the player lay out a city ahead of time. Plans are remembered between
 * invocations by persisting to localStorage, keyed by world seed (segment
 * indices are tile-specific, so plans must not bleed across worlds).
 *
 * Plans are NOT part of the authoritative save — they are a personal planning
 * overlay. `syncPlannedToWorld` flattens the active plans into
 * `world.plannedBuildings` for rendering (greyed out), excluding any segment
 * that already holds a real building.
 */

import { WorldData, BuildingData, CityData } from './worldData.js';
import { cityFactionId } from './buildController.js';
import { dbg } from './debug.js';

/** A single planned building position. */
export interface PlannedSeg {
  tileIndex: number;
  segment: number;
}

/** Map of cityId → planned segments. */
type PlanMap = Record<string, PlannedSeg[]>;

const STORAGE_PREFIX = 'dd-city-plans-';

/** In-memory cache keyed by seed. */
const cache = new Map<number, PlanMap>();

function storageKey(seed: number): string {
  return `${STORAGE_PREFIX}${seed}`;
}

/** Load all city plans for a seed (cached). */
export function loadCityPlans(seed: number): PlanMap {
  const cached = cache.get(seed);
  if (cached) return cached;

  let plans: PlanMap = {};
  try {
    const raw = localStorage.getItem(storageKey(seed));
    if (raw) plans = JSON.parse(raw) as PlanMap;
  } catch (e) {
    dbg.world.warn('Failed to load city plans:', e);
  }
  cache.set(seed, plans);
  return plans;
}

/** Persist all city plans for a seed. */
function persist(seed: number, plans: PlanMap): void {
  cache.set(seed, plans);
  try {
    localStorage.setItem(storageKey(seed), JSON.stringify(plans));
  } catch (e) {
    dbg.world.warn('Failed to save city plans:', e);
  }
}

/** Planned segments for one city (empty array if none). */
export function getCityPlan(seed: number, cityId: string): PlannedSeg[] {
  return loadCityPlans(seed)[cityId] ?? [];
}

/** Whether a specific segment is planned for a city. */
export function isPlanned(seed: number, cityId: string, tileIndex: number, segment: number): boolean {
  return getCityPlan(seed, cityId).some((p) => p.tileIndex === tileIndex && p.segment === segment);
}

/**
 * Toggle a planned segment for a city. Returns the new planned state
 * (true = now planned, false = removed).
 */
export function togglePlanned(
  seed: number,
  cityId: string,
  tileIndex: number,
  segment: number,
): boolean {
  const plans = loadCityPlans(seed);
  const list = plans[cityId] ?? [];
  const idx = list.findIndex((p) => p.tileIndex === tileIndex && p.segment === segment);
  let nowPlanned: boolean;
  if (idx >= 0) {
    list.splice(idx, 1);
    nowPlanned = false;
  } else {
    list.push({ tileIndex, segment });
    nowPlanned = true;
  }
  plans[cityId] = list;
  persist(seed, plans);
  return nowPlanned;
}

/** Remove a planned segment if present (e.g. once it has actually been built). */
export function clearPlanned(seed: number, cityId: string, tileIndex: number, segment: number): void {
  const plans = loadCityPlans(seed);
  const list = plans[cityId];
  if (!list) return;
  const idx = list.findIndex((p) => p.tileIndex === tileIndex && p.segment === segment);
  if (idx >= 0) {
    list.splice(idx, 1);
    persist(seed, plans);
  }
}

/** Clear the entire plan for a city. */
export function clearCityPlan(seed: number, cityId: string): void {
  const plans = loadCityPlans(seed);
  if (plans[cityId]) {
    plans[cityId] = [];
    persist(seed, plans);
  }
}

/**
 * Re-prune a city's plan so every planned building stays contiguous with the
 * actual city. Removing a planned building can orphan others that only extended
 * off it; those are dropped (cascading) until the plan is fully connected to an
 * actual faction building via hex adjacency. Contiguity is the only invariant a
 * removal can violate — placement is otherwise unrestricted (Segment-Based
 * Movement spec), so there is no through-street/reachability rule to re-check.
 *
 * Returns the number of planned buildings pruned.
 */
export function prunePlan(world: WorldData, city: CityData): number {
  const seed = world.seed;
  const factionId = cityFactionId(city);
  const plan = getCityPlan(seed, city.id);
  if (plan.length === 0) return 0;

  // Seed connectivity from hexes that already hold a real faction building.
  const connected = new Set<number>();
  for (const b of world.buildings) {
    if (b.ownerId === factionId) connected.add(b.tileIndex);
  }

  const plannedHexes = [...new Set(plan.map((p) => p.tileIndex))];

  // Grow the connected set: a planned hex joins if it is adjacent to (or equal
  // to) an already-connected hex. Iterate to a fixpoint.
  let changed = true;
  while (changed) {
    changed = false;
    for (const hex of plannedHexes) {
      if (connected.has(hex)) continue;
      const tile = world.tiles[hex];
      if (tile && tile.n.some((n) => connected.has(n))) {
        connected.add(hex);
        changed = true;
      }
    }
  }

  const kept = plan.filter((p) => connected.has(p.tileIndex));
  const pruned = plan.length - kept.length;
  if (pruned > 0) {
    const plans = loadCityPlans(seed);
    plans[city.id] = kept;
    persist(seed, plans);
  }
  return pruned;
}

/**
 * Flatten all city plans into `world.plannedBuildings` for rendering. Any
 * planned segment that already holds a real building is dropped (and pruned
 * from the stored plan, since it is now fulfilled).
 */
export function syncPlannedToWorld(world: WorldData): void {
  const seed = world.seed;
  const plans = loadCityPlans(seed);
  const actual = new Set(world.buildings.map((b) => `${b.tileIndex}:${b.segment}`));
  const result: BuildingData[] = [];
  let mutated = false;

  for (const city of world.cities) {
    const factionId = cityFactionId(city);
    const list = plans[city.id];
    if (!list) continue;
    const kept: PlannedSeg[] = [];
    for (const p of list) {
      if (actual.has(`${p.tileIndex}:${p.segment}`)) {
        mutated = true; // fulfilled — drop from the plan
        continue;
      }
      kept.push(p);
      result.push({
        id: `plan_${city.id}_${p.tileIndex}_${p.segment}`,
        ownerId: factionId,
        tileIndex: p.tileIndex,
        segment: p.segment as BuildingData['segment'],
      });
    }
    plans[city.id] = kept;
  }

  if (mutated) persist(seed, plans);
  world.plannedBuildings = result;
}
