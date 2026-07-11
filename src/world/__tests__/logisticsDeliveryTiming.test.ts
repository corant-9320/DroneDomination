// Feature: oil-logistics-system, Property 20: Delivery timing and destruction losses
//
// Validates: Requirements 7.4, 7.5, 8.5, 8.6
//
// resolveLogisticsTurn(state, tiles, faction) : { logistics, events }
//
// Delivery timing (Req 7.4): a transport dispatched this turn travels its FULL
// Route_Travel_Time T. After the dispatch turn the transport is in transit with
// turnsRemaining = T; only transports already in transit at the start of a turn
// advance. Running resolveLogisticsTurn then delivers the cargo to the far
// endpoint EXACTLY when turnsRemaining reaches 0 — i.e. on the T-th advance turn
// after dispatch, and never before. So the destination stock does not increase on
// the dispatch turn nor on any of the first T-1 advance turns, and increases by
// the carried cargo on advance turn T.
//
// Destruction losses (Req 7.5, 8.6): if a transport carrying cargo is removed from
// state (simulating destruction — the combat path removes destroyed transports and
// their cargo before the delivery turn) before delivery, resolveLogisticsTurn never
// delivers that cargo to either endpoint. With the transport gone the destination
// stock never increases from it.
//
// Req 8.5 (combat resolved via the existing unit model) is exercised structurally
// here by modelling destruction the way the design specifies: a destroyed transport
// (and its cargo) is simply absent from state.transports before the delivery turn.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveLogisticsTurn } from '../logistics.js';
import type {
  HomeStock,
  LogisticsRoute,
  LogisticsState,
  LogisticsTile,
  OilWell,
  Transport,
} from '../../../shared/logisticsTypes.js';

const NUM_RUNS = 200;

const FACTION = 'faction-a';
const WELL_ID = 'well-1';
const HOME_ID = 'home-1'; // not a well/refinery/hub → classified as the Home_City endpoint
const ROUTE_ID = 'route-1';
const TRANSPORT_ID = 'transport-1';

// Travel times are precomputed on the route, so resolveLogisticsTurn ignores the
// tiles argument (`void tiles`); an empty tile list is a valid minimal fixture.
const NO_TILES: LogisticsTile[] = [];

/** A source Oil_Well holding `storedOil` raw Oil, on tile 0 / segment 0. */
function makeWell(storedOil: number): OilWell {
  return {
    id: WELL_ID,
    ownerId: FACTION,
    tileIndex: 0,
    segment: 0,
    storedOil,
    hitPoints: 100,
    maxHitPoints: 100,
  };
}

/**
 * A Road well→home-city with the given travelTime. `wellIsFrom` swaps which end
 * holds the well so both from/to orderings are exercised (the source is always the
 * well endpoint; the destination is the Home_City on the other end).
 */
function makeRoute(travelTime: number, wellIsFrom: boolean): LogisticsRoute {
  return {
    id: ROUTE_ID,
    ownerId: FACTION,
    fromStructureId: wellIsFrom ? WELL_ID : HOME_ID,
    toStructureId: wellIsFrom ? HOME_ID : WELL_ID,
    segments: [0, 1],
    capacity: 1000, // high enough that a single load takes the whole supply
    tier: 'road',
    travelTime,
    operable: true,
  };
}

/** One idle transport assigned to the route, with ample cargo capacity. */
function makeTransport(): Transport {
  return {
    id: TRANSPORT_ID,
    ownerId: FACTION,
    routeId: ROUTE_ID,
    cargoType: null,
    cargo: 0,
    cargoCapacity: 1000,
    speed: 1,
    defence: 1,
    upgrades: 0,
    tier: 'van',
    inTransit: false,
    turnsRemaining: 0,
    unitId: `unit-${TRANSPORT_ID}`,
  };
}

