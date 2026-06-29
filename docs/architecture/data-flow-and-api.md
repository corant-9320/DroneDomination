# Data Flow & API

[← Architecture Wiki](README.md) · Covers `server/**`

## Data Flow

1. Client → `POST /api/generate {enemies, spacing}` → Server
2. Server: `generateWorld(seed)` → geodesic sphere → dual → terrain → cities → spawn units → compact JSON
3. Server → `{success, world}` → Client
4. Client: `worldData.ts` caches in sessionStorage, reloads page
5. On fresh load: fetch `/world.json` (static fallback)
6. Save/Load: localStorage (`saveLoad.ts`)

## API

### POST /api/generate

Request body:
```json
{ "enemies": 5, "spacing": 25 }
```

- `enemies`: 1–11 (clamped to MAX_CITIES - 1)
- `spacing`: 20–45, target graph distance from player home to enemies

Response (200):
```json
{ "success": true, "world": { ...compact world... } }
```

Response (400):
```json
{ "success": false, "error": "World validation failed" }
```

## See Also

- [world-generation.md](world-generation.md) — what `generateWorld(seed)` does internally
- [modules.md](modules.md) — `server/` and `shared/wireTypes.ts` layout
