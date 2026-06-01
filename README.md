# Drone Domination

Turn-based strategy on a globe made of hexagons. Build units, conquer cities, crush your enemies.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000 and click **+ New** to generate a world.

## Other useful commands

```bash
npm test          # run unit tests
npm run build     # compile TypeScript (also regenerates world data)
npm run validate  # check that data/world.json is valid
```

## Starting a game

1. Click **+ New** in the right panel
2. Pick how many enemy cities (1–13) and how far away they start
3. Choose your faction colour
4. Hit **Generate**

## Controls

| Input | Action |
|-------|--------|
| Scroll wheel | Zoom in/out |
| Click + drag | Pan (local map) / Rotate (globe) |
| Click tile | Select tile, show info |
| Right-click tile | Move selected units / Attack enemy |
| Home / ⌂ button | Jump to your home city |
| Space / Next ▶ | End turn |
| Ctrl+S | Save game |
| Ctrl+L | Load game |

Zoom past 1.5× to see units. Zoom past 2.5× to see their stat bars.

## Enemy turns

When enemies move, the right panel shows playback controls:

| Button | What it does |
|--------|-------------|
| ▶ / ⏸ | Auto-play or pause |
| ⏩ | Skip to next action immediately |

Attackers get a red ring, targets get a cyan ring, with an arrow between them.

## Units

There are no fixed unit types — every unit is built from attributes. You design them in the unit designer.

| Attribute | Range | What it does |
|-----------|-------|-------------|
| maxHealth | 1–5 | Hit points (×10, so 10–50 HP) |
| armour | 0–5 | Reduces incoming damage |
| defence | 0–5 | Electronic warfare — stacks with allies in same hex |
| splashAttack | 0–5 | Damages all enemies in target hex |
| rangeAttack | 0–5 | Attack range in hexes (0 = melee only) |
| antiAir | 0–5 | Missile launcher — only targets drones |
| wheeledMovement | 0–5 | Tank chassis |
| limbMovement | 0–5 | Spider chassis |
| flightMovement | 0–5 | Drone chassis |
| repair | 0–5 | Heals a friendly unit in the same hex |

Every unit needs at least 1 point in one movement type. Each hex holds up to 5 units.

### Movement costs

| Chassis | First hex | Clear | Hill or Forest | Hill + Forest |
|---------|-----------|-------|----------------|---------------|
| Tank | 1 MP | 2 MP | 3 MP | 4 MP |
| Spider | 1 MP | 3 MP | 3 MP | 3 MP |
| Drone | 1 MP | 1 MP | 1 MP | 1 MP |

Mountains and oceans block ground units. Drones fly over everything — but enemy anti-air units shoot at them as they pass.

You need at least 1 MP left after moving to attack.

## Saving and loading

- **Ctrl+S** — saves to browser localStorage
- **Ctrl+L** — opens the load screen
- Saves persist between sessions in the same browser

## Deeper docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — module map, data flow, API, TypeScript config
- [COMBAT_RULES.md](COMBAT_RULES.md) — full combat formulas and mechanics reference
