/**
 * GAME DEBUG — DOM instrumentation + window.gameDebug API for dev/test use.
 *
 * ── Implementation note ─────────────────────────────────────────────────────
 * Steering files read: architecture.md, ui-defaults.md, conventions.md,
 *   docs-as-we-go.md, README.md.
 *
 * Game entities instrumented (derived from codebase, not assumptions):
 *   World summary  — seed, tileCount, city/unit counts, turn state
 *   Selection      — selectedTile, selectedSegment, selectedUnitIds
 *   Units          — all UnitData fields + mp/acted/sleeping from TurnManager
 *   Cities         — id, label, tileIndex, isPlayerHome
 *   Event log      — move/attack/repair/turn-end/AI-turn events (rolling 100)
 *
 * Activation:
 *   ?debug=true  in the URL  (checked once at module load)
 *   OR  localStorage.setItem('dd-gameDebug', 'on')  then reload.
 *
 * The debug DOM root is created only in debug mode.  It is a compact overlay
 * that contains machine-readable sections but is not meant for human gameplay.
 *
 * Consumed by:
 *   - Playwright tests (data-testid selectors)
 *   - window.gameDebug.* methods from browser automation / Kiro agents
 *   - scripts/debug-snapshot.mjs already captures window.__DD_STATE__, which
 *     remains the canonical snapshot path — gameDebug adds structured DOM.
 *
 * Update triggers (NOT every animation frame):
 *   - Explicit refreshDebugDom() call
 *   - emitDebugEvent() — called from the game's action handlers
 *   - Automatically after installGameDebug() for initial render
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { WorldData, UnitData, CityData } from './worldData.js';
import type { LocalMapView } from './localMap.js';
import type { TurnManager } from './turnManager.js';
import { getMaxMovement } from '../shared/movementConstants.js';

// ─── Debug mode gate ─────────────────────────────────────────────────────────

function isDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  const urlFlag = new URLSearchParams(window.location.search).get('debug') === 'true';
  const lsFlag  = localStorage.getItem('dd-gameDebug') === 'on';
  return urlFlag || lsFlag;
}

export const DEBUG_ACTIVE = isDebugMode();

// ─── Event log ───────────────────────────────────────────────────────────────

export interface DebugEvent {
  ts: number;
  turn: number;
  type: 'move' | 'attack' | 'repair' | 'turn-end' | 'ai-turn-start' | 'ai-turn-end' | 'refit' | 'sleep' | 'selection';
  detail: Record<string, unknown>;
}

const EVENT_LOG_MAX = 100;
const _eventLog: DebugEvent[] = [];

/**
 * Emit a debug event.  Call this from action handlers in main.ts / aiTurn.ts.
 * Safe to call even when DEBUG_ACTIVE is false — it no-ops immediately.
 */
