# Decision Log

Append-only record of design decisions, gotchas, and known issues. The game's
rules are invented as we go — this log is how that intent survives across
sessions so agents stop re-discovering (or re-breaking) the same things.

**How to use:** Add a new entry at the top whenever you (a) make a design or
balance decision, (b) discover a non-obvious gotcha, or (c) find/fix a bug worth
remembering. Keep entries short. Link to the authoritative doc if one exists
(`COMBAT_RULES.md`, `ARCHITECTURE.md`).

Format: `## YYYY-MM-DD — <short title>` then **Decision / Why / Impact**.

---

## 2026-06-14 — First-person view textures hex tops

**Decision:** Plateau tops in `client/firstPersonView.ts` are now textured with
the same `artifacts/*.webp` terrain artwork the 2D map uses, instead of a flat
biome colour. Tops are grouped per texture key (one `MeshStandardMaterial` with
`map` per terrain type), tile→key resolved by reusing `TerrainTextures.keyForTile`.
Per-hex UVs map each hex's flat bounding box onto the full image (mirroring the
2D `fillTileTexture` look), and the tile's biome colour is kept as a vertex-colour
tint that multiplies the texture. THREE textures are built once via
`TextureLoader` and cached on the view instance; cliff skirts stay vertex-coloured
(no texture).

**Why:** Textured tops make the 3D battlefield read like the 2D map and match
terrain at a glance, rather than as flat colour blocks.

**Impact:** `firstPersonView.ts` imports the same webp assets as
`terrainTextures.ts`. If terrain keys/artwork change there, the 3D view picks up
the mapping automatically (shared `keyForTile`) but the webp import list must stay
in sync.

---

## 2026-06-14 — First-person view gains terrain elevation

**Decision:** The first-person view (`client/firstPersonView.ts`) now renders
terrain at its real elevation instead of a flat plane. Each hex is a flat-topped
plateau raised to `elevationWorldHeight(tile)` — the shared 0→1 elevation scale
(mirroring `terrainContext.elevationHeight`: ocean −0.25, flat 0, rolling 0.28,
hills 0.58, mountain 1.0) lifted into world units by
`ELEV_WORLD_SCALE = HEX_WORLD_RADIUS × 2.2`. A darker (×0.55) vertical **cliff
skirt** is drawn around every hex edge dropping to a common floor below the
lowest tile, so elevation differences read as steps/cliffs and never leave
see-through gaps between neighbours at different heights. Units and the selection
ring now sit on top of their tile's elevation, and the camera anchor lifts by the
selected unit's tile height.

**Why:** Flat terrain (the v1 fast-follow noted in the previous entry) made the
battlefield read as a featureless disc; elevation gives the look-around mode
spatial depth and matches the height cues players already see on the 2D map.

**Gotcha:** The skirt floor is a single shared `floorY` (min tile top −
1.5×hex radius). Interior walls between same-height hexes are buried under the
neighbouring plateau and never seen; only true height transitions and the field
boundary expose a cliff face. Hex top vertices are duplicated per tile (no shared
edge welding), so plateaus are intentionally flat — there is no slope
interpolation between tiles. The ground material is `THREE.DoubleSide`: the skirt
quad winding depends on each tile's projected polygon orientation, so back-face
culling would make some cliff faces see-through — double-siding sidesteps the
per-edge winding problem entirely.

