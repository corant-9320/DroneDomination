# Memory Graph

**Purpose:** A persistent project knowledge graph exists — orient with it, and keep it
accurate for structural changes. **Scope:** all sessions. **Audience:** any agent on this
repo. **Related:** `core.md` (the graph is orientation, never authority).

Served by the `memory` MCP server (`.kiro/settings/mcp.json`). It holds durable Drone
Domination concepts — world model, game entities, combat, game systems, architecture,
client modules — with relations and observations. Search it to discover what's there; do
not keep a copy of its index in steering.

## Rules

1. **Orientation, not authority.** Query early to find relevant concepts, files, and
   relationships; verify against code, tests, and canonical docs before changing behaviour.
2. **Targeted queries.** `mcp_memory_search_nodes("combat")`, `mcp_memory_open_nodes([…])`.
   `mcp_memory_read_graph()` is expensive — only when targeted search is insufficient.
3. **Query at:** session start (before grepping widely or re-reading large docs), on an
   unfamiliar term, and before changing a major system (check neighbouring concepts for
   side effects).
4. **Keep current for structural changes:** new/deleted/renamed entity, changed
   relationship, formula rewrite, new or removed system, changed responsibility boundary.
   Use `mcp_memory_add_observations` / `mcp_memory_create_entities`.
5. **Record non-obvious downstream effects** of value-only changes — a constant bump that
   makes another cap unreachable, a threshold change letting a different formula branch
   dominate, a terrain modifier shifting a unit class's value, a range change altering
   viable tactics.
6. **Skip obvious value-only changes.** Code and git history are authoritative for current
   numeric values.
7. **Don't duplicate steering.** The graph holds what the game contains and how concepts
   relate; steering holds rules for agents. Never copy agent instructions into observations.
8. **Don't store noisy implementation detail** — no per-function, per-file, or
   per-constant entries. Durable concepts and relationships only.
9. **Write observations that explain why a fact matters.** "ElevationAdvantage affects both
   hit chance and damage, so terrain-height changes can indirectly alter combat balance",
   not "ElevationAdvantage exists".
