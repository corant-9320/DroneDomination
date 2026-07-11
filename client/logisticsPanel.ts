/**
 * Logistics Panel — HUD readouts for the Oil Logistics System, hosted inside the
 * bottom detail bar (`#detail-panel`, see `ui-defaults.md`).
 *
 * Presentational only: every function reads from the client-mirrored logistics
 * wire types (`WorldData.logistics` — wells, hubs, routes, transports, home
 * stocks from the task 15.1 mirror) and returns HTML strings / renders into a
 * host element. It performs no fetches and holds no authoritative state — the
 * renderer/controller drive it.
 *
 * DOM-building style mirrors `client/detailPanel.ts`: HTML strings composed with
 * the shared `dp-*` classes and the `dpRow` key/value helper, escaped via
 * `esc()`/`capitalize()` from `client/htmlUtils.ts`, so the readouts inherit the
 * translucent-dark panel look of the existing detail cards.
 *
 * Bounds/labels come from `shared/logisticsConstants.js` (WELL_STORAGE_CAPACITY,
 * HUB_STORAGE_CAPACITY, HOME_CITY_REFINED_PRODUCT_MAX, ROUTE_CAPACITY_MAX) rather
 * than hardcoded numbers, so a constant change flows straight through.
 *
 * Client layering: no imports from `src/` or `server/`; shared imports only.
 * Named exports only; `.js` import extensions.
 */

import type {
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
} from './worldData.js';
import { esc, capitalize } from './htmlUtils.js';
import {
  WELL_STORAGE_CAPACITY,
  HUB_STORAGE_CAPACITY,
  HOME_CITY_REFINED_PRODUCT_MAX,
  ROUTE_CAPACITY_MAX,
} from '../shared/logisticsConstants.js';

// ---------------------------------------------------------------------------
// Selection payload
// ---------------------------------------------------------------------------

/**
 * The logistics entities the panel can display at once. The detail bar passes
 * whatever is relevant to the current selection; the home stock is always shown
 * for the viewing faction. Every field is optional so the panel degrades
 * gracefully when only part of a network is selected.
 */
export interface LogisticsSelection {
  well?: OilWell;
  refinery?: Refinery;
  hub?: DistributionHub;
  route?: LogisticsRoute;
  transport?: Transport;
  home?: HomeStock;
}

// ---------------------------------------------------------------------------
// Per-entity readouts (return HTML string fragments)
// ---------------------------------------------------------------------------

/**
 * Selected Oil_Well storage readout: stored Oil against the fixed
 * WELL_STORAGE_CAPACITY, plus a fill bar and hit points. (Req 3.2)
 */
export function renderWellStorage(well: OilWell): string {
  const stored = clampInt(well.storedOil);
  const cap = WELL_STORAGE_CAPACITY;
  let html = section('🛢 Oil Well', well.id.replace(/^well_/, ''));
  html += storageBar(stored, cap);
  html += dpRow('Stored Oil', `${stored} / ${cap}`);
  html += dpRow('Hit Points', `${clampInt(well.hitPoints)} / ${clampInt(well.maxHitPoints)}`);
  html += sectionEnd();
  return html;
}

/**
 * Selected Distribution_Hub storage readout: buffered combined Oil +
 * Refined_Product against HUB_STORAGE_CAPACITY, plus connected-route count.
 * (Req 11.3)
 */
export function renderHubStorage(hub: DistributionHub): string {
  const buffered = clampInt(hub.buffer);
  const cap = HUB_STORAGE_CAPACITY;
  let html = section('🏗 Distribution Hub', hub.id.replace(/^hub_/, ''));
  html += storageBar(buffered, cap);
  html += dpRow('Buffered', `${buffered} / ${cap}`);
  html += dpRow('Routes', String(hub.routeIds.length));
  html += dpRow('Hit Points', `${clampInt(hub.hitPoints)} / ${clampInt(hub.maxHitPoints)}`);
  html += sectionEnd();
  return html;
}

/**
 * Selected Refinery readout: held raw Oil, Refined_Product awaiting transport,
 * and segment count (which drives throughput). Included so a selected refinery
 * endpoint shows its stock alongside wells/hubs.
 */
export function renderRefineryInfo(refinery: Refinery): string {
  let html = section('🏭 Refinery', refinery.id.replace(/^refinery_/, ''));
  html += dpRow('Segments', String(refinery.segments.length));
  html += dpRow('Held Oil', String(clampInt(refinery.heldOil)));
  html += dpRow('Refined Product', String(clampInt(refinery.refinedProductAvailable)));
  html += dpRow('Hit Points', `${clampInt(refinery.hitPoints)} / ${clampInt(refinery.maxHitPoints)}`);
  html += sectionEnd();
  return html;
}

/**
 * Selected Logistics_Route readout: current Route_Capacity against the
 * ROUTE_CAPACITY_MAX bound, render tier (Road/Highway), and Route_Travel_Time in
 * whole turns. (Req 6.4, 7.3)
 */
