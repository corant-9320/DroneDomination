# Known Issues & Enduring Gotchas

[← Architecture Wiki](README.md)

**This is the live, curated list.** It replaces the old "append everything to
`DECISIONS.md`" workflow. Two kinds of knowledge live here:

1. **Open Issues** — bugs/limitations that are still unresolved. Close them by
   moving the line to the "Recently Fixed" list with a date.
2. **Enduring Gotchas & Sync Requirements** — non-obvious invariants that stay
   true across many changes (not tied to one commit).

Per-diff *rationale* ("why we made this specific change") now lives in the **git
commit body**, not here — see [`docs-as-we-go.md`](../../.kiro/steering/docs-as-we-go.md).
The frozen historical record of past decisions is [`DECISIONS.md`](../../DECISIONS.md)
(archived — no longer appended to).

---

## Open Issues

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
- **Server MP model doesn't cover intra-hex repositions.** ~~A move intent needs a
  2+ tile path, so same-hex repositions aren't sent to the session; their MP cost
  isn't tracked server-side and a later `reconcile` refunds it. Needs a
  segment-move model server-side.~~ → See Recently Fixed.
- **Client/server MP-cost parity.** ~~The server move cost (`computeMovePath`) and
  the client route cost can differ in edge cases; since `reconcile` makes the
  server authoritative, MP can visibly snap after an action. Aligning the two
  cost models is the follow-up.~~ → See Recently Fixed.
- **In-range highlight overlay ignores elevation.** The hover highlight uses base
  range (`isTargetInRange` default), while the authoritative server gate and the
  attack preview both account for the elevation range multiplier. The player sees
  the truth on hover/preview; only the overlay is approximate.
- **Logistics placement validators can't see main-game buildings.** The pure
  logistics validators in `src/world/logistics.ts` (`validateWellPlacement`,
  `validateRefineryPlacement`, `validateRefinerySegment`) determine segment
  occupancy from `LogisticsState` only (wells + refinery segments + hubs). The
  main-game building layer (`shared/buildings.ts`) is not part of
  `LogisticsContext`, so a segment occupied by an ordinary building is not
  detected here. The server applier (spec task 13.2) must add any
  building-collision check it can see against authoritative match state.
  *(Partially mitigated 2026-07-12: the default-world seed now runs after cities
  are founded and is passed the occupied building/unit segments, so the seeded
  network avoids them — see `server/generateApi.ts` + `seedDefaultLogisticsNetwork`.
  Player-built structures still lack a building-collision check.)*
- **Roads can visually cross building segments.** The seeded/player logistics
  route is a tile-level path and buildings only block segments, so a route can
  legally cross a city tile even though it looks like it crosses a building.
  Fixing the visual requires a segment-level route representation in the
  authoritative state (a wire-format change) plus route validation that
  rejects/reroutes around building segments. Not attempted as part of the
  2026-07-12 authoritative-logistics fix below.

## Enduring Gotchas & Sync Requirements

These are invariants not already covered by the Cross-File Dependencies table in
[`conventions.md`](../../.kiro/steering/conventions.md). Check that table too.

- **`shared/segmentGraph.ts` ↔ movement consumers (server + client + AI) must agree
  on occupancy rules.** `buildSegmentOccupancy` / `farthestAffordablePrefix` /
  `findSegmentPath` in `shared/segmentGraph.ts` are the single occupancy-gated
  movement primitive — `server/combatApi.ts::computeMovePath`,
  `server/matchApi.ts::applyMoveIntent`, `client/movementRange.ts::computeMovementRange`,
  `client/movementRoute.ts::computeMovementCostRoute`, and `client/aiTurn.ts` /
  `server/aiTurnApi.ts` (affordableSteps) all flow through them. If the occupancy
  rules change (e.g. drones blocking ground units, faction-specific blocking), the
  change must propagate to all five consumers, and the shared module is the single
  update point. (Segment-Based Movement spec, Requirement B5.)

- **Building placement (`shared/buildings.ts`) and segment movement/occupancy
  (`shared/segmentGraph.ts`) must stay consistent.** `validateBuildingPlacement`
  allows placing a building on any eligible segment, even if it seals off others;
  `segmentReachability` / `findSegmentPath` make those sealed-off segments
  unreachable by movement. This is intentional ("player's problem") — but if the
  building placement rules ever add new A2-style blocks, the movement occupancy
  predicates must be updated too so they continue to agree on what is impassable.

- **`STEEP_VERTICAL_EXAGGERATION` ↔ world scale.** In `segmentSteepness.ts` it
  must stay in sync with `ELEV_WORLD_SCALE / HEX_WORLD_RADIUS` in
  `client/firstPersonView.ts` (currently 4.4). Re-run
  `node scripts/calibrateSteepness.js` if elevation curve / exaggeration / terrain
  generation changes.
- **`buildVertexHeight()` is the single source of surface height.** Both the
  terrain mesh (`firstPersonTerrain.ts`) and unit/building placement
  (`firstPersonView.ts`) sample it; they must stay in sync or units float/clip.
  Placement also clamps `max(sampled, tilePlateau)` so buildings/units don't sink
  into shore slopes.
