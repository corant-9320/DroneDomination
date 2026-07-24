# Module Map

[← Architecture Wiki](README.md)

> **Import rule (enforced by `tsconfig.client.json`):** Client files MUST NOT
> import from `src/` or `server/`. The client tsconfig only includes
> `client/**` and `shared/**`, so any `import from '../src/...'` will fail
> to type-check. Logic needed by both client and server must live in `shared/`.
> Movement constants, range checks, unit naming/attribute types, combat wire
> types, match/logistics types, pathfinding, and the seeded PRNG now live in
> `shared/` (see below). `src/world/tilePathfinding.ts` is the `Tile`-typed
> entry point over the canonical algorithms in `shared/pathfinding.ts`, not a
> duplicate implementation. Some 3D movement
> geometry is still duplicated between `src/world/` and `client/`; migrate it
> into `shared/` when you touch it.

```
client/           → Browser entry (loaded by index.html via Vite)
  main.ts           Entry point — initializes GlobeView + LocalMapView + panels + AI playback
  globe.ts          Three.js OrbitControls globe (class GlobeView)
  localMap.ts       Canvas 2D hex map (class LocalMapView)
  detailPanel.ts    Bottom bar detail view (terrain, units, city info)
  combatPanel.ts    Right-curtain combat log (history nav, attack preview)
  matchClient.ts    Client for the authoritative match-session API
                      (/api/match/create, /api/match/intent) — submits intents,
                      reconciles the returned MatchState into the local world
  turnController.ts Turn/AI-phase orchestration: advances turns, re-creates the
                      match session from the post-AI world, drives aiPlayback
  playerActions.ts  Player-initiated move/attack/repair — submits via matchClient,
                      then reconciles the authoritative response
  aiTurn.ts         AI turn client module. `executeAiTurn` (client-side decision
                      logic: move toward enemy, attack in range) is a fallback/
                      reference implementation, superseded for live play by
                      `fetchAiTurn`/`replayAiTurn`, which fetch the server's
                      precomputed /api/ai-turn event log and replay it through
                      the playback bar — no AI decisions are computed on the
                      client in the live path
  aiPlayback.ts     Video-style playback controller (play/pause/fast-forward for enemy turns)
  worldData.ts      Thin compatibility facade (re-exports only) over
                      client/world/** — see below. ~40 existing consumers keep
                      importing from here; new internal code should import the
                      focused module it needs directly.
  world/            World-data boundary, split by responsibility (Phase 3):
    model.ts          Client runtime model (WorldData, TileData, UnitData,
                        BuildingData, CityData, logistics mirror aliases,
                        buildingAsAttackerUnit). No fetch/storage/parsing —
                        shared/** imports only.
    validation.ts     Dependency-free runtime validation primitives
                        (expectObject/expectArray/expectInteger/expectEnum/…),
                        each throwing a `ValidationError` carrying an
                        actionable property path (e.g. `logistics.wells[0].tileIndex`).
    codec.ts          Unknown-input decoding + validation + legacy-save
                        migration + generated-world bootstrap normalization +
                        canonical save projection. `decodeCompactSave` migrates
                        pre-formatVersion ("legacy v0") saves to the current
                        `CompactSaveV1` (`shared/wireTypes.ts`);
                        `decodeWorldBootstrap` normalizes a full `WireWorld`
                        generate-response into the same shape (dropping
                        deterministic tiles); `decodeWorldInput` dispatches
                        between the two; `projectCompactSave` is the save-time
                        inverse (includes the full logistics state — the
                        historical save-time logistics-loss bug is fixed here).
    tilesClient.ts    POST /api/world-tiles request + runtime-validated
                        response decoding (`regenerateTilesFromSeed`). Owns
                        only the HTTP/JSON/validation concern, not caching.
    expand.ts         Deterministic decoded-save + regenerated-tiles ->
                        WorldData expansion (`expandCompactSave`): tile
                        regen, out-of-range tile-reference rejection, bridge/
                        cleared-forest overlays, city-marker filtering, city-
                        owned-hex reapplication, home-city fallback, founding-
                        building compatibility. No storage/reload; never
                        returns a partially-expanded world on failure.
    repository.ts     Module-level world cache, `getWorld`/`getCompactSave`/
                        `loadWorld`/`applyNewWorld`, session-storage handoff,
                        default-scenario fetch. `cachedWorld` is only assigned
                        after decode+validate+regenerate+expand all succeed.
  buildController.ts Client building placement: validate/construct via
                      shared/buildings, founding-on-load fallback
  logisticsController.ts Dispatches logistics Intent variants through the same
                      matchClient.submit() path as combat/move, adopts the
                      returned authoritative LogisticsState
  logisticsModel*.ts 3D procedural models for logistics structures (hub,
                      refinery, road, transport, well) and the shared
                      logisticsModel.ts assembly/bridge helpers
  logisticsPanel.ts HUD panel for logistics actions/status
  logisticsRenderer.ts Draws routes, deposits, and structures on the local map
  logisticsSpriteRenderer.ts Pre-renders logistics structure sprites
  cityPlan.ts       City Design plan persistence (per-seed localStorage),
                      syncPlannedToWorld() overlay
  cityDesignModal.ts Capital RMB → City Design planner modal
  newWorldModal.ts  Modal UI for world generation config
  saveLoad.ts       Save/Load game state via localStorage
  colors.ts         Faction color palette + terrain color mapping (combined)
  unitIcons.ts      Canvas 2D rendering of unit icons (attribute-driven)
  unitNames.ts      Generates readable names from unit attributes
  unitModel.ts      3D unit model rendering
  unitRenderer.ts   Pre-renders 3D unit sprites for all configurations
  facing.ts         Single source of truth for facing conversions (facingFromTravel,
                      rotateHexIndex, screenAngleBetweenTiles, spriteFacingForRender,
                      facingDirection) — rules in .kiro/steering/ui-facing.md
  firstPersonView.ts    Shell (class FirstPersonView): lifecycle, camera, DOM overlay,
                      render loop, selection. Delegates to the modules below and owns
                      the disposable arrays they fill
  firstPersonScene.ts   Renderer/lighting setup + rebuilders for units, buildings,
                      logistics network, forest scenery; entity-id → world-point
                      placement maths (route-segment encoding lives here)
  firstPersonInput.ts   Screen picking + select/move/attack/repair/rotate handlers;
                      declares FpCommandContext; mirrors MapInputHandler semantics
  firstPersonTerrain.ts Terrain meshes (hex tops, cliff skirts, rim outlines) +
                      buildVertexHeight / elevationWorldHeight
  firstPersonEffects.ts 3D missile/explosion effects, timed in lockstep with
                      client/combatAnimations.ts
  firstPersonGeometry.ts Pure flat-view geometry (sampleSurface, orientToSurface,
                      segmentCentroid, baryWeights) — client-local, depends on THREE
  firstPersonOverlay.ts Movement-range hex fills + hover route line
  firstPersonConstants.ts World scale, camera limits, model fractions, animation
                      timings (shared without importing the view — breaks a cycle)
  debug.ts          Centralized debug logging (toggle via localStorage)
  debugState.ts     Runtime state snapshot + error capture (window.__DD_STATE__)

server/           → API layer (Vite SSR in dev, Lambda in prod)
  generateApi.ts    handleGenerate(config) → GenerateResult (framework-agnostic)
  combatApi.ts      Combat resolution handler — resolves an action via src/world/
  combatExplainer.ts Pure step-by-step explanation builders for combat/repair
  aiTurnApi.ts      Server-authoritative resolver for a whole AI faction turn
                      (target selection, pathfinding, combat) — the client only
                      replays the returned event log, it does not decide anything
  matchApi.ts       Authoritative match-session handlers (handleCreateMatch,
                      handleMatchIntent) — owns MP/turn state, routes each
                      Intent (including logistics intents) to its applier
  sessionStore.ts   Match-state persistence (in-memory locally, DynamoDB-shaped
                      interface for production) behind optimistic-concurrency versioning
  logistics/        Authoritative logistics intent appliers, split by concern
                      (context.ts shared helpers, wells/refineries/routes/hubs/
                      transport/bridgesAndForest.ts one applier group each,
                      structures.ts for development-only segment oil-structure CRUD,
                      dispatch.ts routes to the right applier) — mirrors matchApi's
                      combat-applier convention; reject-and-preserve. Callers
                      import server/logistics/dispatch.js, or index.js for many
                      symbols; the old server/logisticsApi.ts facade is deleted
  regenerate.ts     Rebuild tiles + cities from a seed (for compact saves)
  devPlugin.ts      Vite plugin exposing all dev-mode API routes (see
                      data-flow-and-api.md for the full endpoint list)

shared/           → Logic + types shared by client AND server (client-importable)
  unitTypes.ts      Authoritative UnitAttributes definition
  combatTypes.ts    Combat API wire types (ExplanationStep, etc.)
  matchTypes.ts     Authoritative match-session types: MatchState, the Intent
                      union (combat + logistics intents), and match API
                      request/response shapes
  movementConstants.ts Movement constants + pure cost helpers
  rangeCheck.ts     Segment-distance range check + weaponRangeFromAttributes()
  unitNaming.ts     Shared naming tables + core name-building logic
  buildings.ts      Pure building-placement rules: occupancy/steepness/
                      contiguity gates; through-street + external reachability
                      invariants removed (Segment-Based Movement spec, A1–A5)
  logisticsTypes.ts Authoritative logistics domain types (OilWell, Refinery,
                      LogisticsRoute, Transport, DistributionHub, HomeStock,
                      EngineerTask, LogisticsState) — wire shape === authoritative
                      shape, so serialization is a straight field copy
  logisticsConstants.ts Logistics balance constants (construction costs, transport
                      tiers/thresholds, cargo caps) — imported directly by the client
  wireTypes.ts      Single source of truth for compact wire types (WireTile,
                      WireUnit, WireBuilding, WireCity, WireWorld, CompactSave);
                      previously duplicated in compact.ts (server) and worldData.ts (client).
                      `CompactSave` names the current schema version
                      (`CompactSaveV1`, `formatVersion: 1`,
                      `COMPACT_SAVE_FORMAT_VERSION`); the client's
                      `client/world/codec.ts` migrates older unversioned saves
                      to this shape at load time. Also defines
                      `WorldTilesResponse`, the static contract shared by
                      `server/regenerate.ts` and `client/world/tilesClient.ts`
                      for the `/api/world-tiles` payload.
  pathfinding.ts    graphDistance(), tilesWithinRadius(), findPath() — canonical
                      pure BFS/A* implementations, shared by client and server.
                      `src/world/tilePathfinding.ts` is the `Tile`-typed entry
                      point over this module (adapts the server's `Tile[]` to
                      `PathTile`) — add new algorithms here, not there
  rng.ts            mulberry32 seeded PRNG — canonical implementation. Lives in
                      shared/ so the client can seed deterministic scatter without
                      importing src/; `src/world/rng.ts` re-exports it
  segmentGraph.ts   segmentNeighbours(), segmentReachability(), findSegmentPath(),
                      realizeTilePathOverSegments(), farthestAffordablePrefix() —
                      shared occupancy-gated segment-step movement primitives
                      (Segment-Based Movement spec, B1–B5)

src/              → Server/CLI-only core logic (NOT client-importable)
  generateCli.ts    CLI: generate world → data/world.json
  validate.ts       CLI: validate data/world.json
  world/            World module (barrel: index.ts)
    types.ts          Tile, City, World, Vec3, TerrainType
    units.ts          Unit, HexSegment, validation helpers
    buildings.ts      Server adapter over shared/buildings: foundCity(es),
                        constructBuilding() — no integrity check, placement is
                        otherwise unrestricted (Segment-Based Movement spec)
    rng.ts            World-gen entry point for the seeded PRNG — re-exports
                        mulberry32 from shared/rng.ts (the implementation)
    geodesic.ts       Goldberg geometry: generateGeodesicSphere() + computeDual()
                        (extracted from generate.ts sections 1)
    generate.ts       World-gen orchestrator + terrain/river/city logic:
                        generateWorld(seed) → World, generateTerrain, generateRivers,
                        placeCities (seeded via mulberry32 from rng.ts)
    spawn.ts          spawnInitialUnits(tiles, cities) → Unit[]
    compact.ts        toCompactWorld/toCompactTile/toCompactUnit (wire format)
    combat.ts         Compatibility façade — existing callers import combat.js
    combat/            Internal combat engine split by responsibility:
                        context/adapters, defence, weapon options, unit/building
                        damage, previews, normal/reaction/simultaneous resolution
    combatFormula.ts  Canonical pure, self-contained damage formula
    combatFacing.ts   Canonical bearing-based orientation geometry
    movement.ts       moveUnit/pivot primitives (unified segment-step cost)
    turnState.ts      Per-unit movement tracking within a turn
    repair.ts         Attribute-based healing
    segmentGeometry.ts Segment centroids + segment-aware distance
    tilePathfinding.ts `Tile`-typed entry point for pathfinding: adapts the
                        server's Tile[] to shared PathTile[] and exposes
                        graphDistance/tilesWithinRadius/findPath over it. The
                        algorithms are canonical in shared/pathfinding.ts — add
                        new ones there, not here
    logistics/        Pure logistics engine, split by concern (tasks/placement/
                        production/routes/transport/hubs/combatIntegration.ts, plus
                        turn.ts for the resolveLogisticsTurn orchestrator) — operates
                        on LogisticsState + LogisticsContext, cannot see main-game
                        buildings (server/logistics/** adds that collision check;
                        see known-issues.md). Callers import the owning module,
                        or src/world/logistics/index.js for many symbols; the old
                        src/world/logistics.ts facade is deleted
    logisticsGen.ts    Deterministic generation helpers for logistics deposits/
                        network composition
    logisticsSeed.ts   Seeds the default-world Oil Logistics example network
                        (wells/refinery/routes/hub) after cities/units are placed
    validate.ts       validateWorld(world) → ValidationResult
    vec3.ts           Vec3 math utilities

data/             → Generated world files (Vite publicDir, served at /)
  world.json        Full world data (compact format)
  world-summary.json  Metadata summary
```

`server/combatApi.ts`, `server/combatExplainer.ts`, `server/matchApi.ts`, and
`server/aiTurnApi.ts` consume the compatibility façade at
`src/world/combat.js`; they do not import internal combat modules. Inside
`src/world/combat/`, implementation files import the sibling module that owns a
symbol rather than routing through `combat/index.ts` or the façade. The existing
`combatFormula.ts` and `combatFacing.ts` modules remain the canonical formula
and orientation implementations.

## See Also

- [data-flow-and-api.md](data-flow-and-api.md) — how these modules pass data
- [world-generation.md](world-generation.md) — what `src/world/**` produces
- Cross-file sync rules live in `.kiro/steering/conventions.md`; the logistics/save/wire
  seams are in [known-issues.md](known-issues.md)
