// Feature: oil-logistics-system, Property 26: Pipeline conserves Oil and Refined_Product except at explicit loss points
//
// Validates: Requirements 3.1, 4.5, 5.7, 6.6, 8.8, 11.7, 12.7
//
// resolveLogisticsTurn(state, tiles, faction) : { logistics, events }
//
// Whole-system conservation. Define the raw-unit tally over every commodity field
// in the system (Oil and Refined_Product counted 1:1):
//
//   tally(s) = Σ well.storedOil
//            + Σ (refinery.heldOil + refinery.refinedProductAvailable)
//            + Σ hub.buffer
//            + Σ transport.cargo
//            + Σ (home.oil + home.refinedProduct)
//
// Across a single resolveLogisticsTurn the tally is conserved EXCEPT at the three
// explicitly-modelled points, each of which is reported as an event:
//
//   + extraction  — stage 7 adds up to EXTRACTION_RATE per operational well; the
//                   actual amount added is reported by an 'extracted' event (Req 3.1).
//                   This is the pipeline's SOURCE.
//   − refining    — stage 2 converts 2 raw Oil → 1 Refined_Product (ratio 0.5); the
//                   'refined' event carries produced = floor(consumed/2). When a
//                   refinery's heldOil is EVEN, consumed = min(N*20, heldOil) is even,
//                   so produced = consumed/2 exactly and the raw-unit loss from the
//                   conversion (heldOil drops by consumed, product rises by produced)
//                   equals exactly `produced` — i.e. Σ(refined) (Req 4.5).
//   − discard     — every storage/home clamp and hub spill is reported by a
//                   'storage-full' event carrying the discarded `amount`: the
//                   Home_City Refined_Product overflow (Req 5.7), well/hub storage
//                   clamps (Req 8.8), and hub left-upstream spill (Req 11.7).
//
// Hence the exact conservation identity every turn:
//
//   tally_after === tally_before + Σ(extracted) − Σ(refined) − Σ(storage-full)
//
// (Algebraically: dispatch/load, in-transit delivery, and hub distribution each net
// to zero in the tally save for the reported spill/clamp — a delivered unit simply
// moves from one counted field to another. Only extraction adds, only refining and
// the reported discards remove.)
//
// To keep the refining term exact across MANY turns, this fixture never delivers Oil
// INTO a refinery (no route has a refinery as an Oil destination), so a refinery's
// heldOil only ever decreases by refining and an even heldOil stays even turn over
// turn — keeping consumed even and Σ(refined) an exact loss every turn.
//
// Destruction (Req 12.7) is a SEPARATE explicit loss point resolved by the combat
// path (which removes a destroyed structure/transport and its stored resources from
// state before resolveLogisticsTurn runs); it is covered by task 8.2's Property 24.
// This test asserts conservation on the intact, non-combat pipeline.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveLogisticsTurn } from '../logistics.js';
import type {
  DistributionHub,
  HomeStock,
  LogisticsEvent,
  LogisticsRoute,
  LogisticsState,
  LogisticsTile,
  OilWell,
  Refinery,
  Transport,
} from '../../../shared/logisticsTypes.js';

const NUM_RUNS = 200;
const FACTION = 'faction-a';

// Travel times are precomputed on the routes, so resolveLogisticsTurn ignores the
// tiles argument (`void tiles`); an empty tile list is a valid minimal fixture.
const NO_TILES: LogisticsTile[] = [];

const HUB_ID = 'hub-1';
const REFINERY_ID = 'ref-1';
const HOME_ID = 'home-1'; // not a well/refinery/hub → classified as the Home_City endpoint
const ROUTE_WELL_HUB = 'route-well-hub';
const ROUTE_REF_HOME = 'route-ref-home';
const ROUTE_HUB_HOME = 'route-hub-home';

// ── The whole-system raw-unit commodity tally (Oil + Refined_Product, counted 1:1) ──
function tally(s: LogisticsState): number {
  let total = 0;
  for (const w of s.wells) total += w.storedOil;
  for (const r of s.refineries) total += r.heldOil + r.refinedProductAvailable;
  for (const h of s.hubs) total += h.buffer;
  for (const t of s.transports) total += t.cargo;
  for (const fid of Object.keys(s.home)) total += s.home[fid].oil + s.home[fid].refinedProduct;
  return total;
}

/** Sum the `amount` of every event of the given kind (a missing amount counts as 0). */
function sumEvents(events: LogisticsEvent[], kind: LogisticsEvent['kind']): number {
  return events
    .filter((e) => e.kind === kind)
    .reduce((acc, e) => acc + (e.amount ?? 0), 0);
}

// ─── Generated fixture shape ──────────────────────────────────────────────────

interface TransportSpec {
  cargoCapacity: number;
  inTransit: boolean;
  rawCargo: number;
  turnsRemaining: number;
}

