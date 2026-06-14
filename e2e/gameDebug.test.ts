/**
 * E2E tests for the game's debug instrumentation and gameplay loop.
 *
 * All tests share a single page load at /?debug=true (world built once in
 * beforeAll). Tests run in declaration order; later tests rely on state set
 * by earlier ones, so the suite is intentionally sequential.
 *
 * Requires: npm run dev running on port 3000.
 * Run with: npm run e2e
 */

import { test, expect, Page, BrowserContext } from '@playwright/test';

// ─── Types ────────────────────────────────────────────────────────────────────

type GD = Record<string, (...args: unknown[]) => unknown>;
type DDState = {
  snapshot: () => Snapshot;
  errors: Array<{ message: string }>;
  moveRange: (unitId: string) => MoveRangeResult | null;
};

interface Snapshot {
  seed: number;
  turn: { number: number; activeFaction: string; isPlayerTurn: boolean };
  counts: { tiles: number; cities: number; units: number };
  units: Array<{
    id: string; label: string; ownerId: string;
    tileIndex: number; currentHealth: number; maxHealth: number;
    mp: number; acted: boolean;
  }>;
}

interface MoveRangeResult {
  unit: { id: string; tile: number; mp: number };
  reachableTileCount: number;
  neighbourReach: Array<{ dir: number; tile: number; reachable: boolean; cost: number | null }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function snap(page: Page): Promise<Snapshot> {
  return page.evaluate(() =>
    (window as unknown as { __DD_STATE__: DDState }).__DD_STATE__.snapshot()
  );
}

async function callGD<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([m, a]) => {
      const g = (window as unknown as { gameDebug: GD }).gameDebug;
      return g[m as string](...(a as unknown[])) as T;
    },
    [method, args] as [string, unknown[]]
  );
}

async function refreshDebug(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { gameDebug: GD }).gameDebug.refreshDebugDom()
  );
}

// ─── Shared browser context ───────────────────────────────────────────────────

