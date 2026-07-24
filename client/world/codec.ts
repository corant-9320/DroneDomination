/**
 * Compact-save + generated-world codec.
 *
 * Owns: the current save-format version, legacy-save recognition/migration,
 * runtime structural validation of compact saves and logistics state,
 * WireWorld bootstrap normalization (the `/api/generate` handoff), canonical
 * save projection from `WorldData`, and typed validation errors.
 *
 * Every external payload enters here as `unknown` — nothing is cast. See
 * `client/world/validation.ts` for the primitives used below.
 */

import type {
  WireCity,
  WireUnit,
  WireBuilding,
  CompactSaveV1,
} from '../../shared/wireTypes.js';
import { COMPACT_SAVE_FORMAT_VERSION } from '../../shared/wireTypes.js';
import type {
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
} from '../../shared/logisticsTypes.js';
import type { UnitAttributes } from '../../shared/unitTypes.js';
import type { WorldData } from './model.js';
import {
  ValidationError,
  childPath,
  expectArray,
  expectArrayOf,
  expectBoolean,
  expectEnum,
  expectFiniteNumber,
  expectInteger,
  expectIntegerInRange,
  expectNonEmptyString,
  expectNonNegativeInteger,
  expectNumberEnum,
  expectObject,
  expectString,
  fail,
  optional,
} from './validation.js';

export { ValidationError };

// ─── Shared field decoders ──────────────────────────────────────────────────

const SEGMENT_VALUES = [0, 1, 2, 3, 4, 5] as const;

function decodeUnitAttributes(value: unknown, path: string): UnitAttributes {
  const o = expectObject(value, path);
  const attrs: UnitAttributes = {};
  if (o.size !== undefined) attrs.size = expectIntegerInRange(o.size, `${path}.size`, 1, 5);
  if (o.kinetic !== undefined) attrs.kinetic = expectIntegerInRange(o.kinetic, `${path}.kinetic`, 0, 5);
  if (o.armour !== undefined) attrs.armour = expectIntegerInRange(o.armour, `${path}.armour`, 0, 5);
  if (o.defence !== undefined) attrs.defence = expectIntegerInRange(o.defence, `${path}.defence`, 0, 5);
  if (o.splashAttack !== undefined) attrs.splashAttack = expectIntegerInRange(o.splashAttack, `${path}.splashAttack`, 0, 5);
  if (o.rangeAttack !== undefined) attrs.rangeAttack = expectIntegerInRange(o.rangeAttack, `${path}.rangeAttack`, 0, 5);
  if (o.wheeledMovement !== undefined) attrs.wheeledMovement = expectIntegerInRange(o.wheeledMovement, `${path}.wheeledMovement`, 0, 5);
  if (o.limbMovement !== undefined) attrs.limbMovement = expectIntegerInRange(o.limbMovement, `${path}.limbMovement`, 0, 5);
  if (o.flightMovement !== undefined) attrs.flightMovement = expectIntegerInRange(o.flightMovement, `${path}.flightMovement`, 0, 5);
  if (o.repair !== undefined) attrs.repair = expectIntegerInRange(o.repair, `${path}.repair`, 0, 5);
  if (o.antiAir !== undefined) attrs.antiAir = expectIntegerInRange(o.antiAir, `${path}.antiAir`, 0, 5);
  if (o.engineer !== undefined) attrs.engineer = expectIntegerInRange(o.engineer, `${path}.engineer`, 0, 5);
  return attrs;
}

