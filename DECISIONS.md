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

## 2026-06-15 — First-person view shows a 3D missile/explosion on attacks

**Decision:** `FirstPersonView.playAttackAnimation(...)` now renders a 3D combat
animation — a glowing faction-coloured missile that arcs (parabolic lob, height
scales with distance) from attacker to target with an additive contrail, then an
expanding white-hot core + faction-tinted fireball at the target and each splash
victim. Timings (`MISSILE_DURATION` 520ms, `EXPLOSION_DURATION` 680ms) and the
`scale = min(2.8, 0.6 + damage/18)` blast sizing are copied from
`combatAnimations.ts` so map and first-person attacks feel identical. `main.ts`
fires it in parallel with `localMap.playAttackAnimation` (player + AI paths)
whenever `firstPerson.isActive`.
**Why:** The 2D map's combat animation is a Canvas-2D particle system drawn on the
map canvas, which the WebGL first-person overlay hides — so FP attacks had no
visual feedback. The 2D particle code can't be drawn into a THREE scene, so FP
needs its own equivalent.
**Impact:** Effects are ticked from the FP render loop via an `ActiveEffect` list
and self-dispose (geometry+material) on finish/close, so no leaks across turns.
Faction-colour ground rings (also added this session) sit under every unit; the
missile aims at unit mid-body via `unitWorldPos`. Drone muzzles/impacts use the
same `DRONE_AIR_HEIGHT` hover as the models.

---

## 2026-06-15 — Mountain ranges are continuous ridges; rivers are single-hex

**Decision:** Reworked `growMountainRanges` in `src/world/generate.ts` to build one
meandering **centreline** per range (~60 hexes long via `SPINE_LEN_MIN/MAX`), widened
into a band a few hexes across (`BAND_HALF_MAX`, smoothly-varying half-width), with a
few short **lateral** spurs (`SPUR_COUNT/LEN`). Rivers no longer widen near the coast —
the estuary-widening pass was removed so every river is exactly one hex wide.
**Why:** The old generator picked a continent-spanning spine (190–340 steps) plus 6–13
long radiating spurs, producing a round white blob with spider-leg fingers instead of a
ridge. The user wants a continuous range that builds up from foothills, with spurs
forking to the *sides*, and single-hex rivers arcing to the sea.
**How (key changes):**
- `traceSpine` now walks a fixed `targetLen` along a tectonic axis with a travelling-sine
  wobble (no continent-far target), normalising scores by local hop size so it stays
  scale-independent and never doubles back.
- `widenBand` does a multi-source BFS from the centreline, including tiles within the
  nearest centreline tile's half-width plus a sparse ragged fringe.
- `growSpur` heads perpendicular to the ridge (off to one side), short (7–16 hexes).
- Gradual buildup still comes from the existing `APRON` height ramp (mountain → hills →
  rolling) around the mountain set.
- `ESTUARY_REACH` is now `@deprecated` (kept as an `export *` barrel symbol).
**Impact:** Verified on the live world (seed 817587): the three largest ranges are 63/66/60
hexes long and ~5 wide, as continuous single components; ~2.1k mountain + ~2.1k hills tiles.
Rivers (940 tiles) are single-hex chains from a mountain source to the sea. Mountain/river
*counts* shift per seed, so any test asserting exact terrain counts may need updating.


## 2026-06-15 — River levelling no longer flattens whole rivers to sea level

**Decision:** Rivers now keep a descending elevation from source to mouth, in both
the generated data and the rendered terrain.
**Why (two root causes):**
1. *Generation* — the consistency pass in `generateRivers` (`src/world/generate.ts`)
   took the min height over *all* neighbours, including the connected channel. The
   mouth is 0 (touches ocean), so each pass propagated 0 one hop upstream, flattening
   the lowest ~10 hexes of every river. Fixed by levelling against bank (non-river)
   neighbours only.