interface Config {
  wellStoredOil: number[]; // one entry per well (well-0 is the routed source well)
  refSegments: number;
  refHeldOilHalf: number; // heldOil = 2 * this (kept EVEN so refining loss is exact)
  refProduct: number;
  hubBuffer: number;
  capWellHub: number; // route capacities are multiples of 100 in [100, 1000]
  capRefHome: number;
  capHubHome: number;
  travelWellHub: number;
  travelRefHome: number;
  homeOil: number;
  homeProduct: number;
  transportWellHub: TransportSpec;
  transportRefHome: TransportSpec;
}

function buildTransport(
  id: string,
  routeId: string,
  cargoType: 'oil' | 'product',
  travelTime: number,
  spec: TransportSpec,
): Transport {
  const cargo = spec.inTransit ? Math.min(spec.rawCargo, spec.cargoCapacity) : 0;
  return {
    id,
    ownerId: FACTION,
    routeId,
    cargoType: spec.inTransit && cargo > 0 ? cargoType : null,
    cargo,
    cargoCapacity: spec.cargoCapacity,
    speed: 1,
    defence: 1,
    upgrades: 0,
    tier: 'van',
    inTransit: spec.inTransit,
    // An in-transit transport delivers when turnsRemaining reaches 0 after this
    // turn's advance; [1, travelTime] keeps it a valid mid-journey countdown.
    turnsRemaining: spec.inTransit ? Math.min(Math.max(1, spec.turnsRemaining), travelTime) : 0,
    unitId: `unit-${id}`,
  };
}

function buildState(cfg: Config): LogisticsState {
  const wells: OilWell[] = cfg.wellStoredOil.map((storedOil, i) => ({
    id: `well-${i}`,
    ownerId: FACTION,
    tileIndex: i,
    segment: 0,
    storedOil,
    hitPoints: 30,
    maxHitPoints: 30,
  }));

  const refinery: Refinery = {
    id: REFINERY_ID,
    ownerId: FACTION,
    tileIndex: 50,
    segments: Array.from({ length: cfg.refSegments }, (_, i) => i),
    heldOil: 2 * cfg.refHeldOilHalf, // EVEN → refining consumes an even amount
    refinedProductAvailable: cfg.refProduct,
    hitPoints: 30,
    maxHitPoints: 30,
  };

  const hub: DistributionHub = {
    id: HUB_ID,
    ownerId: FACTION,
    tileIndex: 60,
    segment: 0,
    buffer: cfg.hubBuffer,
    routeIds: [ROUTE_HUB_HOME], // the hub distributes toward the Home_City
    hitPoints: 30,
    maxHitPoints: 30,
  };

  const routes: LogisticsRoute[] = [
    // well-0 → hub (source is the well; ships raw Oil into the hub)
    {
      id: ROUTE_WELL_HUB,
      ownerId: FACTION,
      fromStructureId: 'well-0',
      toStructureId: HUB_ID,
      segments: [0, 60],
      capacity: cfg.capWellHub,
      tier: 'road',
      travelTime: cfg.travelWellHub,
      operable: true,
    },
    // refinery → home (source is the refinery; ships Refined_Product to the Home_City)
    {
      id: ROUTE_REF_HOME,
      ownerId: FACTION,
      fromStructureId: REFINERY_ID,
      toStructureId: HOME_ID,
      segments: [50, 70],
      capacity: cfg.capRefHome,
      tier: 'road',
      travelTime: cfg.travelRefHome,
      operable: true,
    },
    // hub → home (no well/refinery endpoint → fed by the hub distribute stage)
    {
      id: ROUTE_HUB_HOME,
      ownerId: FACTION,
      fromStructureId: HUB_ID,
      toStructureId: HOME_ID,
      segments: [60, 70],
      capacity: cfg.capHubHome,
      tier: 'highway',
      travelTime: 1,
      operable: true,
    },
  ];

  const transports: Transport[] = [
    buildTransport('t-well-hub', ROUTE_WELL_HUB, 'oil', cfg.travelWellHub, cfg.transportWellHub),
    buildTransport('t-ref-home', ROUTE_REF_HOME, 'product', cfg.travelRefHome, cfg.transportRefHome),
  ];

  const home: Record<string, HomeStock> = {
    [FACTION]: { factionId: FACTION, refinedProduct: cfg.homeProduct, oil: cfg.homeOil },
  };

  return {
    wells,
    refineries: [refinery],
    routes,
    transports,
    hubs: [hub],
    home,
    tasks: [],
    clearedForests: [],
    bridges: [],
  };
}

// ─── Arbitraries ────────────────────────────────────────────────────────────────

const transportSpecArb: fc.Arbitrary<TransportSpec> = fc.record({
  cargoCapacity: fc.integer({ min: 1, max: 500 }),
  inTransit: fc.boolean(),
  rawCargo: fc.integer({ min: 0, max: 500 }),
  turnsRemaining: fc.integer({ min: 1, max: 4 }),
});

