# Data Flow & API

[← Architecture Wiki](README.md) · Covers `server/**`

All routes below are registered in `server/devPlugin.ts` (Vite dev-server
plugin); each delegates to a framework-agnostic handler in `server/*Api.ts` so
the same handler can be wired to Lambda in production.

## Data Flow

1. Client → `POST /api/generate {enemies, spacing}` → Server
2. Server: `generateWorld(seed)` → geodesic sphere → dual → terrain → cities → spawn units → compact JSON
3. Server → `{success, world}` → Client. `world` is a full `WireWorld` bootstrap
   payload (deterministic tiles included); `client/world/codec.ts::applyNewWorld`
   normalizes it through `decodeWorldInput`/`decodeWorldBootstrap` into a
   canonical `CompactSaveV1` (tiles dropped — always regenerated from the seed
   on reload) before it's written to sessionStorage.
4. Client: `client/world/repository.ts` (re-exported by `worldData.ts` for
   existing callers) caches in sessionStorage, reloads page
5. On fresh load with no sessionStorage handoff: fetch `/default-scenario.json`
   (bundled default world), not `/world.json`
6. Save/Load: localStorage (`saveLoad.ts`); loading a compact save decodes it
   with `client/world/codec.ts::decodeWorldInput` (recognizing both the
   current version-1 shape and legacy unversioned saves) then calls
   `POST /api/world-tiles` to regenerate tiles from the saved seed
   (`client/world/expand.ts::expandCompactSave` /
   `client/world/tilesClient.ts::regenerateTilesFromSeed`)
7. Player actions (move/attack/repair/logistics) submit through the
   authoritative match session (`client/matchClient.ts` → `/api/match/intent`);
   AI turns still resolve via the separate `/api/ai-turn` request (see Status
   note below)

### Save format versioning (Phase 3)

`CompactSaveV1` (`shared/wireTypes.ts`) adds an explicit `formatVersion: 1`
field. Saves written before this field existed ("legacy version 0", no
`formatVersion` key) are recognized and migrated to `CompactSaveV1` at load
time by `client/world/codec.ts::decodeCompactSave` — every save the client
writes going forward is version 1. An explicit `formatVersion` other than the
current one is rejected rather than silently accepted. This save-schema
version is unrelated to `MatchState.version` (`shared/matchTypes.ts`), which is
an optimistic-concurrency counter for the authoritative match session, not a
serialization-compatibility marker.

Generated-world bootstrap payloads (`/api/generate` responses, full
`WireWorld` shape) and persisted compact saves are recognized as distinct
input shapes by `client/world/codec.ts::decodeWorldInput` — a bootstrap
payload is never accepted as-is as a compact save; it is projected into one
via `decodeWorldBootstrap`, which validates but discards the deterministic
`tiles`/`tileCount`/`pentagonIndices` fields (tiles are always regenerated from
the seed on reload, exactly as for a compact save).

## API

### POST /api/generate

Request body:
```json
{ "enemies": 5, "spacing": 25 }
```

- `enemies`: 0–11 (clamped to MAX_CITIES - 1); `0` creates a sandbox with only the player city
- `spacing`: 20–45, target graph distance from player home to enemies; ignored when `enemies` is `0` or `11`

Response (200):
```json
{ "success": true, "world": { ...compact world... } }
```

Response (400):
```json
{ "success": false, "error": "World validation failed" }
```

### POST /api/world-tiles

Regenerates tiles + cities deterministically from a trusted `seed` (used when
loading a compact save, which only persists the seed and mutable state, not the
full tile array). Body: `{ "seed": number }`. Delegates to
`server/regenerate.ts::regenerateTiles`, whose return type
(`shared/wireTypes.ts::WorldTilesResponse`) is the same static contract the
client's `client/world/tilesClient.ts::regenerateTilesFromSeed` runtime-validates
the response against — static typing on the server doesn't replace the client's
`unknown`-in, validated-out decoding. Called by
`client/world/expand.ts::expandCompactSave`.

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

Authoritative match sessions (server-authority Phase 3, `server/matchApi.ts`). The server owns per-unit MP / acted / rotated state, whose turn it is, and the oil-logistics economy, so it can reject acting twice, moving twice, overspending MP, acting out of turn, or an illegal logistics build — the anti-cheat foundation for multiplayer.

