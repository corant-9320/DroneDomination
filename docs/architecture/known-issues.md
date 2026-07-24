# Known Issues & Enduring Gotchas

[← Architecture Wiki](README.md)

**This is the live, curated list.** It replaces the old "append everything to
`DECISIONS.md`" workflow. Two kinds of knowledge live here:

1. **Open Issues** — bugs/limitations that are still unresolved. When resolving
   one, remove it from this list and preserve useful historical context in the
   [fixed-issue archive](archive/known-issues-fixed.md).
2. **Enduring Gotchas & Sync Requirements** — non-obvious invariants that stay
   true across many changes (not tied to one commit).

Per-diff *rationale* ("why we made this specific change") now lives in the **git
commit body**, not here — see [`docs-as-we-go.md`](../../.kiro/steering/docs-as-we-go.md).
A frozen archive of decisions recorded through the older workflow is
[`DECISIONS.md`](../../DECISIONS.md) (read-only; it is not a complete index of
all later fixes or rationale).

---

## Open Issues

- **`vite` and `vitest` majors are mismatched.** `package.json` declares
  `vite: ^5.4.0` and `vitest: ^4.1.6`, but vitest 4 does not support vite 5, so npm
  satisfies its peer requirement with a nested `vite 8.1.0` under
  `node_modules/vitest` alongside the top-level `vite 5.4.21`. Vitest also loads the
  vite-5-authored `vite.config.ts`. The suite currently passes (843/843), so this is
  latent rather than breaking, and it is **not** the cause of the agentStop-hook
  failure described below (that is invoker-dependent; this mismatch is not). Resolve
  deliberately, not mid-debugging: either downgrade vitest to `^2.x` (peer range
  includes vite 5; keeps the shipped dev-server/build path untouched, but may need
  API fixes across the test suite) or upgrade vite to `^8` (one dependency line, no
  test changes, but three majors of risk to `vite.config.ts`, the dev server, and the
  client bundle). Downgrading vitest is the lower-risk option for shipped code.
- **No UI for route-level logistics actions.** `buildRoute`, `upgradeRoute`,
  `purchaseTransport`, `upgradeTransport`, `buildDistributionHub`,
  `addRefinerySegment`, `buildRefinery`, and `buildOilWell` are all implemented in
  `client/logisticsController.ts` and server-side, but nothing in the client calls
  them — no button, context-menu item, or shortcut. Only bridge/forest/standalone-road
  (God Mode), the `R` engineer road shortcut, and the shuttle create/stop RMB flow
  are wired. So a real `LogisticsRoute` currently cannot be created through the UI at
  all; road connectivity comes from engineer-paved `standaloneRoadSegments` instead.
  `buildRoute` also commits a whole route instantly, which does not fit the intended
  engineer-driven construction model — expect it to be reworked (see next item)
  rather than simply wired to a button.
- **Engineer road building: auto-build mode not implemented (Phase 2).** Phase 1
  (`buildRoadSegment`) paves one segment per timed task, driven by the engineer that
  occupies it. The intended follow-up is an auto-build mode: pick two endpoints,
  resolve a segment path once, then queue/advance construction turn by turn as the
  engineer walks it, aborting if the engineer dies or the path becomes blocked.
  `previewRoutePath` in `client/logisticsController.ts` is the existing (unused)
  path-preview helper to build that on.
- **Globe: units float/sink on slopes.** On the globe view, units are placed at
  the flat per-tile height, not the averaged/tilted segment-centroid surface, so
  they float or sink near slopes (more visible with smaller units at high tile
  counts). Fix: sample the interpolated segment-centroid surface height. *(The
  first-person view's equivalent bug was fixed 2026-07-03; the globe path was
  not.)*
- **Tile-regeneration latency (~4.4 s).** `generateWorld(seed)` is slow for the
  shipped frequency. `handleCreateMatch` warms a per-seed cache so intents stay
  fast, but on Lambda the cost recurs per cold container. Fix: persist/cache
  tiles (warm layer or precomputed artifact) instead of regenerating per
  container.
- **In-range highlight overlay ignores elevation.** The hover highlight uses base
  range (`isTargetInRange` default), while the authoritative server gate and the
  attack preview both account for the elevation range multiplier. The player sees
  the truth on hover/preview; only the overlay is approximate.
- **Legacy and logistics bridges share `TileData.bridge` and may overlap in
  serialized overlays.** `CompactSaveV1.bridges` (legacy player-built bridges)
  and `CompactSaveV1.logistics.bridges` (completed logistics-engineer bridges)
  both set the same runtime `tile.bridge` render flag on load
  (`client/world/expand.ts::expandCompactSave`), and `projectCompactSave`
  derives `bridges` back from `tile.bridge` without knowing which overlay a
  given tile index originally came from. Loading either or both arrays
  produces the same visible bridge overlay, so this is currently harmless, but
  a tile index can appear in both `bridges` and `logistics.bridges` after a
  save round-trip. A broader bridge-ownership redesign (deduplicating the two
  origins) is deliberately out of scope for the Phase 3 save-contract work.

