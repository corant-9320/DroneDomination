# Conventions (always loaded)

## Build & run

See `package.json` scripts. Key: `dev` (Vite:3000), `test` (vitest), `build` (tsc + auto-generates world via `postbuild`).

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
| `src/world/**` (generation logic) | `npm run build` (world regenerates automatically via postbuild), then refresh |
| `data/world.json` regenerated | Refresh the browser |
| `tsconfig.json`, `vite.config.ts` | Restart `npm run dev` |
| `scripts/**` | Run the script manually (`node scripts/<name>.js`) |

## When editing specific areas

| Area | Also check / verify |
|---|---|
| `src/world/types.ts` | `client/worldData.ts` mirrors compact format — keep in sync |
| `src/world/compact.ts` | Wire format affects `client/worldData.ts` interfaces |
| `src/world/units.ts` | `client/unitIcons.ts` renders from attributes |
| `client/colors.ts` | Single source for both terrain + faction palettes |
| `server/generate.ts` | Uses `spawnInitialUnits` + `toCompactWorld` from `src/world/` |

## Key reference

- `architecture.md` auto-loads when editing `src/`, `server/`, or config files
