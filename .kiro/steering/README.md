# Steering Index

Scoped guidance for AI agents working on Drone Domination.

**Purpose:** Route agents to the right context based on what files they're editing.  
**Audience:** AI agents (Kiro, Copilot, etc.)  
**Load rule:** Always included (top-level index).

## Steering Files

| File | Loads when | One-line summary |
|------|-----------|-----------------|
| `conventions.md` | Always | Build/test commands, import rules, post-change checklists |
| `debugging.md` | Always | Stop guessing at root cause — instrument and hand back to human for manual repro |
| `docs-as-we-go.md` | Always | When to log decisions, where docs live, headless debug workflow |
| `memory.md` | Always | Persistent knowledge graph — query before reading files |
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
| [DECISIONS.md](/DECISIONS.md) | Design decisions, gotchas, and open known-issues |
