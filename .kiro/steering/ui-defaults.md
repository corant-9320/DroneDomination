---
inclusion: fileMatch
fileMatchPattern: "client/**"
---

# UI Defaults — Civ6-Inspired Screen Furniture

## Applies to: `client/**`, `index.html`

## When to load: editing UI layout, HUD, menus, or keyboard shortcuts

## Audience

Drone Domination targets the same player base as Civilization VI. The screen
furniture and keyboard conventions should feel immediately familiar to Civ6
players while adapting to our dual-panel globe/local-map layout.

## Layout Deviations from Civ6

- Globe view (left panel) replaces the mini-map
- Right curtain (`#combat-log-panel`) shows combat log, menu bar, AI playback controls, and Next Turn
- Bottom bar (`#detail-panel`) shows hex/unit detail — terrain, city, up to 5 unit cards side-by-side
- Menu bar lives at top of right curtain (not top-of-screen)

## Right Curtain (Combat Panel)

The right curtain (`#combat-log-panel.curtain`) has a **menu bar** (`#curtain-menu-bar`)
pinned at its top. This bar holds pill-shaped buttons for global actions:

- **+ New** — opens the New World generation modal
- **⌂ Home** — centres both views on the player's home city
- **💾 Save** — saves game state to localStorage
- **📂 Load** — opens load-game modal (pick from saved slots)

Below the menu bar, `#combat-log-content` renders:
- Combat history (◀/▶ navigation through past engagements)
- Attack previews (when hovering an enemy with a unit selected)
- AI playback bar (during enemy turns: ▶/⏸ Play/Pause + ⏩ Fast Forward)

A **Next ▶** button is positioned at the bottom of the curtain
(inside `#turn-controls`) for ending the turn.

## Bottom Detail Bar

The bottom bar (`#detail-panel`) spans the local map width minus the right
curtain (280px). It shows:
- Tile info (index, shape, neighbours)
- Terrain type + elevation
- City ownership
- Up to 5 unit cards displayed inline (sections are `display: inline-block`)

## AI Turn Playback

During enemy turns, `#ai-playback-bar` appears in the combat panel with:
- **▶ / ⏸** — auto-play at ~1.5s intervals or pause for manual stepping
- **⏩** — fast-forward (skip current wait, advance immediately)

The local map draws combat highlights (red attacker ring, cyan target ring,
dashed arrow) so the player can see which unit is attacking which.

## Keyboard Shortcuts (implemented)

| Key | Action |
|---|---|
| Home | Centre on home city |
| Space | End Turn |
| Ctrl+S | Save game |
| Ctrl+L | Load game |
| Escape | Close modal / deselect |

## Design Principles

- Keep HUD elements along screen edges; centre area stays unobstructed for map
- Translucent dark panels (rgba 10,10,10 @ 0.5) — content behind remains visible
- Compact typography (12–13px), no ornate borders — functional over decorative
- Buttons use subtle hover states, no loud colours except faction highlights
- Actions accessible via both mouse click and keyboard shortcut
