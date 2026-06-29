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
| `src/world/combatFacing.ts` | `client/localMapUnits.ts` (getCorrectedFacing) must agree on facing semantics |
| `client/unitRenderer.ts` | `client/localMapUnits.ts` sprite selection assumes 6 fixed directions |
| `client/facing.ts` | All facing conversions — no other file may do raw `.n.indexOf()` or `(facing ± n) % 6` |
| `client/colors.ts` | Single source for terrain + faction palettes |
| `shared/unitTypes.ts` | Authoritative `UnitAttributes`; `src/world/units.ts`, `client/worldData.ts`, `server/combatApi.ts` all import it |
| `server/generateApi.ts` | Uses `spawnInitialUnits` + `toCompactWorld` from `src/world/` |

## Testing Rules

- **No pinned formula values.** Do not assert exact damage numbers from game-balance formulas (e.g., `expect(damage).toBe(14)`). Use property/range assertions instead: monotonicity, min/max bounds, relative comparisons.
- **One golden smoke test per formula is fine** — but label it clearly and expect it to break on balance changes.
- **Test behavior, not implementation.** Good: "splash hits all enemies in hex". Bad: "splash deals exactly 9 damage to a unit with armour 2".
- **Don't add tests proactively.** Only add tests when the user asks, or when fixing a bug that needs a regression guard.
- **Keep test files under 300 lines.** If a test file grows past that, it's testing too many implementation details.

## Related Files

- `architecture.md` (+ `architecture-*.md`) — auto-load the relevant `docs/architecture/` wiki page when editing `src/`, `server/`, or config files
- `ui-defaults.md` — auto-loads when editing `client/`
