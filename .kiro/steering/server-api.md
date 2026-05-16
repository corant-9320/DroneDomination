# Server API Steering

## Applies to: `server/**`

## When to load: editing API handlers or the Vite dev plugin

## Architecture

- `server/generate.ts` — pure function handler `handleGenerate(config) → GenerateResult`
- `server/devPlugin.ts` — Vite plugin that wires POST `/api/generate` to the handler
- Future deployment: AWS Lambda + API Gateway (handler is framework-agnostic for easy porting)

## API contract

### POST /api/generate

Request: `{ "enemies": 1–13, "spacing": 20–45 }`
Response 200: `{ "success": true, "world": { ...compact format... } }`
Response 400: `{ "success": false, "error": "..." }`

## Rules

- Handler must remain a pure function — no side effects, no framework imports
- Validate and clamp inputs (enemies, spacing) before generation
- Always run `validateWorld()` on generated world before returning
- Compact wire format documented in ARCHITECTURE.md (§ Compact Wire Format)

## When editing server code

- Do not add Express, Fastify, or other framework deps — handler stays framework-agnostic
- Keep the Vite plugin thin (routing only); logic stays in handler
- When adding new API routes, add them in `devPlugin.ts` and keep handlers in separate files
- Read ARCHITECTURE.md § API section for wire format details