2. *Rendering (the visible cause)* — river hexes share `terrainType === 'ocean'`
   (with `rv` set). `terrainContext.elevationHeight`, `firstPersonView.elevationWorldHeight`,
   and `detailPanel` all clamped any ocean/water tile to fixed sea level, ignoring
   `tile.h`. So even correct river heights rendered flat. Fixed by treating only
   *open ocean* (`terrain === 'ocean' && rv === undefined`) as sea level; river tiles
   now use their own `tileHeight`.
**Impact:** Rivers descend with the valley (verified: river-tile heights span 0–6, not
all 0). Open ocean still renders at the fixed sea-level floor. Estuary/mouth tiles sit
near 0, blending into the sea.

## 2026-06-15 — First-person view can command units (move/attack/repair)

**Decision:** First-person view is no longer read-only. With a command context wired
(`FirstPersonView.setCommandContext`, set in `main.ts`), left-click selects an own-faction
unit and shows its movement range as 3D hex fills, hover previews the route line, and
right-click issues move / attack / repair — mirroring the 2D map's `mapInput.onRightClick`
priority (attack → repair → move).
**Why:** The strategic map is for the player faction; first-person is for tactical battles —
so battles need to be playable there, not just viewable.
**How (reuse, not duplication):** All pathing is the existing pure logic
(`computeMovementRange`, `computeMovementRouteForDestination`, `extractMovePlan`,
`isInWeaponRange`) from `localMapMovement.ts`. Both views share the same `TurnManager`
(MP/acted state) and the same `onAttack`/`onRepair` handlers (extracted to named
`handlePlayerAttack`/`handlePlayerRepair` in `main.ts`). 3D picking raycasts the terrain
top meshes, inverts the tangent-plane projection to flat coords, then point-in-poly +
barycentric segment test. After an async attack/repair resolves, `main` calls
`firstPerson.refresh()` to rebuild models/overlays.
**Gotcha:** `firstPerson.world` is private and the live world reference; it's restored on
every open via `setWorld` before `open`. Overlay geometries/materials are tracked and
disposed on rebuild (not deferred to close) to avoid leaks across repeated commands.
**Impact:** `firstPersonView.ts` header comment updated (was "purely visual, read-only").
Deferred for now: rotation, sleep, refit, and the right-click context menu.

## 2026-06-15 — First-person: rotation + context menu (rotate/sleep/refit)

**Decision:** Completed the deferred first-person commands. Arrow keys ←/→ rotate the
selected unit's facing (charging the once-per-turn `ROTATION_FEE` via the shared
TurnManager), Shift+←/→ shifts it to the adjacent hex segment (free). Right-clicking the
selected unit's own segment opens the shared `UnitContextMenu` (Rotate L/R, Refit, Sleep);
the "View" item is suppressed since we're already in first-person.
**Why:** Full command parity with the 2D map so a battle can be played entirely from the
first-person view.
**How (reuse):** Sleep/refit reuse the same `main.ts` handlers as the map, extracted to
named `handlePlayerSleep`/`handlePlayerRefit` and passed to first-person via
`FpCommandContext.onSleep`/`onRefit`. The context menu is the existing `UnitContextMenu`
driven through a thin host adapter. `chargeRotation` mirrors `MapInputHandler.chargeRotation`.
**Gotcha:** Esc must close an open context menu without exiting the view — `onKeyDown`
guards on `contextMenuOpen` so the menu's own Esc handler wins. Refit is gated on full MP
(`currentMP >= maxMovement`), so it greys out once a unit has moved/rotated — same rule as
the map.
**Impact:** Header comment updated again; nothing left deferred from the original plan.

---

## 2026-06-15 — World-gen consolidated into a single file

**Decision:** Merged `goldberg.ts`, `terrain.ts`, `rivers.ts`, and `cities.ts`
into `src/world/generate.ts` (now sectioned: PRNG → Goldberg → Terrain → Rivers
→ Cities → `generateWorld`). The four source files were deleted.
**Why:** Requested all generation logic in one place. `mulberry32` (shared by
terrain/rivers/cities) now lives once at the top instead of being cross-imported.
**Impact:** Public API unchanged — every prior export (`generateWorld`,
`FREQUENCY`, `generateTerrain`, `mulberry32`, `generateGeodesicSphere`,
`computeDual`, `DualTile`, `TileTerrainData`, `generateRivers`, `RIVER_DENSITY`,
`SOURCE_HEIGHT`, `ESTUARY_REACH`, `MAX_RIVER_LEN`, `placeCities`, `CITY_COUNT`)
is re-exported from `generate.ts`. Importers updated: `index.ts` barrel,
`validate.ts`, `server/generateApi.ts`, and `__tests__/terrain.test.ts`.
tsc clean, 643 tests pass. ARCHITECTURE.md module map may reference the old
file names.

