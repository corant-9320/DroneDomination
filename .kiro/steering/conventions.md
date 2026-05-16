# Conventions (always loaded)

## Applies to: all files in this repo

## Language & module rules

- TypeScript strict mode, ESM
- All imports use `.js` extension (ESM resolution, even for .ts sources)
- No default exports — named exports only
- Barrel re-exports in `src/world/index.ts`

## Build & run

- Build: `tsc` → `dist/`
- Dev: `npm run dev` (Vite, port 3000)
- Tests: `npm run test` (vitest)
- Generate static world: `npm run build && npm run generate`

## Code style

- No side effects in shared modules (`src/world/`)
- Server handler (`server/generate.ts`) is a pure function — no framework deps
- World data is immutable once generated; client reads only
- Constants go in the module that owns them (e.g. `MAX_CITIES` in `server/generate.ts`, `FREQUENCY` in `src/world/generate.ts`)

## Data files

- `data/world.json` and `data/world-summary.json` are generated output
- Do not hand-edit data files; regenerate with `npm run generate`
- `data/` is Vite's `publicDir` — served at `/` in dev

## After making changes — tell the user what to do

After every change, explicitly state which action is needed to see the result:

| What changed | Action needed |
|---|---|
| `client/**`, `index.html` | Just refresh the browser (Vite HMR may do it automatically) |
| `server/**` (dev plugin / API handlers) | Restart `npm run dev` |
| `src/world/**` (generation logic) | `npm run build && npm run generate`, then refresh |
| `data/world.json` regenerated | Refresh the browser |
| `tsconfig.json`, `vite.config.ts` | Restart `npm run dev` |

Always be explicit — never leave ambiguous whether a rebuild, restart, or refresh is required.

## Key reference

- [ARCHITECTURE.md](/ARCHITECTURE.md) — module map, types, data flow, wire format