export function emitDebugEvent(
  type: DebugEvent['type'],
  detail: Record<string, unknown>,
  turn: number,
): void {
  if (!DEBUG_ACTIVE) return;
  _eventLog.push({ ts: Date.now(), turn, type, detail });
  if (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  scheduleDomRefresh();
}

// ─── Deps ────────────────────────────────────────────────────────────────────

interface GameDebugDeps {
  world: WorldData;
  localMap: LocalMapView;
  turnManager: TurnManager;
}

let _deps: GameDebugDeps | null = null;

// ─── Throttled DOM refresh ───────────────────────────────────────────────────

let _refreshPending = false;
function scheduleDomRefresh(): void {
  if (_refreshPending || !DEBUG_ACTIVE) return;
  _refreshPending = true;
  requestAnimationFrame(() => {
    _refreshPending = false;
    refreshDebugDom();
  });
}

// ─── DOM root helpers ────────────────────────────────────────────────────────

function getOrCreateRoot(): HTMLElement | null {
  if (!DEBUG_ACTIVE || typeof document === 'undefined') return null;
  let root = document.getElementById('game-debug-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'game-debug-root';
    root.setAttribute('data-testid', 'game-debug-root');
    root.style.cssText = [
      'position:fixed',
      'bottom:0',
      'right:0',
      'z-index:9999',
      'background:rgba(0,0,0,0.82)',
      'color:#b0ffd8',
      'font-family:monospace',
      'font-size:10px',
      'max-width:320px',
      'max-height:48vh',
      'overflow:hidden',
      'border-top-left-radius:6px',
      'pointer-events:none',
      'display:flex',
      'flex-direction:column',
    ].join(';');
    document.body.appendChild(root);
  }
  return root;
}

function section(testid: string): HTMLElement {
  const el = document.createElement('section');
  el.setAttribute('data-testid', testid);
  return el;
}

// ─── Data builders ───────────────────────────────────────────────────────────

function buildSummary(): Record<string, unknown> {
  if (!_deps) return {};
  const { world, turnManager } = _deps;
  return {
    seed: world.seed,
    tileCount: world.tileCount,
    cityCount: world.cities.length,
    unitCount: world.units.length,
    turn: turnManager.turnNumber,
    activeFaction: turnManager.getActiveFaction(),
    playerFaction: turnManager.getPlayerFaction(),
    isPlayerTurn: turnManager.isPlayerTurn(),
  };
}

function buildCurrentState(): Record<string, unknown> {
  if (!_deps) return {};
  const { turnManager } = _deps;
  const factions = turnManager.getFactions();
  const unitsByFaction: Record<string, number> = {};
  for (const u of _deps.world.units) {
    unitsByFaction[u.ownerId] = (unitsByFaction[u.ownerId] ?? 0) + 1;
  }
  return {
    turnNumber: turnManager.turnNumber,
    activeFaction: turnManager.getActiveFaction(),
    isPlayerTurn: turnManager.isPlayerTurn(),
    factions,
    unitsByFaction,
  };
}

function buildSelection(): Record<string, unknown> {
  if (!_deps) return {};
  const { localMap, world, turnManager } = _deps;
  const selectedIds = [...localMap.getSelectedUnits()];
  const units = selectedIds.map((id) => {
    const u = world.units.find((u) => u.id === id);
    if (!u) return null;
    return serializeUnit(u, turnManager);
  }).filter(Boolean);
  return {
    selectedTile: localMap.selectedTile,
    selectedSegment: localMap.selectedSegment,
    selectedUnitIds: selectedIds,
    centreTile: localMap.centreTileIndex,
    units,
  };
}

function buildVisibleEntities(): Record<string, unknown> {
  if (!_deps) return {};
  const { localMap, world, turnManager } = _deps;
  // Tiles currently projected into the flat view
  const visibleTileIndices = localMap.flatTiles.map((ft) => ft.tileIndex);
  const visibleTileSet = new Set(visibleTileIndices);
  const visibleUnits = world.units
    .filter((u) => visibleTileSet.has(u.tileIndex))
    .map((u) => serializeUnit(u, turnManager));
  const visibleCities = world.cities
    .filter((c) => visibleTileSet.has(c.tileIndex))
    .map(serializeCity);
  return {
    visibleTileCount: visibleTileIndices.length,
    visibleUnitCount: visibleUnits.length,
    visibleCityCount: visibleCities.length,
    units: visibleUnits,
    cities: visibleCities,
  };
}

function buildAvailableActions(): Record<string, unknown> {
  if (!_deps) return {};
  const { world, turnManager } = _deps;
  if (!turnManager.isPlayerTurn()) return { isPlayerTurn: false, actions: [] };
  const actions: string[] = [];
  const playerFaction = turnManager.getPlayerFaction();
  const playerUnits = world.units.filter((u) => u.ownerId === playerFaction);
  const canMoveAny = playerUnits.some((u) => turnManager.canMove(u.id));
  const canActAny  = playerUnits.some((u) => turnManager.canAct(u.id));
  if (canMoveAny)  actions.push('move');
  if (canActAny)   actions.push('attack', 'repair');
  actions.push('end-turn');
  return { isPlayerTurn: true, actions, canMoveAny, canActAny };
}

// ─── Entity serializers ──────────────────────────────────────────────────────

function serializeUnit(u: UnitData, tm: TurnManager): Record<string, unknown> {
  const mp  = tm.getMovementPoints(u.id);
  const maxMp = getMaxMovement(u.attributes);
  return {
    id: u.id,
    label: u.label,
    ownerId: u.ownerId,
    tileIndex: u.tileIndex,
    segment: u.segment,
    facing: u.facing,
    currentHealth: u.currentHealth,
    maxHealth: (u.attributes.maxHealth ?? 1) * 10,
    mp,
    maxMp,
    acted: tm.actedUnits.has(u.id),
    sleeping: tm.isSleeping(u.id),
    attributes: { ...u.attributes },
  };
}

function serializeCity(c: CityData): Record<string, unknown> {
  return {
    id: c.id,
    label: c.label,
    tileIndex: c.tileIndex,
    isPlayerHome: !!c.isPlayerHome,
  };
}

// ─── DOM renderer ────────────────────────────────────────────────────────────

/**
 * Rebuild the entire debug DOM from current game state.
 * Called via scheduleDomRefresh() or directly via window.gameDebug.refreshDebugDom().
 */
function refreshDebugDom(): void {
  const root = getOrCreateRoot();
  if (!root || !_deps) return;

  const summary    = buildSummary();
  const state      = buildCurrentState();
  const sel        = buildSelection();
  const visible    = buildVisibleEntities();
  const actions    = buildAvailableActions();

  // Header bar (always visible, toggles body)
  let header = root.querySelector<HTMLElement>('[data-testid="debug-header"]');
  if (!header) {
    header = document.createElement('div');
    header.setAttribute('data-testid', 'debug-header');
    header.style.cssText = 'padding:3px 6px;background:rgba(0,100,60,0.6);cursor:pointer;pointer-events:auto;flex-shrink:0;user-select:none;';
    header.textContent = '🛠 DD Debug';
    let bodyVisible = true;
    header.addEventListener('click', () => {
      const body = root.querySelector<HTMLElement>('[data-testid="debug-body"]');
      if (body) {
        bodyVisible = !bodyVisible;
        body.style.display = bodyVisible ? 'flex' : 'none';
      }
    });
    root.appendChild(header);
  }

  // Update header with current turn info
  header.textContent = `🛠 DD Debug — T${(summary.turn as number)} ${summary.isPlayerTurn ? '(Player)' : '(AI)'}`;

  // Body container
  let body = root.querySelector<HTMLElement>('[data-testid="debug-body"]');
  if (!body) {
    body = document.createElement('div');
    body.setAttribute('data-testid', 'debug-body');
    body.style.cssText = 'overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:1px;padding:2px 4px 4px;';
    root.appendChild(body);
  }

  // Rebuild all sections
  body.innerHTML = '';

  // ── Summary section ──────────────────────────────────────────────────────
  const summaryEl = section('debug-game-summary');
  summaryEl.innerHTML = `<span style="color:#7ef;">Turn ${summary.turn} · Faction: ${summary.activeFaction} · ${summary.isPlayerTurn ? '▶ Player' : '⏸ AI'}</span>
<span style="color:#aaa;">Tiles:${summary.tileCount} Cities:${summary.cityCount} Units:${summary.unitCount}</span>`;
  summaryEl.style.cssText = 'display:flex;flex-direction:column;gap:1px;padding:2px 0;border-bottom:1px solid #234;';
  body.appendChild(summaryEl);

  // ── Current state section ────────────────────────────────────────────────
  const stateEl = section('debug-current-state');
  const byFaction = (state.unitsByFaction as Record<string, number>);
  const factionSummary = Object.entries(byFaction)
    .map(([id, n]) => `${id.slice(0, 8)}:${n}`)
    .join(' ');
  stateEl.innerHTML = `<span style="color:#fa8;">Factions: ${factionSummary}</span>`;
  stateEl.style.cssText = 'padding:2px 0;border-bottom:1px solid #234;';
  body.appendChild(stateEl);

  // ── Selection section ────────────────────────────────────────────────────
  const selEl = section('debug-selection');
  selEl.setAttribute('data-selected-tile', String(sel.selectedTile ?? -1));
  selEl.setAttribute('data-selected-segment', String(sel.selectedSegment ?? -1));
  selEl.setAttribute('data-selected-unit-ids', JSON.stringify(sel.selectedUnitIds));
  const selUnits = (sel.units as Array<Record<string, unknown>> | undefined) ?? [];
  selEl.style.cssText = 'padding:2px 0;border-bottom:1px solid #234;';
  if (selUnits.length > 0) {
    const u = selUnits[0];
    selEl.innerHTML = `<span style="color:#ff9;">Selected: ${u.label} (${u.id}) HP:${u.currentHealth}/${u.maxHealth} MP:${u.mp}/${u.maxMp}</span>`;
  } else {
    selEl.innerHTML = `<span style="color:#666;">No selection — tile:${sel.selectedTile ?? '–'}</span>`;
  }
  body.appendChild(selEl);

  // ── Visible entities section ─────────────────────────────────────────────
  const visEl = section('debug-visible-entities');
  visEl.style.cssText = 'padding:2px 0;border-bottom:1px solid #234;';
  visEl.innerHTML = `<span style="color:#adf;">View: ${visible.visibleTileCount} tiles · ${visible.visibleUnitCount} units · ${visible.visibleCityCount} cities</span>`;
  // Attach machine-readable unit list
  const visUnits = (visible.units as Array<Record<string, unknown>>) ?? [];
  visEl.querySelectorAll('[data-testid="debug-entity"]').forEach((e) => e.remove());
  for (const u of visUnits) {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'debug-entity');
    el.setAttribute('data-entity-type', 'unit');
    el.setAttribute('data-entity-id', String(u.id));
    el.setAttribute('data-owner-id', String(u.ownerId));
    el.setAttribute('data-tile-index', String(u.tileIndex));
    el.setAttribute('data-segment', String(u.segment));
    el.setAttribute('data-facing', String(u.facing));
    el.setAttribute('data-health', String(u.currentHealth));
    el.setAttribute('data-max-health', String(u.maxHealth));
    el.setAttribute('data-mp', String(u.mp));
    el.setAttribute('data-acted', String(u.acted));
    el.style.display = 'none'; // machine-readable only, no visual clutter
    visEl.appendChild(el);
  }
  body.appendChild(visEl);

  // ── Available actions section ────────────────────────────────────────────
  const actEl = section('debug-available-actions');
  actEl.style.cssText = 'padding:2px 0;border-bottom:1px solid #234;';
  const availActions = (actions.actions as string[]) ?? [];
  actEl.innerHTML = `<span style="color:#aaa;">Actions: ${availActions.length > 0 ? availActions.join(', ') : 'none'}</span>`;
  actEl.setAttribute('data-actions', JSON.stringify(availActions));
  actEl.setAttribute('data-is-player-turn', String(actions.isPlayerTurn ?? false));
  body.appendChild(actEl);

  // ── Event log section ────────────────────────────────────────────────────
  const logEl = section('debug-event-log');
  logEl.style.cssText = 'padding:2px 0;border-bottom:1px solid #234;max-height:60px;overflow-y:auto;';
  const recentEvents = _eventLog.slice(-5);
  if (recentEvents.length === 0) {
    logEl.innerHTML = '<span style="color:#555;">No events yet</span>';
  } else {
    logEl.innerHTML = recentEvents.map((ev) =>
      `<div style="color:#8cf;">T${ev.turn} ${ev.type}: ${JSON.stringify(ev.detail).slice(0, 60)}</div>`
    ).join('');
  }
  body.appendChild(logEl);

  // ── JSON snapshot section ────────────────────────────────────────────────
  const jsonEl = section('debug-state-json');
  const snapshotData = {
    summary,
    state,
    selection: sel,
    availableActions: actions,
    visibleEntityCounts: {
      tiles: visible.visibleTileCount,
      units: visible.visibleUnitCount,
      cities: visible.visibleCityCount,
    },
    recentEvents: _eventLog.slice(-10),
  };
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:2px 0;color:#7c9;font-size:9px;max-height:80px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;';
  pre.textContent = JSON.stringify(snapshotData, null, 0);
  jsonEl.appendChild(pre);
  body.appendChild(jsonEl);
}

