---
inclusion: always
---

# Context7 Usage

**Purpose:** When to use Context7 for up-to-date library docs, and how.  
**Scope:** All sessions.  
**Audience:** Any agent working on this repo.

## When to use Context7

Before implementing anything that depends on an **external library, framework, SDK, test runner, build tool, or browser API wrapper**, use Context7 to fetch current docs. This avoids hallucinated APIs and pattern drift.

Use Context7 especially for:

- **Vitest** — test APIs, matchers, mocking, configuration
- **Vite** — config, plugins, HMR, build options
- **Three.js** — geometry, materials, cameras, quaternions, lighting
- **Playwright** — selectors, page actions, assertions, fixtures
- **Chrome DevTools MCP** — tool names, parameter schemas
- **AWS SDKs** — client constructors, commands, pagination, error handling
- **Zod / validation libraries** — schema composition, refinements, transforms
- **date/time libraries** — formatting, parsing, timezone handling
- **routing / state-management libraries** — setup, hooks, patterns

## When NOT to use Context7

- Pure project-specific game rules (combat formulas, world-gen logic)
- Simple TypeScript refactors (rename, move file, change a constant)
- Code already clearly covered by local examples in this repo

## How to use it

1. **Resolve** the correct library ID first (`mcp_context7_resolve_library_id`).
2. **Fetch docs** scoped to the specific task (`mcp_context7_query_docs`).
3. **Prefer patterns from the docs** over memory or guesses.
4. **Mention** which docs or patterns influenced the implementation in your response.
