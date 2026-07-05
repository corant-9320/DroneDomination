# Steering Index

Scoped guidance for AI agents working on Drone Domination.

**Purpose:** Route agents to the right context based on what files they're editing.  
**Audience:** AI agents (Kiro, Copilot, etc.)  
**Load rule:** Always included (top-level index).

## Steering Files

| File | Loads when | One-line summary |
|------|-----------|-----------------|
| `context7.md` | Always | When and how to use Context7 for external library docs |
| `conventions.md` | Always | Build/test commands, import rules, post-change checklists |
| `debugging.md` | Always | Stop guessing at root cause — instrument and hand back to human for manual repro |
| `docs-as-we-go.md` | Always | When to log decisions, where docs live, headless debug workflow |
| `memory.md` | Always | Persistent knowledge graph — query early for orientation, then verify against code/docs |
| `agent-map.md` | Always | Structured domain map linking concepts, memory nodes, docs, source, tests, commands, debug tools, and danger zones |
| `ui-defaults.md` | Editing `client/**` | Civ6-style HUD layout, panel structure, keyboard shortcuts |
| `architecture.md` | Editing `src/**`, `server/**`, `shared/**`, configs | Wiki hub — tech stack + module map, links to detail pages |
| `architecture-worldgen.md` | Editing `src/world/**` | World-gen pipeline, hex segments, pathfinding, constants |
| `architecture-api.md` | Editing `server/**` | Client↔server data flow + `/api/generate` contract |
| `architecture-config.md` | Editing `vite.config.ts`, `tsconfig*.json` | Build/TS config + client import rule |
| `architecture-debugging.md` | Editing `client/debug*.ts`, `client/gameDebug.ts`, `e2e/**`, `scripts/**` | Headless snapshot + `window.gameDebug` instrumentation |

## Key References (not steering, but often needed)

| Document | What it covers |
|----------|---------------|
| [README.md](/README.md) | Player setup, controls, common dev workflows |
| [ARCHITECTURE.md](/ARCHITECTURE.md) | Landing page for the architecture wiki under `docs/architecture/` |
| [COMBAT_RULES.md](/COMBAT_RULES.md) | Authoritative combat formulas, validation rules, constants |
| [ai/agent-map.yaml](/ai/agent-map.yaml) | Structured domain map — routes from task to docs, code, tests, memory nodes, and danger zones |
| [ai/generated/dep-summary.md](/ai/generated/dep-summary.md) | **Dependency graph** — module hubs, fan-in/fan-out, cross-area import edges. Read before grepping broadly |
| [docs/architecture/known-issues.md](/docs/architecture/known-issues.md) | Live open issues + enduring gotchas/sync requirements |
| [DECISIONS.md](/DECISIONS.md) | Frozen archive of past decisions (pre-2026-07-04). New rationale goes in git commit bodies |