---

## 2026-06-15 — Strategic map shows ~50% more hexes

**Decision:** Bumped the strategic map BFS hop radius (`LocalMap.radius`) from 10 to 12.
**Why:** Requested a 50% increase in hexes shown. Visible hex count is area-based
(`1 + 3r(r+1)`), not linear in radius — r10→331 hexes, r12→469 (≈+42%, the closest
integer to a true +50%; r13 would be +65%).
**Impact:** Wider strategic view; slightly more tiles to project/render per recenter.

---

## 2026-06-15 — Single sweeping mountain range; flat deserts; peaky relief

**Decision:** Reworked mountain generation and globe rendering.

`src/world/terrain.ts`:
- **One thin sweeping range on the largest continent.** `growMountainRanges`
  computes connected land components, seeds the range on the biggest one, and
  grows it by extending from its *tips* (weight `1/(mc⁴+1)` strongly favours
  tiles with few mountain neighbours → elongated band, not a blob). Coverage is
  a fraction of the host continent (`MOUNTAIN_COVERAGE = 0.035`), so the range
  fills ~10% of the continent once the hills/rolling foothill buffers are added,
  instead of a fixed tile count that swallowed the whole landmass.
- **Mountain height 8–11 from high-frequency `peakNoise`** (freq 28·noiseScale)
  so summits and saddles differ within the range.
- **Flat deserts.** Desert elevation is always `flat` and wins the elevation
  priority chain (no desert:hills/rolling/mountain).

`client/globe.ts` — the globe is **unlit flat-shaded**, so the previous
`ELEVATION_SCALE` (one radial push per 4-way band) made every mountain a
flat-topped white plateau. Now:
- Radial push is driven by discrete `height` (0–11), quadratic curve, `MAX_PUSH
  = 0.06` → calm lowlands, dramatic peaks. Cliffs render between any height step
  above `CLIFF_EPS`.
- Mountain colour is a **rock→snow gradient by height** (`mountainColorRGB`):
  grey shoulders (h=8) grading to white summits (h=11). Without lighting, the
  colour gradient is what makes peaks read as peaks.

**Why:** Requested — a single range sweeping across the continent (~10%) with
real snowy peaks, not a flat-topped white mass; deserts flat.

**Gotcha for future agents:** The globe top faces use `MeshBasicMaterial`
(unlit). Height/elevation differences alone are *invisible* without either a
colour gradient or cliff walls — don't expect bare extrusion to look 3D.

**Impact:** Regenerated `data/world.json` (mountains ≈1830 tiles, all on one
continent). Verified via headless snapshot + globe inspection. All 643 tests
pass.



## 2026-06-15 — First-person view is now a free-fly camera

**Decision:** Replaced the orbit-style controls in `client/firstPersonView.ts`
with a free-flying camera (state = `camPos` + `yaw`/`pitch`, no anchor/boom):
- **Drag** pans the eye across the battlefield in its own screen plane
  (grab-the-world; pan speed scales with altitude via `PAN_FACTOR`).
- **Ctrl+drag** looks around in place (yaw/pitch only, no movement).
- **Wheel** dollies forward/back along the view direction (`BOOM_STEP`/notch).
- The eye is clamped to the field borders (`±FIELD_EXTENT`, y ∈ [0.5, `BOOM_MAX`])
  via `clampPos()`.

**Why:** Requested — a free-fly camera is more useful for inspecting the
battlefield than the previous anchored look-around.

**Impact:** `getDiagnostics()` no longer returns `boom` (returns x/y/z/yaw/pitch).
Removed `BOOM_LIFT`; added `WORLD_UP` and `PAN_FACTOR`. Camera starts pulled back
behind/above the selected unit so it's in frame.

