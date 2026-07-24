# Context7 Usage

**Purpose:** When to fetch up-to-date external library docs, and how.
**Scope:** All sessions.
**Audience:** Any agent working on this repo.

## When to use it

Before implementing anything that depends on an **external library, framework, SDK,
test runner, build tool, or browser API wrapper**, fetch current docs through
Context7. This avoids hallucinated APIs and pattern drift. In this repo that means
Vitest, Vite, Three.js, Playwright, and Chrome DevTools MCP tool schemas most often,
plus AWS SDKs, validation libraries, and date/time libraries when they appear.

## When NOT to use it

- Project-specific game rules (combat formulas, world-gen logic)
- Simple TypeScript refactors (rename, move file, change a constant)
- Code already clearly covered by local examples in this repo

## How

1. **Resolve** the library ID first (`mcp_context7_resolve_library_id`).
2. **Fetch docs** scoped to the specific task (`mcp_context7_query_docs`).
3. **Prefer patterns from the docs** over memory or guesses.
4. **Mention** which docs or patterns influenced the implementation in your response.
