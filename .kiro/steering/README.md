# Steering Index

**Purpose:** Route agents to steering that loads on demand, and to the documents worth
opening directly. **Scope:** all sessions. **Audience:** AI agents. **Load rule:** always.

Already in context, so don't go looking for them: `core.md` (which artifact wins),
`conventions.md` (build/test, imports, cross-file sync, testing, efficiency,
expensive-tool approval, git), `agent-map.md` (domain routing), `docs-as-we-go.md`
(where decisions and issues go), `debugging.md`, `memory.md`, `context7.md`.

## Loads on demand

| File | Loads when |
|------|-----------|
| `ui-defaults.md` | `client/**`, `index.html` — HUD layout, panels, shortcuts, right-click menus |
| `ui-facing.md` | Facing/renderer/sprite/model + first-person modules — facing frames, sprite rotation |
| `external-3d-models.md` | Client model/renderer/first-person/startup files, GLB/GLTF assets |
| `architecture.md` | `src/**`, `server/**`, `shared/**`, `index.html`, `scripts/**`, root configs — hub + module map |
| `architecture-worldgen.md` | Worldgen, geometry, movement, pathfinding files only (not combat/logistics) |
| `architecture-api.md` | `server/**` — data flow and API routes |
| `architecture-config.md` | `index.html` + root package/TS/Vite/ESLint/Playwright/dep-cruiser configs |
| `architecture-debugging.md` | Debug client modules, `e2e/**`, `scripts/**` |

## Key References (not steering)

| Document | What it covers |
|----------|---------------|
| [README.md](/README.md) | Player setup, controls, common dev workflows |
| [ARCHITECTURE.md](/ARCHITECTURE.md) | Landing page for the `docs/architecture/` wiki |
| [COMBAT_RULES.md](/COMBAT_RULES.md) | Combat intent + maintained validation invariants |
| [ai/agent-map.yaml](/ai/agent-map.yaml) | Task → docs, code, tests, memory nodes, danger zones |
| [ai/generated/dep-summary.md](/ai/generated/dep-summary.md) | Dependency graph — hubs, fan-in/out, cross-area edges. Read before grepping broadly |
| [docs/architecture/known-issues.md](/docs/architecture/known-issues.md) | Live open issues + enduring gotchas/sync requirements |
| [docs/architecture/debugging.md](/docs/architecture/debugging.md) | Snapshot workflow + `window.gameDebug` reference |
| [DECISIONS.md](/DECISIONS.md) | Frozen archive (pre-2026-07-04). New rationale goes in commit bodies |
