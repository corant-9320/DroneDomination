# Client Steering

## Applies to: `client/**`, `index.html`

## When to load: editing browser-side rendering, UI, or interaction code

## Architecture

- Entry: `client/main.ts` (loaded by `index.html` via Vite)
- Two views: `GlobeView` (Three.js + OrbitControls) and `LocalMapView` (Canvas 2D hex map)
- World data loaded by `worldData.ts` — fetches `/world.json`, caches in sessionStorage
- Modal for new world generation: `newWorldModal.ts`

## Rendering rules

- Globe uses Three.js — do not introduce other 3D libraries
- Local map uses Canvas 2D — no DOM-heavy rendering for the hex grid
- Color palettes are in dedicated files: `factionColors.ts`, `terrainColors.ts`

## Data flow

- Client fetches static `/world.json` or receives world from POST `/api/generate`
- World data is read-only on the client; all mutation happens server-side
- After generation, `worldData.ts` caches result in sessionStorage and reloads

## When editing client code

- Keep rendering logic in view classes, data fetching in `worldData.ts`
- Do not add server-side imports — client bundle must not include `src/` or `server/`
- Test in browser at http://localhost:3000 via `npm run dev`