function decodeCity(value: unknown, path: string): WireCity {
  const o = expectObject(value, path);
  const id = expectNonEmptyString(o.id, `${path}.id`);
  const label = expectString(o.label, `${path}.label`);
  const tileIndex = expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`);
  const neighbourCityIds = expectArrayOf(o.neighbourCityIds, `${path}.neighbourCityIds`, expectString);
  const isPlayerHome = o.isPlayerHome === undefined ? undefined : expectBoolean(o.isPlayerHome, `${path}.isPlayerHome`);
  const ownerId = optional(o.ownerId, `${path}.ownerId`, expectString);
  const ownedHexes = optional(o.ownedHexes, `${path}.ownedHexes`, (v, p) => expectArrayOf(v, p, expectNonNegativeInteger));
  return { id, label, tileIndex, neighbourCityIds, isPlayerHome, ownerId, ownedHexes };
}

function decodeUnit(value: unknown, path: string): WireUnit {
  const o = expectObject(value, path);
  const id = expectNonEmptyString(o.id, `${path}.id`);
  const label = expectString(o.label, `${path}.label`);
  const ownerId = expectNonEmptyString(o.ownerId, `${path}.ownerId`);
  const tileIndex = expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`);
  const segment = expectNumberEnum(o.segment, `${path}.segment`, SEGMENT_VALUES);
  const facing = expectNumberEnum(o.facing, `${path}.facing`, SEGMENT_VALUES);
  const attributes = decodeUnitAttributes(o.attributes, `${path}.attributes`);
  const currentHealth = expectFiniteNumber(o.currentHealth, `${path}.currentHealth`);
  if (currentHealth < 0) fail(`${path}.currentHealth`, `expected a non-negative health value, got ${currentHealth}`);
  return { id, label, ownerId, tileIndex, segment, facing, attributes, currentHealth };
}

function decodeBuilding(value: unknown, path: string): WireBuilding {
  const o = expectObject(value, path);
  const id = expectNonEmptyString(o.id, `${path}.id`);
  const ownerId = expectNonEmptyString(o.ownerId, `${path}.ownerId`);
  const tileIndex = expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`);
  const segment = expectNumberEnum(o.segment, `${path}.segment`, SEGMENT_VALUES);
  const attributes = optional(o.attributes, `${path}.attributes`, decodeUnitAttributes);
  return { id, ownerId, tileIndex, segment, attributes };
}

// ─── Logistics decoders ─────────────────────────────────────────────────────

function decodeOilWell(value: unknown, path: string): OilWell {
  const o = expectObject(value, path);
  return {
    id: expectNonEmptyString(o.id, `${path}.id`),
    ownerId: expectNonEmptyString(o.ownerId, `${path}.ownerId`),
    tileIndex: expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`),
    segment: expectIntegerInRange(o.segment, `${path}.segment`, 0, 5),
    storedOil: expectNonNegativeInteger(o.storedOil, `${path}.storedOil`),
    hitPoints: expectNonNegativeInteger(o.hitPoints, `${path}.hitPoints`),
    maxHitPoints: expectNonNegativeInteger(o.maxHitPoints, `${path}.maxHitPoints`),
  };
}

