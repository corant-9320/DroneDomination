// Phase 3 — versioned world-data contracts: codec tests.
//
// Covers `client/world/codec.ts`: decoding canonical v1 saves, migrating
// legacy (unversioned) saves, normalizing generated-world bootstrap payloads,
// and rejecting malformed input with actionable error paths.

import { describe, it, expect } from 'vitest';
import {
  decodeCompactSave,
  decodeWorldBootstrap,
  decodeWorldInput,
  projectCompactSave,
  ValidationError,
} from '../world/codec.js';
import type { WorldData } from '../world/model.js';
import type { LogisticsState } from '../../shared/logisticsTypes.js';

function makeLogistics(overrides: Partial<LogisticsState> = {}): LogisticsState {
  return {
    wells: [],
    refineries: [],
    routes: [],
    transports: [],
    hubs: [],
    home: {},
    tasks: [],
    clearedForests: [],
    bridges: [],
    ...overrides,
  };
}

function makeCity(id = 'city_0') {
  return { id, label: 'C', tileIndex: 5, neighbourCityIds: [] as string[] };
}

function makeUnit(id = 'unit_0') {
  return {
    id,
    label: 'Scout',
    ownerId: 'city_0',
    tileIndex: 5,
    segment: 0 as const,
    facing: 0 as const,
    attributes: { wheeledMovement: 3 },
    currentHealth: 10,
  };
}

function makeV1Save(overrides: Record<string, unknown> = {}) {
  return {
    format: 'compact',
    formatVersion: 1,
    seed: 42,
    cities: [makeCity()],
    units: [makeUnit()],
    buildings: [],
    ...overrides,
  };
}

describe('decodeCompactSave — canonical version 1', () => {
  it('decodes a well-formed v1 save', () => {
    const decoded = decodeCompactSave(makeV1Save());
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.seed).toBe(42);
    expect(decoded.cities).toHaveLength(1);
    expect(decoded.units).toHaveLength(1);
  });

  it('preserves all optional fields', () => {
    const logistics = makeLogistics({ bridges: [3, 7] });
    const decoded = decodeCompactSave(makeV1Save({
      playerColor: '#abcdef',
      battleCentreTile: 12,
      bridges: [1, 2],
      logistics,
    }));
    expect(decoded.playerColor).toBe('#abcdef');
    expect(decoded.battleCentreTile).toBe(12);
    expect(decoded.bridges).toEqual([1, 2]);
    expect(decoded.logistics).toEqual(logistics);
  });

  it('rejects an unsupported explicit formatVersion', () => {
    expect(() => decodeCompactSave(makeV1Save({ formatVersion: 2 }))).toThrow(ValidationError);
  });

  it('rejects a missing format field', () => {
    const bad = makeV1Save();
    delete (bad as Record<string, unknown>).format;
    expect(() => decodeCompactSave(bad)).toThrow(ValidationError);
  });

  it('rejects a wrong format value', () => {
    expect(() => decodeCompactSave(makeV1Save({ format: 'full' }))).toThrow(ValidationError);
  });

  it('rejects malformed cities', () => {
    expect(() => decodeCompactSave(makeV1Save({ cities: [{ id: 'x' }] }))).toThrow(ValidationError);
  });

  it('rejects malformed units', () => {
    const badUnit = { ...makeUnit(), segment: 9 };
    expect(() => decodeCompactSave(makeV1Save({ units: [badUnit] }))).toThrow(ValidationError);
  });

  it('rejects malformed buildings', () => {
    const badBuilding = { id: 'b', ownerId: 'city_0', tileIndex: 5, segment: 0, attributes: { kinetic: 9 } };
    expect(() => decodeCompactSave(makeV1Save({ buildings: [badBuilding] }))).toThrow(ValidationError);
  });

  it('preserves the building-component 0..5 invariant on valid buildings', () => {
    const building = { id: 'b', ownerId: 'city_0', tileIndex: 5, segment: 0, attributes: { kinetic: 5, armour: 0 } };
    const decoded = decodeCompactSave(makeV1Save({ buildings: [building] }));
    expect(decoded.buildings?.[0].attributes?.kinetic).toBe(5);
    expect(decoded.buildings?.[0].attributes?.armour).toBe(0);
  });

  it('rejects malformed logistics collections', () => {
    const bad = makeLogistics({ wells: [{ id: 'w', ownerId: 'f', tileIndex: -1, segment: 0, storedOil: 0, hitPoints: 1, maxHitPoints: 1 }] });
    expect(() => decodeCompactSave(makeV1Save({ logistics: bad }))).toThrow(ValidationError);
  });

  it('rejects invalid logistics enum values', () => {
    const bad = makeLogistics({
      routes: [{
        id: 'r', ownerId: 'f', fromStructureId: 'a', toStructureId: 'b',
        segments: [], capacity: 100, tier: 'dirt-track' as unknown as 'road', travelTime: 1, operable: true,
      }],
    });
    expect(() => decodeCompactSave(makeV1Save({ logistics: bad }))).toThrow(ValidationError);
  });

  it('rejects non-finite, fractional, or negative values where prohibited', () => {
    expect(() => decodeCompactSave(makeV1Save({ seed: Number.NaN }))).toThrow(ValidationError);
    expect(() => decodeCompactSave(makeV1Save({ seed: 1.5 }))).toThrow(ValidationError);
    const badUnit = { ...makeUnit(), currentHealth: -5 };
    expect(() => decodeCompactSave(makeV1Save({ units: [badUnit] }))).toThrow(ValidationError);
  });

  it('includes a useful property path in errors', () => {
    const badUnit = { ...makeUnit(), tileIndex: -1 };
    try {
      decodeCompactSave(makeV1Save({ units: [badUnit] }));
      expect.unreachable('expected a ValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).path).toBe('units[0].tileIndex');
    }
  });

  it('tolerates irrelevant unknown metadata without treating it as known data', () => {
    const decoded = decodeCompactSave({ ...makeV1Save(), someFutureField: { anything: true } });
    expect(decoded.seed).toBe(42);
    expect((decoded as unknown as Record<string, unknown>).someFutureField).toBeUndefined();
  });
});

