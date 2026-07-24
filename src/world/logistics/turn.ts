/**
 * Per-turn orchestration — resolveLogisticsTurn (Req 3.1, 4.5, 5.4, 6.6, 6.9,
 * 7.4, 7.5, 8.1, 8.6, 8.9, 11.4, 12.8).
 *
 * Composes the pure helpers from the sibling modules (tasks/production/transport/
 * hubs.ts) into seven ordered stages. See {@link resolveLogisticsTurn}'s own doc
 * comment for purity/scope guarantees.
 *
 * Ordered stages (design "Per-turn orchestration"):
 *   1. Tick tasks      — tickTask each in-progress EngineerTask; apply completions
 *                        (well / cleared-forest / bridge). (Req 2.7, 2.8, 9.4, 10.3)
 *   2. Refine          — refine() each faction refinery. (Req 4.5)
 *   3. Dispatch        — load idle transports on operable routes from their source
 *                        (well→oil, refinery→product), clamped to route capacity,
 *                        and send in transit for `route.travelTime` turns. Inoperable
 *                        routes are skipped. (Req 6.6, 8.1, 12.8)
 *   4. Advance+deliver — advance ONLY transports already in transit at the START of
 *                        the turn, so a freshly-dispatched transport travels its
 *                        FULL travelTime (Req 7.4); deliver on arrival, clamped to
 *                        destination capacity (Req 8.9, 8.10). A destroyed transport's
 *                        cargo is never delivered — it's removed from state by the
 *                        combat path before this runs (Req 7.5, 8.6).
 *   5. Hub distribute  — distributeHub each faction hub with its accumulated inflow
 *                        and operable outgoing route capacities; apply newBuffer and
 *                        push distributed amounts toward each route's far endpoint.
 *                        (Req 11.4)
 *   6. Home accrual    — accrue the turn's delivered Oil / Refined_Product to the
 *                        faction's HomeStock, clamped (Req 5.4, 6.9).
 *   7. Extract         — extract() each operational well at end of turn, including
 *                        wells completed in stage 1. (Req 3.1)
 *   8. Adjacent fill   — an adjacent, same-faction storage hex fills directly from
 *                        a well's Oil or refinery's Petrol; no route or transport is
 *                        required, and each storage segment remains capped at five.
 *
 * Under-specified inter-stage data flow (documented deterministic policy):
 *   • Route source/destination — a route's SOURCE is its well endpoint if it has one
 *     (ships raw Oil), else its refinery endpoint (ships Refined_Product); the
 *     DESTINATION is the other endpoint. A route with neither endpoint (e.g.
 *     hub→home) has no dispatch source and is fed by the hub stage instead.
 *   • Hub inflow — transports delivering INTO a hub accumulate as that hub's
 *     `inflow` for stage 5 rather than writing the buffer directly. A hub's buffer
 *     is a single COMBINED Oil+Product pool (Req 11.3); pushing toward a Home_City
 *     endpoint accrues the combined units to raw Oil (documented simplification).
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { HUB_STORAGE_CAPACITY, WELL_STORAGE_CAPACITY } from '../../../shared/logisticsConstants.js';
import type {
  DistributionHub,
  EngineerTask,
  HomeStock,
  LogisticsEvent,
  LogisticsRoute,
  LogisticsState,
  LogisticsTile,
  OilWell,
  Refinery,
  Transport,
} from '../../../shared/logisticsTypes.js';
import { encodeSeg } from '../../../shared/segmentGraph.js';
import {
  completeBridgeTask,
  completeClearForestTask,
  completeRoadTask,
  completeTask,
  isTaskComplete,
  tickTask,
} from './tasks.js';
import { accrueOil, accrueRefinedProduct, extract, refine } from './production.js';
import { clampTransport, deliver, loadTransport, retainAtSource } from './transport.js';
import { distributeHub } from './hubs.js';
import { advanceShuttle } from './shuttle.js';

/**
 * Default Hit_Points for an Oil_Well completed in stage 1. Within the unit-combat
 * HP domain [1, 50] (see `combatIntegration.ts`); the server applier may override
 * when constructing wells directly — this is just a sensible in-domain default.
 */
