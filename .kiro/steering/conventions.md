# Conventions

**Purpose:** Project-wide build, import, testing, change-management, and efficiency rules.
**Scope:** all code areas. **Audience:** any agent editing this repo.
**Related:** `core.md` · `agent-map.md` · `architecture*.md` (auto-load for `src/`/`server/`/`shared/`/config) · `ui-defaults.md` + `ui-facing.md` (auto-load for `client/`)

## Build & Run

`package.json` is authoritative for scripts — read it, don't trust a copy. What it
doesn't tell you:

- `npm run build` type-checks and compiles to `dist/` but does **not** regenerate
  `data/world.json`. Use `npm run build:world` (alias `generate`) for that.
- `npm test` runs `test:fast`, which **must stay under 10 seconds**.
- `test:fast` and `test:extended` are complementary explicit file lists: every file in
  `test:fast` is `--exclude`d from `test:extended`. Adding, renaming, or moving a test
  means updating **both**, or it runs twice or not at all. `test:all` needs no list.
- `npm run e2e` is approval-only — see Expensive Tooling.

## Imports

- `.js` extension on all imports (ESM, even for `.ts` sources).
- Named exports only, no default exports.
- Barrel re-exports live in `src/world/index.ts`.
- Client bundle must NOT import from `src/` or `server/` (enforced by `tsconfig.client.json`).

## After Changing X, Tell The User

| Changed | Action |
|---|---|
| `client/**`, `index.html` | Refresh browser (Vite HMR usually handles it) |
| `server/**` | Restart `npm run dev` |
| `src/world/**` | Run relevant tests/type-check; `npm run build:world` only when the committed world artifact must change |
| `data/world.json` regenerated | Refresh browser |
| Build/dev config (`vite.config.ts`, `tsconfig*.json`, …) | Restart `npm run dev` |
| `scripts/**` | Run the specific script or package command documented for it |

## Cross-File Sync

| Editing | Also check |
|---|---|
| `src/world/types.ts` | `client/world/model.ts` mirrors the compact format (re-exported by the `client/worldData.ts` facade) |
| `src/world/compact.ts` | Wire format affects `shared/wireTypes.ts`, `client/world/model.ts`, and the validators in `client/world/codec.ts` |
| `src/world/units.ts` | `client/unitIcons.ts` renders from unit attributes |
| `src/world/combatFacing.ts` | `client/localMapUnits.ts` (via `spriteFacingForRender`) must agree on facing semantics |
| `client/unitRenderer.ts` | `client/localMapUnits.ts` sprite selection assumes 6 fixed directions |
| `client/facing.ts` | All facing conversions, incl. `facingDirection` used by first-person. No other file may do raw `.neighbours.indexOf()` or `(facing ± n) % 6` |
| `client/firstPersonView.ts` | Shell only (lifecycle, camera, DOM overlay, render loop, selection). Scene, input, effects, overlays, geometry, terrain and tuning constants live in the sibling `firstPerson*.ts` modules — add behaviour to the owning module |
| `client/firstPersonConstants.ts` | Combat-animation timings stay in lockstep with `client/combatAnimations.ts` |
| `LogisticsRoute.segments` encoding | `client/logisticsRenderer.ts`, `client/globe.ts`, `client/firstPersonScene.ts` must decode it identically |
| `client/colors.ts` | Single source for terrain + faction palettes |
| `shared/unitTypes.ts` | Authoritative `UnitAttributes`; imported by `src/world/units.ts`, `client/world/model.ts`, `server/combatApi.ts` |
| `server/generateApi.ts` | Uses `spawnInitialUnits` + `toCompactWorld` from `src/world/` |

Logistics wire-format, save round-trip, and intent-routing seams are listed in
[`known-issues.md`](/docs/architecture/known-issues.md).

## Testing

- **No pinned formula values.** Never assert exact balance-formula output
  (`expect(damage).toBe(14)`). Use monotonicity, bounds, relative comparisons.
- One golden smoke test per formula is fine — label it, expect balance changes to break it.
- Test behaviour, not implementation ("splash hits all enemies in hex", not "deals 9").
- New module/endpoint/behaviour branch gets focused tests; a bug fix gets a regression
  guard. Don't pad the suite with trivial or cosmetic tests.
- Keep test files under 300 lines.

## Efficiency

- Batch related edits in one turn: a constant, signature, or type change updates all
  references (code + tests) in one batch of parallel calls.
- One verification pass at the end (`tsc --noEmit`, `npm test`) — not per file.
- Don't re-read files you just wrote.
- Fix multiple obvious test failures in one turn.
- No sub-agent/exploration phase for renames, constant updates, or signature changes:
  grep, edit all references, verify.
- Don't narrate or explain the obvious.
- Batch doc/known-issues/memory updates into the same turn as the code edit — never a
  separate documentation pass. Per-diff rationale goes in the commit body
  (`docs-as-we-go.md`), costing no tool call.

## Expensive Tooling — Ask First

**Canonical rule; other steering links here.** Chrome DevTools browser tools and
Playwright/`e2e` runs cost a lot of tokens. Do not invoke them on your own — get
explicit user approval. Exhaust cheap options first: unit tests,
`npm run debug:snapshot`, existing `artifacts/sessions/**`. Where `ai/agent-map.yaml`
lists verifications, use the cheapest one first; E2E is never a default check.

## Git Tools

Built-in `mcp_git_*` tools for all write operations (commit, push, branch, cherry-pick,
reset) — preferred by default. `@cyanheads/git-mcp-server` only for read-heavy queries
the built-ins don't cover (structured log filtering, blame, diffstat, stash inspection).
Never use both for the same operation in one turn.
