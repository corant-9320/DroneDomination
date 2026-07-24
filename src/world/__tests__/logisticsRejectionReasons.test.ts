// Feature: oil-logistics-system, Task 2.8: rejection reason codes
//
// Validates: Requirements 2.2, 2.3, 2.4, 2.5, 4.8, 4.9, 4.10, 11.2
//
// Example/unit tests (not property tests) for the three placement validators in
// `src/world/logistics/placement.ts`. For every distinct `LogisticsRejectionReason` a
// validator can return, we construct the minimal scenario that triggers exactly
// that reason (all higher-precedence gates pass), then assert:
//   - `result.legal === false`
//   - `result.reason === '<the exact code>'`
//   - the validator is reject-and-preserve: its `ctx` / `unit` / `refinery`
//     inputs are byte-for-byte unchanged (deep-equal snapshot before/after).

import { describe, it, expect } from 'vitest';

import {
  validateWellPlacement,
  validateRefineryPlacement,
  validateRefinerySegment,
} from '../logistics/placement.js';
import { MAX_STEEP_WHEELED } from '../../../shared/movementConstants.js';
import type {
  EngineerUnitRef,
  LogisticsContext,
  LogisticsState,
  LogisticsTile,
  OilWell,
  Refinery,
} from '../../../shared/logisticsTypes.js';

// ---------------------------------------------------------------------------
// Fixtures — a single 6-segment (hex) tile at index 0.
// ---------------------------------------------------------------------------

const MY_FACTION = 'p1';
const OTHER_FACTION = 'p2';
const SEGMENT_COUNT = 6;
const STEEP_OVER = MAX_STEEP_WHEELED + 0.1; // strictly over the wheeled gate

interface TileOverrides {
  terrainType?: string;
  forested?: boolean;
  resourceType?: string;
  ownerId?: string;
  cityId?: string;
  steepSegment?: number; // segment index made too-steep; others stay flat
}

function makeTile(o: TileOverrides = {}): LogisticsTile {
  const segSteep = new Array<number>(SEGMENT_COUNT).fill(0);
  if (o.steepSegment !== undefined) segSteep[o.steepSegment] = STEEP_OVER;
  return {
    index: 0,
    neighbours: [1, 2, 3, 4, 5, 6],
    terrainType: o.terrainType ?? 'plains',
    height: 3,
    forested: o.forested ?? false,
    segSteep,
    resourceType: o.resourceType,
    ownerId: o.ownerId,
    cityId: o.cityId,
  };
}

function emptyState(): LogisticsState {
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
  };
}

function wellAt(segment: number): OilWell {
  return {
    id: 'existing-well',
    ownerId: MY_FACTION,
    tileIndex: 0,
    segment,
    storedOil: 0,
    hitPoints: 10,
    maxHitPoints: 10,
  };
}

function makeUnit(engineer: number): EngineerUnitRef {
  return {
    id: 'engineer-unit',
    ownerId: MY_FACTION,
    tileIndex: 0,
    segment: 0,
    attributes: { size: 3, wheeledMovement: 1, engineer },
  };
}

function refineryWith(segments: number[]): Refinery {
  return {
    id: 'refinery-1',
    ownerId: MY_FACTION,
    tileIndex: 0,
    segments,
    heldOil: 0,
    refinedProductAvailable: 0,
    hitPoints: 20,
    maxHitPoints: 20,
  };
}

// ---------------------------------------------------------------------------
// validateWellPlacement — one case per reason code (Req 2.2–2.5)
// ---------------------------------------------------------------------------

describe('validateWellPlacement — rejection reason codes', () => {
  it('returns "lacks-engineer" when the unit engineer attribute is not 1..5 (Req 2.2)', () => {
    const ctx: LogisticsContext = { tiles: [makeTile({ resourceType: 'oil' })], state: emptyState() };
    const unit = makeUnit(0);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, 0, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('lacks-engineer');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });

  it('returns "ineligible-tile" when the segment index is out of range', () => {
    const ctx: LogisticsContext = { tiles: [makeTile({ resourceType: 'oil' })], state: emptyState() };
    const unit = makeUnit(3);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, SEGMENT_COUNT + 5, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('ineligible-tile');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });

  it('returns "owned-by-other-player" when the tile belongs to another faction (Req 12.3)', () => {
    const ctx: LogisticsContext = {
      tiles: [makeTile({ resourceType: 'oil', ownerId: OTHER_FACTION })],
      state: emptyState(),
    };
    const unit = makeUnit(3);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, 0, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('owned-by-other-player');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });

  it('returns "too-steep" when the target segment exceeds MAX_STEEP_WHEELED (Req 2.3)', () => {
    const ctx: LogisticsContext = {
      tiles: [makeTile({ resourceType: 'oil', steepSegment: 2 })],
      state: emptyState(),
    };
    const unit = makeUnit(3);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, 2, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('too-steep');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });

  it('returns "no-deposit" when the tile is not an oil deposit (Req 2.4)', () => {
    const ctx: LogisticsContext = { tiles: [makeTile({ resourceType: 'iron' })], state: emptyState() };
    const unit = makeUnit(3);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, 0, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('no-deposit');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });

  it('returns "segment-occupied" when a well already holds the target segment (Req 2.5)', () => {
    const state = emptyState();
    state.wells = [wellAt(1)];
    const ctx: LogisticsContext = { tiles: [makeTile({ resourceType: 'oil' })], state };
    const unit = makeUnit(3);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, 1, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('segment-occupied');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });

  it('returns "in-city" when the oil tile lies inside a city', () => {
    // Owner-ok + oil deposit + flat, but the tile carries a cityId → barred.
    const ctx: LogisticsContext = {
      tiles: [makeTile({ resourceType: 'oil', cityId: MY_FACTION })],
      state: emptyState(),
    };
    const unit = makeUnit(3);
    const snapCtx = structuredClone(ctx);
    const snapUnit = structuredClone(unit);

    const result = validateWellPlacement(ctx, 0, 0, unit);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('in-city');
    expect(ctx).toEqual(snapCtx);
    expect(unit).toEqual(snapUnit);
  });
});

