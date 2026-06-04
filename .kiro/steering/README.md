# Steering Index

Scoped guidance for AI agents working on Drone Domination.

**Purpose:** Route agents to the right context based on what files they're editing.  
**Audience:** AI agents (Kiro, Copilot, etc.)  
**Load rule:** Always included (top-level index).

## Steering Files

| File | Loads when | One-line summary |
|------|-----------|-----------------|
| `conventions.md` | Always | Build/test commands, import rules, post-change checklists |
| `ui-defaults.md` | Editing `client/**` | Civ6-style HUD layout, panel structure, keyboard shortcuts |
| `architecture.md` | Editing `src/**`, `server/**`, configs | Pulls in `ARCHITECTURE.md` — module map, types, data flow |

## Key References (not steering, but often needed)

| Document | What it covers |
|----------|---------------|
| [README.md](/README.md) | Player setup, controls, common dev workflows |
| [ARCHITECTURE.md](/ARCHITECTURE.md) | Full module map, data flow, API contract |
| [COMBAT_RULES.md](/COMBAT_RULES.md) | Authoritative combat formulas, validation rules, constants |