/** A minimal LogisticsState with one well, one route, and the given transports. */
function makeState(
  travelTime: number,
  supply: number,
  wellIsFrom: boolean,
  transports: Transport[],
): LogisticsState {
  const home: Record<string, HomeStock> = {
    [FACTION]: { factionId: FACTION, refinedProduct: 0, oil: 0 },
  };
  return {
    wells: [makeWell(supply)],
    refineries: [],
    routes: [makeRoute(travelTime, wellIsFrom)],
    transports,
    hubs: [],
    home,
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

/** The Home_City's delivered raw-Oil stock for the acting faction. */
function homeOil(state: LogisticsState): number {
  return state.home[FACTION]?.oil ?? 0;
}

describe('logistics delivery timing and destruction losses (Property 20)', () => {
  // ── Req 7.4 — cargo is delivered exactly on travel-time turn T, not before ──
  it('delivers cargo exactly on the T-th advance turn after dispatch, never earlier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }), // bounded travel time T
        fc.integer({ min: 1, max: 100 }), // well supply (<= WELL_STORAGE_CAPACITY)
        fc.boolean(), // well as route `from` or `to`
        (T, supply, wellIsFrom) => {
          let state = makeState(T, supply, wellIsFrom, [makeTransport()]);

          // Dispatch turn: the transport loads and departs; nothing is delivered yet.
          state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
          const dispatched = state.transports[0];
          expect(dispatched.inTransit).toBe(true);
          expect(dispatched.turnsRemaining).toBe(T); // full travel time at dispatch (Req 7.4)
          expect(dispatched.cargo).toBe(supply); // the whole supply was loaded
          expect(homeOil(state)).toBe(0); // not delivered on the dispatch turn

          // Advance turns 1..T. Delivery must occur exactly on advance T.
          for (let i = 1; i <= T; i++) {
            state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
            if (i < T) {
              // Before the travel time elapses, the destination stock is unchanged.
              expect(homeOil(state)).toBe(0);
              expect(state.transports[0].inTransit).toBe(true);
            } else {
              // On advance turn T the cargo arrives — exactly the carried amount.
              expect(homeOil(state)).toBe(supply);
              expect(state.transports[0].inTransit).toBe(false);
              expect(state.transports[0].cargo).toBe(0);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── Req 7.5, 8.6 — a transport destroyed in transit delivers nothing ──
  it('never delivers the cargo of a transport removed (destroyed) before its arrival', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 100 }),
        fc.boolean(),
        (T, supply, wellIsFrom) => {
          let state = makeState(T, supply, wellIsFrom, [makeTransport()]);

          // Dispatch turn: the transport departs carrying `supply`.
          state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
          expect(state.transports[0].inTransit).toBe(true);
          expect(state.transports[0].cargo).toBe(supply);
          expect(homeOil(state)).toBe(0);

          // Model destruction: remove the in-transit transport (and its cargo) from
          // state before the delivery turn, exactly as the combat path does (Req 8.6).
          state = { ...state, transports: [] };

          // Run through and past the turn the cargo would have arrived on. With the
          // transport gone, nothing is ever delivered to either endpoint (Req 7.5).
          for (let i = 1; i <= T + 1; i++) {
            state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
            expect(homeOil(state)).toBe(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── Focused deterministic example (T = 3): crisp turn-by-turn timing ──
  it('example: with T=3, delivery lands on the 3rd advance turn only', () => {
    const T = 3;
    const supply = 40;
    let state = makeState(T, supply, true, [makeTransport()]);

    // Turn 1 (dispatch)
    state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
    expect(state.transports[0].turnsRemaining).toBe(3);
    expect(homeOil(state)).toBe(0);

    // Turn 2 (advance 1) — still travelling
    state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
    expect(state.transports[0].turnsRemaining).toBe(2);
    expect(homeOil(state)).toBe(0);

    // Turn 3 (advance 2) — still travelling
    state = resolveLogisticsTurn(state, NO_TILES, FACTION).logistics;
    expect(state.transports[0].turnsRemaining).toBe(1);
    expect(homeOil(state)).toBe(0);

    // Turn 4 (advance 3 == T) — delivered
    const { logistics, events } = resolveLogisticsTurn(state, NO_TILES, FACTION);
    state = logistics;
    expect(homeOil(state)).toBe(supply);
    expect(state.transports[0].inTransit).toBe(false);
    expect(events.some((e) => e.kind === 'delivered' && e.amount === supply)).toBe(true);
  });
});
