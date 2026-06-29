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

### POST /api/combat

Stateless pure resolver for a single action. Body: `{ action: 'attack' | 'move' | 'preview' | 'repair', …, activeFaction, units, tiles, buildings? }`. Returns `CombatResponse` (combats, reactions, updatedUnits, updatedBuildings?). Holds no state — turn/MP live client-side in `TurnManager`. Serves the **player's** own actions.

**Move legality (server-authority Phase 2):** `move` requests are validated by `validateMovePath` before being applied — the path must start at the unit's tile, be contiguous, avoid impassable terrain, and cost ≤ the unit's max movement. Illegal requests return `{ success: false, error }`. The wire tile carries height `h` so the server's cost model matches the client's. Cumulative per-turn MP and "already acted" enforcement is deferred to Phase 3 (sessions).

### POST /api/ai-turn

Server-authoritative resolver for an **entire AI faction turn** (server-authority Phase 1 — see `DECISIONS.md` 2026-06-29). Replaces the per-action round-trips the client AI used to make.

Request body:
```json
{ "factionId": "city_3", "units": [ ...WireUnit ], "tiles": [ ...minimal WireTile ], "buildings": [ ...WireBuilding ] }
```

- Each AI unit is assumed to start its turn with full movement (no per-unit MP travels over the wire), so the handler stays a pure snapshot-in/result-out function.
- `handleAiTurn` (`server/aiTurnApi.ts`) runs target selection + pathfinding (`shared/`) and resolves combat (`src/world/combat.ts`) in-process.

Response (200):
```json
{
  "success": true,
  "events": [ { "kind": "move|attack", "unitId": "...", "...": "...", "units": [ ...post-action snapshot ] } ],
  "finalUnits": [ ...WireUnit ],
  "finalBuildings": [ ...WireBuilding ]
}
```

Each `AiActionEvent` carries the post-action world snapshot plus animation metadata (damage, splash victims, move from→to) and combat-log explanations. The client (`replayAiTurn` in `client/aiTurn.ts`) replays the log through the AI playback bar — step/play/rewind/skip just navigate the precomputed events, computing nothing locally.

### POST /api/match/create · POST /api/match/intent

Authoritative match sessions (server-authority Phase 3, `server/matchApi.ts`). The server owns per-unit MP / acted / rotated state and whose turn it is, so it can reject acting twice, moving twice, overspending MP, or acting out of turn — the anti-cheat foundation for multiplayer.

- `POST /api/match/create` `{ seed, factions, units, buildings? }` → `{ success, state: MatchState }`. Initialises each unit's turn budget and warms the authoritative tile cache.
- `POST /api/match/intent` `{ matchId, expectedVersion?, intent }` → `MatchIntentResponse` with the updated state (+ combats/reactions/repair). `intent` is one of `move | attack | repair | endTurn`. Returns **409** when `expectedVersion` is stale or a concurrent write loses the optimistic-lock race.

State is held in a `SessionStore` (`server/sessionStore.ts`). Production backend is **DynamoDB** (one versioned item per match); locally the Dynamo call is **mocked** in-memory behind the same interface, so deploying is a one-adapter swap. Tiles are regenerated from the trusted `seed`, never accepted from the client.

> Status: implemented + verified, not yet on the live client path. The client `TurnManager` still owns turn state; wiring it to this API (and routing AI turns through sessions) is the next increment.

## See Also

- [world-generation.md](world-generation.md) — what `generateWorld(seed)` does internally
- [modules.md](modules.md) — `server/` and `shared/wireTypes.ts` layout
