---
inclusion: fileMatch
fileMatchPattern: "{client/**,index.html}"
---

# UI Defaults — Civ6-Inspired Screen Furniture

**Purpose:** Layout rules, controls, and panel anatomy for the browser UI.
**Scope:** `client/**`, `index.html`.
**Audience:** Agents editing front-end layout, HUD, panels, menus, or controls.
**Related:** `ui-facing.md` (facing/sprite/model orientation rules — loads only for renderer and facing modules) · `external-3d-models.md` (GLB/GLTF import rules) · `conventions.md`

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
| B | Queue an authoritative bridge task; with God Mode, use the selected bridge tile without an engineer |
| F | Queue an authoritative forest-clearing task; with God Mode, use the selected forest without an engineer |
| R | Selected engineer paves the road segment it is standing on (timed `road` task). Chain segments to connect two oil structures so a shuttle transport can run |
| C | Construct a building on the selected hex segment (one per faction per turn) |
| E | Toggle EW coverage circles (all EW-bearing units & buildings, both factions) |
| N | Cycle entity overlays: labels → labels + health/movement bars + selection circles + faction unit circles hidden (2D and 3D views) → all shown |
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
  - A distinct **God Mode** section appears only when the server-derived match
    capability permits the relevant development action. It shows context-valid
    terrain actions — **🌉 Build Bridge** for an unbridged impassable tile,
    **🌲 Clear Forest** for an uncleared forest tile, and **🛣 Build Road** for
    an empty cleared/bridged land segment. Bridge/forest pending tasks suppress
    the matching action; the standalone road is a visual overlay, not a logistics
    route. On a selected unit, or any clicked unit/building segment
    when no unit is selected, it instead exposes **⚙ Edit** and **🗑 Delete**;
    God Mode unit editing also unlocks the **Size** slider and full 0–5
    attribute budget. Both are backed by authoritative development-only intents
    rather than local mutation.

## Design Principles

- HUD along screen edges; centre unobstructed for map
- Translucent dark panels (`rgba(10,10,10,0.5)`)
- Compact typography (12–13 px), functional over decorative
- Subtle hover states, no loud colours except faction highlights
- Every action reachable via mouse and keyboard

## Unit Facing & Rendering

Moved to `ui-facing.md`, which loads only for facing, sprite, model, and first-person
modules. Read it before touching unit orientation — it holds the three facing frames
and the "never apply 2D canvas rotation to isometric sprites" rule.