**Impact:** Visual-only. No combat/turn/movement code touched. The mapping
duplicates the small elevation switch from `terrainContext.ts` (client bundle
must not pull in the terrain renderer's context just for one helper).

## 2026-06-14 — First-person view: drones fly, zoom-out reaches further

**Decision:** In `client/firstPersonView.ts`, units with `flightMovement >= 1`
(drones — see `unitNaming.TYPE_NAMES`) are now rendered hovering at
`DRONE_AIR_HEIGHT = HEX_WORLD_RADIUS × 1.6` above their tile's terrain top
instead of sitting on the ground; their selection ring stays on the ground
directly below as a position marker. When the *viewed* unit is a drone, the
camera anchor is raised by the same amount so the look-around starts in the air.
Zoom-out range extended: `BOOM_MAX` raised from `FIELD_EXTENT × 1.6` to
`× 3.0` (with `BOOM_STEP = BOOM_MAX / 30`) so the player can pull the eye much
further back behind the selected unit.

**Why:** Drones reading as ground units broke the look; a drone view should feel
airborne. The previous zoom-out stopped too close to give a real stand-off view.

**Impact:** Visual-only. `isDrone` keys off the same `flightMovement` signal as
movement/naming, so it stays consistent if more chassis types are added.

## 2026-06-14 — First-person "look around" view (purely visual)

**Decision:** Added `client/firstPersonView.ts` — a read-only 3D camera mode
entered with the **V** key while a unit is selected (`Esc`/✕ to exit). It builds
its own Three.js scene + WebGL context on enter and disposes them on exit. Hex
environment is rendered FLAT (no elevation) using the SAME `buildFlatView`
tangent-plane projection as the 2D local map, mapped to 3D as `(px, py) → (px, 0, -py)`
and scaled so a hex ≈ `HEX_WORLD_RADIUS` world units. Surrounding units reuse
`buildUnitModel` (the same meshes the sprite renderer bakes), placed at their
segment centroid and rotated to their facing. Free-look only (drag = yaw/pitch);
the scroll wheel pulls the eye **back and up** along a "boom" (0 = first person,
up to `BOOM_MAX ≈ field × 1.6`, gaining `BOOM_LIFT` altitude per unit) so the
player can zoom out to an aerial overview of the whole battlefield. The view
renders `VIEW_RADIUS = 12` hex rings — the 20v20 field spans ~8 rings, so both
armies stay in frame. No movement, no mechanics.

**Why:** Immersion. Reuses existing 3D infrastructure (Three.js, unit models,
terrain palette) rather than adding a new rendering stack.

**Gotcha:** `unitDataToModelAttrs` is exported from `unitRenderer.ts`, NOT
`unitModel.ts`. Model groups are centred on origin (half below y=0), so we
`Box3`-measure each model and lift it by `-box.min.y` to sit it on the ground.
Facing→world rotation: model front is `-Z`, so `rotation.y = atan2(-dirX, -dirZ)`
where the faced direction comes from the projected edge midpoint. The feature
relies on `localMap.getSelectedUnits()` being populated — that happens on a real
left-click, but `gameDebug.selectUnit()` only sets the selected *tile*, so
browser tests must click the canvas (or add to `selectedUnits`) to populate it.

**Impact:** New visual-only mode. WebGL context budget respected (created/disposed
per session). No combat/turn code touched. Elevation is a deliberate fast-follow.
`window.__DD_FIRSTPERSON__.getDiagnostics()` exposes camera position/boom/yaw/pitch
for headless verification.

---

## 2026-06-14 — First browser-based gameplay test + gameDebug.moveUnit

**Decision:** Replaced the deprecated `/api/combat` move test with an in-browser
test that drives the real client move pipeline. Added
`window.gameDebug.moveUnit(unitId, destTile)` which mirrors the player's
left-click selection (clears + adds to `selectedUnits`, `computeMovementRange()`),
runs the shared `localMap.planMove` route logic, then applies position + facing +
MP spend in-browser (skips the glide animation for a synchronous result).

**Why:** The old test shipped the entire world (~13k tiles + units) to a stateless
server resolver — slow (20–60s) and it couldn't verify MP (server has no MP
concept). `moveUnit` exercises the client's own movement code and decrements
TurnManager-backed MP, so the test can assert relocation AND MP spend via
`getUnit(id)`.

**Gotcha:** `localMap.movementPoints` is a getter that delegates to
`turnManager.movementPoints` when a TurnManager is wired — so a client move and
`gameDebug.getUnit().mp` read/write the same map. `planMove` reads
`localMap._rangeResult`, which is only valid after selecting the unit and calling
`computeMovementRange()`; `moveUnit` does both first.

**Impact:** New test runs in ~0.7s (was 20–60s). Suite: 22 passed, ~50s total.
`moveUnit` is the recommended primitive for future client-driven gameplay tests.

---

## 2026-06-14 — ⏩ button: instant skip-to-end for AI playback