const configArb: fc.Arbitrary<Config> = fc.record({
  wellStoredOil: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 3 }),
  refSegments: fc.integer({ min: 1, max: 3 }),
  refHeldOilHalf: fc.integer({ min: 0, max: 30 }), // heldOil ∈ [0, 60], always even
  refProduct: fc.integer({ min: 0, max: 60 }),
  hubBuffer: fc.integer({ min: 0, max: 200 }),
  capWellHub: fc.integer({ min: 1, max: 10 }).map((n) => n * 100),
  capRefHome: fc.integer({ min: 1, max: 10 }).map((n) => n * 100),
  capHubHome: fc.integer({ min: 1, max: 10 }).map((n) => n * 100),
  travelWellHub: fc.integer({ min: 1, max: 4 }),
  travelRefHome: fc.integer({ min: 1, max: 4 }),
  homeOil: fc.integer({ min: 0, max: 100 }),
  homeProduct: fc.integer({ min: 0, max: 100 }),
  transportWellHub: transportSpecArb,
  transportRefHome: transportSpecArb,
});

// ─── Properties ───────────────────────────────────────────────────────────────

describe('logistics whole-pipeline conservation (Property 26)', () => {
  // ── One turn: the exact source/loss identity holds for any varied pipeline ──
  it('conserves the system tally over one turn, up to reported extraction/refining/discard', () => {
    fc.assert(
      fc.property(configArb, (cfg) => {
        const state = buildState(cfg);
        const before = tally(state);

        const { logistics, events } = resolveLogisticsTurn(state, NO_TILES, FACTION);
        const after = tally(logistics);

        const extracted = sumEvents(events, 'extracted');
        const refined = sumEvents(events, 'refined');
        const discarded = sumEvents(events, 'storage-full');

        // Exact whole-system conservation identity (Req 3.1, 4.5, 5.7, 6.6, 8.8, 11.7).
        expect(after).toBe(before + extracted - refined - discarded);

        // Bounding sanity: the ONLY source is extraction and the ONLY sinks are the
        // reported refining conversion + discards, so the tally can only rise by the
        // extracted amount and fall by at most refined + discarded.
        expect(after).toBeLessThanOrEqual(before + extracted);
        expect(after).toBeGreaterThanOrEqual(before + extracted - refined - discarded);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // ── Several turns: the identity holds turn-over-turn (heldOil stays even) ──
  it('conserves the system tally across several consecutive turns', () => {
    fc.assert(
      fc.property(configArb, fc.integer({ min: 2, max: 6 }), (cfg, turns) => {
        let state = buildState(cfg);

        for (let turn = 0; turn < turns; turn++) {
          const before = tally(state);
          const { logistics, events } = resolveLogisticsTurn(state, NO_TILES, FACTION);
          const after = tally(logistics);

          const extracted = sumEvents(events, 'extracted');
          const refined = sumEvents(events, 'refined');
          const discarded = sumEvents(events, 'storage-full');

          expect(after).toBe(before + extracted - refined - discarded);
          state = logistics;
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // ── Focused deterministic example: crisp, hand-checkable accounting ──
  it('example: two wells, a 1-segment refinery, and idle transports balance exactly', () => {
    const cfg: Config = {
      wellStoredOil: [50, 20], // well-0 routed to the hub; well-1 just extracts
      refSegments: 1, // throughput 20/turn
      refHeldOilHalf: 5, // heldOil = 10 → consumes 10, produces floor(10*0.5)=5
      refProduct: 0,
      hubBuffer: 0,
      capWellHub: 1000,
      capRefHome: 1000,
      capHubHome: 1000,
      travelWellHub: 2,
      travelRefHome: 2,
      homeOil: 0,
      homeProduct: 0,
      // Both transports idle → they dispatch (load) this turn; loading conserves.
      transportWellHub: { cargoCapacity: 500, inTransit: false, rawCargo: 0, turnsRemaining: 1 },
      transportRefHome: { cargoCapacity: 500, inTransit: false, rawCargo: 0, turnsRemaining: 1 },
    };

    const state = buildState(cfg);
    const before = tally(state); // 50 + 20 + (10 + 0) + 0 + 0 + 0 = 80

    const { logistics, events } = resolveLogisticsTurn(state, NO_TILES, FACTION);
    const after = tally(logistics);

    const extracted = sumEvents(events, 'extracted');
    const refined = sumEvents(events, 'refined');
    const discarded = sumEvents(events, 'storage-full');

    // Refining converted 10 raw Oil into 5 Refined_Product → a 5-unit tally loss.
    expect(refined).toBe(5);
    // Two operational wells each extract EXTRACTION_RATE (10) at end of turn → +20.
    expect(extracted).toBe(20);
    // Nothing overflowed on this generous-capacity pipeline.
    expect(discarded).toBe(0);

    expect(after).toBe(before + extracted - refined - discarded);
    expect(after).toBe(80 + 20 - 5 - 0); // 95
  });
});
