---
inclusion: always
---

# Conventions

**Purpose:** Project-wide build, import, and change-management rules.  
**Scope:** All code areas.  
**Audience:** Any agent editing this repo.

## Build & Run

| Command | What it does |
|---------|-------------|
| `npm run dev` | Vite dev server on :3000 (HMR for client) |
| `npm test` | Vitest unit tests (single run) |
| `npm run build` | tsc → dist/, then auto-regenerates `data/world.json` |
| `npm run validate` | Checks `data/world.json` integrity |
| `npm run e2e` | Playwright end-to-end tests |

## Import Rules

- All imports use `.js` extension (ESM resolution, even for .ts sources)
- No default exports — named exports only
- Barrel re-exports live in `src/world/index.ts`
- Client bundle must NOT import from `src/` or `server/` (enforced by `tsconfig.client.json`)

## After Making Changes — What to Tell the User

| What changed | Action needed |
|---|---|
| `client/**`, `index.html` | Refresh browser (Vite HMR usually handles it) |
| `server/**` | Restart `npm run dev` |
| `src/world/**` | `npm run build` (world regenerates via postbuild), then refresh |
| `data/world.json` regenerated | Refresh browser |
| `tsconfig.json`, `vite.config.ts` | Restart `npm run dev` |
| `scripts/**` | Run manually: `node scripts/<name>.js` |

## Cross-File Dependencies

| When editing | Also check / keep in sync |
|---|---|
| `src/world/types.ts` | `client/worldData.ts` mirrors compact format |
| `src/world/compact.ts` | Wire format affects `client/worldData.ts` interfaces |
| `src/world/units.ts` | `client/unitIcons.ts` renders from unit attributes |
| `client/colors.ts` | Single source for terrain + faction palettes |
| `server/generate.ts` | Uses `spawnInitialUnits` + `toCompactWorld` from `src/world/` |

## Related Files

- `architecture.md` — auto-loads when editing `src/`, `server/`, or config files
- `ui-defaults.md` — auto-loads when editing `client/`