**Decision:** Repurposed the AI playback ⏩ button from "fast-forward at 1s/step"
to **Skip to End** — it resolves all remaining enemy moves to their final outcome
immediately. Added `AiPlaybackController.skipping` flag + `isSkipping()`;
`waitForNext()` resolves instantly while skipping, `recordSnapshot()` stops
scheduling timed advances, and `main.ts` AI callbacks bypass `playAttackAnimation`
and intermediate `renderMap` when skipping. The final board is drawn once after
the round completes. Removed the `'fastForward'` playback mode and `FF_DELAY`.

**Why:** Stepping through a full enemy round at 1s/action was slow (the e2e
end-turn test took ~96s). Players (and tests) want to jump straight to the result.

**Impact:** Clicking ⏩ during the enemy turn drains the round as fast as the
sequential `/api/combat` calls allow (real outcomes still computed — only the
artificial delays/animations are skipped). e2e end-turn test dropped ~96s → ~15s.
Button id renamed `#ai-pb-ff` → `#ai-pb-skip` (e2e updated). ▶ Play (3s auto-step)
and ⏭/⏮/⏪ are unchanged.

---

## 2026-06-14 — Fixed 3 failing e2e tests + Windows e2e runner

**Decision:** Repaired the three failing Playwright tests in `e2e/gameDebug.test.ts`
and fixed the `npm run e2e` script.

