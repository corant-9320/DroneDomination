# Architecture Wiki

Machine-readable reference for AI code generators working on Drone Domination.
Split into focused pages so a session loads only what it needs.

## Tech Stack

- Language: TypeScript (strict, ESM)
- Build: `tsc` → `dist/`
- Dev server: Vite 5 (serves client + SSR API routes)
- Client rendering: Three.js (globe), Canvas 2D (local map)
- Runtime: Node.js 18+
- Future deployment: AWS Lambda + API Gateway

## Pages

| Page | Read when you are working on… |
|------|-------------------------------|
| [modules.md](modules.md) | Finding where code lives — full module map + the client/`src`/`server` import rule |
| [world-generation.md](world-generation.md) | World generation, geometry, movement/segments, and pathfinding; canonical pathfinding is in `shared/pathfinding.ts` |
| [data-flow-and-api.md](data-flow-and-api.md) | Client↔server data flow, API contracts, and authoritative server routes |
| [configuration.md](configuration.md) | Browser entry plus package, TypeScript, Vite, ESLint, Playwright, and dependency-cruiser config |
| [debugging.md](debugging.md) | Headless snapshots, `window.__DD_STATE__`, `window.gameDebug` DOM instrumentation |
| [known-issues.md](known-issues.md) | **Live** open issues and enduring gotchas/sync requirements |
| [archive/known-issues-fixed.md](archive/known-issues-fixed.md) | Historical fixed-issue notes moved out of the live page |

## Related Authoritative Docs

- [COMBAT_RULES.md](../../COMBAT_RULES.md) — combat formulas, validation, constants
- [known-issues.md](known-issues.md) — live open issues + enduring gotchas
- [DECISIONS.md](../../DECISIONS.md) — frozen archive of past decisions (pre-2026-07-04)
- [README.md](../../README.md) — player setup, controls, dev workflows

See the source-of-truth hierarchy in [`.kiro/steering/core.md`](../../.kiro/steering/core.md) for how these docs rank against code, tests, and each other.