// ─── Public install function ──────────────────────────────────────────────────

/**
 * Install window.gameDebug and the debug DOM root.
 * Call after installDebugState() in main.ts.
 *
 * If DEBUG_ACTIVE is false this is a no-op, so there is zero overhead in
 * production and no DOM changes outside debug mode.
 */
export function installGameDebug(deps: GameDebugDeps): void {
  if (!DEBUG_ACTIVE || typeof window === 'undefined') return;

  _deps = deps;

  const gameDebug = {
    /** Summarised world + turn state. */
    getSummary(): Record<string, unknown> {
      return buildSummary();
    },

    /** Current turn/faction/unit-count state. */
    getState(): Record<string, unknown> {
      return buildCurrentState();
    },

    /** Currently selected tile, segment, and unit(s). */
    getSelection(): Record<string, unknown> {
      return buildSelection();
    },

    /** All units and cities currently in the flat-view projection. */
    getEntities(): Record<string, unknown> {
      return buildVisibleEntities();
    },

    /** Actions available to the human player this turn. */
    getAvailableActions(): Record<string, unknown> {
      return buildAvailableActions();
    },

    /** Rolling event log (last 100 events). */
    getEventLog(): DebugEvent[] {
      return _eventLog.slice();
    },

    /**
     * Force a full DOM refresh immediately.
     * Use when you need an up-to-date snapshot synchronously.
     */
    refreshDebugDom(): void {
      refreshDebugDom();
    },

    /**
     * Look up a unit by id and return its current serialized state.
     */
    getUnit(unitId: string): Record<string, unknown> | null {
      if (!_deps) return null;
      const u = _deps.world.units.find((u) => u.id === unitId);
      if (!u) return null;
      return serializeUnit(u, _deps.turnManager);
    },

    /**
     * Look up all units belonging to a faction.
     */
    getUnitsByFaction(factionId: string): Array<Record<string, unknown>> {
      if (!_deps) return [];
      return _deps.world.units
        .filter((u) => u.ownerId === factionId)
        .map((u) => serializeUnit(u, _deps!.turnManager));
    },

    /**
     * Return city data for all cities.
     */
    getCities(): Array<Record<string, unknown>> {
      if (!_deps) return [];
      return _deps.world.cities.map(serializeCity);
    },

    /**
     * Select a unit by id on the local map (navigates to it).
     * This mirrors what the player does via mouse click.
     */
    selectUnit(unitId: string): boolean {
      if (!_deps) return false;
      const unit = _deps.world.units.find((u) => u.id === unitId);
      if (!unit) return false;
      _deps.localMap.setCentre(unit.tileIndex);
      _deps.localMap.setSelected(unit.tileIndex);
      return true;
    },

    /**
     * Move a unit to a destination tile through the REAL client move pipeline
     * (the same `localMap.planMove` route logic the right-click handler uses),
     * then apply the resulting position + MP cost in-browser. Skips the glide
     * animation so callers get a synchronous final state.
     *
     * Unlike POSTing to /api/combat, this exercises the client's own movement
     * code and decrements the unit's movement points (TurnManager-backed), so
     * tests can verify MP spend via getUnit(id).mp.
     *
     * Returns a summary of the move, or null if the unit/plan is invalid.
     */
    moveUnit(unitId: string, destTile: number): {
      moved: boolean;
      fromTile: number;
      toTile: number;
      mpBefore: number;
      mpAfter: number;
    } | null {
      if (!_deps) return null;
      const { world, localMap, turnManager } = _deps;
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return null;

      // Mirror the player's left-click selection so the movement range is
      // computed for THIS unit (planMove reads localMap._rangeResult, which
      // computeMovementRange() derives from the selected unit).
      localMap.setCentre(unit.tileIndex);
      localMap.selectedUnits.clear();
      localMap.selectedUnits.add(unitId);
      localMap.selectedTile = unit.tileIndex;
      localMap.selectedSegment = unit.segment;
      localMap.computeMovementRange();

      const fromTile = unit.tileIndex;
      const mpBefore = turnManager.getMovementPoints(unitId);

      // Shared route computation — identical to the on-screen preview line.
      const plan = localMap.planMove(unit, destTile, unit.segment, mpBefore);
      if (!plan || (plan.destTile === unit.tileIndex && plan.destSegment === unit.segment)) {
        return { moved: false, fromTile, toTile: fromTile, mpBefore, mpAfter: mpBefore };
      }

      // Apply the move (position, facing, MP spend). localMap.movementPoints is
      // TurnManager-backed in the live game, so this is the MP getUnit() reads.
      unit.tileIndex = plan.destTile;
      unit.segment = plan.destSegment as UnitData['segment'];
      if (plan.facing != null) unit.facing = plan.facing as UnitData['facing'];
      localMap.movementPoints.set(unitId, Math.max(0, mpBefore - plan.mpCost));
      localMap.render();

      return {
        moved: true,
        fromTile,
        toTile: unit.tileIndex,
        mpBefore,
        mpAfter: turnManager.getMovementPoints(unitId),
      };
    },

    /**
     * Centre the local map on a tile index without changing selection.
     */
    centreTile(tileIndex: number): void {
      _deps?.localMap.setCentre(tileIndex);
    },

    /**
     * Return all units in the world in the wire format accepted by /api/combat,
     * including the full attributes object the server needs for combat resolution.
     */
    getAllUnits(): Array<Record<string, unknown>> {
      if (!_deps) return [];
      return _deps.world.units.map((u) => serializeUnit(u, _deps!.turnManager));
    },

    /**
     * Return minimal tile adjacency data in the wire format accepted by
     * /api/combat. Only includes idx, s, n, t, elev, f — omits pos and b
     * (boundary vertices) to keep the payload small (~20 KB vs ~4 MB).
     *
     * Sufficient for move and attack resolution. Use the full world save if
     * you need bearing-based orientation bonuses (which require pos).
     */
    getTiles(): unknown[] {
      if (!_deps) return [];
      return _deps.world.tiles.map((t) => ({
        idx: t.idx,
        s: t.s,
        n: t.n,
        t: t.terrain,
        elev: t.elevType,
        f: t.f || undefined,
      }));
    },
  };

  (window as unknown as Record<string, unknown>).gameDebug = gameDebug;

  // Initial DOM render
  refreshDebugDom();
}