- `POST /api/match/create` `{ seed, factions, units, buildings?, logistics? }` → `{ success, state: MatchState }` (`shared/matchTypes.ts::CreateMatchRequest`/`MatchState`). Initialises each unit's turn budget, warms the authoritative tile cache, and adopts the optional pre-seeded `LogisticsState` (falls back to an empty one) — `MatchState.logistics` is a required field on every match.
- `POST /api/match/intent` `{ matchId, expectedVersion?, intent }` → `MatchIntentResponse` with the updated state (+ combats/reactions/repair/logistics/events). Returns **409** when `expectedVersion` is stale or a concurrent write loses the optimistic-lock race.

`intent.kind` (`shared/matchTypes.ts::Intent`) is one of:
- Combat/movement: `move | attack | attackBuilding | buildingAttackUnit | repair | endTurn`
- Logistics (routed by `matchApi.ts` through `server/logistics/dispatch.ts` to the canonical appliers under `server/logistics/**`): `buildOilWell | buildRefinery | addRefinerySegment | buildRoute | upgradeRoute | buildDistributionHub | buildBridge | clearForest | buildRoadSegment | purchaseTransport | upgradeTransport`. `buildRoadSegment` is the engineer-driven road mechanic: the acting engineer paves the segment it occupies via a timed `road` `EngineerTask`, which `resolveLogisticsTurn` completes into a `logistics.standaloneRoadSegments` entry. Position is derived from the unit (like `buildOilWell`), and roads never block movement, so the actor is excluded from that segment's occupancy check.
- Development-only maintenance: `godModeBuildRoad | godModeCreateOilBuilding | godModeEditOilBuilding | godModeDeleteOilBuilding | godModeEditUnit | godModeDeleteUnit | godModeEditBuilding | godModeDeleteBuilding`. `godModeBuildRoad` is rejected unless the server-derived standalone-road capability is active, and records a validated empty-segment overlay rather than a `LogisticsRoute`. Oil-building CRUD is server-authorized and segment-addressed: wells occupy one segment; refinery creation/deletion affects the selected refinery footprint segment. Entity edits are restricted to validated attributes and deletes update the authoritative match state.

Each logistics applier uses the canonical pure engine under `src/world/logistics/**` (importing the owning module, or `src/world/logistics/index.js` when it needs many symbols), validates against authoritative tiles + `MatchState.logistics`, and charges `Refined_Product` via `shared/logisticsConstants.ts::CONSTRUCTION_COST`. Appliers are **reject-and-preserve**: validation failure returns before mutation. `endTurn` additionally runs `resolveLogisticsTurn` (extraction/refining/delivery/engineer-task progress), surfaced to the client as `MatchIntentResponse.events` (`LogisticsEvent[]`).

**Development God Mode:** outside `NODE_ENV=production`, God Mode is active unless `DD_GOD_MODE=false`. This is a server-only logistics policy: it waives Refined_Product charges, permits `buildBridge` / `clearForest` intents without a unit ID, permits the explicit `godModeBuildRoad` intent only on an empty cleared/bridged segment, and enables the explicit `godModeEdit*` / `godModeDelete*` entity intents. Successful match create and intent responses include a read-only `capabilities` object derived from that policy, allowing the client to display those actions without inferring the setting from client configuration. Entity edits are whitelisted, range-validated attribute changes (including unit size in the God Mode editor); deletions update the server-owned unit/building state and turn metadata. The server records a virtual engineer-1 task actor for remote terrain work, so no player unit is created and the normal five-turn bridge/forest countdown still applies. Production always rejects entity-editing intents and requires a real engineer; terrain target and duplicate-placement checks remain enforced, including an already-pending task for the same tile. New behavior belongs in the focused canonical module that owns the concern under `src/world/logistics/**` or `server/logistics/**`.

State is held in a `SessionStore` (`server/sessionStore.ts`). Production backend is **DynamoDB** (one versioned item per match); locally the Dynamo call is **mocked** in-memory behind the same interface, so deploying is a one-adapter swap. Tiles are regenerated from the trusted `seed`, never accepted from the client.

> **Status (verified against code):** the match-session path is live for player
> actions. `client/matchClient.ts` is wired into `client/main.ts` (creates the
> session on load) and `client/playerActions.ts` / `client/logisticsController.ts`
> submit every player move/attack/repair/logistics intent through
> `matchClient.submit()`, reconciling the authoritative response. `TurnManager`
> now mirrors session state rather than owning it for player actions.
> AI faction turns are **not yet routed through the session** — they still
> resolve via the separate stateless `POST /api/ai-turn` request
> (`client/turnController.ts` re-creates the match session from the post-AI
> world afterward). Routing AI turns through `/api/match/intent` is the
> remaining increment.

## See Also

- [world-generation.md](world-generation.md) — what `generateWorld(seed)` does internally
- [modules.md](modules.md) — `server/` and `shared/wireTypes.ts` layout
