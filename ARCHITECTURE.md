# Architecture

Machine-readable reference for AI code generators working on this project.

## Tech Stack

- Language: TypeScript (strict, ESM)
- Build: `tsc` → `dist/`
- Dev server: Vite 5 (serves client + SSR API routes)
- Client rendering: Three.js (globe), Canvas 2D (local map)
- Runtime: Node.js 18+
- Future deployment: AWS Lambda + API Gateway

## Module Map

```
client/           → Browser entry (loaded by index.html via Vite)
```

> **Import rule (enforced by tsconfig.client.json):** Client files MUST NOT
> import from `src/` or `server/`. The client tsconfig only includes
> `client/**` and `shared/**`, so any `import from '../src/...'` will fail
> to type-check. Logic needed by both client and server must live in `shared/`.
> Movement constants, range checks, unit naming/attribute types, and combat
> wire types now live in `shared/` (see the module map below). Some heavier
> logic (pathfinding, 3D movement geometry) is still duplicated between
> `src/world/` and `client/`; migrate it into `shared/` when you touch it.

```
client/           → Browser entry (loaded by index.html via Vite)
  main.ts           Entry point — initializes GlobeView + LocalMapView + panels + AI playback
  globe.ts          Three.js OrbitControls globe (class GlobeView)
  localMap.ts       Canvas 2D hex map (class LocalMapView)
  detailPanel.ts    Bottom bar detail view (terrain, units, city info)
  combatPanel.ts    Right-curtain combat log (history nav, attack preview)
  aiTurn.ts         AI faction turn logic (move toward enemy, attack when in range)
  aiPlayback.ts     Video-style playback controller (play/pause/fast-forward for enemy turns)
  worldData.ts      Loads world JSON, caches in memory/sessionStorage
  newWorldModal.ts  Modal UI for world generation config
  saveLoad.ts       Save/Load game state via localStorage
  colors.ts         Faction color palette + terrain color mapping (combined)
  unitIcons.ts      Canvas 2D rendering of unit icons (attribute-driven)
  unitNames.ts      Generates readable names from unit attributes
  unitModel.ts      3D unit model rendering
  unitRenderer.ts   Pre-renders 3D unit sprites for all configurations
  debug.ts          Centralized debug logging (toggle via localStorage)
  debugState.ts     Runtime state snapshot + error capture (window.__DD_STATE__)

server/           → API layer (Vite SSR in dev, Lambda in prod)
  generateApi.ts    handleGenerate(config) → GenerateResult (framework-agnostic)
  combatApi.ts      Combat resolution handler — resolves an action via src/world/
  combatExplainer.ts Pure step-by-step explanation builders for combat/repair
  regenerate.ts     Rebuild tiles + cities from a seed (for compact saves)
  devPlugin.ts      Vite plugin exposing POST /api/generate

shared/           → Logic + types shared by client AND server (client-importable)
  unitTypes.ts      Authoritative UnitAttributes definition
  combatTypes.ts    Combat API wire types (ExplanationStep, etc.)
  movementConstants.ts Movement constants + pure cost helpers
  rangeCheck.ts     Segment-distance range check + weaponRangeFromAttributes()
  unitNaming.ts     Shared naming tables + core name-building logic

src/              → Server/CLI-only core logic (NOT client-importable)
  generateCli.ts    CLI: generate world → data/world.json
  validate.ts       CLI: validate data/world.json
  world/            World module (barrel: index.ts)
    types.ts          Tile, City, World, Vec3, TerrainType
    units.ts          Unit, HexSegment, validation helpers
    generate.ts       Full world-gen pipeline in one file:
                        generateWorld(seed) → World, plus generateGeodesicSphere/
                        computeDual (Goldberg), generateTerrain, generateRivers,
                        placeCities, and mulberry32
    spawn.ts          spawnInitialUnits(tiles, cities) → Unit[]
    compact.ts        toCompactWorld/toCompactTile/toCompactUnit (wire format)
    combat.ts         resolveCombat() — deterministic combat on the hex grid
    combatMath.ts     Pure, stateless damage formulas
    combatFacing.ts   Bearing-based orientation bonus geometry
    movement.ts       moveUnit/pivot primitives (unified segment-step cost)
    turnState.ts      Per-unit movement tracking within a turn
    repair.ts         Attribute-based healing
    segmentGeometry.ts Segment centroids + segment-aware distance
    pathfinding.ts    graphDistance(), tilesWithinRadius(), findPath() (A*)
    validate.ts       validateWorld(world) → ValidationResult
    vec3.ts           Vec3 math utilities

data/             → Generated world files (Vite publicDir, served at /)
  world.json        Full world data (compact format)
  world-summary.json  Metadata summary
```

