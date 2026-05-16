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
  main.ts           Entry point — initializes GlobeView + LocalMapView
  globe.ts          Three.js OrbitControls globe (class GlobeView)
  localMap.ts       Canvas 2D hex map (class LocalMapView)
  worldData.ts      Loads world JSON, caches in memory/sessionStorage
  newWorldModal.ts  Modal UI for world generation config
  factionColors.ts  Faction color palette + assignment logic
  terrainColors.ts  Terrain → color mapping

server/           → API layer (Vite SSR in dev, Lambda in prod)
  generate.ts       handleGenerate(config) → GenerateResult (framework-agnostic)
  devPlugin.ts      Vite plugin exposing POST /api/generate

src/              → Shared core logic (server + CLI)
  generate.ts       CLI: generate world → data/world.json
  validate.ts       CLI: validate data/world.json
  world/            World module (barrel: index.ts)
    types.ts          Tile, City, World, Vec3, TerrainType
    units.ts          Unit, UnitAttributes, HexSegment, validation
    generate.ts       generateWorld(seed) → World
    goldberg.ts       generateGeodesicSphere(freq), computeDual(mesh)
    terrain.ts        generateTerrain(positions, seed) → TerrainData[]
    cities.ts         placeCities(tiles, seed) → City[]
    pathfinding.ts    graphDistance(), tilesWithinRadius(), findPath() (A*)
    validate.ts       validateWorld(world) → ValidationResult
    peeledView.ts     Flat projection for 2D map
    vec3.ts           Vec3 math utilities

data/             → Generated world files (Vite publicDir, served at /)
  world.json        Full world data (compact format)
  world-summary.json  Metadata summary
```

## Data Flow

```
[Browser]                           [Server]
    │                                   │
    │  POST /api/generate {enemies,     │
    │       spacing}                    │
    │ ─────────────────────────────────►│
    │                                   │  generateWorld(seed)
    │                                   │    → geodesic sphere
    │                                   │    → dual polyhedron (tiles)
    │                                   │    → terrain assignment
    │                                   │    → city placement
    │                                   │    → enemy selection by spacing
    │                                   │    → compact JSON
    │  ◄─────────────────────────────── │
    │  {success, world}                 │
    │                                   │
    │  worldData.ts caches in           │
    │  sessionStorage, reloads page     │
    │                                   │
    │  On load: fetch /world.json       │
    │  (static fallback if no session)  │
```

## Key Types

```typescript
interface World {
  tiles: Tile[];
  cities: City[];
  units: Unit[];
  seed: number;
  pentagonIndices: number[];
}

interface Tile {
  id: string; index: number; sides: 5 | 6;
  neighbours: number[];        // adjacency by tile index
  position3d: Vec3;            // unit sphere
  boundary: Vec3[];            // polygon vertices
  terrainType: TerrainType;    // plains|forest|mountain|desert|ocean|tundra|grassland|hills
  elevation: number;           // 0–1
  ownerId?: string; cityId?: string; unitIds?: string[];
}

interface City {
  id: string; label: string; tileIndex: number;
  neighbourCityIds: string[];
}

interface Unit {
  id: string; label: string; ownerId: string;
  tileIndex: number; segment: HexSegment; // 0–5
  attributes: UnitAttributes;
  currentHealth: number;
}
```

## World Generation Pipeline

1. `generateGeodesicSphere(24)` — subdivided icosahedron → vertices + triangles
2. `computeDual(mesh)` — triangle centroids become tiles, shared edges become adjacency
3. Result: 1442 tiles (12 pentagons + 1430 hexagons)
4. `generateTerrain(positions, seed)` — noise-based terrain + elevation
5. `placeCities(tiles, seed)` — 14 cities on non-ocean tiles, spaced apart
6. `selectEnemyCities(world, player, count, targetSpacing)` — picks enemies closest to target graph distance

## Compact Wire Format

The API and `data/world.json` use a minified format:

| Field | Full name | Note |
|-------|-----------|------|
| `idx` | index | Tile index |
| `s` | sides | 5 or 6 |
| `n` | neighbours | Array of tile indices |
| `pos` | position3d | `[x, y, z]` rounded to 6 decimals |
| `b` | boundary | `[[x,y,z], ...]` rounded to 5 decimals |
| `terrain` | terrainType | String literal |
| `elev` | elevation | Rounded to 3 decimals |
| `city` | cityId | Optional |

## API

### POST /api/generate

Request body:
```json
{ "enemies": 5, "spacing": 25 }
```

- `enemies`: 1–13 (clamped)
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

Each tile is divided into 6 triangular segments (0–5, clockwise from neighbour[0]). Each segment holds at most 1 unit. Max 6 units per tile.

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

## Conventions

- All imports use `.js` extension (ESM resolution)
- No default exports — named exports only
- Barrel re-exports in `src/world/index.ts`
- World data is immutable once generated; UI reads only
- Server handler is pure function (no side effects, no framework deps)
- Constants: `MAX_CITIES = 14`, `MIN_SPACING = 20`, `MAX_SPACING = 45`, `FREQUENCY = 24`
