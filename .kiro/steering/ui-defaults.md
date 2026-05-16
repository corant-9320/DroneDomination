# UI Defaults — Civ6-Inspired Screen Furniture

## Applies to: `client/**`, `index.html`

## When to load: editing UI layout, HUD, menus, or keyboard shortcuts

## Audience

Drone Domination targets the same player base as Civilization VI. The screen
furniture and keyboard conventions should feel immediately familiar to Civ6
players while adapting to our dual-panel globe/local-map layout.

## Civ6 HUD Reference (adapted)

| Civ6 Element | Drone Domination Equivalent |
|---|---|
| Top resource bar (Science, Culture, Gold…) | Future: top bar with faction resources/turn info |
| Mini-map (bottom-left) | Globe view (left panel) serves as the strategic overview |
| Unit/City info panel (bottom-centre) | **Deviation:** Full right curtain (not a small box). Up to 5 units per tile means we need the vertical space to show all unit cards, terrain, and city info together. |
| Notifications (right edge) | Future: notification feed in right curtain |
| Civilopedia (top-right) | Future: in-game help |
| End Turn button (bottom-right) | Future: End Turn in action bar |
| Menu bar (top of panels) | **Menu bar at top of right curtain** — holds quick-action buttons (New World, Home, Settings) |

## Right Curtain Menu Bar

The right curtain (`#detail-panel`) has a **menu bar** pinned at its top.
This bar holds icon/text buttons for global actions:

- **+ New** — opens the New World generation modal
- **⌂ Home** — centres both views on the player's home city
- Future slots: Settings (gear icon), Civilopedia (? icon), End Turn

The menu bar uses a horizontal flex layout, dark background slightly lighter
than the curtain, with compact pill-shaped buttons.

## Keyboard Shortcuts (Civ6-aligned)

| Key | Action | Civ6 analogue |
|---|---|---|
| Home | Centre on home city | Capital (\) |
| G | Toggle grid overlay (future) | Toggle Grid |
| N | Open New World modal | — |
| Escape | Close modal / deselect | Close dialogs |
| Space | Skip/End Turn (future) | Skip Turn |
| 1–9 | Lens overlays (future) | Lenses |
| T | Technology panel (future) | Technology Tree |
| M | Move selected unit (future) | Move To |
| A | Attack with selected unit (future) | Attack |

## Design Principles

- Keep HUD elements along screen edges; centre area stays unobstructed for map
- Translucent dark panels (rgba 10,10,10 @ 0.5) — content behind remains visible
- Compact typography (12–13px), no ornate borders — functional over decorative
- Buttons use subtle hover states, no loud colours except faction highlights
- Actions accessible via both mouse click and keyboard shortcut
