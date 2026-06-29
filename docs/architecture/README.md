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
| [world-generation.md](world-generation.md) | World gen pipeline, hex segments, pathfinding, world constants (`src/world/**`) |
| [data-flow-and-api.md](data-flow-and-api.md) | Client↔server data flow and the `/api/generate` contract (`server/**`) |
| [configuration.md](configuration.md) | `vite.config.ts`, `tsconfig*.json`, build/output settings |
| [debugging.md](debugging.md) | Headless snapshots, `window.__DD_STATE__`, `window.gameDebug` DOM instrumentation |
| [known-issues.md](known-issues.md) | Architectural drift and fixed-issue history (points to `DECISIONS.md`) |

## Related Authoritative Docs

- [COMBAT_RULES.md](../../COMBAT_RULES.md) — combat formulas, validation, constants
- [DECISIONS.md](../../DECISIONS.md) — design decisions, gotchas, known issues
- [README.md](../../README.md) — player setup, controls, dev workflows
