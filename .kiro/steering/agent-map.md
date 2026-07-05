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

The `ai/generated/` folder contains dependency-cruiser output committed to the repo.
It exists specifically so agents can navigate the codebase without broad grepping.

### Files

| File | Size | Use for |
|------|------|---------|
| `ai/generated/dep-summary.md` | ~5 KB | **Read this first.** Module hubs, fan-in/fan-out, cross-area edges |
| `ai/generated/dep-graph.json` | ~270 KB | Machine-readable full graph — trace specific import chains |
| `ai/generated/violations.md` | <1 KB | Import boundary violations (should always be clean) |

### When to read `dep-summary.md`

- **Before any change touching shared/ or src/world/types.ts** — these are high-fan-in hubs. The summary tells you exactly how many modules will be affected.
- **When deciding where to put new code** — the cross-area edges section shows the existing import contracts between client, server, src, and shared.
- **When renaming or moving a module** — check its fan-in count. High fan-in = many files to update.
- **When investigating a bug that crosses boundaries** — the cross-area section shows which modules bridge areas and might be the coupling point.

### When to read `dep-graph.json`

- When you need the exact import chain from module A → module B (trace transitive deps).
- When `dep-summary.md` shows a surprising edge and you want the full details.
- Parse with `JSON.parse()` — each entry in `.modules[]` has `.source` and `.dependencies[].resolved`.

### When to regenerate

Run `npm run deps:graph` after:

- Adding or removing source files
- Changing import statements across module boundaries
- Refactoring module structure

The committed output is a snapshot. If your session adds new files or changes imports, regenerate before relying on it for navigation.

### Import rules enforced

These are checked by dependency-cruiser and reported in `violations.md`:

- `client/` must NOT import from `src/` or `server/`
- `server/` must NOT import from `client/`
- `src/` must NOT import from `client/` or `server/`

If you introduce a new cross-area import that violates these rules, `npm run deps:graph` will flag it.

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