export function renderRouteInfo(route: LogisticsRoute): string {
  const cap = clampInt(route.capacity);
  const turns = clampInt(route.travelTime);
  let html = section('🛣 Route', route.id.replace(/^route_/, ''));
  html += dpRow('Capacity', `${cap} / ${ROUTE_CAPACITY_MAX} per turn`);
  html += dpRow('Tier', capitalize(route.tier));
  html += dpRow('Travel Time', `${turns} turn${turns === 1 ? '' : 's'}`);
  html += dpRow('Segments', String(route.segments.length));
  if (!route.operable) {
    html += `<div class="dp-row"><span style="color:#f66;">⚠ Route inoperable (segment destroyed)</span></div>`;
  }
  html += sectionEnd();
  return html;
}

/**
 * Selected Transportation_Unit readout: Transport_Tier (Small_Van / Truck /
 * Juggernaut) and current cargo against its fixed cargo capacity. The tier is a
 * derived field on the mirrored wire type, so it is shown straight. (Req 14.3)
 */
export function renderTransportInfo(transport: Transport): string {
  const cargo = clampInt(transport.cargo);
  const cap = clampInt(transport.cargoCapacity);
  const cargoLabel = transport.cargoType === 'oil'
    ? 'Oil'
    : transport.cargoType === 'product'
      ? 'Refined Product'
      : 'Empty';
  let html = section('🚚 Transport', transport.id.replace(/^transport_/, ''));
  html += dpRow('Tier', tierLabel(transport.tier));
  html += dpRow('Cargo', `${cargo} / ${cap} (${cargoLabel})`);
  html += dpRow('Status', transport.inTransit ? `In transit — ${clampInt(transport.turnsRemaining)} turn(s) left` : 'At endpoint');
  html += sectionEnd();
  return html;
}

/**
 * Home_City stock readout: Refined_Product against the
 * HOME_CITY_REFINED_PRODUCT_MAX bound, and delivered raw Oil. (Req 5.5, 6.9)
 */
export function renderHomeStock(home: HomeStock): string {
  const product = clampInt(home.refinedProduct);
  const oil = clampInt(home.oil);
  let html = section('🏛 Home City', '');
  html += dpRow('Refined Product', `${product} / ${HOME_CITY_REFINED_PRODUCT_MAX}`);
  html += dpRow('Oil', String(oil));
  html += sectionEnd();
  return html;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose the readouts for a selection into a single panel section the detail
 * bar can host. Emits an entity readout for whichever of well / refinery / hub /
 * route / transport is present, followed by the Home_City stock when supplied.
 * Returns an empty-state message when nothing logistics-related is selected.
 */
export function buildLogisticsPanelHtml(sel: LogisticsSelection): string {
  const parts: string[] = [];

  if (sel.well) parts.push(renderWellStorage(sel.well));
  if (sel.refinery) parts.push(renderRefineryInfo(sel.refinery));
  if (sel.hub) parts.push(renderHubStorage(sel.hub));
  if (sel.route) parts.push(renderRouteInfo(sel.route));
  if (sel.transport) parts.push(renderTransportInfo(sel.transport));
  if (sel.home) parts.push(renderHomeStock(sel.home));

  if (parts.length === 0) {
    return '<span class="empty-msg">No logistics entity selected</span>';
  }
  return `<div class="dp-logistics">${parts.join('')}</div>`;
}

/**
 * Render the composed logistics readouts into a host element (the detail bar
 * section). Presentational sink for `buildLogisticsPanelHtml`.
 */
export function renderLogisticsPanel(target: HTMLElement, sel: LogisticsSelection): void {
  target.innerHTML = buildLogisticsPanelHtml(sel);
}

// ---------------------------------------------------------------------------
// Helpers (mirror detailPanel.ts's dpRow / dp-* class conventions)
// ---------------------------------------------------------------------------

/** Key/value row — identical markup to `detailPanel.ts`'s `dpRow`. */
function dpRow(label: string, value: string): string {
  return `<div class="dp-row"><span class="dp-key">${esc(label)}</span><span class="dp-val">${esc(value)}</span></div>`;
}

/** Section header, reusing the `dp-unit-name` heading style with an optional id suffix. */
function section(title: string, idSuffix: string): string {
  const suffix = idSuffix
    ? ` <span style="color:#666;font-size:0.8em;">#${esc(idSuffix)}</span>`
    : '';
  return `<div class="dp-logistics-section"><div class="dp-unit-name">${esc(title)}${suffix}</div>`;
}

function sectionEnd(): string {
  return `</div>`;
}

/** Storage fill bar — reuses the detail panel's HP bar markup for a consistent look. */
function storageBar(current: number, capacity: number): string {
  const ratio = capacity > 0 ? Math.max(0, Math.min(1, current / capacity)) : 0;
  return `<div class="dp-hp-bar-wrap"><div class="dp-hp-bar-fill" style="width:${(ratio * 100).toFixed(1)}%;"></div></div>`;
}

/** Human-readable Transport_Tier label. */
function tierLabel(tier: Transport['tier']): string {
  switch (tier) {
    case 'van':        return 'Small Van';
    case 'truck':      return 'Truck';
    case 'juggernaut': return 'Juggernaut';
    default:           return capitalize(tier);
  }
}

/** Coerce a wire amount to a safe non-negative integer for display. */
function clampInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}
