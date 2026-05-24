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

server/           → API layer (Vite SSR in dev, Lambda in prod)
  generate.ts       handleGenerate(config) → GenerateResult (framework-agnostic)
  devPlugin.ts      Vite plugin exposing POST /api/generate

src/              → Shared core logic (server + CLI)
  generate.ts       CLI: generate world → data/world.json
  validate.ts       CLI: validate data/world.json
  world/            World module (barrel: index.ts)
    types.ts          Tile, City, World, Vec3, TerrainType
    units.ts          Unit, UnitAttributes, HexSegment, validation helpers
    generate.ts       generateWorld(seed) → World
    goldberg.ts       generateGeodesicSphere(freq), computeDual(mesh)
    terrain.ts        generateTerrain(positions, seed) → TerrainData[]
    cities.ts         placeCities(tiles, seed) → City[]
    spawn.ts          spawnInitialUnits(tiles, cities) → Unit[]
    compact.ts        toCompactWorld/toCompactTile/toCompactUnit (wire format)
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

`CITY_COUNT = 12` (src/world/cities.ts), `MIN_SPACING = 20`, `MAX_SPACING = 45`, `FREQUENCY = 24`
