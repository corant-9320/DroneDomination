# Debugging Instrumentation

[← Architecture Wiki](README.md) · Covers `client/debugState.ts`, `client/gameDebug.ts`, headless snapshots

The client exposes a machine-readable runtime snapshot so agents can inspect the
running game without a human relaying screenshots.

## Runtime Snapshot (`window.__DD_STATE__`)

- `window.__DD_STATE__.snapshot()` — turn, selection, camera, and every unit's
  position/health/MP. Defined in `client/debugState.ts`.
- `window.__DD_STATE__.errors` — uncaught errors + unhandled rejections.
- `npm run debug:snapshot` — loads the game headless (needs `npm run dev` running)
  and writes `artifacts/sessions/<timestamp>/{summary.md,state.json,errors.json,console.log,screenshot.png}`.
  Flags: `--turns N`, `--url`, `--wait`.

### What the snapshot does and does not cover

`snapshot()` is **units-only**. It returns `seed`, `turn`, `counts`
(tiles/cities/units + units-by-faction), `selection`, `units[]`, and `errors` —
and nothing else. It does **not** include:

- `world.logistics` (wells, refineries, routes, transports, hubs, tasks, home stock)
- `world.buildings`
- city detail beyond a count

So it cannot answer "is this logistics entity present?" — use `console.log` in the
relevant renderer, or read `console.log` from the session directory, which does
capture every browser console message including rejected-intent errors. Check this
list before spending a run: a snapshot that structurally cannot contain the answer
is a wasted round-trip. Extend the `snapshot()` return in `client/debugState.ts`
if a new domain needs coverage.

### Load-time floor

The default `--wait` is 30 s, which is **shorter than this project's cold load**
(seed-based tile regeneration alone is ~4–9 s and the `#loading` overlay clears
well after that). A default-flag run typically fails with
`waiting for locator('#loading') to be hidden`. Pass `--wait 45000` or higher.

## DOM Debug Instrumentation (`window.gameDebug`)

Activate by appending `?debug=true` to the URL, or:
```js
localStorage.setItem('dd-gameDebug', 'on');  // then reload
```

This installs `window.gameDebug` and a persistent DOM overlay
`#game-debug-root [data-testid="game-debug-root"]` with the following sections:

| `data-testid` | Content |
|---|---|
| `debug-game-summary` | Turn number, active faction, unit/city counts |
| `debug-current-state` | Faction list and unit-count-by-faction |
| `debug-selection` | Selected tile/segment/units + `data-selected-*` attrs |
| `debug-visible-entities` | Per-unit `[data-testid="debug-entity"]` elements (hidden, machine-readable) |
| `debug-available-actions` | `data-actions` JSON array + `data-is-player-turn` |
| `debug-event-log` | Rolling last-5 events visible; full 100 via `getEventLog()` |
| `debug-state-json` | Compact JSON snapshot `<pre>` |

Per-unit DOM elements (inside `debug-visible-entities`):
```html
<div data-testid="debug-entity"
     data-entity-type="unit"
     data-entity-id="unit_5"
     data-owner-id="city_0"
     data-tile-index="1234"
     data-segment="2"
     data-facing="3"
     data-health="40"
     data-max-health="50"
     data-mp="3"
     data-acted="false">
</div>
```

`window.gameDebug` methods:
```ts
gameDebug.getSummary()          // seed, turn, faction, isPlayerTurn, counts
gameDebug.getState()            // factions array, unitsByFaction map
gameDebug.getSelection()        // selectedTile, selectedSegment, units[]
gameDebug.getEntities()         // units + cities in current flat-view
gameDebug.getAvailableActions() // actions[], isPlayerTurn, canMoveAny, canActAny
gameDebug.getEventLog()         // DebugEvent[] — last 100 events
gameDebug.refreshDebugDom()     // force DOM refresh
gameDebug.getUnit(id)           // full unit state by id
gameDebug.getUnitsByFaction(id) // all units for a faction
gameDebug.getCities()           // all city data
gameDebug.selectUnit(id)        // navigate + select a unit on the map
gameDebug.centreTile(idx)       // pan local map to tile
```

Example Playwright/Kiro usage:
```ts
await page.goto('/?debug=true');
await expect(page.locator('[data-testid="game-debug-root"]')).toBeAttached();
const summary = await page.evaluate(() =>
  (window as any).gameDebug.getSummary()
);
const units = await page.locator('[data-testid="debug-entity"]').all();
```

To add new entity attributes later: add a `data-*` attribute assignment in
the `visEl` loop inside `refreshDebugDom()` in `client/gameDebug.ts`.

## See Also

- `.kiro/steering/debugging.md` — when to instrument vs. keep guessing
- `.kiro/steering/docs-as-we-go.md` — the headless debug workflow