function decodeRefinery(value: unknown, path: string): Refinery {
  const o = expectObject(value, path);
  return {
    id: expectNonEmptyString(o.id, `${path}.id`),
    ownerId: expectNonEmptyString(o.ownerId, `${path}.ownerId`),
    tileIndex: expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`),
    segments: expectArrayOf(o.segments, `${path}.segments`, (v, p) => expectIntegerInRange(v, p, 0, 5)),
    heldOil: expectNonNegativeInteger(o.heldOil, `${path}.heldOil`),
    refinedProductAvailable: expectNonNegativeInteger(o.refinedProductAvailable, `${path}.refinedProductAvailable`),
    hitPoints: expectNonNegativeInteger(o.hitPoints, `${path}.hitPoints`),
    maxHitPoints: expectNonNegativeInteger(o.maxHitPoints, `${path}.maxHitPoints`),
  };
}

const ROUTE_TIERS = ['road', 'highway'] as const;

function decodeRoute(value: unknown, path: string): LogisticsRoute {
  const o = expectObject(value, path);
  const travelTime = expectInteger(o.travelTime, `${path}.travelTime`);
  if (travelTime < 1) fail(`${path}.travelTime`, `expected an integer >= 1, got ${travelTime}`);
  return {
    id: expectNonEmptyString(o.id, `${path}.id`),
    ownerId: expectNonEmptyString(o.ownerId, `${path}.ownerId`),
    fromStructureId: expectNonEmptyString(o.fromStructureId, `${path}.fromStructureId`),
    toStructureId: expectNonEmptyString(o.toStructureId, `${path}.toStructureId`),
    segments: expectArrayOf(o.segments, `${path}.segments`, expectNonNegativeInteger),
    capacity: expectNonNegativeInteger(o.capacity, `${path}.capacity`),
    tier: expectEnum(o.tier, `${path}.tier`, ROUTE_TIERS),
    travelTime,
    operable: expectBoolean(o.operable, `${path}.operable`),
  };
}

const CARGO_TYPES = ['oil', 'product'] as const;
const TRANSPORT_TIERS = ['van', 'truck', 'juggernaut'] as const;

/** Validate `value` is a shuttle travel direction (`1` or `-1`). */
function expectShuttleDirection(value: unknown, path: string): 1 | -1 {
  const n = expectInteger(value, path);
  if (n !== 1 && n !== -1) fail(path, `expected 1 or -1, got ${n}`);
  return n;
}

function decodeTransport(value: unknown, path: string): Transport {
  const o = expectObject(value, path);
  const cargoType = o.cargoType === null ? null : expectEnum(o.cargoType, `${path}.cargoType`, CARGO_TYPES);
  const shuttleMode = optional(o.shuttleMode, `${path}.shuttleMode`, expectBoolean);
  const shuttlePath = optional(o.shuttlePath, `${path}.shuttlePath`, (v, p) => expectArrayOf(v, p, expectNonNegativeInteger));
  const shuttlePosition = optional(o.shuttlePosition, `${path}.shuttlePosition`, expectNonNegativeInteger);
  const shuttleDirection = optional(o.shuttleDirection, `${path}.shuttleDirection`, expectShuttleDirection);
  const shuttleStopped = optional(o.shuttleStopped, `${path}.shuttleStopped`, expectBoolean);
  return {
    id: expectNonEmptyString(o.id, `${path}.id`),
    ownerId: expectNonEmptyString(o.ownerId, `${path}.ownerId`),
    // A shuttle transport has no meaningful LogisticsRoute, so routeId may be
    // the empty string (see src/world/logistics/shuttle.ts::createShuttleTransport).
    routeId: expectString(o.routeId, `${path}.routeId`),
    cargoType,
    cargo: expectNonNegativeInteger(o.cargo, `${path}.cargo`),
    cargoCapacity: expectNonNegativeInteger(o.cargoCapacity, `${path}.cargoCapacity`),
    speed: expectNonNegativeInteger(o.speed, `${path}.speed`),
    defence: expectNonNegativeInteger(o.defence, `${path}.defence`),
    upgrades: expectNonNegativeInteger(o.upgrades, `${path}.upgrades`),
    tier: expectEnum(o.tier, `${path}.tier`, TRANSPORT_TIERS),
    inTransit: expectBoolean(o.inTransit, `${path}.inTransit`),
    turnsRemaining: expectNonNegativeInteger(o.turnsRemaining, `${path}.turnsRemaining`),
    unitId: expectNonEmptyString(o.unitId, `${path}.unitId`),
    ...(shuttleMode === undefined ? {} : { shuttleMode }),
    ...(shuttlePath === undefined ? {} : { shuttlePath }),
    ...(shuttlePosition === undefined ? {} : { shuttlePosition }),
    ...(shuttleDirection === undefined ? {} : { shuttleDirection }),
    ...(shuttleStopped === undefined ? {} : { shuttleStopped }),
  };
}

function decodeHub(value: unknown, path: string): DistributionHub {
  const o = expectObject(value, path);
  return {
    id: expectNonEmptyString(o.id, `${path}.id`),
    ownerId: expectNonEmptyString(o.ownerId, `${path}.ownerId`),
    tileIndex: expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`),
    segment: expectIntegerInRange(o.segment, `${path}.segment`, 0, 5),
    buffer: expectNonNegativeInteger(o.buffer, `${path}.buffer`),
    routeIds: expectArrayOf(o.routeIds, `${path}.routeIds`, expectString),
    hitPoints: expectNonNegativeInteger(o.hitPoints, `${path}.hitPoints`),
    maxHitPoints: expectNonNegativeInteger(o.maxHitPoints, `${path}.maxHitPoints`),
  };
}

function decodeHomeStock(value: unknown, path: string): HomeStock {
  const o = expectObject(value, path);
  return {
    factionId: expectNonEmptyString(o.factionId, `${path}.factionId`),
    refinedProduct: expectNonNegativeInteger(o.refinedProduct, `${path}.refinedProduct`),
    oil: expectNonNegativeInteger(o.oil, `${path}.oil`),
  };
}

