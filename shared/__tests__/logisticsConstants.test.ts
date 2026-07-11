/**
 * Unit tests for shared/logisticsConstants.ts
 *
 * These assert the Construction_Cost golden table and the specification
 * numeric constants EXACTLY. Per the "no pinned formula values" testing rule,
 * exact assertions are allowed here because these are *specification constants*
 * from the requirements Glossary (not balance-formula outputs).
 *
 * Validates: Requirements 5.8, 5.9
 */

import { describe, it, expect } from 'vitest';
import {
  EXTRACTION_RATE,
  WELL_STORAGE_CAPACITY,
  REFINERY_THROUGHPUT_RATE,
  CONVERSION_RATIO,
  HUB_STORAGE_CAPACITY,
  DEPOSIT_SPACING,
  HOME_CITY_REFINED_PRODUCT_MAX,
  ROUTE_CAPACITY_MIN,
  ROUTE_CAPACITY_MAX,
  ROUTE_CAPACITY_STEP,
  TRANSPORT_CARGO_MIN,
  TRANSPORT_CARGO_MAX,
  MAX_TRANSPORTS_PER_ROUTE,
  ENGINEER_TASK_BASE,
  DEFAULT_SEED,
  TRANSPORT_TIER_THRESHOLDS,
  CONSTRUCTION_COST,
} from '../logisticsConstants.js';

describe('logisticsConstants — specification constants', () => {
  it('exposes the exact resolved numeric values from the requirements Glossary', () => {
    expect(EXTRACTION_RATE).toBe(10);
    expect(WELL_STORAGE_CAPACITY).toBe(100);
    expect(REFINERY_THROUGHPUT_RATE).toBe(20);
    expect(CONVERSION_RATIO).toBe(0.5);
    expect(HUB_STORAGE_CAPACITY).toBe(500);
    expect(DEPOSIT_SPACING).toBe(20);
    expect(HOME_CITY_REFINED_PRODUCT_MAX).toBe(100000);
    expect(ROUTE_CAPACITY_MIN).toBe(100);
    expect(ROUTE_CAPACITY_MAX).toBe(1000);
    expect(ROUTE_CAPACITY_STEP).toBe(100);
    expect(TRANSPORT_CARGO_MIN).toBe(1);
    expect(TRANSPORT_CARGO_MAX).toBe(1000);
    expect(MAX_TRANSPORTS_PER_ROUTE).toBe(3);
    expect(ENGINEER_TASK_BASE).toBe(6);
    expect(DEFAULT_SEED).toBe(4242);
  });

  it('defines the transport tier thresholds as inclusive lower bounds', () => {
    expect(TRANSPORT_TIER_THRESHOLDS).toEqual({
      van: 0,
      truck: 2,
      juggernaut: 4,
    });
  });
});

describe('logisticsConstants — CONSTRUCTION_COST golden table', () => {
  it('matches the Construction_Cost table exactly (Req 5.8, 5.9)', () => {
    expect(CONSTRUCTION_COST).toEqual({
      oilWell: 50,
      refineryFirstSegment: 150,
      refineryAdditionalSegment: 100,
      routeRoadPerSegment: 40,
      routeUpgradePerSegment: 60,
      distributionHub: 200,
      bridge: 80,
      transportUnit: 30,
      transportUpgrade: 45,
      forestClear: 0,
    });
  });

  it('charges no Refined_Product for forest clearing (Req 5.9 — turns only)', () => {
    expect(CONSTRUCTION_COST.forestClear).toBe(0);
  });
});
