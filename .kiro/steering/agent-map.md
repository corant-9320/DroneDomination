# Agent Map Routing

**Purpose:** Route non-trivial tasks to focused source, tests, docs, checks, and danger
zones without loading those details into steering. **Scope:** all sessions.
**Audience:** any agent on this repo. **Related:** `core.md` · `conventions.md`.

## Use

1. Open `ai/agent-map.yaml`; pick only the domains the task touches.
2. Read those domains' scoped steering and canonical docs.
3. For cross-boundary or high-fan-in work, skim `ai/generated/dep-summary.md` before
   searching broadly.
4. Verify map claims against code/tests before relying on them (`core.md`).
5. Use the cheapest verification the domain lists first.

## Canonical implementations

- **Pathfinding.** Algorithms are canonical in `shared/pathfinding.ts`.
  `src/world/tilePathfinding.ts` is the `Tile`-typed entry point owning type adaptation
  (server `Tile` → `PathTile`) — not a shim. New algorithms go in `shared/pathfinding.ts`.
- **Logistics.** Pure engine under `src/world/logistics/**`; server intent appliers under
  `server/logistics/**`. Import the owning module, or that area's `index.js` when you need
  many symbols. The old flat facades are gone — don't reintroduce one.
- **Real facades that must keep their exports:** `client/worldData.ts` over
  `client/world/**` (~40 consumers), and `src/world/combat.ts` over `src/world/combat/**`
  (every public export must stay reachable through it). Put new internal code in the
  focused module behind the facade.

## Dependency graph

`ai/generated/dep-summary.md` (summary) · `dep-graph.json` (exact edges) ·
`violations.md` (boundary report). Regenerate with `npm run deps:graph` after
source-file or import-boundary changes.

Keep implementation detail in code/architecture docs and route metadata in
`ai/agent-map.yaml`; don't duplicate them here.