**Why (root causes — each test asserted something that doesn't match the architecture):**
- *move test* asserted `updatedUnits[].mp` decreased, but `/api/combat` is a
  stateless pure resolver: `WireUnit` has no `mp` field — MP lives client-side in
  `TurnManager`. Now it only asserts the server contract (unit relocates to target).
- *end-turn test* waited for the turn to auto-advance, but the AI round is
  player-driven: `aiPlayback.begin()` starts `'paused'` and the loop blocks on
  `waitForNext()` until the player drives `#ai-playback-bar`. Now the test clicks
  `#ai-pb-ff` (fast-forward) and waits for completion.
- *getEventLog test* expected events from prior API/HTTP actions, but
  `emitDebugEvent` only fires from real UI handlers in `main.ts`. Now it asserts a
  `turn-end` event (emitted by the end-turn test) — an intentional, documented
  sequential dependency.

**Why (runner):** `npm run e2e` invoked `node_modules/.bin/playwright` (the bash
shim), which Node can't parse on Windows. Changed to
`node node_modules/@playwright/test/cli.js test` (cross-platform, keeps `--max-old-space-size`).

**Impact:** All 22 e2e tests pass. The end-turn test is slow (~90s) because AI
playback fast-forward steps at 1s/action with no instant-skip; timeouts set to
180s (test) / 160s (wait) for headroom. If client-side move/turn coverage is added
later, MP-decrement belongs in a test that drives a real UI move and reads
`gameDebug.getUnit(id).mp`.

---

## 2026-06-14 — DOM debug instrumentation + window.gameDebug API

**Decision:** Added `client/gameDebug.ts` — dev-only DOM instrumentation for
Playwright and Kiro agent use.  Activation: `?debug=true` URL param (or
`localStorage.setItem('dd-gameDebug', 'on')`).  No-ops at zero cost when inactive.

**Why:** `window.__DD_STATE__.snapshot()` (debugState.ts) is great for headless
snapshots but returns a flat blob with no stable DOM hooks for Playwright selectors.
`window.gameDebug` adds structured DOM sections with `data-testid` attributes and
targeted query methods so agents can inspect precise state without parsing a large
JSON dump. Event log fills the gap between snapshots.

**What's exposed:**
- `window.gameDebug.{getSummary,getState,getSelection,getEntities,getAvailableActions,getEventLog,refreshDebugDom,getUnit,getUnitsByFaction,getCities,selectUnit,centreTile}`
- DOM root: `#game-debug-root [data-testid="game-debug-root"]`
- Sections: `debug-game-summary`, `debug-current-state`, `debug-selection`, `debug-visible-entities`, `debug-available-actions`, `debug-event-log`, `debug-state-json`
- Per-unit elements: `[data-testid="debug-entity"]` with `data-entity-id`, `data-owner-id`, `data-tile-index`, `data-segment`, `data-facing`, `data-health`, `data-max-health`, `data-mp`, `data-acted`
- Events emitted from main.ts: `move`, `attack`, `repair`, `refit`, `sleep`, `turn-end`, `ai-turn-start`, `ai-turn-end`
- Smoke tests: `e2e/gameDebug.test.ts`

**Impact:** `client/gameDebug.ts` (new), `client/main.ts` (import + 8 call sites),
`e2e/gameDebug.test.ts` (new). No gameplay changes. tsc clean, 626 tests pass.

---

## 2026-06-13 — Hex seams were drawn by the seam-eraser over textures

**Decision:** `eraseSameElevationInternalEdges` (terrainRelief.ts) now early-returns
when terrain textures are loaded. `fillTileTexture` expands its clip + bounding box
2px outward (`clipToTile(ft, expandPx)` in terrainContext.ts) so adjacent textures
overlap and cover the antialiased edge.

**Why:** The eraser strokes the *flat base fill colour* along same-elevation edges.
That was correct for the old flat-fill rendering, but it runs *after* textures are
composited — so it painted flat-colour lines (e.g. `plains:hills` `#6b6b6b` grey)
on top of the tan desert texture. Those strokes WERE the visible hex outlines.

**Impact:** Same-elevation land tiles now merge cleanly with no grey seam lines.
True elevation transitions (feathering / contour relief) are untouched. The eraser
still runs as a fallback before textures finish loading.

---
## 2026-06-13 — TerrainRenderer carved into focused helpers (P1)

**Decision:** Split the ~1140-line `client/localMapTerrain.ts` `TerrainRenderer`
into a thin orchestrator plus focused modules: `terrainContext.ts` (shared
state + worldToScreen / neighbour / elevation / clip helpers), `terrainColor.ts`
(pure hex/rgb/mix/hash), `terrainWater.ts` (boundary edges + connected-surface
sheen), `terrainRelief.ts` (seam erasure, feathering, contour/peak/trough
relief, unused `drawElevationShading`), and `terrainFeatures.ts` (forest icons).
The helper classes share one `TerrainContext` instance (canvas ctx, world, view
transform) so no draw pass re-derives them. `localMapTerrain.ts` keeps only
`drawAllTiles`, selection overlays, and the set* accessors, and re-exports
`TerrainTextures` so existing importers are unaffected.  
**Why:** Lets agents edit water/contours/trees without loading the whole file.  
**Why safe:** Method bodies moved verbatim (only `this.X` → `this.c.X` for
context members); rendering output is unchanged. Client tsc clean, 626 tests pass.

**Gotcha / lost + reconstructed work:** The working tree had `client/localMapTerrain.ts`
(and two `- Copy` variants) staged-deleted while `localMap.ts` already imported a
`TerrainTextures` class and called `terrain.setTextures(...)`. That texture
implementation was never committed and is unrecoverable (absent from git HEAD,
reflogs, every dangling/unreachable blob, `dist/`, and the Vite cache). The
renderer was restored from HEAD (no texture code), so terrain textures stopped
rendering — they had to be **reconstructed from scratch**:

- `terrainTextures.ts` now ESM-imports `artifacts/*.webp` (Vite resolves each to a
  served URL — verified `/artifacts/ocean.webp` → HTTP 200 `image/webp`), loads them
  into an image map, and maps a tile→texture key via `keyForTile` mirroring
  `baseTerrainColor` priority (water → mountain → hills(plains uses `HillsPlains.webp`)
  → biome). `load()` resolves even on per-image failure so the first render never blocks.
- `TerrainRenderer.fillTileTexture` clips to the hex polygon and `drawImage`s the
  texture over the solid fill (cities keep faction colour; solid fill is the
  pre-load fallback). Relief/feather/water passes still composite on top.
- `client/vite-env.d.ts` (`/// <reference types="vite/client" />`) supplies the
  `*.webp` module declarations so `tsconfig.client.json` type-checks the imports.
  Main `tsconfig.json` only includes `src/`+`shared/`, so `npm run build` is unaffected.

The texture look is a reconstruction (bbox-stretch cover fit); the exact original
scale/blend is unknown. Verified via `debug:snapshot`: Load OK, 0 errors, assets 200.

**Encoding gotcha:** Restoring a file with PowerShell `git show HEAD:path > file`
writes UTF-16LE+BOM, which breaks Vite/esbuild parsing (`Unexpected "\ufeff"`).
Re-encode to UTF-8 (no BOM) after such a redirect.

---

## 2026-06-13 — Route-function consolidation (P3)

**Decision:** Consolidated `client/movementRoute.ts`. (1) Deleted the unused `computeExtendedCostRoute` (~230 lines, no caller — only barrel-exported) plus its now-orphaned helpers `appendWeaponRangeHops` and `tileBFS`. (2) Extracted the duplicated "BFS outward to the nearest reachable tile" (was inline in `computeContextualAttackRoute` Case 3 and `computeMovementTowardTile`) into `nearestReachableTile(tiles, originTile, reachable, ownTile, maxBFS)`; the two call sites keep their original `maxBFS` (30 vs 40) and post-checks. (3) Extracted the contextual Case-3 straight-line weapon-hop loop into `appendStraightLineWeaponHops`. (4) Single-sourced the offensive-attribute check as `hasWeapon(attributes)` in `shared/rangeCheck.ts`, reused by `weaponRangeFromAttributes`, `isInWeaponRange` (movementRange.ts) and the contextual function.  
**Why:** The five route functions overlapped heavily; most duplication was concentrated in dead code. Removing it and extracting two shared primitives leaves a much smaller surface for future edits.  
**Why safe:** Added `client/__tests__/movementRoute.test.ts` first — 9 characterization tests (structural invariants + golden snapshots) on a unit-sphere hex-grid fixture, covering all live entry points and all three contextual cases. Snapshots were unchanged across every refactor step. Note: the fixture MUST sit on the unit sphere — `rangeCheck.ts` normalizes segment centroids, so a flat plane collapses all distances.  
**Impact:** `computeMovementTowardTile` hardcodes `destSegment 0`, so it returns null when segment 0 of the nearest reachable tile exceeds the MP budget (captured behavior, locked by a test). 626 tests pass.

---

## 2026-06-13 — Refactor housekeeping (P1/P5/P6/P7)

**Decision:** (1) Deleted dead `client/colors - Copy.ts`. (2) Renamed ambiguous entry points: `server/combat.ts`→`combatApi.ts`, `server/generate.ts`→`generateApi.ts`, `src/generate.ts`→`src/generateCli.ts`. (3) Consolidated weapon-range derivation into one `weaponRangeFromAttributes(attributes)` helper in `shared/rangeCheck.ts`; `localMapMovement.ts` now re-exports it and `aiTurn.ts` calls it. (4) Documented the compact wire-format field mapping in `client/worldData.ts` and `src/world/compact.ts`.  
**Why:** Reduce search ambiguity and single-source the has-weapon check so client/server can't drift.  
**Impact:** `weaponRangeFromAttributes` now counts `splashAttack`/`antiAir` as weapons (the old client wrapper only checked `kinetic`/`rangeAttack`) — a correctness fix, slightly widens move-range overlays for splash/AA-only units. No test changes; all 617 pass.

---

## 2026-06-13 — Refit action (RMB menu)

**Decision:** Right-clicking a player's own unit shows a "⚙ Refit" context menu item. Refit opens a modal with the 3D unit designer locked to the unit's chassis. The player redistributes points equal to the unit's current upgrade total (all attributes except the chassis movement key). On confirm: new attributes applied, HP restored to new maxHealth×10, all MP zeroed (unit cannot act this turn). Item is greyed out if the unit has already spent any MP.  
**Why:** Allows loadout changes mid-game for flexibility and testing. Chassis is locked because changing it would fundamentally change the unit. Full-MP gate enforces "initial action only" rule.  
**Impact:** Future plan to gate refit to specific map locations (depot/city tiles). AI refit deferred until location gating is added. No server changes needed — refit is purely client-side attribute mutation.



**Decision:** `SEGMENT_RANGE_PER_POINT` reduced from 1.0 → 0.5; `SEGMENT_RANGE_BASE` raised from 0.5 → 1.0.  
**Why:** Attack ranges felt too large in play. Base raised to 1.0 so range=0 (kinetic/antiAir only) units can still hit adjacent segments (segment distance ≈ 1.0).  
**Impact:** range=5 threshold drops from 5.5 to 3.5 (~3–4 hexes); range=0 can now attack adjacent (previously couldn't). Updated `COMBAT_RULES.md` §3 and constants table. Test for range=0 flipped from `wasValid=false` to `wasValid=true`.

---

## 2026-06-11 — Attack costs 1 MP; one action per turn; any move/attack/rotate sequence allowed

**Decision:** Each unit gets one action per turn (attack OR repair). The action costs 1 MP and
can be taken at any point during the turn — before moving, between moves, or after moving.
Remaining MP after the action can still be spent on movement and rotation.

**Why:** Flexible combined-arms play; the old model that drained all MP on action was wrong.

**Impact:** `TurnManager.recordAttack` and `recordRepair` both mark `actedUnits` (once-per-turn
gate) and deduct exactly 1 MP. `canAct` checks `!actedUnits && MP >= 1`. `mapInput.ts` attack
and repair handlers deduct 1 MP instead of zeroing. Unit label turns red when MP = 0.

---

## 2026-06-10 — Unified client pathfinding: one route function for preview + execution

**Decision:** The on-screen movement line and the actual right-click move now come from a
**single** computation. Added `computeMovementRouteForDestination` + `extractMovePlan` in
`client/localMapMovement.ts` and a `LocalMapView.planMove` method. The hover preview and the
right-click handler both call this one route function, so the line drawn and the move executed
can never diverge.

**Removed the second pathfinder entirely:** deleted `findPathBFS`, `affordableHops`, and
`mpSpentForHops` from `client/localMapGeometry.ts` (and their `MapViewInterface` entries /
`LocalMapView` delegations). These were a tile-level BFS that minimised *hop count* and ignored
terrain cost — a parallel system to the preview's segment-level Dijkstra that minimised *MP cost*.
They disagreed whenever cheapest-cost ≠ fewest-tiles (e.g. tank choosing flat vs hills) and were
the root cause of the recurring "line says one thing, move does another" bug — including the
drone/ocean case below.

**Group movement deprecated.** The right-click handler now moves only the primary selected unit.
This removed the multi-unit `groupHops` / per-unit path loops that complicated unification.
Multi-unit selection still works for facing/rotation (arrow keys).

**Why:** Unifying the cost *function* (`segmentCost`) was not enough — there were still two
different graph *searches*. One route function is the only way to keep them in sync.

**Impact:** Movement line == executed move for all chassis and terrain. Group movement no longer
available. See `client/localMapMovement.ts` (`computeMovementRouteForDestination`, `extractMovePlan`).

## 2026-06-13 — Centralized facing conversions into `client/facing.ts`

**Decision:** Created `client/facing.ts` as the single source of truth for all unit-facing
conversions. Consolidated the previously scattered logic: `facingFromTravel` (the move-facing
calc, extracted from `extractMovePlan`), `rotateHexIndex` (replaces ad-hoc `(x ± n) % 6`),
`screenAngleBetweenTiles` + `screenAngleToSpriteFacing` (moved from `localMapGeometry.ts`,
old names kept as thin deprecated wrappers), and `spriteFacingForRender` (moved from the
private `getCorrectedFacing` in `localMapUnits.ts`).

**Why:** Both recent facing bugs were reference-frame errors — a NeighbourFacing (index into
`tile.neighbours[]`, tile-relative) being confused with a SpriteFacing (fixed screen mapping) or
applied against the wrong tile. The math was spread across four files with raw index arithmetic
in each, so the bug class kept recurring. `facing.ts` documents the three frames explicitly and
gives each conversion a named, single-definition home.

**Impact:** `client/facing.ts` (new), `client/localMapGeometry.ts`, `client/localMapUnits.ts`,
`client/localMapMovement.ts`, `client/mapInput.ts`. Rule: no other file does `.n.indexOf()` or
`(facing ± n) % 6` for facing — route through `facing.ts`. All 617 tests pass.

## 2026-06-13 — Bug fix: unit faces backward after moving

**Bug:** After a cross-hex move, `unit.facing` pointed backward (toward the origin tile) instead of forward.

**Root cause:** `extractMovePlan` computed facing as `tiles[prevTile].n.indexOf(destTile)` — a neighbour index valid for `prevTile`. Once the unit is at `destTile`, that index is interpreted against `destTile`'s neighbour array, which points somewhere completely different (often back toward the origin).

**Fix:** Changed `extractMovePlan` to find which of `destTile`'s neighbours is most aligned with the travel direction (`prevTile → destTile`) using 3D dot products. This gives a neighbour index valid for `destTile`, which is what `unit.facing` must be (since `getFacingAngle` looks up `tile.neighbours[facing]` using the unit's **current** tile).

**Also fixed:** The fallback in `mapInput.ts` for intra-hex moves was `v.angleToFacing(travelAngle)` (a screen-sprite index, wrong type for `unit.facing`). Changed to `unit.facing` (keep current facing unchanged), which is correct — intra-hex repositions don't change which direction the unit is pointing.

**Impact:** `client/localMapMovement.ts` (`extractMovePlan`), `client/mapInput.ts`.



**Decision:** `findPathBFS` in `client/localMapGeometry.ts` unconditionally blocked ocean tiles,
so drones (flight mode) were navigated around ocean even though the hover path preview
(which uses `segmentCost`) correctly showed a direct route over water.

**Fix:** `findPathBFS` now accepts an optional `mode: MovementMode` parameter (defaults to
`'wheeled'`). Ocean tiles are only skipped when `mode !== 'flight'`. `LocalMapView.findPathBFS`
resolves the mode from the currently selected unit before delegating.

**Why:** The preview uses `computeMovementRange` / `computeExtendedCostRoute` which call
`segmentCost` (returns 0.25 for flight over ocean), but the actual movement on RMB called
`findPathBFS` which had a hardcoded ocean skip — mismatch between display and execution.

**Impact:** Drones can now fly directly over ocean on RMB confirm, matching the path preview.
The "cannot end turn on ocean" restriction (documented in COMBAT_RULES.md) is still not enforced
at the turn-state level — that remains a known gap.

## 2026-06-10 — Fixed KI-1: unified movement on the segment-step model + rotation fee

**Decision:** Movement is now a single model everywhere: a move is a count of
segment steps, each costing `segmentCost(destTile, mode)` (destination terrain ×
chassis), with **no separate hex-entry cost**. Deleted the server's competing
distance×terrain model (`segmentMoveCost`, `getTerrainMultiplier`,
`TERRAIN_MULTIPLIER_*`, `pathSegmentMovementCost`) from `src/world/movement.ts`;
`moveUnit` now charges `segmentCost` directly — the same function the client and
AI already use (`shared/movementConstants.ts`).

Rotation is now a separate, explicit cost: changing **facing** costs a flat
`ROTATION_FEE = 0.25` (terrain-independent), charged **once per unit per turn**.
After the fee is paid, all further facing changes that turn are free (so players
can correct orientation mistakes for free). Changing which **segment** a unit
occupies is movement, not rotation, and is still charged per segment step.
Moving no longer locks rotation — move and rotate interleave freely while MP
remains (removed the old "hasMoved locks pivot" rule in `turnState.ts`).

**Why:** The client/AI (step-cost) and server (distance×terrain) disagreed by up
to ~5× on how far a unit could go, the clearest source of "looks wrong on screen"
(KI-1). The user chose the step-count model and added an explicit rotation fee.
**Impact:** `ROTATION_FEE` added to `shared/movementConstants.ts`. `turnState.ts`
record gains `hasRotated`; `pivotCost`/`canPivot`/`recordPivot` reworked. Client
charges the fee in `mapInput.ts` (tracked via `rotatedUnits` on `turnManager.ts`
/ `localMap.ts`). Server `segmentCost`/`pivotStepCost` are terrain-aware for the
inter-hex path; the server-side intra-hex reposition still uses the flat
`pivotStepCost` per chassis (no tile context in `turnState`) — a documented
approximation, since the runtime authority for what's shown is the client.
Also deleted a stray unreferenced `client/localMap - Copy.ts` backup that broke
the client typecheck. See `COMBAT_RULES.md` §21.

## 2026-06-10 — Fixed KI-2: server combat now honours elevation

**Decision:** The combat wire format now carries tile elevation. Added `elev` to
the client's `minimalTile` (`combatPanel.ts`), to `WireTile` (`server/combat.ts`),
and `rebuildTiles` now sets `elevationType` from it (defaulting to `flat`).
**Why:** `rebuildTiles` previously dropped `elevationType`, so server-resolved
combat always saw `delta = 0` and the elevation multiplier was always 1.0 —
COMBAT_RULES §13 was dead on the server path. The src/world combat tests build
full `Tile` objects directly, so the wire-layer drop was invisible to them.
**Impact:** Uphill attackers now deal up to +30%, downhill up to −30% (clamped
[0.70, 1.30]); drones unaffected. The combat preview already surfaced this via the
"⛰ Elevation" step — it now shows real values. Regression guard added at the wire
boundary: `server/__tests__/combat.test.ts`.

## 2026-06-10 — Established decision log + headless debug snapshot

**Decision:** Added this log, a `docs-as-we-go` steering rule, and a
`npm run debug:snapshot` harness that captures game state/console/errors/screenshot
to `artifacts/sessions/<timestamp>/`.
**Why:** Agents were stuck in guessing loops, burning tokens, and depended on the
user to relay screenshots. Now an agent can read the running game's actual state.
**Impact:** New files: `client/debugState.ts`, `scripts/debug-snapshot.mjs`,
`window.__DD_STATE__` exposed in `client/main.ts`.

## 2026-06-10 — Removed abandoned `- Copy` files

**Decision:** Deleted `client/combatAnimations - Copy.ts`,
`client/localMapTerrain - Copy.ts`, `client/localMapTerrain - Copy (2).ts`.
**Why:** Unused editor backups (not imported anywhere). They confused agents into
editing the wrong file.
**Impact:** None functional — recoverable via git if needed.

---

## 2026-06-14 — Fix: AI fires invalid attacks due to BFS/segment-distance mismatch

**Bug:** On every enemy turn, several AI attacks landed in the combat history as
`✗ Invalid — Out of range`. The server correctly rejected them; no phantom damage
occurred, but the log was polluted.

**Root cause:** `aiTurn.ts` gated attacks with `bfsDistance(unit, enemy) <= ceil(rangeThreshold)`.
`Math.ceil` is deliberately conservative for range-overlay drawing — it rounds 3.5 up to 4,
meaning the AI thought it was in range at 4 hops while the server threshold is 3.5 (Rng 5).
A target 4 hops away can have a segment distance > 3.5, so the server rejected the attack.

**Fix:** `aiTurn.ts` now calls `isTargetInRange` from `shared/rangeCheck.ts` (same function the
server uses) as a final confirmation before both attack gates (attack without moving, and
attack after moving). BFS hop count is kept as a cheap movement-target heuristic but no longer
gates the actual attack commit.

**Impact:** AI attacks that would be rejected as out-of-range are now silently skipped rather
than sent to the server. The invalid entries no longer appear in the combat log.

---

These are real drift bugs found 2026-06-10. They change game balance, so they
await a decision before fixing.

### KI-1 — Two competing movement cost models  ✅ FIXED 2026-06-10
- ~~`shared/movementConstants.ts` step-cost (client/AI) vs `src/world/movement.ts`
  distance×terrain (`segmentMoveCost`)~~ — resolved by deleting the server's
  distance×terrain model and charging the shared `segmentCost` everywhere, plus a
  flat once-per-turn rotation fee. See the dated entry above.

### KI-2 — Server combat ignores elevation  ✅ FIXED 2026-06-10
- ~~`server/combat.ts` `rebuildTiles` never sets `elevationType`~~ — fixed by
  carrying `elev` through the wire format. See the dated entry above.