---

## 2026-06-15 — Steep-border outline marks impassable-to-ground borders

**Decision:** The local map draws a solid dark-brown line
(`TerrainRelief.drawSteepBorderLines` / `drawSteepBorderLine`) along the hex
boundary on the *high* side of any border whose raw 0–11 height step is too
steep for ground chassis, on top of the existing continuous relief shading. Two
tiers, keyed to the movement climb limits and conveyed by line weight: thin line
for `drop > MAX_CLIMB_WHEELED` (4+, tanks blocked), thick line for
`drop > MAX_CLIMB_LIMB` (9+, tanks+spiders blocked, drones only).

**Why:** Proportional shading is continuous, so you couldn't read the gameplay
breakpoints (a 3 vs a 4, an 8 vs a 9). The outline is an explicit cue at exactly
those thresholds. (Earlier tried cliff hatching/ticks — looked like ladder
rungs — replaced with the boundary line.)

**Impact:** Pure client render addition in `client/terrainRelief.ts`, drawn as
the last pass in `drawContourRelief`. The line is clipped to the high tile and
nudged inward by half its width so it hugs the boundary on the high side. Each
steep edge is drawn once (from the higher tile only). No data/format changes.
Refresh browser to see it.

## 2026-06-15 — First-person units conform to the tilted terrain surface

**Decision:** In `client/firstPersonView.ts`, units are now placed on the
*actual* rendered surface, not the flat plateau height. The terrain top is drawn
as a triangle fan whose boundary vertices are lifted to a shared,
neighbour-averaged height (so adjacent hexes tilt to meet). Unit placement now
samples that same surface at the unit's footprint (`sampleSurface`) for both
**height** (barycentric-interpolated) and **upward normal**, then orients the
model with `orientToSurface` so its +Y aligns with the slope normal and -Z to
its facing. The camera anchor and selection ring use the sampled height too.

**Why:** Units were positioned at `elevationWorldHeight(tile)` (the discrete
plateau height) and rotated by yaw only, so on any slope they floated above or
sank into the surface and stood bolt-upright instead of lying flush.

**Impact:**
- The neighbour-averaged vertex-height map was extracted from `buildEnvironment`
  into `buildVertexHeight()` so both the terrain mesh and unit placement share
  one source of truth — they must stay in sync or units will float again.
- Ground units tilt to the surface normal; **drones stay level** (up = world up)
  and hover `DRONE_AIR_HEIGHT` above the sampled ground.
- `groundLift` is applied along the surface normal so a tilted unit's base
  doesn't dig a corner into the slope.

---

## 2026-06-14 — Rivers impassable + engineer attribute builds bridges

**Decision:** Rivers are now the **same terrain type as ocean** (`terrainType =
'ocean'`, `elev flat`, `height 0`), so they are impassable to ground units;
drones fly over. The `riverTo`/`rv` marker is preserved so they still render as
river-blue. Added a new `engineer` unit attribute (0–5) to `UnitAttributes`. An
engineer (≥1) with an available action builds a **bridge** over an adjacent
river hex (keyboard **B**), making that hex passable.

- Bridges are a runtime per-tile flag (`TileData.bridge`); `segmentCost` treats a
  bridged tile as passable flat land and **bypasses the steepness gate** when
  stepping onto/off a bridge (a river sits at sea level but its banks may be
  high). See `shared/movementConstants.ts`.
- Persistence: bridges are stored in the compact save as `bridges: number[]`
  (tile indices) and re-applied after tiles regenerate from seed
  (`client/worldData.ts` getCompactSave / expandCompactSave). Combat returns
  units only and never replaces tiles, so the runtime flag survives combat.
- Building costs the unit's once-per-turn action + 1 MP (`recordBuildBridge`,
  mirrors repair). Bridge renders as a brown deck (`BRIDGE_COLOR`); the detail
  panel shows "Bridge (river crossing)" and an Engineer attribute row.