describe('decodeCompactSave — legacy migration (version 0)', () => {
  it('migrates an unversioned compact save, adding formatVersion: 1', () => {
    const legacy = makeV1Save();
    delete (legacy as Record<string, unknown>).formatVersion;
    const decoded = decodeCompactSave(legacy);
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.seed).toBe(42);
  });

  it('does not mutate the source object', () => {
    const legacy = makeV1Save();
    delete (legacy as Record<string, unknown>).formatVersion;
    const snapshot: unknown = JSON.parse(JSON.stringify(legacy));
    decodeCompactSave(legacy);
    expect(legacy).toEqual(snapshot);
  });

  it('defaults missing legacy units to an empty array', () => {
    const legacy = makeV1Save();
    delete (legacy as Record<string, unknown>).formatVersion;
    delete (legacy as Record<string, unknown>).units;
    const decoded = decodeCompactSave(legacy);
    expect(decoded.units).toEqual([]);
  });

  it('preserves optional fields through migration', () => {
    const legacy = makeV1Save({ playerColor: '#112233', bridges: [4] });
    delete (legacy as Record<string, unknown>).formatVersion;
    const decoded = decodeCompactSave(legacy);
    expect(decoded.playerColor).toBe('#112233');
    expect(decoded.bridges).toEqual([4]);
  });
});

