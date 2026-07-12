/**
 * buildController.ts — client-side building placement and construction.
 *
 * Validates placements with the SAME pure rules the server uses
 * (`shared/buildings.ts`), so the client never disagrees with the
 * authoritative engine (Requirement 6 / 7.3). Placement inside a city is
 * otherwise unrestricted (Segment-Based Movement spec) — it also handles:
 *   - founding any city that loaded without a building (so old saves and
 *     bundled scenarios still get a starting building — Requirement 1);
 *   - committing a construction, mutating WorldData in place;
 *   - keeping `city.ownedHexes` and `tile.city` in sync.
 *
 * The per-turn construction cap (Requirement 2) is enforced by TurnManager,
 * not here.
 */

import { WorldData, BuildingData, CityData } from './worldData.js';
import {
  PlacementContext,
  PlacementValidation,
  ValidateOptions,
  validateBuildingPlacement,
  chooseFoundingSegment,
} from '../shared/buildings.js';

/** Faction id for a city (defaults to the city's own id). */
export function cityFactionId(city: CityData): string {
  return city.ownerId ?? city.id;
}

/** Find a faction's city. */
export function cityForFaction(world: WorldData, factionId: string): CityData | undefined {
  return world.cities.find((c) => cityFactionId(c) === factionId);
}

function ownedHexes(world: WorldData, factionId: string): number[] {
  const city = cityForFaction(world, factionId);
  if (!city) return [];
  return city.ownedHexes ?? [city.tileIndex];
}

/** Build the abstract world view the shared engine validates against. */
export function makePlacementContext(world: WorldData, factionId: string): PlacementContext {
  return {
    getTile(index: number) {
      const t = world.tiles[index];
      if (!t) return undefined;
      return {
        index: t.idx,
        sides: t.s,
        neighbours: t.n,
        groundPassable: t.terrain !== 'ocean',
        segSteep: t.ss ?? new Array<number>(t.s).fill(0),
      };
    },
    buildings: world.buildings.map((b) => ({
      tileIndex: b.tileIndex,
      segment: b.segment,
      ownerId: b.ownerId,
    })),
    units: world.units.map((u) => ({
      tileIndex: u.tileIndex,
      segment: u.segment,
      ownerId: u.ownerId,
    })),
    factionId,
    cityHexes: ownedHexes(world, factionId),
  };
}

/** Validate a proposed placement (pure; no mutation). Requirement 6.2. */
export function validatePlacement(
  world: WorldData,
  factionId: string,
  placement: { tileIndex: number; segment: number },
  options: ValidateOptions = {},
): PlacementValidation {
  return validateBuildingPlacement(makePlacementContext(world, factionId), placement, options);
}

/**
 * Build a context where the city's PLANNED buildings count as real ones. Used
 * by the City Design planner so planned placements honour the same rules
 * (occupancy, contiguity) as actual construction — planned buildings can
 * extend off other planned buildings, and the planned hexes join the city
 * footprint.
 */
export function makePlannedContext(
  world: WorldData,
  factionId: string,
  plannedSegs: ReadonlyArray<{ tileIndex: number; segment: number }>,
): PlacementContext {
  const base = makePlacementContext(world, factionId);
  const cityHexes = new Set(base.cityHexes);
  for (const p of plannedSegs) cityHexes.add(p.tileIndex);
  return {
    ...base,
    buildings: [
      ...base.buildings,
      ...plannedSegs.map((p) => ({ tileIndex: p.tileIndex, segment: p.segment, ownerId: factionId })),
    ],
    cityHexes: [...cityHexes],
  };
}

/**
 * Validate a planned placement against the current plan + actual buildings.
 * Because occupancy only ever shrinks the free-segment set, if this single
 * placement is legal against the existing (legal) union, the whole plan stays
 * legal — so callers can validate incrementally per add.
 */
export function validatePlannedPlacement(
  world: WorldData,
  factionId: string,
  plannedSegs: ReadonlyArray<{ tileIndex: number; segment: number }>,
  placement: { tileIndex: number; segment: number },
): PlacementValidation {
  return validateBuildingPlacement(makePlannedContext(world, factionId, plannedSegs), placement);
}

function nextBuildingId(world: WorldData): string {
  let max = -1;
  for (const b of world.buildings) {
    const m = /^building_(\d+)$/.exec(b.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `building_${max + 1}`;
}

export interface ConstructResult {
  success: boolean;
  validation: PlacementValidation;
  building?: BuildingData;
}

/**
 * Validate and commit a placement, mutating WorldData. Marks the hex
 * city-owned (Requirement 3.4). Does not check the per-turn cap.
 */
export function constructBuilding(
  world: WorldData,
  factionId: string,
  placement: { tileIndex: number; segment: number },
  options: ValidateOptions = {},
): ConstructResult {
  const validation = validatePlacement(world, factionId, placement, options);
  if (!validation.legal) return { success: false, validation };

  const building: BuildingData = {
    id: nextBuildingId(world),
    ownerId: factionId,
    tileIndex: placement.tileIndex,
    segment: placement.segment as BuildingData['segment'],
  };
  world.buildings.push(building);

  const tile = world.tiles[placement.tileIndex];
  const city = cityForFaction(world, factionId);
  // A building clears the whole hex — once anything is built, the hex is no
  // longer forested.
  if (tile) tile.f = false;
  if (city) {
    city.ownerId = factionId;
    city.ownedHexes ??= [city.tileIndex];
    if (!city.ownedHexes.includes(placement.tileIndex)) {
      city.ownedHexes.push(placement.tileIndex);
    }
    if (tile) tile.city = city.id;
  }

  return { success: true, validation, building };
}

/** Found a single city (place its free building). Requirement 1. */
export function foundCity(world: WorldData, city: CityData): BuildingData | null {
  const factionId = cityFactionId(city);
  city.ownerId = factionId;
  city.ownedHexes = [city.tileIndex];
  const tile = world.tiles[city.tileIndex];
  if (tile) {
    tile.city = city.id;
    // A city hex is a settled, cleared site — never forested.
    tile.f = false;
  }

  const segment = chooseFoundingSegment(makePlacementContext(world, factionId), city.tileIndex);
  if (segment === null) return null;

  return constructBuilding(world, factionId, { tileIndex: city.tileIndex, segment }, { founding: true })
    .building ?? null;
}

/**
 * Ensure every city has at least one building. Worlds generated by the current
 * server already arrive founded; this is a fallback for older saves and
 * bundled scenarios that predate buildings.
 */
export function ensureCitiesFounded(world: WorldData): void {
  if (!world.buildings) world.buildings = [];
  const factionsWithBuildings = new Set(world.buildings.map((b) => b.ownerId));
  for (const city of world.cities) {
    if (!factionsWithBuildings.has(cityFactionId(city))) {
      foundCity(world, city);
    }
  }
}
