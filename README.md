# Drone Domination

Turn-based strategy on a globe made of hexagons. Build units, conquer cities, crush your enemies.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000 and click **+ New** to generate a world.

## Development God Mode

God Mode is enabled by default whenever the server is not running with
`NODE_ENV=production`. It waives Refined_Product costs for logistics
construction/upgrades and lets **B** queue a bridge task or **F** queue a
forest-clearing task on the selected target tile without an engineer nearby. It
also allows **🛣 Build Road** on an empty cleared/bridged land segment as a
standalone visual overlay, rather than as an economic logistics route. When no
unit is selected, right-clicking an eligible segment exposes these actions in a
separate **God Mode** section. The same section appears when
right-clicking a selected unit, or any unit/building segment with no unit
selected: it can **Edit** its permitted combat attributes (including unit size,
without inheriting the old refit-point budget) or **Delete** the entity. Entity
edits/deletions are persisted
through development-only authoritative match intents; production and
`DD_GOD_MODE=false` reject them. Terrain changes still use the normal five-turn
task duration and retain terrain and duplicate-placement validation. The switch
remains server-owned; clients cannot enable it through a request or URL.

To temporarily use normal rules in development:

```cmd
set DD_GOD_MODE=false && npm run dev
```

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start dev server (localhost:3000) |
| `npm test` | Run the <10-second Group 1 unit smoke suite |
| `npm run test:extended` | Run the remaining Group 2 unit tests |
| `npm run test:all` | Run both unit-test groups |
| `npm run typecheck` | Type-check core, client, and server |
| `npm run build` | Type-check all areas and compile core/server TypeScript to `dist/` |
| `npm run build:world` | Compile and explicitly regenerate `data/world.json` |
| `npm run validate` | Check `data/world.json` is valid (requires compiled CLI) |
| `npm run e2e` | Run Playwright end-to-end tests |

## Starting a Game

1. Click **+ New** in the right panel
2. Pick enemy count (1–13) and spacing
3. Choose faction colour
4. Hit **Generate**

## Controls

| Input | Action |
|-------|--------|
| Scroll wheel | Zoom in/out |
| Click + drag | Pan (local map) / Rotate (globe) |
| Click tile | Select tile |
| Right-click tile | Move selected units / Attack enemy |
| Home / ⌂ | Jump to home city |
| Space / Next ▶ | End turn |
| Ctrl+S | Save game |
| Ctrl+L | Load game |

Zoom past 1.5× to see units. Zoom past 2.5× to see stat bars.

## Units

No fixed unit types — every unit is assembled from attributes (0–5 each):

| Attribute | Effect |
|-----------|--------|
| size | Frame class (1–5). Max HP = size×10. Caps weapons/armour/EW/repair. Locked at creation. |
| armour | Reduces incoming damage |
| defence | Electronic warfare — stacks with allies in same hex |
| splashAttack | Area damage to all enemies in target hex |
| rangeAttack | Attack range in hexes (0 = melee only) |
| antiAir | Missile launcher — targets drones only |
| wheeledMovement | Tank chassis |
| limbMovement | Spider chassis |
| flightMovement | Drone chassis |
| repair | Heals a friendly unit in same hex |

Every unit needs at least 1 point in one movement type. Each hex holds up to 5 units.

## Common Workflows (for Vibe-Coders)

Quick guide to "I want to change X — where do I go?"

| I want to... | Edit these files |
|---|---|
| Tweak combat balance (damage, armour) | `src/world/combatFormula.ts` + `src/world/combat.ts` (reference: `COMBAT_RULES.md`) |
| Add a new unit attribute | `shared/unitTypes.ts`, then update `src/world/units.ts`, `client/unitIcons.ts`, `client/unitDesigner.ts` |
| Change terrain generation | `src/world/generate.ts` |
| Adjust movement costs | `shared/movementConstants.ts` |
| Modify the HUD / panels | `client/` — see `detailPanel.ts`, `combatPanel.ts`, `main.ts` |
| Change world size | `src/world/generate.ts` (`FREQUENCY` constant) |
| Add an API endpoint | `server/devPlugin.ts` (Vite plugin routes) |

After editing world-generation code, run focused tests/type-checks first. Run `npm run build:world` only when you intend to regenerate the committed `data/world.json` artifact; `npm run build` does not regenerate it.

## Saving & Loading

- **Ctrl+S** saves to browser localStorage
- **Ctrl+L** opens the load screen
- Saves persist across sessions in the same browser

## Deeper Docs

- [Architecture wiki](docs/architecture/README.md) — module map, data flow, API contract, debugging (split into focused pages; landing page at [ARCHITECTURE.md](ARCHITECTURE.md))
- [COMBAT_RULES.md](COMBAT_RULES.md) — full combat formulas, validation, constants

See the source-of-truth hierarchy in [`.kiro/steering/core.md`](.kiro/steering/core.md) for how docs, code, and tests rank against each other when they disagree.
