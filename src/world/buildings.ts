/**
 * Buildings — server-side adapter over the shared placement engine.
 *
 * Bridges the authoritative `World` to the pure rules in
 * `shared/buildings.ts`, and provides the stateful operations the rest of the
 * server needs: founding a city's free building and committing a
 * construction. Placement inside a buildable cluster is otherwise
 * unrestricted (Segment-Based Movement spec) — there is no through-street or
 * external-reachability integrity check to run here.
 */

import { World, Building, City } from './types.js';
import {
  PlacementContext,
  PlacementValidation,
  ValidateOptions,
  validateBuildingPlacement,
  chooseFoundingSegment,
} from '../../shared/buildings.js';

/** A tile is ground-passable for street purposes when it is not ocean. */
function groundPassable(terrainType: string): boolean {
  return terrainType !== 'ocean';
}

/** Resolve a faction's city (faction id defaults to the city's own id). */
export function cityForFaction(world: World, factionId: string): City | undefined {
  return world.cities.find((c) => (c.ownerId ?? c.id) === factionId);
}

/** Hexes currently owned by a faction's city (capital + built-on hexes). */
function ownedHexes(world: World, factionId: string): number[] {
  const city = cityForFaction(world, factionId);
  if (!city) return [];
  return city.ownedHexes ?? [city.tileIndex];
}

/** Build the abstract world view the shared engine validates against. */
export function makePlacementContext(world: World, factionId: string): PlacementContext {
  return {
    getTile(index: number) {
      const t = world.tiles[index];
      if (!t) return undefined;
      return {
        index: t.index,
        sides: t.sides,
        neighbours: t.neighbours,
        groundPassable: groundPassable(t.terrainType),
        segSteep: t.segSteep,
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

/** Allocate the next stable building id. */
function nextBuildingId(world: World): string {
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
  building?: Building;
}

/**
 * Validate and commit a building placement for a faction. On success the world
 * is mutated: the building is added, the tile's `buildingIds` updated, and the
 * hex marked city-owned (Requirement 3.4). Does NOT enforce the per-turn cap —
 * that is the caller's (turn manager's) responsibility (Requirement 2).
 */
export function constructBuilding(
  world: World,
  factionId: string,
  placement: { tileIndex: number; segment: number },
  options: ValidateOptions = {},
): ConstructResult {
  const ctx = makePlacementContext(world, factionId);
  const validation = validateBuildingPlacement(ctx, placement, options);
  if (!validation.legal) return { success: false, validation };

  const building: Building = {
    id: nextBuildingId(world),
    ownerId: factionId,
    tileIndex: placement.tileIndex,
    segment: placement.segment,
  };
  world.buildings.push(building);

  const tile = world.tiles[placement.tileIndex];
  (tile.buildingIds ??= []).push(building.id);
  // A building clears the whole hex — once anything is built, the hex is no
  // longer forested.
  tile.forested = false;

  const city = cityForFaction(world, factionId);
  if (city) {
    city.ownerId = factionId;
    city.ownedHexes ??= [city.tileIndex];
    if (!city.ownedHexes.includes(placement.tileIndex)) {
      city.ownedHexes.push(placement.tileIndex);
    }
    tile.cityId = city.id;
    tile.ownerId = factionId;
  }

  return { success: true, validation, building };
}

/**
 * Found a city: mark the capital hex city-owned and place one free building on
 * the first A2-legal segment (Requirement 1, A3 — no through-street
 * preference). Returns the founding building, or null if no legal segment
 * exists.
 */
export function foundCity(world: World, city: City): Building | null {
  const factionId = city.ownerId ?? city.id;
  city.ownerId = factionId;
  city.ownedHexes = [city.tileIndex];

  const tile = world.tiles[city.tileIndex];
  tile.cityId = city.id;
  tile.ownerId = factionId;
  // A city hex is a settled, cleared site — never forested.
  tile.forested = false;

  const ctx = makePlacementContext(world, factionId);
  const segment = chooseFoundingSegment(ctx, city.tileIndex);
  if (segment === null) return null;

  const result = constructBuilding(
    world,
    factionId,
    { tileIndex: city.tileIndex, segment },
    { founding: true },
  );
  return result.building ?? null;
}

/** Found every city in the given list (Requirement 1.1). */
export function foundCities(world: World, cities: City[] = world.cities): void {
  for (const city of cities) foundCity(world, city);
}