describe('decodeWorldBootstrap — generated-world normalization', () => {
  it('normalizes a valid full WireWorld bootstrap payload, dropping deterministic tiles', () => {
    const bootstrap = {
      seed: 99,
      tileCount: 42,
      pentagonCount: 12,
      hexCount: 30,
      pentagonIndices: [0, 1, 2],
      cities: [makeCity()],
      units: [makeUnit()],
      buildings: [],
      tiles: [{ idx: 0, s: 6, n: [], pos: [0, 0, 0], b: [], terrain: 'plains' }],
      logistics: makeLogistics(),
    };
    const decoded = decodeWorldBootstrap(bootstrap);
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.seed).toBe(99);
    expect(decoded.cities).toHaveLength(1);
    expect((decoded as unknown as Record<string, unknown>).tiles).toBeUndefined();
    expect((decoded as unknown as Record<string, unknown>).tileCount).toBeUndefined();
  });

  it('normalizes the compact-shaped /api/generate payload (no tiles field)', () => {
    const bootstrap = { seed: 7, cities: [makeCity()], units: [makeUnit()], buildings: [], logistics: makeLogistics() };
    const decoded = decodeWorldBootstrap(bootstrap);
    expect(decoded.seed).toBe(7);
    expect(decoded.logistics).toEqual(makeLogistics());
  });

  it('rejects a malformed bootstrap payload', () => {
    expect(() => decodeWorldBootstrap({ cities: [] })).toThrow(ValidationError);
  });
});

describe('decodeWorldInput — compatibility dispatch', () => {
  it('routes a compact-formatted save through decodeCompactSave', () => {
    const decoded = decodeWorldInput(makeV1Save());
    expect(decoded.formatVersion).toBe(1);
  });

  it('routes a non-compact payload through decodeWorldBootstrap', () => {
    const bootstrap = { seed: 7, cities: [makeCity()], units: [makeUnit()] };
    const decoded = decodeWorldInput(bootstrap);
    expect(decoded.seed).toBe(7);
    expect(decoded.formatVersion).toBe(1);
  });

  it('rejects an explicit non-compact format value', () => {
    expect(() => decodeWorldInput({ format: 'full', seed: 1 })).toThrow(ValidationError);
  });
});

describe('projectCompactSave — save round-trip', () => {
  function makeWorld(overrides: Partial<WorldData> = {}): WorldData {
    return {
      seed: 42,
      tileCount: 2,
      pentagonCount: 0,
      hexCount: 2,
      pentagonIndices: [],
      cities: [makeCity()],
      tiles: [
        { idx: 0, s: 6, n: [1], pos: [0, 0, 0], b: [], terrain: 'plains' },
        { idx: 1, s: 6, n: [0], pos: [1, 0, 0], b: [], terrain: 'plains' },
      ],
      units: [makeUnit()],
      buildings: [],
      ...overrides,
    };
  }

  it('projects a current-format save that decodes back to the same content', () => {
    const logistics = makeLogistics({ bridges: [1], clearedForests: [] });
    const world = makeWorld({ logistics, playerColor: '#fff000', battleCentreTile: 1 });
    const projected = projectCompactSave(world);
    expect(projected.formatVersion).toBe(1);
    expect(projected.logistics).toEqual(logistics);
    expect(projected.playerColor).toBe('#fff000');
    expect(projected.battleCentreTile).toBe(1);

    // Round-trips cleanly back through the decoder.
    const decoded = decodeCompactSave(projected);
    expect(decoded).toEqual(projected);
  });

  it('derives the bridge overlay from tile.bridge flags', () => {
    const world = makeWorld();
    world.tiles[1].bridge = true;
    const projected = projectCompactSave(world);
    expect(projected.bridges).toEqual([1]);
  });

  it('omits bridges when no tile has the flag set', () => {
    const world = makeWorld();
    const projected = projectCompactSave(world);
    expect(projected.bridges).toBeUndefined();
  });

  it('THE KNOWN REGRESSION GUARD: includes logistics in the projected save', () => {
    const logistics = makeLogistics({
      home: { city_0: { factionId: 'city_0', refinedProduct: 500, oil: 10 } },
    });
    const world = makeWorld({ logistics });
    const projected = projectCompactSave(world);
    // This assertion fails against an implementation that omits logistics
    // from getCompactSave/projectCompactSave (the historical bug).
    expect(projected.logistics).toBeDefined();
    expect(projected.logistics?.home.city_0.refinedProduct).toBe(500);
  });
});
