# Conventions (always loaded)

## Build & run

- Build: `tsc` → `dist/`
- Dev: `npm run dev` (Vite, port 3000)
- Tests: `npm run test` (vitest)
- Generate static world: `npm run build && npm run generate`

## Import rules

- All imports use `.js` extension (ESM resolution, even for .ts sources)
- No default exports — named exports only
- Barrel re-exports in `src/world/index.ts`
- Client bundle must not import from `src/` or `server/`

## After making changes — tell the user what to do

| What changed | Action needed |
|---|---|
| `client/**`, `index.html` | Just refresh the browser (Vite HMR may do it automatically) |
| `server/**` (dev plugin / API handlers) | Restart `npm run dev` |
| `src/world/**` (generation logic) | `npm run build && npm run generate`, then refresh |
| `data/world.json` regenerated | Refresh the browser |
| `tsconfig.json`, `vite.config.ts` | Restart `npm run dev` |

## Key reference

- [ARCHITECTURE.md](/ARCHITECTURE.md) — module map, types, data flow, wire format, constants, API contract
