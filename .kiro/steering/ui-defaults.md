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
- ▶/⏸ auto-play (~1.5 s intervals)
- ⏩ skip/fast-forward

Combat highlights: red attacker ring, cyan target ring, dashed arrow.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Home | Centre on home city |
| Space | End Turn |
| Ctrl+S | Save game |
| Ctrl+L | Load game |
| Escape | Close modal / deselect |

## Design Principles

- HUD along screen edges; centre unobstructed for map
- Translucent dark panels (`rgba(10,10,10,0.5)`)
- Compact typography (12–13 px), functional over decorative
- Subtle hover states, no loud colours except faction highlights
- Every action reachable via mouse and keyboard

## Related Files

- `conventions.md` — always loaded, covers build/test commands
- `architecture.md` — loads when editing `src/` or `server/`
