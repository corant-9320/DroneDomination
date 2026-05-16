# Drone Domination

Civilization-style game on a Goldberg G(24,0) polyhedron — a sphere made of hexagons (and 12 pentagons).

## Prerequisites

- Node.js 18+
- npm

## Install

```bash
npm install
```

## Development

Start the Vite dev server (serves the client + API routes):

```bash
npm run dev
```

Opens at http://localhost:3000. Hot-reloads client changes. The `/api/generate` endpoint runs world generation server-side via Vite SSR.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run generate` | Generate a static world file (`data/world.json`) |
| `npm run validate` | Validate an existing `data/world.json` |

## Project Structure

```
├── client/           # Browser code (Canvas 2D local map, Three.js globe)
│   ├── main.ts       # Entry point, wires views + UI
│   ├── globe.ts      # 3D globe view (Three.js + OrbitControls)
│   ├── localMap.ts   # 2D hex map (zoomable, shows segments + units)
│   ├── worldData.ts  # Loads/caches world JSON
│   ├── newWorldModal.ts  # New World config popup
│   └── terrainColors.ts  # Terrain palette
├── server/           # API handlers (will port to AWS Lambda)
│   ├── generate.ts   # handleGenerate() — pure config→world function
│   └── devPlugin.ts  # Vite middleware exposing /api/generate in dev
├── src/              # Core game logic (shared between server + CLI)
│   ├── generate.ts   # CLI: generate world to disk
│   ├── validate.ts   # CLI: validate world.json
│   └── world/        # World module
│       ├── types.ts      # Tile, City, World, Vec3
│       ├── units.ts      # Unit system (attributes, segments, validation)
│       ├── generate.ts   # World generation pipeline
│       ├── goldberg.ts   # Geodesic sphere + dual graph
│       ├── terrain.ts    # Terrain/elevation generation
│       ├── cities.ts     # City placement
│       ├── pathfinding.ts# BFS graph distance
│       ├── validate.ts   # World validation checks
│       ├── peeledView.ts # Flat projection helpers
│       └── vec3.ts       # Vector math
├── data/             # Generated world files (served as static assets)
├── index.html        # App shell
└── vite.config.ts    # Vite config + API plugin
```

## Generating a Static World (offline)

If you want a pre-baked world file without the dev server:

```bash
npm run build
npm run generate
```

This writes `data/world.json` and `data/world-summary.json`.

## In-Game World Generation

Click the **+ New World** button in the local map panel. Configure:
- **Enemy Cities** — how many opponents (1–13)
- **Spacing** — minimum tile distance between your home and the nearest enemy (20–45). Hidden at max enemies since all cities are used.

Hit **Generate** and the server creates a fresh world with a random seed.

## Controls

| Input | Action |
|-------|--------|
| Scroll wheel | Zoom in/out |
| Click + drag | Pan (local map) / Rotate (globe) |
| Click tile | Select tile, show info |
| Home key | Pan to player home city |
| ⌂ Home button | Same as Home key |

Zooming past 1.5× reveals hex segment triangles and unit positions. Past 2.5× shows unit attribute bars.

## Units

Units have no fixed types — each is defined by its attributes:

| Attribute | Range | Description |
|-----------|-------|-------------|
| maxHealth | 1–5 | Hit points |
| armour | 0–5 | Damage reduction |
| meleeAttack | 0–5 | Adjacent combat damage |
| rangeAttack | 0–5 | Ranged combat damage |
| wheeledMovement | 0–5 | Vehicle traversal speed |
| limbMovement | 0–5 | Infantry/creature traversal speed |
| flightMovement | 0–5 | Aerial traversal speed |
| repair | 0–5 | Health restored per action |
| initiative | 0–5 | Turn order priority |

Every unit must have at least 1 point in a movement attribute (wheeled, limb, or flight).

Each hex is divided into 6 triangular segments — max 6 units per tile.

## Future

The `server/generate.ts` handler is framework-agnostic and will port to AWS Lambda behind API Gateway with a thin adapter.