## Data Flow

1. Client → `POST /api/generate {enemies, spacing}` → Server
2. Server: `generateWorld(seed)` → geodesic sphere → dual → terrain → cities → spawn units → compact JSON
3. Server → `{success, world}` → Client
4. Client: `worldData.ts` caches in sessionStorage, reloads page
5. On fresh load: fetch `/world.json` (static fallback)
6. Save/Load: localStorage (`saveLoad.ts`)

## World Generation Pipeline

1. `generateGeodesicSphere(24)` — subdivided icosahedron → vertices + triangles
2. `computeDual(mesh)` — triangle centroids become tiles, shared edges become adjacency
3. Result: 5762 tiles (12 pentagons + 5750 hexagons) — formula: 10×T²+2 where T=24
4. `generateTerrain(positions, seed)` — noise-based terrain + elevation
5. `placeCities(tiles, seed)` — 12 cities on non-ocean tiles, spaced apart (avoiding polar caps)
6. `selectEnemyCities(world, player, count, targetSpacing)` — picks enemies closest to target graph distance
7. `spawnInitialUnits(tiles, cities)` — 6 units per city (3 splash + 3 ranged, placed in alternating neighbour tiles)

## API

### POST /api/generate

Request body:
```json
{ "enemies": 5, "spacing": 25 }
```

- `enemies`: 1–11 (clamped to MAX_CITIES - 1)
- `spacing`: 20–45, target graph distance from player home to enemies

Response (200):
```json
{ "success": true, "world": { ...compact world... } }
```

Response (400):
```json
{ "success": false, "error": "World validation failed" }
```

## Hex Segments

Each tile is divided into 6 triangular segments (0–5, clockwise from neighbour[0]). Each segment holds at most 1 unit. Max 5 units per tile — one segment must remain unoccupied, keeping hex and pentagon capacity equal.

## Pathfinding

- `graphDistance(tiles, from, to)` — BFS, returns hop count or -1
- `tilesWithinRadius(tiles, centre, radius)` — BFS flood fill → Map<index, distance>
- `findPath(tiles, from, to, costFn?)` — A* with great-circle heuristic

## Configuration

| File | Purpose |
|------|---------|
| `vite.config.ts` | Dev server port 3000, publicDir = `data/`, API plugin |
| `tsconfig.json` | Strict, ESM, target ES2022, outDir `dist/` |
| `tsconfig.client.json` | Client-specific TS config |

## Constants

`CITY_COUNT = 12` (src/world/generate.ts), `MIN_SPACING = 20`, `MAX_SPACING = 45`, `FREQUENCY = 24`

## Debugging Without Screenshots

The client exposes a machine-readable runtime snapshot so agents can inspect the
running game without a human relaying screenshots:

- `window.__DD_STATE__.snapshot()` — turn, selection, camera, and every unit's
  position/health/MP. Defined in `client/debugState.ts`.
- `window.__DD_STATE__.errors` — uncaught errors + unhandled rejections.
- `npm run debug:snapshot` — loads the game headless (needs `npm run dev` running)
  and writes `artifacts/sessions/<timestamp>/{summary.md,state.json,errors.json,console.log,screenshot.png}`.
  Flags: `--turns N`, `--url`, `--wait`.

### DOM Debug Instrumentation (`window.gameDebug`)

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

## Known Drift / Issues

See [`DECISIONS.md`](DECISIONS.md) "Known Issues" for the live list. As of
2026-06-10 the open architectural issues are:

- **Movement cost was modelled twice** — FIXED 2026-06-10. Now a single
  segment-step model: `moveUnit` charges the shared `segmentCost`, and the
  distance×terrain code (`segmentMoveCost`, `TERRAIN_MULTIPLIER_*`) is deleted.
  Rotation is a flat once-per-turn `ROTATION_FEE`. (DECISIONS KI-1)
- **Server combat ignores elevation** — FIXED 2026-06-10. `server/combatApi.ts`
  (then named `server/combat.ts`) now carries `elev` through the wire format so
  the elevation multiplier (COMBAT_RULES §13) works on the server path. (DECISIONS KI-2)
- The compact wire format (`TileData`/`UnitData` in `client/worldData.ts`) is a
  hand-maintained mirror of `src/world/types.ts`; keep the shapes in sync.