**Why:** The previous river entry was visual-only; the user wanted rivers to
actually block movement and an engineer mechanic to cross them.

**Impact:** `ATTRIBUTE_RANGES` now has 12 keys (test updated). Every city-spawn
gets one engineer (`spawn.ts`); the 20v20 scenario gives each side 2 engineers.
Refit can allocate engineer points. Supersedes the "visual only" note in the
earlier rivers entry. Engineers/bridges are not yet used by the AI.

---

## 2026-06-14 — Rivers (mountain→sea) + height readout in detail panel

**Decision:** Added rivers as a generated per-tile attribute. `src/world/rivers.ts`
(`generateRivers`) seeds on mountain-height tiles (`height ≥ SOURCE_HEIGHT`) and
routes to the coast by **distance-to-nearest-ocean** (multi-source BFS), stepping
to the closest-to-sea neighbour (tie-broken by lowest height). This *guarantees*
every river reaches the sea — steepest-descent alone could dead-end in a basin.
Rivers are **whole hexes of water**: a river tile is marked by `Tile.riverTo` (wire
field `rv`) and renders as water (`RIVER_COLOR`, `isWaterTile` true) on both the
globe (`tileColorRGB`) and local map (`baseTerrainColor` + water passes). When a
river meets another it stops (they join); near the coast (`oceanDist ≤
ESTUARY_REACH`) the channel is widened by one hex so mouths form ~2-hex estuaries.
The detail panel shows `Height n/11` for the selected tile and a `River` tag.

**Why:** Earth-like worlds want rivers that actually reach the sea and read as
real waterways, not thin lines; height was invisible in the UI.

**Impact:** Deterministic from seed (rivers regenerate with tiles via
`/api/world-tiles`, so they appear in bundled scenarios too). ~500 river tiles on
the current world. Tunables live in `rivers.ts` (`RIVER_DENSITY`, `SOURCE_HEIGHT`,
`ESTUARY_REACH`, `MAX_RIVER_LEN`). Rivers don't yet affect movement or combat —
visual only (they render as water, so movement code that keys off `terrain`/`elev`
still sees the underlying land type).

---

## 2026-06-14 — Earth-like land/ocean balance (continents on a mostly-ocean globe)

**Decision:** Reworked Step 1 of `src/world/terrain.ts` so the globe forms like
Earth: a low-frequency continental noise field ranks tiles, and the highest
`LAND_FRACTION = 0.30` become land while the rest become ocean (~70%). Mountains
and deserts now only seed/grow on land tiles (`isLandMap` passed into
`growMountainRanges` / `growDesertPatches` and their hills/rolling buffers), and
desert noise gets a subtropical latitude boost (peak at |y|≈0.5, ~±30°) so
deserts cluster where Earth's great deserts sit.

**Why:** The old generator made the globe ~96% land with tiny seas (ocean target
≈3.9%) — the inverse of Earth. Land is now gathered into a few large continents
with natural coastlines.

**Impact:** Regenerated `data/world.json` (G100) is now ~69% ocean (68,756 /
100,002 tiles), land ~31%. All 12 cities still place (city placement already
searches for nearest non-ocean tile) and world validation passes. Rank-based
land selection guarantees the exact land fraction even on tiny test meshes, so
polar-cap/ocean-buffer tests are unaffected. Tune `LAND_FRACTION` to taste.

---

## 2026-06-14 — Bigger globe (G100) + scale-aware terrain + tiny first-person units

**Decision:** Three coordinated changes to push back on the "asteroid-scale"
feel of the realistic first-person view:
1. **Globe size:** `FREQUENCY` 36 → **100** in `src/world/generate.ts`
   → 100,002 tiles (was 12,962). Lifted the hard 65,535-tile wall in
   `client/globe.ts` (`tileIdByFace` `Uint16Array` → `Uint32Array`). Made
   `validate.ts` tile-count checks frequency-independent (asserts `T = 10·F²+2`).