const WELL_DEFAULT_MAX_HIT_POINTS = 30;

/** Which kind of endpoint a structure id resolves to within a route. */
type EndpointKind = 'well' | 'refinery' | 'hub' | 'home-city';

/**
 * Resolve one faction's logistics economy for a single turn (see the module note
 * above for the seven ordered stages and the documented inter-stage policy).
 *
 * Pure: neither `state` nor `tiles` is mutated; a fresh `LogisticsState` is returned
 * along with the `LogisticsEvent`s to forward to the client — the same
 * `(state, tiles, faction)` always resolves the same way. Only `faction`'s entities
 * are resolved; every other faction's wells, refineries, routes, transports, hubs,
 * home stock, and tasks are carried through unchanged (by identity where possible).
 *
 * @param state The current authoritative logistics state.
 * @param tiles The seed-regenerated authoritative tiles (as client-safe LogisticsTile).
 * @param faction The acting faction whose economy is resolved this turn.
 * @returns `{ logistics, events }` — the next state and the per-turn events.
 */
export function resolveLogisticsTurn(
  state: LogisticsState,
  tiles: LogisticsTile[],
  faction: string,
): { logistics: LogisticsState; events: LogisticsEvent[] } {
  const events: LogisticsEvent[] = [];
  const owned = (ownerId: string): boolean => ownerId === faction;

  /** True when two structure hexes share a tile edge. */
  const hexesAreAdjacent = (fromTileIndex: number, toTileIndex: number): boolean =>
    tiles[fromTileIndex]?.neighbours.includes(toTileIndex) ?? false;

  /**
   * Fill every adjacent, same-faction storage segment in deterministic state order.
   * Returns the amount accepted so callers can remove exactly that much from the
   * well or refinery without creating or losing commodities.
   */
  const fillAdjacentStorage = (
    sourceId: string,
    sourceTileIndex: number,
    cargoType: 'oil' | 'product',
    available: number,
  ): number => {
    let remaining = Math.max(0, available);
    for (const originalHub of state.hubs) {
      if (!owned(originalHub.ownerId) || !hexesAreAdjacent(sourceTileIndex, originalHub.tileIndex)) continue;
      const hub = hubsById.get(originalHub.id)!;
      const accepted = Math.min(remaining, Math.max(0, HUB_STORAGE_CAPACITY - hub.buffer));
      if (accepted <= 0) continue;
      hubsById.set(hub.id, { ...hub, buffer: hub.buffer + accepted });
      remaining -= accepted;
      events.push({
        kind: 'delivered',
        factionId: faction,
        entityId: hub.id,
        amount: accepted,
        cargoType,
        tileIndex: hub.tileIndex,
        message: `Adjacent storage filled from ${sourceId}.`,
      });
      if (remaining === 0) break;
    }
    return available - remaining;
  };

  // ── Working copies (clones), keyed by id, so we never mutate the inputs. ──
  const wellsById = new Map<string, OilWell>(state.wells.map((w) => [w.id, { ...w }]));
  const refineriesById = new Map<string, Refinery>(state.refineries.map((r) => [r.id, { ...r }]));
  const hubsById = new Map<string, DistributionHub>(state.hubs.map((h) => [h.id, { ...h }]));
  const transportsById = new Map<string, Transport>(state.transports.map((t) => [t.id, { ...t }]));
  const routesById = new Map<string, LogisticsRoute>(state.routes.map((r) => [r.id, r]));
  const home: Record<string, HomeStock> = { ...state.home };
  const clearedForests = [...state.clearedForests];
  const bridges = [...state.bridges];
  // Engineer-built road overlay. Stage 1 appends completed `road` tasks here, so a
  // state that had no roads yet still gains the array once the first one finishes.
  const standaloneRoadSegments = state.standaloneRoadSegments
    ? [...state.standaloneRoadSegments]
    : [];

  // Oil / Refined_Product delivered toward the Home_City this turn, applied in stage 6.
  const homeDelta = { oil: 0, product: 0 };
  // Combined Oil+Product arriving into each hub this turn (fed to distributeHub in stage 5).
  const hubInflow = new Map<string, number>();

  /** Classify a route endpoint id (a well / refinery / hub, else the Home_City). */
  const classify = (id: string): EndpointKind => {
    if (wellsById.has(id)) return 'well';
    if (refineriesById.has(id)) return 'refinery';
    if (hubsById.has(id)) return 'hub';
    return 'home-city';
  };

  /** A route's source (where a transport loads): well if present (ships Oil), else
   *  refinery (ships Product), else null (no dispatch source — fed by the hub stage). */
  const routeSource = (
    route: LogisticsRoute,
  ): { kind: 'well' | 'refinery'; id: string } | null => {
    const ends = [route.fromStructureId, route.toStructureId];
    const wellEnd = ends.find((id) => wellsById.has(id));
    if (wellEnd !== undefined) return { kind: 'well', id: wellEnd };
    const refEnd = ends.find((id) => refineriesById.has(id));
    if (refEnd !== undefined) return { kind: 'refinery', id: refEnd };
    return null;
  };

  /** The endpoint of `route` that is not `structureId` (its far end). */
  const otherEndpoint = (route: LogisticsRoute, structureId: string): string =>
    route.fromStructureId === structureId ? route.toStructureId : route.fromStructureId;

  /** The tile a structure id sits on, when resolvable (for event annotation). */
  const tileOf = (id: string): number | undefined =>
    wellsById.get(id)?.tileIndex ??
    refineriesById.get(id)?.tileIndex ??
    hubsById.get(id)?.tileIndex;

  /**
   * Deliver a transport's `cargo` of `cargoType` into `destId`, returning the
   * undelivered remainder (retained on the transport, Req 8.10). Home_City product
   * is clamped/discarded in stage 6 (Req 5.4, 6.9); hub deliveries become the hub's
   * inflow for stage 5 (Req 11.4), uncapped per-arrival.
   */
  const deliverToEndpoint = (
    destId: string,
    cargoType: 'oil' | 'product',
    cargo: number,
  ): number => {
    switch (classify(destId)) {
      case 'home-city':
        if (cargoType === 'oil') homeDelta.oil += cargo;
        else homeDelta.product += cargo;
        return 0;
      case 'hub':
        hubInflow.set(destId, (hubInflow.get(destId) ?? 0) + cargo);
        return 0;
      case 'well': {
        const w = wellsById.get(destId)!;
        if (cargoType !== 'oil') return cargo; // a well stores only raw Oil; retain the rest.
        const { dest, remainder } = deliver({ stored: w.storedOil, capacity: WELL_STORAGE_CAPACITY }, cargo);
        wellsById.set(destId, { ...w, storedOil: dest.stored });
        return remainder;
      }
      case 'refinery': {
        const r = refineriesById.get(destId)!;
        // A refinery has no stated storage cap, so it accepts the full cargo (Req 8.9).
        if (cargoType === 'oil') refineriesById.set(destId, { ...r, heldOil: r.heldOil + cargo });
        else
          refineriesById.set(destId, {
            ...r,
            refinedProductAvailable: r.refinedProductAvailable + cargo,
          });
        return 0;
      }
    }
  };

  /**
   * Push a hub's distributed COMBINED amount toward `destId`, returning what could
   * not be placed (retained in the hub buffer). Home_City accrues as raw Oil
   * (combined-pool simplification, Req 11.3).
   */
  const depositCombinedToEndpoint = (destId: string, amount: number): number => {
    switch (classify(destId)) {
      case 'home-city':
        homeDelta.oil += amount;
        return 0;
      case 'well': {
        const w = wellsById.get(destId)!;
        const { dest, remainder } = deliver({ stored: w.storedOil, capacity: WELL_STORAGE_CAPACITY }, amount);
        wellsById.set(destId, { ...w, storedOil: dest.stored });
        return remainder;
      }
      case 'refinery': {
        const r = refineriesById.get(destId)!;
        refineriesById.set(destId, { ...r, heldOil: r.heldOil + amount });
        return 0;
      }
      case 'hub': {
        const h = hubsById.get(destId)!;
        const { dest, remainder } = deliver({ stored: h.buffer, capacity: HUB_STORAGE_CAPACITY }, amount);
        hubsById.set(destId, { ...h, buffer: dest.stored });
        return remainder;
      }
    }
  };

  // ── Stage 1: tick engineer tasks and apply completions (Req 2.7, 2.8, 9.4, 10.3) ──
  const remainingTasks: EngineerTask[] = [];
  const newWellIds: string[] = [];
  for (const task of state.tasks) {
    if (!owned(task.ownerId)) {
      remainingTasks.push(task); // other factions' tasks are untouched.
      continue;
    }
    const ticked = tickTask(task);
    if (!isTaskComplete(ticked)) {
      remainingTasks.push(ticked);
      continue;
    }
    // turnsRemaining hit 0 this turn → apply the completion transition.
    switch (task.kind) {
      case 'well': {
        const completion = completeTask(ticked, {
          id: `well-${task.id}`,
          maxHitPoints: WELL_DEFAULT_MAX_HIT_POINTS,
        });
        // completion.kind === 'well' by construction.
        const well = (completion as { kind: 'well'; well: OilWell }).well;
        wellsById.set(well.id, well);
        newWellIds.push(well.id);
        events.push({
          kind: 'well-completed',
          factionId: faction,
          entityId: well.id,
          tileIndex: well.tileIndex,
        });
        break;
      }
      case 'clearForest': {
        const idx = completeClearForestTask(ticked);
        if (!clearedForests.includes(idx)) clearedForests.push(idx);
        break;
      }
      case 'bridge': {
        const idx = completeBridgeTask(ticked);
        if (!bridges.includes(idx)) bridges.push(idx);
        break;
      }
      case 'road': {
        const { tileIndex, segment } = completeRoadTask(ticked);
        const key = encodeSeg(tileIndex, segment);
        if (!standaloneRoadSegments.includes(key)) standaloneRoadSegments.push(key);
        break;
      }
    }
    // A completed task is not retained (its progress is consumed by the transition).
  }

  // ── Stage 2: refine each faction refinery (Req 4.5) ──
  for (const r of state.refineries) {
    if (!owned(r.ownerId)) continue;
    const work = refineriesById.get(r.id)!;
    const before = work.refinedProductAvailable;
    const refined = refine(work);
    refineriesById.set(r.id, refined);
    const produced = refined.refinedProductAvailable - before;
    if (produced > 0) {
      events.push({
        kind: 'refined',
        factionId: faction,
        entityId: r.id,
        amount: produced,
        cargoType: 'product',
      });
    }
  }

  // Capture transports already in transit at the START of the turn: only these advance
  // in stage 4, so a transport dispatched this turn travels its FULL travelTime (Req 7.4).
  const inTransitAtStart = new Set<string>();
  for (const t of state.transports) {
    if (owned(t.ownerId) && t.inTransit) inTransitAtStart.add(t.id);
  }

  // ── Stage 3: dispatch idle transports on operable routes (Req 6.6, 8.1, 12.8) ──
  for (const route of state.routes) {
    if (!owned(route.ownerId)) continue;
    if (route.operable === false) continue; // inoperable route: skip dispatch (Req 12.8, 8.1).
    const src = routeSource(route);
    if (!src) continue; // no well/refinery source (e.g. hub→home): fed by the hub stage.

    let remainingCap = route.capacity; // per-turn Route_Capacity budget (Req 6.6).
    for (const t of state.transports) {
      if (!owned(t.ownerId) || t.routeId !== route.id || t.inTransit) continue;
      if (t.shuttleMode) continue; // shuttles never load/dispatch cargo (advanced separately below).
      if (remainingCap <= 0) break;
      const work = transportsById.get(t.id)!;
      if (work.cargo >= work.cargoCapacity) continue; // no free capacity.

      const cargoType: 'oil' | 'product' = src.kind === 'well' ? 'oil' : 'product';
      const supply =
        src.kind === 'well'
          ? wellsById.get(src.id)!.storedOil
          : refineriesById.get(src.id)!.refinedProductAvailable;
      if (supply <= 0) continue;

      // clampTransport bounds to the route budget, loadTransport to free cargo space;
      // the undelivered surplus stays at the source (retainAtSource, below).
      const allowed = clampTransport(supply, remainingCap);
      const { t: loaded, loaded: amt } = loadTransport(work, allowed, cargoType);
      if (amt <= 0) continue;

      if (src.kind === 'well') {
        const w = wellsById.get(src.id)!;
        wellsById.set(src.id, {
          ...w,
          storedOil: retainAtSource(0, WELL_STORAGE_CAPACITY, w.storedOil - amt),
        });
      } else {
        const r = refineriesById.get(src.id)!;
        refineriesById.set(src.id, {
          ...r,
          refinedProductAvailable: Math.max(0, r.refinedProductAvailable - amt),
        });
      }

      // Send it in transit for the route's travel time (Req 7.4).
      transportsById.set(t.id, { ...loaded, inTransit: true, turnsRemaining: route.travelTime });
      remainingCap -= amt;
      events.push({
        kind: 'dispatched',
        factionId: faction,
        entityId: t.id,
        routeId: route.id,
        amount: amt,
        cargoType,
      });
    }
  }

  // ── Stage 4: advance in-transit transports and deliver on arrival (Req 7.4, 7.5, 8.9) ──
  for (const t of state.transports) {
    if (!owned(t.ownerId) || !inTransitAtStart.has(t.id)) continue;
    const work = transportsById.get(t.id)!;
    const nextRemaining = Math.max(0, work.turnsRemaining - 1);
    if (nextRemaining > 0) {
      transportsById.set(t.id, { ...work, turnsRemaining: nextRemaining }); // still travelling.
      continue;
    }

    // Arrived this turn; destroyed transports were already removed by the combat
    // path, so no destroyed cargo is ever delivered (Req 7.5, 8.6).
    const route = routesById.get(work.routeId);
    const cargo = work.cargo;
    const cargoType = work.cargoType;
    if (!route || cargo <= 0 || cargoType == null) {
      transportsById.set(t.id, { ...work, inTransit: false, turnsRemaining: 0 });
      continue;
    }
    const src = routeSource(route);
    const destId = src ? otherEndpoint(route, src.id) : route.toStructureId;
    const remainder = deliverToEndpoint(destId, cargoType, cargo);
    const delivered = cargo - remainder;
    transportsById.set(t.id, {
      ...work,
      cargo: remainder,
      cargoType: remainder > 0 ? cargoType : null,
      inTransit: false,
      turnsRemaining: 0,
    });
    if (delivered > 0) {
      events.push({
        kind: 'delivered',
        factionId: faction,
        entityId: t.id,
        routeId: route.id,
        amount: delivered,
        cargoType,
        tileIndex: tileOf(destId),
      });
    }
  }

  // ── Stage 4b: advance shuttle transports along their own fixed path. ──
  // Shuttles never carry cargo and are not gated by inTransit/dispatch — they
  // simply patrol back and forth SHUTTLE_SEGMENTS_PER_TURN segments per turn
  // along their own `shuttlePath` (resolved once at creation time; independent
  // of any LogisticsRoute) until stopped. Runs for every faction shuttle
  // regardless of turn-start inTransit state (which shuttles never set).
  for (const t of state.transports) {
    if (!owned(t.ownerId) || !t.shuttleMode) continue;
    transportsById.set(t.id, advanceShuttle(transportsById.get(t.id)!));
  }

  // ── Stage 5: distribute each faction hub's buffered + inflow (Req 11.4) ──
  for (const h of state.hubs) {
    if (!owned(h.ownerId)) continue;
    const hub = hubsById.get(h.id)!;
    const inflowAmt = hubInflow.get(h.id) ?? 0;

    // Operable outgoing routes and their capacities, in the hub's connection order.
    const outgoing = hub.routeIds
      .map((rid) => routesById.get(rid))
      .filter((r): r is LogisticsRoute => r !== undefined && r.operable !== false);
    const caps = outgoing.map((r) => r.capacity);

    const dist = distributeHub(hub, inflowAmt, caps);
    let buffer = dist.newBuffer;

    // Push each route's distributed amount toward its far endpoint; anything that will
    // not fit is retained back in the hub buffer (clamped) so nothing is silently lost.
    outgoing.forEach((route, i) => {
      const amt = dist.amounts[i];
      if (amt <= 0) return;
      const destId = otherEndpoint(route, h.id);
      const leftover = depositCombinedToEndpoint(destId, amt);
      const placed = amt - leftover;
      if (leftover > 0) buffer = Math.min(HUB_STORAGE_CAPACITY, buffer + leftover);
      if (placed > 0) {
        events.push({
          kind: 'delivered',
          factionId: faction,
          entityId: h.id,
          routeId: route.id,
          amount: placed,
          tileIndex: tileOf(destId),
        });
      }
    });

    hubsById.set(h.id, { ...hub, buffer });

    // Anything that fit neither an outgoing route nor the buffer is surfaced as spill.
    if (dist.leftUpstream > 0) {
      events.push({
        kind: 'storage-full',
        factionId: faction,
        entityId: h.id,
        amount: dist.leftUpstream,
      });
    }
  }

  // ── Stage 6: accrue this turn's Home_City deliveries, clamped (Req 5.4, 6.9) ──
  if (homeDelta.oil > 0 || homeDelta.product > 0) {
    const existing: HomeStock = home[faction] ?? { factionId: faction, refinedProduct: 0, oil: 0 };
    let stock: HomeStock = { ...existing };
    if (homeDelta.oil > 0) stock = accrueOil(stock, homeDelta.oil);
    if (homeDelta.product > 0) {
      const before = stock.refinedProduct;
      stock = accrueRefinedProduct(stock, homeDelta.product);
      const discarded = before + homeDelta.product - stock.refinedProduct;
      if (discarded > 0) {
        events.push({
          kind: 'storage-full',
          factionId: faction,
          amount: discarded,
          cargoType: 'product',
        });
      }
    }
    home[faction] = stock;
  }

  // ── Stage 7: extract at end of turn for every operational faction well (Req 3.1) ──
  const factionWellIds = [
    ...state.wells.filter((w) => owned(w.ownerId)).map((w) => w.id),
    ...newWellIds,
  ];
  for (const id of factionWellIds) {
    const w = wellsById.get(id)!;
    const before = w.storedOil;
    const extracted = extract(w);
    wellsById.set(id, extracted);
    const added = extracted.storedOil - before;
    if (added > 0) {
      events.push({
        kind: 'extracted',
        factionId: faction,
        entityId: id,
        amount: added,
        cargoType: 'oil',
      });
    }
  }

  // ── Stage 8: automatically fill storage on adjacent same-faction hexes. ──
  // This runs after well extraction, so a just-produced oil unit can be stored in
  // the same turn. Refinery product made in stage 2 is likewise transferred without
  // consuming a road or a transport.
  for (const r of state.refineries) {
    if (!owned(r.ownerId)) continue;
    const refinery = refineriesById.get(r.id)!;
    const moved = fillAdjacentStorage(
      refinery.id,
      refinery.tileIndex,
      'product',
      refinery.refinedProductAvailable,
    );
    if (moved > 0) {
      refineriesById.set(refinery.id, {
        ...refinery,
        refinedProductAvailable: refinery.refinedProductAvailable - moved,
      });
    }
  }
  for (const id of factionWellIds) {
    const well = wellsById.get(id)!;
    const moved = fillAdjacentStorage(well.id, well.tileIndex, 'oil', well.storedOil);
    if (moved > 0) wellsById.set(well.id, { ...well, storedOil: well.storedOil - moved });
  }

  // ── Rebuild the next state, preserving original order and non-faction entities. ──
  const logistics: LogisticsState = {
    wells: [
      ...state.wells.map((w) => wellsById.get(w.id)!),
      ...newWellIds.map((id) => wellsById.get(id)!),
    ],
    refineries: state.refineries.map((r) => refineriesById.get(r.id)!),
    routes: state.routes.map((r) => routesById.get(r.id)!),
    transports: state.transports.map((t) => transportsById.get(t.id)!),
    hubs: state.hubs.map((h) => hubsById.get(h.id)!),
    home,
    tasks: remainingTasks,
    clearedForests,
    bridges,
    // Omit the key entirely when there is still no road overlay, so states that
    // never had one keep their original shape.
    ...(standaloneRoadSegments.length > 0 ? { standaloneRoadSegments } : {}),
  };

  return { logistics, events };
}
