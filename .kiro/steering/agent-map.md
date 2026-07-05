# Agent Map

**Purpose:** Give agents a structured map from domain/task → concepts, memory nodes, docs, source files, tests, verification commands, debug tools, and danger zones.  
**Scope:** All sessions.  
**Audience:** Any agent working on this repo.

## What it is

`ai/agent-map.yaml` is the repo's domain-level routing map for agents.

It bridges:

- steering files
- memory graph concepts
- architecture docs
- source-code areas
- tests
- verification commands
- debug tools
- danger zones

Use it to find the right context before wide code search.

## What it is not

The agent map is not the source of truth for implementation details.

The source of truth remains:

1. Code
2. Tests
3. Canonical docs

If the map conflicts with source code, source code wins. Update the map if the mismatch is durable and would mislead future agents.

## Generated dependency graph

`ai/generated/dep-summary.md` contains a dependency-cruiser output showing:

- Per-module fan-in (how many modules depend on it) and fan-out (how many it imports)
- Key hubs per area (highest blast radius for changes)
- Cross-area dependency edges (client→shared, server→src, etc.)

Use it for quick orientation before grepping. Regenerate with `npm run deps:graph`.
The full machine-readable graph is in `ai/generated/dep-graph.json`.

## Context order

For non-trivial changes, use this order:

1. Read the task.
2. Read always-loaded steering.
3. Search `memory.mcp` for relevant concepts.
4. Open `ai/agent-map.yaml`.
5. Skim `ai/generated/dep-summary.md` for relevant module hubs and cross-area edges.
6. Identify the relevant domain or domains.
7. Read the linked scoped steering and canonical docs.
8. Use `grep_search`, `file_search`, and `read_code` for targeted navigation.
9. Open only the specific file ranges you need.
10. Make the smallest safe change.
11. Verify once at the end, using the cheapest sufficient command first.
12. Update memory, docs, or the map only if the change creates durable knowledge.

## Rules

1. Use the map for routing, not authority.
2. Prefer domain-level understanding over broad grepping.
3. Do not add every file, function, constant, or implementation detail to the map.
4. Add or update map entries when a new durable domain, responsibility boundary, test area, debug tool, or danger zone is introduced.
5. Keep generated code maps separate from this hand-maintained map.
6. If a change affects multiple domains, check each domain's danger zones before editing.
