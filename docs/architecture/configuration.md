# Configuration

[← Architecture Wiki](README.md) · Covers the browser entry and root build/tool configuration

| File | Purpose |
|------|---------|
| `index.html` | Vite browser entry document |
| `package.json` | Canonical scripts and dependency declarations; `build` compiles without regenerating world data, while `build:world`/`generate` regenerate it explicitly |
| `vite.config.ts` | Dev server port 3000, `data/` public directory, API plugin, and Vitest configuration |
| `tsconfig.json` | Core compile settings: strict ESM, target ES2022, output to `dist/` |
| `tsconfig.client.json` | Client type-check boundary: includes only `client/**` and `shared/**` |
| `tsconfig.server.json` | No-emit server/core/shared type-check settings |
| `tsconfig.eslint.json` | Type information used by ESLint for core/shared/server files |
| `eslint.config.js` | Type-aware TypeScript lint rules and test-file exceptions |
| `playwright.config.ts` | E2E directory, browser launch, and dev-server setup; E2E is an approval-only escalation for agents |
| `.dependency-cruiser.cjs` | Cross-layer import boundaries, cycle checks, and dependency-graph exclusions |

## See Also

- [modules.md](modules.md) — canonical module ownership and import boundaries
- Build/test behavior and expensive-tool approval rules live in `.kiro/steering/conventions.md`