function decodeHomeRecord(value: unknown, path: string): Record<string, HomeStock> {
  const o = expectObject(value, path);
  const result: Record<string, HomeStock> = {};
  for (const [key, v] of Object.entries(o)) {
    result[key] = decodeHomeStock(v, childPath(path, key));
  }
  return result;
}

const ENGINEER_TASK_KINDS = ['well', 'clearForest', 'bridge', 'road'] as const;

function decodeEngineerTask(value: unknown, path: string): EngineerTask {
  const o = expectObject(value, path);
  return {
    id: expectNonEmptyString(o.id, `${path}.id`),
    kind: expectEnum(o.kind, `${path}.kind`, ENGINEER_TASK_KINDS),
    unitId: expectNonEmptyString(o.unitId, `${path}.unitId`),
    tileIndex: expectNonNegativeInteger(o.tileIndex, `${path}.tileIndex`),
    segment: optional(o.segment, `${path}.segment`, (v, p) => expectIntegerInRange(v, p, 0, 5)),
    turnsRemaining: expectNonNegativeInteger(o.turnsRemaining, `${path}.turnsRemaining`),
    ownerId: expectNonEmptyString(o.ownerId, `${path}.ownerId`),
  };
}

/** Validate a complete `LogisticsState`. Exported for direct use by tests/other decoders. */
export function decodeLogisticsState(value: unknown, path: string): LogisticsState {
  const o = expectObject(value, path);
  return {
    wells: expectArrayOf(o.wells, `${path}.wells`, decodeOilWell),
    refineries: expectArrayOf(o.refineries, `${path}.refineries`, decodeRefinery),
    routes: expectArrayOf(o.routes, `${path}.routes`, decodeRoute),
    transports: expectArrayOf(o.transports, `${path}.transports`, decodeTransport),
    hubs: expectArrayOf(o.hubs, `${path}.hubs`, decodeHub),
    home: decodeHomeRecord(o.home, `${path}.home`),
    tasks: expectArrayOf(o.tasks, `${path}.tasks`, decodeEngineerTask),
    clearedForests: expectArrayOf(o.clearedForests, `${path}.clearedForests`, expectNonNegativeInteger),
    bridges: expectArrayOf(o.bridges, `${path}.bridges`, expectNonNegativeInteger),
    ...(o.standaloneRoadSegments === undefined
      ? {}
      : {
        standaloneRoadSegments: expectArrayOf(
          o.standaloneRoadSegments,
          `${path}.standaloneRoadSegments`,
          expectNonNegativeInteger,
        ),
      }),
  };
}

// ─── Compact-save envelope decoding + legacy migration ─────────────────────

/**
 * Decode a persisted/bundled compact save from `unknown`. Recognizes both the
 * canonical version-1 shape and the legacy unversioned shape (no
 * `formatVersion` field — "version 0"), migrating the latter to
 * `CompactSaveV1` without mutating the source object. Rejects any explicit
 * `formatVersion` other than the current one.
 */
export function decodeCompactSave(value: unknown, path = ''): CompactSaveV1 {
  const o = expectObject(value, path);
  expectEnum(o.format, childPath(path, 'format'), ['compact'] as const);

  if (o.formatVersion !== undefined) {
    expectNumberEnum(o.formatVersion, childPath(path, 'formatVersion'), [COMPACT_SAVE_FORMAT_VERSION] as const);
  }
  // o.formatVersion === undefined => legacy version 0, migrated below.

  const seed = expectInteger(o.seed, childPath(path, 'seed'));
  const cities = expectArrayOf(o.cities, childPath(path, 'cities'), decodeCity);
  // Legacy compatibility: older saves may omit units entirely.
  const units = o.units === undefined ? [] : expectArrayOf(o.units, childPath(path, 'units'), decodeUnit);
  const buildings = optional(o.buildings, childPath(path, 'buildings'), (v, p) => expectArrayOf(v, p, decodeBuilding));
  const playerColor = optional(o.playerColor, childPath(path, 'playerColor'), expectString);
  const battleCentreTile = optional(o.battleCentreTile, childPath(path, 'battleCentreTile'), expectNonNegativeInteger);
  const bridges = optional(o.bridges, childPath(path, 'bridges'), (v, p) => expectArrayOf(v, p, expectNonNegativeInteger));
  const logistics = optional(o.logistics, childPath(path, 'logistics'), decodeLogisticsState);

  return {
    format: 'compact',
    formatVersion: COMPACT_SAVE_FORMAT_VERSION,
    seed,
    cities,
    units,
    buildings,
    playerColor,
    battleCentreTile,
    bridges,
    logistics,
  };
}

