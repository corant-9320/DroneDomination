# Drone Domination

Turn-based strategy on a globe made of hexagons. Build units, conquer cities, crush your enemies.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000 and click **+ New** to generate a world.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start dev server (localhost:3000) |
| `npm test` | Run unit tests |
| `npm run build` | Compile TypeScript + regenerate world data |
| `npm run validate` | Check `data/world.json` is valid |
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
| Tweak combat balance (damage, armour) | `COMBAT_RULES.md` (spec), then `src/world/combatFormula.ts` + `src/world/combat.ts` |
| Add a new unit attribute | `shared/unitTypes.ts`, then update `src/world/units.ts`, `client/unitIcons.ts`, `client/unitDesigner.ts` |
| Change terrain generation | `src/world/generate.ts` |
| Adjust movement costs | `shared/movementConstants.ts` |
| Modify the HUD / panels | `client/` — see `detailPanel.ts`, `combatPanel.ts`, `main.ts` |
| Change world size | `src/world/generate.ts` (`FREQUENCY` constant) |
| Add an API endpoint | `server/devPlugin.ts` (Vite plugin routes) |

After editing `src/world/**`, run `npm run build` to regenerate world data.

## Saving & Loading

- **Ctrl+S** saves to browser localStorage
- **Ctrl+L** opens the load screen
- Saves persist across sessions in the same browser

## Deeper Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — module map, data flow, API contract
- [COMBAT_RULES.md](COMBAT_RULES.md) — full combat formulas, validation, constants