- **First-person webp import list ↔ `terrainTextures.ts`.** `firstPersonView.ts`
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
- **Logistics structure Hit_Points share the unit combat HP domain [0, 50].**
  `attackStructure` in `src/world/logistics.ts` reduces a structure's `hitPoints`
  with the combat model's own `applyDamage` (`src/world/combat.ts`), which clamps
  into `[0, 50]` — the same domain as unit health. So a destroyable structure's
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
  `WireUnit`/`WireBuilding`) ↔ `client/worldData.ts` mirror aliases ↔
  `src/world/compact.ts` (de)serializers. Wire shape === authoritative shape, so
  serialization is a plain copy; adding/renaming a field means touching all three.
- **Save round-trip.** `src/world/compact.ts` logistics (de)serialize ↔
  `client/worldData.ts` `expandCompactSave` load path — the load path must decode
  exactly what the serializer emits.
- **Generate/save payload.** `shared/wireTypes.ts` `CompactSave`/`WireWorld`
  logistics payload ↔ `src/world/compact.ts::toCompactWorld` ↔
  `server/generateApi.ts` payload. (`shared/logisticsConstants.ts` is imported
  directly by the client — no duplicated copy to sync.)
- **Intent routing.** `shared/matchTypes.ts` `Intent` union ↔ `server/matchApi.ts`
  routing + `server/logisticsApi.ts` appliers. Adding a new logistics intent means
  extending the union, routing it in `matchApi`, and adding a matching applier.
- **`MatchState.logistics` is required.** Any new `MatchState` construction site
  must initialise the `logistics` field, or the appliers/serializers will fault.

## Recently Fixed

- **Segment-Based Movement & Unrestricted In-Cluster Building** — FIXED 2026-07-12.
  Two interlocked changes: (1) `shared/buildings.ts` no longer enforces per-tile
  through-street or whole-city external reachability invariants — a player may
  build on any eligible segment inside a city, even if it seals off others; sealed
  pockets are the player's problem, not an illegal build. (2) Movement is now a
  uniform segment-step model gated by `shared/segmentGraph.ts` — every unit move
  (server `computeMovePath`, matchApi `applyMoveIntent`, client `computeMovementRange`
  / `computeMovementCostRoute`, AI `affordableSteps`) validates occupancy on the
  destination segment before stepping, so no unit or building can be walked through.
  Server, client, and AI all use the same shared primitive (B5). `src/world/movement.ts`
  `moveUnit`/`pivotUnit` now accept an optional `isOccupied` predicate.

- **Seeded logistics network was client-render-only, not authoritative** — FIXED
  2026-07-12. `server/generateApi.ts` seeded the default Oil Logistics network
  into the compact world, but `server/matchApi.ts::handleCreateMatch` hardcoded
  `MatchState.logistics` to empty and never adopted it — a split source of truth.
  Fix: added optional `logistics?: LogisticsState` to `CreateMatchRequest`;
  `handleCreateMatch` now adopts `req.logistics ?? createEmptyLogisticsState()`;
  `client/matchClient.ts::create()` passes `world.logistics` through. Seeding
  itself still happens exactly once, in `generateApi.ts`; the client just carries
  the already-seeded compact-save network into the create-match request rather
  than the server re-deriving it. The per-turn economy (`advanceTurn` →
  `resolveLogisticsTurn`) and the intent round-trip already operated on
  `state.logistics`; only initial population was missing.

- **Oil-deposit markers didn't reach the client (integration seam)** — FIXED
  2026-07-04. `tile.resourceType` is now carried by the compact wire tile under
  the identical field name: added to `shared/wireTypes.ts::WireTile`, emitted by
  `src/world/compact.ts::toCompactTile`, and flowing through the `/api/world-tiles`
  regeneration path automatically. `client/logisticsRenderer.ts::renderDeposits`
  now receives `resourceType === 'oil'` tiles and draws their pre-drill markers.

- **Cliff skirt drawn on every edge** — FIXED 2026-07-03. `buildTerrainMesh`'s
  `isCliff` stub (`tile.n && tile.n.length > 0`, always true) emitted a full skirt
  wall on every hex edge, occluding units on non-cliff slopes. Now gated on
  `isCliffEdge(a, b)`.
- **Units invisible on shore-adjacent segments** — FIXED 2026-07-03. Unit
  placement now applies the same `max(sampled, plateau)` clamp as buildings.
- **Movement cost modelled twice** — FIXED 2026-06-10. Single segment-step model;
  rotation is a flat once-per-turn `ROTATION_FEE`.
- **Server combat ignored elevation** — FIXED 2026-06-10. `server/combatApi.ts`
  carries `elev` through the wire format.
- **Compact wire format hand-mirrored** — FIXED 2026-06-17. Unified into
  `shared/wireTypes.ts`; both sides import it. `TileData` in `client/worldData.ts`
  extends `WireTile` with a client-only `bridge?` flag.

Detail on any fixed item is in the [`DECISIONS.md`](../../DECISIONS.md) archive
(search by date) and the git history for the relevant commit.