## Enduring Gotchas & Sync Requirements

These are invariants not already covered by the Cross-File Dependencies table in
[`conventions.md`](../../.kiro/steering/conventions.md). Check that table too.

- **Every `vitest` npm script must go through `scripts/run-vitest.mjs`.** On Windows,
  a lowercase drive letter in the cwd (`c:\Kiro\...` rather than `C:\Kiro\...`) makes
  vite resolve modules under two path spellings, instantiating vitest twice; the
  `describe` a test file imports then belongs to a different instance than the one
  holding worker state, and every file fails at its first `describe()` with
  `TypeError: Cannot read properties of undefined (reading 'config')`. Kiro's
  `agentStop` hook shell uses a lowercase drive letter, so the whole suite failed
  under the hook while passing from an agent shell. The launcher normalises the drive
  letter for **both** `process.cwd()` and the resolved vitest bin path — normalising
  only one reintroduces the duplicate load. Calling `vitest` directly from a script
  reintroduces the bug; `scripts/__tests__/runVitest.test.ts` guards against that.
  The launcher also needs its main-module guard: without it, a test importing
  `normaliseDriveLetter` spawns vitest at import time and recurses.

- **`shared/segmentGraph.ts` ↔ movement consumers (server + client + AI) must agree
  on occupancy rules.** `buildSegmentOccupancy` / `farthestAffordablePrefix` /
  `findSegmentPath` in `shared/segmentGraph.ts` are the single occupancy-gated
  movement primitive — `server/combatApi.ts::computeMovePath`,
  `server/matchApi.ts::applyMoveIntent`, `client/movementRange.ts::computeMovementRange`,
  `client/movementRoute.ts::computeMovementCostRoute`, and `client/aiTurn.ts` /
  `server/aiTurnApi.ts` (affordableSteps) all flow through them. If the occupancy
  rules change (including what entity types count as occupants), the change must
  propagate to all five consumers through the shared helper. Every other unit
  and every building currently blocks every chassis, including flight-capable
  units. (Segment-Based Movement spec, Requirement B5.)

- **Building placement (`shared/buildings.ts`) and segment movement/occupancy
  (`shared/segmentGraph.ts`) must stay consistent.** `validateBuildingPlacement`
  allows placing a building on any eligible segment, even if it seals off others;
  `segmentReachability` / `findSegmentPath` make those sealed-off segments
  unreachable by movement. This is intentional ("player's problem") — but if the
  building placement rules ever add new A2-style blocks, the movement occupancy
  predicates must be updated too so they continue to agree on what is impassable.

- **`STEEP_VERTICAL_EXAGGERATION` ↔ world scale.** In `segmentSteepness.ts` it
  must stay in sync with `ELEV_WORLD_SCALE / HEX_WORLD_RADIUS` in
  `client/firstPersonConstants.ts` (currently 4.4). Re-run
  `node scripts/calibrateSteepness.js` if elevation curve / exaggeration / terrain
  generation changes.
- **`buildVertexHeight()` is the single source of surface height.** Both the
  terrain mesh (`firstPersonTerrain.ts`) and unit/building placement
  (`firstPersonScene.ts`, via `sampleSurface` in `firstPersonGeometry.ts`) sample
  it; they must stay in sync or units float/clip.
  Placement also clamps `max(sampled, tilePlateau)` so buildings/units don't sink
  into shore slopes.
- **First-person webp import list ↔ `terrainTextures.ts`.** `firstPersonTerrain.ts`
  imports the same webp assets; the key→artwork mapping is shared via `keyForTile`,
  but the import list itself must be kept in sync when terrain artwork changes.
- **Global `window` keydown listeners.** Both the map and first-person views attach
  global keydown listeners. Any new modal/overlay that handles keys must capture +
  `stopPropagation` (or otherwise suppress the map handler) or it will
  double-handle. Esc in the first-person view must close an open context menu
  without exiting the view.
- **`unitDataToModelAttrs` lives in `unitRenderer.ts`,** not `unitModel.ts`. Model
  groups are centred on origin, so measure with `Box3` and lift by `-box.min.y` to
  seat them on the ground.
- **`localMap.movementPoints` is a getter** that delegates to
  `turnManager.movementPoints` when a TurnManager is wired — client moves and
  `gameDebug.getUnit().mp` read/write the same map.
- **Rivers carry `terrainType === 'ocean'`.** City sanitisation's ocean→plains
  clearing can strip `riverTo` from river tiles next to a city, orphaning the
  channel upstream. Guard river tiles when sanitising city doorsteps.
- **Globe top faces use `MeshBasicMaterial` (unlit).** Height differences are
  invisible without a colour gradient or cliff walls — bare extrusion won't look
  3D.
- **Encoding when restoring files via git.** `git show HEAD:path > file` in
  PowerShell writes UTF-16LE+BOM, which breaks Vite/esbuild (`Unexpected "\ufeff"`).
  Re-encode to UTF-8 (no BOM) after such a redirect.