// ---------------------------------------------------------------------------
// validateRefineryPlacement — one case per reason code (Req 4.8–4.10, 11.2)
// ---------------------------------------------------------------------------

describe('validateRefineryPlacement — rejection reason codes', () => {
  it('returns "owned-by-other-player" when the tile belongs to another faction (Req 12.3)', () => {
    const ctx: LogisticsContext = {
      tiles: [makeTile({ ownerId: OTHER_FACTION })],
      state: emptyState(),
    };
    const snap = structuredClone(ctx);

    const result = validateRefineryPlacement(ctx, 0, MY_FACTION);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('owned-by-other-player');
    expect(ctx).toEqual(snap);
  });

  it('returns "ineligible-tile" when the tile is water/already-refined (Req 4.10)', () => {
    const ctx: LogisticsContext = { tiles: [makeTile({ terrainType: 'ocean' })], state: emptyState() };
    const snap = structuredClone(ctx);

    const result = validateRefineryPlacement(ctx, 0, MY_FACTION);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('ineligible-tile');
    expect(ctx).toEqual(snap);
  });

  it('returns "too-steep" when a segment exceeds MAX_STEEP_WHEELED (Req 4.11)', () => {
    const ctx: LogisticsContext = { tiles: [makeTile({ steepSegment: 4 })], state: emptyState() };
    const snap = structuredClone(ctx);

    const result = validateRefineryPlacement(ctx, 0, MY_FACTION);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('too-steep');
    expect(ctx).toEqual(snap);
  });

  it('returns "segment-occupied" when a segment is already held by a structure', () => {
    const state = emptyState();
    state.wells = [wellAt(0)];
    const ctx: LogisticsContext = { tiles: [makeTile()], state };
    const snap = structuredClone(ctx);

    const result = validateRefineryPlacement(ctx, 0, MY_FACTION);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('segment-occupied');
    expect(ctx).toEqual(snap);
  });

  it('returns "in-city" when the tile lies inside a city', () => {
    // Owner-ok land tile, but it carries a cityId → refineries are barred.
    const ctx: LogisticsContext = { tiles: [makeTile({ cityId: MY_FACTION })], state: emptyState() };
    const snap = structuredClone(ctx);

    const result = validateRefineryPlacement(ctx, 0, MY_FACTION);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('in-city');
    expect(ctx).toEqual(snap);
  });
});

// ---------------------------------------------------------------------------
// validateRefinerySegment — one case per reason code (Req 4.8, 4.9)
// ---------------------------------------------------------------------------

describe('validateRefinerySegment — rejection reason codes', () => {
  it('returns "outside-refinery-tile" when the segment index is out of range (Req 4.8)', () => {
    const ctx: LogisticsContext = { tiles: [makeTile()], state: emptyState() };
    const refinery = refineryWith([0]);
    const snapCtx = structuredClone(ctx);
    const snapRef = structuredClone(refinery);

    const result = validateRefinerySegment(ctx, refinery, SEGMENT_COUNT + 3);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('outside-refinery-tile');
    expect(ctx).toEqual(snapCtx);
    expect(refinery).toEqual(snapRef);
  });

  it('returns "refinery-at-capacity" when every segment is already a refinery segment (Req 4.9)', () => {
    const ctx: LogisticsContext = { tiles: [makeTile()], state: emptyState() };
    const refinery = refineryWith([0, 1, 2, 3, 4, 5]);
    const snapCtx = structuredClone(ctx);
    const snapRef = structuredClone(refinery);

    const result = validateRefinerySegment(ctx, refinery, 2);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('refinery-at-capacity');
    expect(ctx).toEqual(snapCtx);
    expect(refinery).toEqual(snapRef);
  });

  it('returns "segment-occupied" when the target segment already has a refinery segment', () => {
    const ctx: LogisticsContext = { tiles: [makeTile()], state: emptyState() };
    const refinery = refineryWith([0, 1]);
    const snapCtx = structuredClone(ctx);
    const snapRef = structuredClone(refinery);

    const result = validateRefinerySegment(ctx, refinery, 0);

    expect(result.legal).toBe(false);
    expect(result.reason).toBe('segment-occupied');
    expect(ctx).toEqual(snapCtx);
    expect(refinery).toEqual(snapRef);
  });
});
