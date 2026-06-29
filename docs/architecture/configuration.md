# Configuration

[← Architecture Wiki](README.md) · Covers `vite.config.ts`, `tsconfig*.json`

| File | Purpose |
|------|---------|
| `vite.config.ts` | Dev server port 3000, publicDir = `data/`, API plugin |
| `tsconfig.json` | Strict, ESM, target ES2022, outDir `dist/` |
| `tsconfig.client.json` | Client-specific TS config — includes only `client/**` + `shared/**`, which enforces the no-`src/`-import rule |

## See Also

- [modules.md](modules.md) — the import rule enforced by `tsconfig.client.json`
- Build/test commands live in `.kiro/steering/conventions.md`
