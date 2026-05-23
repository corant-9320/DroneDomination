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
- Right curtain replaces the small unit/city info box — needed for up to 5 unit cards + terrain + city info
- Menu bar lives at top of right curtain (not top-of-screen)

## Right Curtain Menu Bar

The right curtain (`#detail-panel`) has a **menu bar** (`#curtain-menu-bar`)
pinned at its top. This bar holds pill-shaped buttons for global actions:

- **+ New** — opens the New World generation modal
- **⌂ Home** — centres both views on the player's home city
- **💾 Save** — saves game state to localStorage
- **📂 Load** — opens load-game modal (pick from saved slots)

A **Next ▶** button is positioned at the bottom-right of the curtain
(outside the menu bar) for ending the turn.

The menu bar uses a horizontal flex layout, dark background slightly lighter
than the curtain, with compact pill-shaped buttons.

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
