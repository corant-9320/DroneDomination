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

Opens at http://localhost:3000. Hot-reloads client changes.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run generate` | Generate a static world file (`data/world.json`) |
| `npm run validate` | Validate an existing `data/world.json` |

## Generating a Static World (offline)

```bash
npm run build
npm run generate
```

Writes `data/world.json` and `data/world-summary.json`.

## In-Game World Generation

Click **+ New World** in the local map panel:

- **Enemy Cities** — number of opponents (1–13)
- **Distance from Home** — target tile distance to enemies (20–45). Hidden at max enemies.
- **Your Colour** — pick a faction color

## Controls

| Input | Action |
|-------|--------|
| Scroll wheel | Zoom in/out |
| Click + drag | Pan (local map) / Rotate (globe) |
| Click tile | Select tile, show info |
| Home key / ⌂ button | Pan to player home city |

Zooming past 1.5× reveals hex segments and units. Past 2.5× shows attribute bars.

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

Every unit must have at least 1 movement point (wheeled, limb, or flight). Each hex holds up to 5 units in triangular segments (one segment stays free).

## Project Layout

```
client/     Browser code (Three.js globe + Canvas 2D local map)
server/     API handlers (Vite SSR in dev, will port to Lambda)
src/        Core game logic (shared between server + CLI)
data/       Generated world files (served as static assets)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed module breakdown, data flow, types, and conventions.