2. **Scale-aware terrain** (`terrain.ts`): feature sizes now derive from tile
   density (`densityScale = √((T-2)/10)/36`). Ocean/mountain/desert *targets*
   scale with tile count (proportions preserved); polar bands scale with
   `max(1, densityScale)`; mountain chains & desert blobs grow by
   `featureScale = densityScale·PATCH_BOOST` (PATCH_BOOST=1.6) and noise
   frequencies drop by `1/PATCH_BOOST` → fewer, larger sweeping landforms.
3. **First-person units ×10 smaller** (`firstPersonView.ts`):
   `UNIT_HEX_FRACTION = 0.055` (was 0.55). Selection ring decoupled to a
   hex-relative `SELECT_RING_RADIUS` so the tiny unit stays findable; drone
   hover `DRONE_AIR_HEIGHT` reduced 1.6→0.5 hex-radii for coherence.

**Why:** At 20 m/hex the old globe implied a ~1.2 km asteroid with
football-field "mountains". The √ relationship means tile count alone can't make
it planetary, but combining a bigger globe (~3.8 km from tiles) with 10×-smaller
units (hex now reads as hundreds of metres of ground holding a spread-out
formation) makes terrain feel vast. This is an experiment, not a final answer to
the hex-scale question.

**Impact:** `world.json` ~4 MB → ~30 MB; runtime regen ~3 s, globe mesh build
~320 ms, 0 load errors at 100k tiles. Practical ceiling ~130k tiles before JSON
parse hurts; beyond that needs a binary format + raycast BVH. Tunable knobs:
`FREQUENCY`, `PATCH_BOOST`, `UNIT_HEX_FRACTION`. **Known issue (unaddressed):**
units still placed at the flat per-tile height, not the averaged/tilted surface,
so float/sink near slopes — now *more* visible with smaller units. Fix is to
sample the interpolated segment-centroid surface height.

---

## 2026-06-14 — 12-level elevation height + steepness-gated movement

**Decision:** Elevation is now a discrete height `0–11` (`HEIGHT_LEVELS`) on each
tile (`Tile.height`, wire field `h`). The old 4-way `elevationType`
(`flat/rolling/hills/mountain`) is kept as a **derived band** over that height
(0–2/3–5/6–8/9–11, see `heightToBand`) and still drives textures, terrain
classification, and the combat elevation-advantage multiplier — so combat
balance is unchanged. Generation derives height from the existing elevation
noise: band base + a 0–2 within-band offset from normalised noise
(`bandHeight` in `terrain.ts`). Ocean is height 0.

Movement is no longer blocked by absolute elevation. Mountains are passable.
Instead `segmentCost(toTile, mode, fromTile?)` applies a **steepness gate**: a
border step whose `|height delta|` exceeds the chassis climb limit is `Infinity`.
Limits: wheeled `MAX_CLIMB_WHEELED = 3`, limb `MAX_CLIMB_LIMB = 8`, flight
ignores steepness. Ocean still blocks ground units per-cell. This is why every
cost call now threads the origin tile.

Rendering: the globe map keeps flat hexes, but cliff-shadow strength in
`terrainRelief.drawContourEdgeRelief` now scales with the true 0–11 height drop
(`TerrainContext.height12`) rather than the 4-way band difference, so taller
cliffs cast deeper shadows. The first-person view builds a **continuous** mesh:
each shared boundary vertex is lifted to the neighbour-averaged height, so hex
tops tilt to meet each other and steepness reads as slope (no more flat
plateaus). `elevationWorldHeight` is now `height/11 × scale`.

**Why:** Requested change — finer terrain, high ground reachable via ramps but
walled off by cliffs, and a smooth 3D landscape.

**Impact:** `segmentCost` signature gained an optional `fromTile`; all callers
(`movement.ts`, `aiTurn.ts`, `movementRange.ts`, `movementRoute.ts`) pass it.
`isImpassable` is now ocean-only. Tests that asserted "mountain is impassable"
were updated to the steepness model. Within-band height steps (e.g. flat h0 vs
flat h2) don't currently get globe relief — only band-transition edges do; the
3D view shows them as gentle tilts. Height/band helpers live in
`shared/movementConstants.ts` (`tileHeight`, `bandToHeight`, `heightToBand`,
`HEIGHT_LEVELS`).

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