test.describe('Drone Domination — world validation and gameplay', () => {
  let context: BrowserContext;
  let page: Page;

  // Captured across tests
  let playerFaction = '';

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto('/?debug=true');
    await expect(page.locator('#loading')).toBeHidden({ timeout: 25_000 });
    // Capture player faction once after load — used by all gameplay tests
    const summary = await callGD<Record<string, unknown>>(page, 'getSummary');
    playerFaction = summary['activeFaction'] as string;
  });

  test.afterAll(async () => {
    await context.close();
  });

  // ── Section 1: World loads and renders ───────────────────────────────────

  test('World loads — globe and local-map canvases are visible with non-zero dimensions', async () => {
    const globeCanvas = page.locator('#globe-canvas');
    const localCanvas = page.locator('#local-canvas');

    await expect(globeCanvas, 'globe canvas is visible').toBeVisible();
    await expect(localCanvas, 'local-map canvas is visible').toBeVisible();

    const [g, l] = await Promise.all([
      globeCanvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height })),
      localCanvas.evaluate((el: HTMLCanvasElement) => ({ w: el.width, h: el.height })),
    ]);

    expect(g.w, 'globe canvas width > 0').toBeGreaterThan(0);
    expect(g.h, 'globe canvas height > 0').toBeGreaterThan(0);
    expect(l.w, 'local-map canvas width > 0').toBeGreaterThan(0);
    expect(l.h, 'local-map canvas height > 0').toBeGreaterThan(0);
  });

  test('World loads — no uncaught JS errors captured during initialisation', async () => {
    const errors = await page.evaluate(
      () => (window as unknown as { __DD_STATE__: DDState }).__DD_STATE__.errors
    );
    expect(errors, 'zero uncaught JS errors on load').toHaveLength(0);
  });

  test('World loads — debug overlay is injected and all required DOM sections are present', async () => {
    for (const testid of [
      'game-debug-root',
      'debug-game-summary',
      'debug-current-state',
      'debug-selection',
      'debug-visible-entities',
    ]) {
      await expect(
        page.locator(`[data-testid="${testid}"]`),
        `[data-testid="${testid}"] is in the DOM`
      ).toBeAttached();
    }
  });

  // ── Section 2: World structure ───────────────────────────────────────────

  test('World structure — getSummary() reports a numeric seed, tile count ≥ 1 000, and at least 1 city and unit', async () => {
    const s = await callGD<Record<string, unknown>>(page, 'getSummary');

    expect(typeof s['seed'], 'seed is a number').toBe('number');
    expect(typeof s['turn'], 'turn is a number').toBe('number');
    expect(typeof s['tileCount'], 'tileCount is a number').toBe('number');
    expect(s['tileCount'] as number, 'world has ≥ 1 000 tiles').toBeGreaterThan(1_000);
    expect(s['cityCount'] as number, 'world has ≥ 1 city').toBeGreaterThan(0);
    expect(s['unitCount'] as number, 'world has ≥ 1 unit').toBeGreaterThan(0);
  });

  test('World structure — getState() returns at least 2 factions with unit counts reported by faction', async () => {
    const state = await callGD<Record<string, unknown>>(page, 'getState');

    // factions is string[] of faction ids (may include all factions, some may have 0 units)
    const factions = state['factions'] as string[];
    expect(Array.isArray(factions), 'factions is an array').toBe(true);
    expect(factions.length, 'at least 2 factions').toBeGreaterThanOrEqual(2);
    for (const fid of factions) {
      expect(typeof fid, `faction entry is a string`).toBe('string');
    }

    // unitsByFaction may only include factions that have units
    const byFaction = state['unitsByFaction'] as Record<string, number>;
    expect(typeof byFaction, 'unitsByFaction is an object').toBe('object');
    const totalUnits = Object.values(byFaction).reduce((sum, n) => sum + n, 0);
    expect(totalUnits, 'unitsByFaction totals at least 1 unit').toBeGreaterThan(0);
  });

  test('World structure — getCities() returns cities each with a string id and a non-negative tile index', async () => {
    const cities = await callGD<Array<Record<string, unknown>>>(page, 'getCities');

    expect(cities.length, 'at least 1 city').toBeGreaterThan(0);
    for (const c of cities) {
      expect(typeof c['id'], `city id is a string`).toBe('string');
      expect(typeof c['tileIndex'], `city ${c['id']} tileIndex is a number`).toBe('number');
      expect(c['tileIndex'] as number, `city ${c['id']} tileIndex is non-negative`).toBeGreaterThanOrEqual(0);
    }
  });

  test('World structure — debug-state-json DOM element contains parseable JSON with a summary block', async () => {
    await refreshDebug(page);
    const text = await page.locator('[data-testid="debug-state-json"]').textContent();
    expect(text, 'debug-state-json has content').toBeTruthy();

    let parsed: Record<string, unknown> = {};
    expect(() => { parsed = JSON.parse(text!); }, 'debug-state-json is valid JSON').not.toThrow();
    expect(typeof parsed['summary'], 'parsed JSON contains a summary object').toBe('object');
  });

  // ── Section 3: Unit validation ───────────────────────────────────────────

  test('Units — every unit in the snapshot has a string id, label, non-negative tile index, health > 0, and MP ≥ 0', async () => {
    const s = await snap(page);

    expect(s.units.length, 'snapshot contains at least 1 unit').toBeGreaterThan(0);
    for (const u of s.units) {
      expect(typeof u.id, 'unit id is string').toBe('string');
      expect(typeof u.label, `unit ${u.id} label is string`).toBe('string');
      expect(u.tileIndex, `unit ${u.id} tileIndex is non-negative`).toBeGreaterThanOrEqual(0);
      expect(u.currentHealth, `unit ${u.id} health > 0`).toBeGreaterThan(0);
      expect(u.mp, `unit ${u.id} MP ≥ 0`).toBeGreaterThanOrEqual(0);
    }
  });

  test('Units — unit DOM elements in the debug overlay expose all required automation data-attributes', async () => {
    const unitEl = page.locator('[data-testid="debug-entity"][data-entity-type="unit"]').first();
    await expect(unitEl, 'at least one unit DOM element exists').toBeAttached();

    for (const attr of ['data-entity-id', 'data-owner-id', 'data-tile-index', 'data-health', 'data-mp']) {
      await expect(unitEl, `unit element has ${attr}`).toHaveAttribute(attr);
    }
  });

  test('Units — getUnit(id) returns state consistent with the snapshot: same id, label, and health', async () => {
    const s = await snap(page);
    const first = s.units[0];

    const u = await callGD<Record<string, unknown>>(page, 'getUnit', first.id);
    expect(u, 'getUnit returns a non-null result').not.toBeNull();
    expect(u!['id'], 'id matches snapshot').toBe(first.id);
    expect(u!['label'], 'label is a non-empty string').toMatch(/\S/);
    expect(u!['currentHealth'] as number, 'health matches snapshot').toBe(first.currentHealth);
    expect(u!['mp'] as number, 'mp is non-negative').toBeGreaterThanOrEqual(0);
  });

  test('Units — getUnitsByFaction(id) returns only units that belong to the requested faction', async () => {
    const s = await snap(page);
    const fid = s.units[0].ownerId;

    const units = await callGD<Array<Record<string, unknown>>>(page, 'getUnitsByFaction', fid);
    expect(units.length, 'at least one unit in faction').toBeGreaterThan(0);
    for (const u of units) {
      expect(u['ownerId'], `unit ${u['id']} belongs to ${fid}`).toBe(fid);
    }
  });

  // ── Section 4: Turn state ────────────────────────────────────────────────

  test('Turn state — game starts on the player\'s turn and available actions include end-turn', async () => {
    const summary = await callGD<Record<string, unknown>>(page, 'getSummary');
    expect(summary['isPlayerTurn'], 'game starts on player turn').toBe(true);

    const actEl = page.locator('[data-testid="debug-available-actions"]');
    await expect(actEl, 'debug-available-actions element exists').toBeAttached();
    const raw = await actEl.getAttribute('data-actions');
    expect(raw, 'data-actions attribute is present').not.toBeNull();

    const actions: string[] = JSON.parse(raw!);
    expect(Array.isArray(actions), 'data-actions is an array').toBe(true);
    expect(actions, 'end-turn is always listed').toContain('end-turn');
  });

  test('Turn state — player faction has at least one unit with remaining movement points', async () => {
    const units = await callGD<Array<Record<string, unknown>>>(page, 'getUnitsByFaction', playerFaction);
    const movable = units.filter((u) => (u['mp'] as number) > 0);
    expect(movable.length, `faction ${playerFaction} has ≥ 1 unit with MP`).toBeGreaterThan(0);
  });

  // ── Section 5: Gameplay — navigation ────────────────────────────────────

  test('Gameplay — selectUnit(id) navigates the local map to the unit\'s tile and updates the selection', async () => {
    const s = await snap(page);
    const unit = s.units.find((u) => u.ownerId === playerFaction);
    expect(unit, 'a player unit exists in snapshot').toBeDefined();

    const ok = await callGD<boolean>(page, 'selectUnit', unit!.id);
    expect(ok, 'selectUnit returns true').toBe(true);

    const sel = await callGD<Record<string, unknown>>(page, 'getSelection');
    expect(sel['selectedTile'], 'selected tile matches unit tile after selectUnit').toBe(unit!.tileIndex);
  });

  // ── Section 6: Gameplay — movement validation ────────────────────────────

  test('Gameplay — moveRange: reports reachable neighbours for a player unit with MP remaining', async () => {
    const s = await snap(page);
    const unit = s.units.find((u) => u.ownerId === playerFaction && u.mp > 0);
    expect(unit, 'a movable player unit exists').toBeDefined();

    const info = await page.evaluate(
      (uid) => (window as unknown as { __DD_STATE__: DDState }).__DD_STATE__.moveRange(uid),
      unit!.id
    ) as MoveRangeResult | null;

    expect(info, 'moveRange returns a result').not.toBeNull();
    expect(info!.reachableTileCount, 'unit can reach at least 1 tile').toBeGreaterThan(0);

    const reachable = info!.neighbourReach.filter((n) => n.reachable);
    expect(reachable.length, 'at least 1 adjacent tile is reachable').toBeGreaterThan(0);
  });

  // NOTE: /api/combat is a STATELESS pure resolver. It updates a unit's
  // tileIndex/facing and returns the new board, but it does NOT track movement
  // points — MP lives client-side in TurnManager. So this test validates the
  // server contract (unit relocates to the target tile) only. Verifying that
  // MP is decremented is the job of a client-side test that drives a real move
  // through the UI and reads gameDebug.getUnit(id).mp.
  // Our first browser-based gameplay test: drives the REAL client move pipeline
  // (gameDebug.moveUnit → localMap.planMove → in-browser state mutation) and
  // verifies the unit relocates AND spends movement points client-side. This is
  // the lightweight replacement for the old /api/combat move test, which shipped
  // the entire world over the wire and was too slow.
  test('Gameplay — move (in-browser): moveUnit relocates a player unit to an adjacent tile and spends MP', async () => {
    const s = await snap(page);
    const unit = s.units.find((u) => u.ownerId === playerFaction && u.mp > 0);
    expect(unit, 'a movable player unit exists').toBeDefined();

    // Pick an adjacent tile the unit can actually reach (same source the
    // on-screen movement overlay uses).
    const info = await page.evaluate(
      (uid) => (window as unknown as { __DD_STATE__: DDState }).__DD_STATE__.moveRange(uid),
      unit!.id
    ) as MoveRangeResult | null;
    const reachable = (info?.neighbourReach ?? []).filter((n) => n.reachable);
    expect(reachable.length, 'unit has at least one reachable adjacent tile').toBeGreaterThan(0);
    const targetTile = reachable[0].tile;

    const before = await callGD<Record<string, unknown>>(page, 'getUnit', unit!.id);
    const mpBefore = before!['mp'] as number;

    // Drive the real client-side move.
    const result = await callGD<{
      moved: boolean; fromTile: number; toTile: number; mpBefore: number; mpAfter: number;
    } | null>(page, 'moveUnit', unit!.id, targetTile);

    expect(result, 'moveUnit returns a result').not.toBeNull();
    expect(result!.moved, 'the move was executed').toBe(true);
    expect(result!.toTile, 'unit landed on the requested adjacent tile').toBe(targetTile);
    expect(result!.mpAfter, 'MP decreased after the in-browser move').toBeLessThan(mpBefore);

    // Cross-check via the public debug API — the game state actually changed.
    const after = await callGD<Record<string, unknown>>(page, 'getUnit', unit!.id);
    expect(after!['tileIndex'] as number, 'getUnit reports the new tile').toBe(targetTile);
    expect(after!['mp'] as number, 'getUnit reports reduced MP').toBeLessThan(mpBefore);
  });

  // ── Section 7: Gameplay — end turn ───────────────────────────────────────

  test('Gameplay — end turn: ending the turn and skipping AI playback advances the turn counter and returns to the player', async () => {
    // The enemy round is player-driven: after end-turn the game shows the AI
    // playback bar (#ai-playback-bar) and pauses. The ⏩ Skip-to-End button
    // resolves every AI move to its final outcome instantly (no per-step delay,
    // animations bypassed), after which the turn advances back to the player.
    test.setTimeout(60_000);

    const sBefore = await snap(page);
    const turnBefore = sBefore.turn.number;

    await page.click('#next-turn-btn');

    // Dismiss the "unmoved units" confirmation dialog if it appears
    try {
      await page.locator('#confirm-end').click({ timeout: 2_000 });
    } catch {
      // No dialog — turn ended immediately
    }

    // Skip straight to the final outcome of the enemy round.
    const skip = page.locator('#ai-pb-skip');
    await expect(skip, 'AI playback bar appears after ending the turn').toBeVisible({ timeout: 10_000 });
    await skip.click();

    // Wait for the turn counter to increment (skip resolves the round quickly)
    await page.waitForFunction(
      (expected: number) =>
        (window as unknown as { __DD_STATE__: DDState }).__DD_STATE__.snapshot().turn.number > expected,
      turnBefore,
      { timeout: 30_000 }
    );

    const sAfter = await snap(page);
    expect(sAfter.turn.number, 'turn number incremented after end-turn').toBeGreaterThan(turnBefore);
    expect(sAfter.turn.isPlayerTurn, 'game returns to player turn after all AI factions move').toBe(true);
  });

  test('Gameplay — new turn: player units have refreshed movement points at the start of the new turn', async () => {
    const units = await callGD<Array<Record<string, unknown>>>(page, 'getUnitsByFaction', playerFaction);
    const withMp = units.filter((u) => (u['mp'] as number) > 0);
    expect(withMp.length, 'at least one player unit has MP on the new turn').toBeGreaterThan(0);
  });

  // ── Section 8: Debug API completeness ────────────────────────────────────

  test('Debug API — window.gameDebug exposes all required public methods', async () => {
    const methods = await page.evaluate(() =>
      Object.keys((window as unknown as { gameDebug: GD }).gameDebug)
    );
    for (const m of [
      'getSummary', 'getState', 'getSelection', 'getEntities',
      'getAvailableActions', 'getEventLog', 'refreshDebugDom',
      'getUnit', 'getUnitsByFaction', 'getAllUnits', 'getCities', 'getTiles', 'selectUnit', 'moveUnit', 'centreTile',
    ]) {
      expect(methods, `gameDebug.${m}() exists`).toContain(m);
    }
  });

  test('Debug API — getEventLog() contains the turn-end/AI events emitted by the preceding end-turn', async () => {
    // emitDebugEvent() is only called from the real UI action handlers in
    // main.ts (turn-end, ai-turn-start, ai-turn-end, attack, repair, ...).
    // The end-turn test above drives that flow, so the log must now contain a
    // 'turn-end' event. This test intentionally depends on the prior end-turn
    // (the suite is sequential — see the file header) and asserts the specific
    // events rather than a bare length, so a future ordering change fails loudly.
    const log = await callGD<Array<{ type: string }>>(page, 'getEventLog');
    expect(Array.isArray(log), 'getEventLog returns an array').toBe(true);
    expect(log.length, 'event log has entries after the end-turn').toBeGreaterThan(0);

    const types = log.map((e) => e.type);
    expect(types, 'a turn-end event was emitted by the end-turn flow').toContain('turn-end');
  });

  test('Debug API — refreshDebugDom() updates the overlay synchronously without throwing', async () => {
    const error = await page.evaluate(() => {
      try {
        (window as unknown as { gameDebug: GD }).gameDebug.refreshDebugDom();
        return null;
      } catch (e) {
        return String(e);
      }
    });
    expect(error, 'refreshDebugDom does not throw').toBeNull();
  });
});