- **Pure logistics placement ↔ authoritative server collision checks.**
  `src/world/logistics/placement.ts` deliberately sees only `LogisticsState`, so
  ordinary main-game buildings remain outside its occupancy checks. The canonical
  server appliers compensate before mutation: `server/logistics/wells.ts` checks
  the target segment, `server/logistics/refineries.ts` checks whole-tile and added-
  segment placement, and `server/logistics/hubs.ts` checks the hub segment. Keep
  these checks when adding placement intents.

- **Oil-building tile designation and road access.** The first Oil_Well,
  Refinery_Segment, or Distribution_Hub (oil storage) claims the whole tile for
  that type. Wells, refinery segments, and storage hubs cannot mix; a hex may
  use at most five of its six segments (a pentagon at most four of five),
  keeping one segment available for road ingress/egress. All oil buildings are
  map-only: they cannot be created on city tiles. A pending well task reserves
  its segment and well designation until it completes, preventing a concurrent
  refinery, storage hub, or sixth well from invalidating that limit. The
  completed designation clears only after every footprint on that tile is
  deleted; God Mode follows the same reset rule.
  `src/world/logistics/placement.ts` is authoritative, while
  `client/localMapUnits.ts` shades claimed tiles dark grey and `mapInput.ts`
  suppresses invalid God Mode options. Legacy city-based storage hubs are
  removed with their dependent routes/transports and stale hub route references
  when a compact save expands or a match state is created/used; server city
  footprints come from regenerated tile `cityId` markers and compact saves use
  every persisted `ownedHexes` entry.

- **Logistics structure Hit_Points share the unit combat HP domain [0, 50].**
  `attackStructure` in `src/world/logistics/combatIntegration.ts` reduces a
  structure's `hitPoints` with `applyDamage` from the combat compatibility facade
  (`src/world/combat.ts`), which clamps into `[0, 50]` — the same domain as unit
  health. So a destroyable structure's
  `maxHitPoints` must be a positive integer within `[1, 50]`; a caller that assigns
  `maxHitPoints > 50` will see HP silently clamped to 50 on the first hit. Structure
  damage magnitude itself is produced upstream by the shared `computeDamage`
  pipeline (armour/EW/terrain from the structure's `attributes` + tile), then passed
  to `attackStructure` — no balance numbers live in the logistics engine.

### Logistics wire-format sync requirements

The logistics feature spans four wire/serialization seams that must move together
(from oil-logistics design §7). When editing any one, update the others:

- **Entity wire shapes stay a straight field copy across three files.**
  `shared/logisticsTypes.ts` (authoritative + wire shapes — same field names, like
  `WireUnit`/`WireBuilding`) ↔ `client/world/model.ts` mirror aliases ↔
  `src/world/compact.ts` (de)serializers. Wire shape === authoritative shape, so
  serialization is a plain copy; adding/renaming a field means touching all three.
  `client/world/codec.ts` additionally runtime-validates every logistics field
  (`decodeLogisticsState`) — a new field must be validated there too, or it
  silently passes through unchecked.
- **Save round-trip.** `src/world/compact.ts` logistics (de)serialize ↔
  `client/world/expand.ts::expandCompactSave` load path ↔
  `client/world/codec.ts::projectCompactSave` save path — the load path must
  decode exactly what the serializer emits, and the save path must include
  every field the load path expects (the historical omission of `logistics`
  from the saved payload is fixed; see the
  [fixed-issue archive](archive/known-issues-fixed.md)).
- **Generate/save payload.** `shared/wireTypes.ts` `CompactSave`/`WireWorld`
  logistics payload ↔ `src/world/compact.ts::toCompactWorld` ↔
  `server/generateApi.ts` payload ↔ `client/world/codec.ts::decodeWorldBootstrap`
  (which normalizes the generated `WireWorld` payload into `CompactSaveV1`,
  dropping deterministic tiles). (`shared/logisticsConstants.ts` is imported
  directly by the client — no duplicated copy to sync.)
- **Save schema version vs. match version.** `CompactSaveV1.formatVersion`
  (`shared/wireTypes.ts::COMPACT_SAVE_FORMAT_VERSION`) is serialization
  compatibility for persisted saves; `MatchState.version`
  (`shared/matchTypes.ts`) is optimistic-concurrency for the live match
  session. They are unrelated counters — do not reuse one for the other.
- **Intent routing.** `shared/matchTypes.ts` `Intent` union ↔ `server/matchApi.ts`
  routing ↔ `server/logistics/dispatch.ts` ↔ canonical appliers under
  `server/logistics/**`. Adding a new logistics intent
  means extending the union, routing it in `matchApi`, and adding a matching
  focused applier.
- **`MatchState.logistics` is required.** Any new `MatchState` construction site
  must initialise the `logistics` field, or the appliers/serializers will fault.

## Fixed-Issue History

Resolved issue notes are archived in
[`archive/known-issues-fixed.md`](archive/known-issues-fixed.md) so this live page
stays focused on unresolved work and enduring constraints. Use git history for
exact diffs and per-change rationale; do not assume a fixed item has a matching
entry in `DECISIONS.md`.
