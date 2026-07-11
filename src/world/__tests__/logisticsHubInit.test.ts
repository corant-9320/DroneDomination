// Feature: oil-logistics-system, Task 7.3: hub initialization
//
// Validates: Requirements 11.1
//
// Example/unit test (not a property test) for `createHub` in
// `src/world/logistics.ts`. A newly-placed Distribution_Hub must start with a
// zero buffer (Req 11.1). We also assert the rest of the initialisation contract
// documented on `createHub`: full health, the caller's `routeIds` copied (equal
// by value but not aliased), and ids/owner/location carried through unchanged.

import { describe, it, expect } from 'vitest';

import { createHub } from '../logistics.js';
import type { HubCreationInit } from '../logistics.js';

describe('createHub — hub initialization (Req 11.1)', () => {
  const routeIds = ['route-a', 'route-b'];
  const init: HubCreationInit = {
    id: 'hub-1',
    ownerId: 'faction-home',
    tileIndex: 42,
    segment: 3,
    routeIds,
    maxHitPoints: 200,
  };

  it('starts a newly placed hub with a zero buffer (Req 11.1)', () => {
    const hub = createHub(init);
    expect(hub.buffer).toBe(0);
  });

  it('starts the hub at full health', () => {
    const hub = createHub(init);
    expect(hub.hitPoints).toBe(init.maxHitPoints);
    expect(hub.maxHitPoints).toBe(init.maxHitPoints);
  });

  it('carries ids, owner, and location through from init', () => {
    const hub = createHub(init);
    expect(hub.id).toBe('hub-1');
    expect(hub.ownerId).toBe('faction-home');
    expect(hub.tileIndex).toBe(42);
    expect(hub.segment).toBe(3);
  });

  it('copies routeIds by value without aliasing the caller array', () => {
    const hub = createHub(init);
    expect(hub.routeIds).toEqual(routeIds);
    expect(hub.routeIds).not.toBe(routeIds);
  });
});