/**
 * Decode a generated-world bootstrap payload (the `/api/generate` handoff)
 * from `unknown`, projecting it into `CompactSaveV1`. Recognizes both the
 * current server response (a compact-shaped payload with no deterministic
 * tiles) and a full `WireWorld` payload (which additionally carries `tiles`,
 * `tileCount`, `pentagonIndices`, etc.) — those deterministic-geometry fields
 * are read but never carried into the projected save; the client always
 * regenerates tiles from the seed after reload.
 */
export function decodeWorldBootstrap(value: unknown, path = ''): CompactSaveV1 {
  const o = expectObject(value, path);
  const seed = expectInteger(o.seed, childPath(path, 'seed'));
  const cities = expectArrayOf(o.cities, childPath(path, 'cities'), decodeCity);
  const units = o.units === undefined ? [] : expectArrayOf(o.units, childPath(path, 'units'), decodeUnit);
  const buildings = optional(o.buildings, childPath(path, 'buildings'), (v, p) => expectArrayOf(v, p, decodeBuilding));
  const playerColor = optional(o.playerColor, childPath(path, 'playerColor'), expectString);
  const battleCentreTile = optional(o.battleCentreTile, childPath(path, 'battleCentreTile'), expectNonNegativeInteger);
  const bridges = optional(o.bridges, childPath(path, 'bridges'), (v, p) => expectArrayOf(v, p, expectNonNegativeInteger));
  const logistics = optional(o.logistics, childPath(path, 'logistics'), decodeLogisticsState);

  // Deterministic-geometry fields are validated as a courtesy (catches a
  // truncated/corrupt bootstrap early) but intentionally never copied into
  // the projected save — tiles are always regenerated from the seed.
  if (o.tiles !== undefined) expectArray(o.tiles, childPath(path, 'tiles'));
  if (o.pentagonIndices !== undefined) expectArray(o.pentagonIndices, childPath(path, 'pentagonIndices'));

  return {
    format: 'compact',
    formatVersion: COMPACT_SAVE_FORMAT_VERSION,
    seed,
    cities,
    units,
    buildings,
    playerColor,
    battleCentreTile,
    bridges,
    logistics,
  };
}

/**
 * Compatibility entry point for any unknown world-shaped input the client
 * receives (session-storage handoff, `applyNewWorld` callers, bundled
 * scenario files). Dispatches to `decodeCompactSave` when the payload
 * declares `format: 'compact'`, otherwise treats it as a generated-world
 * bootstrap payload (`decodeWorldBootstrap`) — the two are recognized and
 * validated as distinct input shapes, not merged into one loosely-inferred
 * decoder.
 */
export function decodeWorldInput(value: unknown): CompactSaveV1 {
  const o = expectObject(value, '');
  if ('format' in o) {
    if (o.format !== 'compact') {
      fail('format', `expected "compact", got ${JSON.stringify(o.format)}`);
    }
    return decodeCompactSave(value);
  }
  return decodeWorldBootstrap(value);
}

/**
 * Project the current live `WorldData` into a canonical `CompactSaveV1`.
 * Includes the complete logistics state (previously omitted — the known
 * save-time logistics-loss regression) and derives the bridge-tile overlay
 * from `tile.bridge`, which already carries both legacy player-built bridges
 * and completed logistics bridges (the two overlays converge on the same
 * runtime flag; see `docs/architecture/known-issues.md`).
 */
export function projectCompactSave(world: WorldData): CompactSaveV1 {
  const bridges: number[] = [];
  for (const tile of world.tiles) {
    if (tile.bridge) bridges.push(tile.idx);
  }
  return {
    format: 'compact',
    formatVersion: COMPACT_SAVE_FORMAT_VERSION,
    seed: world.seed,
    cities: world.cities,
    units: world.units,
    buildings: world.buildings,
    playerColor: world.playerColor,
    battleCentreTile: world.battleCentreTile,
    bridges: bridges.length > 0 ? bridges : undefined,
    logistics: world.logistics,
  };
}
