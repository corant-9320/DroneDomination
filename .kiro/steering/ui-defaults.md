---
inclusion: fileMatch
fileMatchPattern: "client/**"
---

# UI Defaults — Civ6-Inspired Screen Furniture

**Purpose:** Layout rules and panel anatomy for the browser UI.  
**Scope:** `client/**`, `index.html`.  
**Audience:** Agents editing front-end rendering or HUD elements.

## Layout Overview

- **Globe view** (left panel) replaces the Civ6 mini-map
- **Right curtain** (`#combat-log-panel`) — combat log, menu bar, AI playback, Next Turn
- **Bottom bar** (`#detail-panel`) — hex/unit detail: terrain, city, up to 5 unit cards inline
- **Menu bar** lives at top of right curtain (not top-of-screen)

## Right Curtain (Combat Panel)

Menu bar (`#curtain-menu-bar`) — pill-shaped buttons:
- **+ New** — New World generation modal
- **⌂ Home** — centres views on player's home city
- **💾 Save** — localStorage save
- **📂 Load** — load-game modal

Below menu bar (`#combat-log-content`):
- Combat history (◀/▶ navigation)
- Attack previews (hover enemy with unit selected)
- AI playback bar (enemy turns: ▶/⏸ + ⏩)

**Next ▶** button at bottom (`#turn-controls`).

## Bottom Detail Bar

Spans local map width minus curtain (280 px). Shows:
- Tile info (index, shape, neighbours)
- Terrain + elevation
- City ownership
- Up to 5 unit cards (`display: inline-block`)

## AI Turn Playback

`#ai-playback-bar` during enemy turns:
- ▶/⏸ auto-play (~3 s intervals)
- ⏭ step forward (one move) · ⏮/⏪ step/rewind to start
- ⏩ skip to end — instantly resolves all remaining AI moves to their final
  outcome (no per-step delay, animations bypassed); turn then returns to player

Combat highlights: red attacker ring, cyan target ring, dashed arrow.
Move indicator: amber origin ring + dot at the start segment, dashed amber arrow
to the unit's new position. An enemy unit's `#number` turns red once it has
moved/acted this AI turn.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Home | Centre on home city |
| Space | End Turn |
| B | Engineer builds a bridge over an adjacent river hex |
| C | Construct a building on the selected hex segment (one per faction per turn) |
| E | Toggle EW coverage circles (all EW-bearing units & buildings, both factions) |
| N | Toggle unit and building #N number labels (2D and 3D views) |
| V | First-person view of selected unit (toggle; Esc exits) |
| Ctrl+S | Save game |
| Ctrl+L | Load game |
| Escape | Close modal / deselect / exit first-person view |

## Right-Click Menus

- **Own unit** (selected): rotate, refit, sleep, first-person view, **EW coverage**.
- **Enemy building** (own unit selected, in range): right-click the building's
  segment to attack it. Splash-only attackers fire immediately; when a choice
  exists, a small menu offers **💥 Splash Fire** (default) and **⚡ Direct Fire**
  with a list of the building's degradable components. See the building-damage
  feature in `COMBAT_RULES.md` §12.
- **Any segment** (no unit selected, right-click the segment): **👁 View** —
  enter the read-only first-person look-around positioned at that segment, works
  on empty segments too (Esc exits). Also offers **📡 EW coverage** for the
  unit/building occupying that segment (either faction) — draws its anti-drone
  screen radius. When the segment also holds a player-owned building or is on
  the player capital, the same menu additionally shows:
  - **⚙ Refit Building** — opens the building refit modal. Redistribute
    the seven equipment attributes (kinetic, range, splash, anti-air, armour,
    defence, repair) within a fixed points budget. No movement/engineering.
  - **🏛 City Design** (capital hex, segment without a building) — opens the city
    planner modal. Plan buildings ahead of time; planned buildings show
    greyed/dashed, built ones solid. Plans persist per seed (localStorage).

## Design Principles

- HUD along screen edges; centre unobstructed for map
- Translucent dark panels (`rgba(10,10,10,0.5)`)
- Compact typography (12–13 px), functional over decorative
- Subtle hover states, no loud colours except faction highlights
- Every action reachable via mouse and keyboard

## Unit Facing & Rendering

### The Two Coordinate Systems

There are **two independent angle systems** for unit facing that must stay in sync:

1. **Combat math** (`src/world/combatFacing.ts`): Uses `tile.neighbours[facing]` — the facing index selects which neighbour the unit points toward. The orientation bonus is computed from the bearing between 3D tile positions on the unit sphere using tangent-plane projection.

2. **Rendering** (`client/unitRenderer.ts`): Pre-renders 6 isometric sprites per unit type, one per facing direction. The 3D model is rotated around Y by `-(facing × π/3) + π/4` — this assumes facing 0 = screen-north, facing 1 = 60° clockwise, etc.

### The Mismatch Problem

On a sphere, `tile.neighbours[0]` is NOT guaranteed to point screen-north. Its actual screen direction depends on the tile's position on the globe and the local map's tangent-plane projection. Without correction, a unit's **visual direction** (from the pre-rendered sprite) can differ by up to 60° from the **combat math direction** (which determines orientation bonus).

### The Solution: `getCorrectedFacing` (localMapUnits.ts)

When drawing a unit, `drawUnits` computes the **actual screen angle** toward the unit's faced hex edge (using the tile's projected polygon), then quantizes it to the nearest pre-rendered sprite (0°, 60°, 120°, ...). This sprite is drawn without 2D rotation, preserving correct isometric perspective.

**Critical rule:** Never apply 2D canvas rotation to isometric sprites — it breaks the 3D perspective ("tumbling" effect). Always select the nearest pre-rendered facing instead.

### Quantization Error

Since we only have 6 pre-rendered directions, there's up to ±30° of visual error. The **combat math** always uses the exact bearing (continuous 0–2 bonus), so the numbers are precise. The visual is approximate.

### File Responsibilities

| File | Role |
|------|------|
| `client/facing.ts` | **Single source of truth** for all facing conversions — `facingFromTravel`, `rotateHexIndex`, `screenAngleBetweenTiles`, `screenAngleToSpriteFacing`, `spriteFacingForRender`. No other file may do raw `.neighbours.indexOf()` or `(facing ± n) % 6`. |
| `src/world/combatFacing.ts` | Authoritative bearing/bonus math (tangent-plane, continuous) |
| `client/unitRenderer.ts` | Pre-renders 6 isometric sprites per unit type (Y rotation in 3D) |
| `client/unitIcons.ts` | `drawUnitIcon` — draws the sprite at the given corrected facing |
| `client/localMapUnits.ts` | Calls `spriteFacingForRender` from `facing.ts` to map data facing to screen sprite |

### The Three Facing Frames (all are integers/values that look alike but differ)

1. **NeighbourFacing** — index into `tile.neighbours[]`. Tile-relative; the same integer means a different world direction on every tile. This is what `unit.facing` stores. **Never reuse a NeighbourFacing computed for one tile on a different tile.**
2. **ScreenAngle** — radians, north-clockwise (0 = up). Continuous, view-dependent.
3. **SpriteFacing** — index into the pre-rendered sprite set, fixed screen mapping (0 = up, +60°/step). What the renderer expects. **Never store a SpriteFacing in `unit.facing`.**

## Related Files

- `conventions.md` — always loaded, covers build/test commands
- `architecture.md` (+ `architecture-*.md`) — auto-load the relevant architecture wiki page when editing `src/`, `server/`, or config files
