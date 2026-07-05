# Generated Agent Context

This folder contains generated dependency and import maps for AI agent orientation.

Generated files are hints, not authority. If generated context conflicts with
source code, source code wins.

## Contents

| File | Purpose | Regenerate with |
|------|---------|-----------------|
| `dep-graph.json` | Full dependency-cruiser graph (machine-readable) | `npm run deps:graph` |
| `dep-summary.md` | Module fan-in/fan-out table + cross-area edges | `npm run deps:graph` |
| `violations.md` | Dependency rule violations (import boundary checks) | `npm run deps:graph` |

## When to regenerate

Run `npm run deps:graph` after:

- Adding or removing source files
- Changing import relationships
- Refactoring module boundaries

The generated output is committed to the repo so new sessions can use it
without running the script. Regenerate periodically to keep it fresh.

## How agents should use this

1. **Quick orientation:** Read `dep-summary.md` to see which modules are
   high-fan-in hubs (many dependents → high blast radius for changes).
2. **Cross-area imports:** The cross-area section shows where client, server,
   src, and shared code connect. Use this to anticipate side effects.
3. **Violation check:** If `violations.md` shows errors, fix them before
   committing — they represent enforced import boundaries.
4. **Deep lookup:** Query `dep-graph.json` for exact dependency chains when
   you need to trace a specific import path.

## Import rules enforced

- `client/` must NOT import from `src/` or `server/`
- `server/` must NOT import from `client/`
- `src/` must NOT import from `client/` or `server/`
