# Module Map

[← Architecture Wiki](README.md)

> **Import rule (enforced by `tsconfig.client.json`):** Client files MUST NOT
> import from `src/` or `server/`. The client tsconfig only includes
> `client/**` and `shared/**`, so any `import from '../src/...'` will fail
> to type-check. Logic needed by both client and server must live in `shared/`.
> Movement constants, range checks, unit naming/attribute types, and combat
> wire types now live in `shared/` (see below). Some heavier logic (pathfinding,
> 3D movement geometry) is still duplicated between `src/world/` and `client/`;
> migrate it into `shared/` when you touch it.

```
client/           → Browser entry (loaded by index.html via Vite)
  main.ts           Entry point — initializes GlobeView + LocalMapView + panels + AI playback
  globe.ts          Three.js OrbitControls globe (class GlobeView)
  localMap.ts       Canvas 2D hex map (class LocalMapView)
  detailPanel.ts    Bottom bar detail view (terrain, units, city info)
  combatPanel.ts    Right-curtain combat log (history nav, attack preview)
  aiTurn.ts         AI faction turn logic (move toward enemy, attack when in range)
  aiPlayback.ts     Video-style playback controller (play/pause/fast-forward for enemy turns)
  worldData.ts      Loads world JSON, caches in memory/sessionStorage
  buildController.ts Client building placement: validate/construct via
                      shared/buildings, founding-on-load fallback
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
  debug.ts          Centralized debug logging (toggle via localStorage)
  debugState.ts     Runtime state snapshot + error capture (window.__DD_STATE__)

server/           → API layer (Vite SSR in dev, Lambda in prod)
  generateApi.ts    handleGenerate(config) → GenerateResult (framework-agnostic)
  combatApi.ts      Combat resolution handler — resolves an action via src/world/
  combatExplainer.ts Pure step-by-step explanation builders for combat/repair
  regenerate.ts     Rebuild tiles + cities from a seed (for compact saves)
  devPlugin.ts      Vite plugin exposing POST /api/generate

shared/           → Logic + types shared by client AND server (client-importable)
  unitTypes.ts      Authoritative UnitAttributes definition
  combatTypes.ts    Combat API wire types (ExplanationStep, etc.)
  movementConstants.ts Movement constants + pure cost helpers
  rangeCheck.ts     Segment-distance range check + weaponRangeFromAttributes()
  unitNaming.ts     Shared naming tables + core name-building logic
  buildings.ts      Pure building-placement rules: through-street + external
                      reachability invariants, validateBuildingPlacement()
  wireTypes.ts      Single source of truth for compact wire types (WireTile,
                      WireUnit, WireBuilding, WireCity, WireWorld, CompactSave);
                      previously duplicated in compact.ts (server) and worldData.ts (client)
  pathfinding.ts    graphDistance(), tilesWithinRadius(), findPath() — pure BFS/A*;
                      previously duplicated between src/world/ and client/aiTurn.ts

src/              → Server/CLI-only core logic (NOT client-importable)
  generateCli.ts    CLI: generate world → data/world.json
  validate.ts       CLI: validate data/world.json
  world/            World module (barrel: index.ts)
    types.ts          Tile, City, World, Vec3, TerrainType
    units.ts          Unit, HexSegment, validation helpers
    buildings.ts      Server adapter over shared/buildings: foundCity(es),
                        constructBuilding(), checkCityIntegrity()
    rng.ts            mulberry32 seeded PRNG (extracted from generate.ts)
    geodesic.ts       Goldberg geometry: generateGeodesicSphere() + computeDual()
                        (extracted from generate.ts sections 1)
    generate.ts       World-gen orchestrator + terrain/river/city logic:
                        generateWorld(seed) → World, generateTerrain, generateRivers,
                        placeCities, and mulberry32
    spawn.ts          spawnInitialUnits(tiles, cities) → Unit[]
    compact.ts        toCompactWorld/toCompactTile/toCompactUnit (wire format)
    combat.ts         resolveCombat() — deterministic combat on the hex grid
    combatFormula.ts  Pure, self-contained damage formula (clean param objects)
    combatFacing.ts   Bearing-based orientation bonus geometry
    movement.ts       moveUnit/pivot primitives (unified segment-step cost)
    turnState.ts      Per-unit movement tracking within a turn
    repair.ts         Attribute-based healing
    segmentGeometry.ts Segment centroids + segment-aware distance
    pathfinding.ts    graphDistance(), tilesWithinRadius(), findPath() (A*)
    validate.ts       validateWorld(world) → ValidationResult
    vec3.ts           Vec3 math utilities

data/             → Generated world files (Vite publicDir, served at /)
  world.json        Full world data (compact format)
  world-summary.json  Metadata summary
```

## See Also

- [data-flow-and-api.md](data-flow-and-api.md) — how these modules pass data
- [world-generation.md](world-generation.md) — what `src/world/**` produces
- Cross-file sync rules live in `.kiro/steering/conventions.md`
