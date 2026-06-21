# Decision Log

Append-only record of design decisions, gotchas, and known issues. The game's
rules are invented as we go — this log is how that intent survives across
sessions so agents stop re-discovering (or re-breaking) the same things.

## 2026-06-21 — EW is a radius-based anti-drone screen

**Decision:** Electronic Warfare (`defence`) is no longer same-hex stacking with
a per-weapon-mode multiplier. A unit's `defence` value is the **radius** (in
tile hops) of an anti-drone screen. Each friendly source (including the
defender) contributes `max(0, defence − hopDistance)` to a defender, additive
across overlapping screens with **no cap**. EW **only mitigates damage from
drone attackers** — zero against tank/spider fire. The old
`EW_EFFECTIVENESS_DIRECT/SPLASH/ANTIAIR` table is removed.

**Why:** Makes EW a meaningful area-denial screen against the drone threat and
removes the per-mode complexity. Pairs with drones being the adjacent
bomb/collision attacker.

**Impact:**
- `combat.ts`: `getEWDefense` → `getEWProtection(target, allUnits, tiles)` (BFS radius sum);
  `getDefencePower(..., attackerIsDrone)` gates EW on a drone attacker; all call
  sites pass `isDrone(attacker)`. Added `MAX_EW_RADIUS = 5`.
- `combatFormula.ts`: removed `EW_EFFECTIVENESS_*` + `ewEffectiveness`.
- Explainer/detailPanel: defence display now shows a single radius anti-drone EW
  (applies only vs drone attackers). `CombatBreakdown.defEWMultiplier` is now 1
  (drone attacker) or 0.
- EW sources are **units only** for now — buildings carry `defence` but are not
  yet threaded into combat resolution (the combat API takes units+tiles only).
  Follow-up if building EW should contribute.
- Tests: `getEWDefense` tests replaced with `getEWProtection` radius tests.
- COMBAT_RULES §5/§12 + constants/appendix updated. Checkpoint before this work: `31e5b28`.
- tsc clean, 348 tests pass.

## 2026-06-21 — Drones lose rangeAttack; hard-locked to range 1

**Decision:** Drones (flight chassis) have no `rangeAttack` concept and attack
adjacent only. Their attack reach is hard-locked to `SEGMENT_RANGE_BASE` (range 1)
for all weapon modes (direct/splash/anti-air), simulating that they drop bombs or
collide with adjacent targets.

**Why:** Fits the drone fantasy and removes a degenerate "sniper drone" loadout;
pairs with EW becoming an anti-drone screen (next step).

**Impact:**
- `combat.ts` `getSegmentRangeThreshold`: returns `SEGMENT_RANGE_BASE` for drones
  regardless of any `rangeAttack` (defensive lock; the explainer's range step uses this too).
- `validateAttributes`: a drone with `rangeAttack > 0` is now invalid.
- Refit modal: the `rangeAttack` slider is hidden for a flight chassis.
- Battle generator excludes `rangeAttack` from drone loadouts; `battle-20v20.json`
  regenerated (14 drones, 0 with rangeAttack).
- Elevation range multiplier already skips drones (airborne).
- COMBAT_RULES §3 attribute table + constraints updated. Checkpoint before this work: `754224c`.
- tsc clean, 347 tests pass.

## 2026-06-21 — Elevation moved from damage to range

**Decision:** Relative elevation no longer modifies damage. It now scales the
attack-RANGE threshold: a unit on higher ground shoots farther, lower ground
shorter. `rangeMultiplier = clamp(1 + (attackerLevel − defenderLevel) × (0.5/3),
0.5, 1.5)` — max delta 3 gives ×1.5 (uphill) / ×0.5 (downhill). Applies to the
unified attack-reach gate (direct/splash/AA). No effect when either combatant is
a drone (airborne).

**Why:** Height advantage realistically extends weapon reach/line-of-sight more
than it boosts hit damage, and it pairs better with the upcoming drone/EW rules.

**Impact:**
- `combatFormula.ts`: removed `elevationDamageMultiplier`, `ELEVATION_MULTIPLIER_PER_LEVEL`,
  and the elevation step from `computeDamage`; dropped elevation fields from `DamageInput`/`DamageBreakdown`.
- `shared/rangeCheck.ts`: added `ELEVATION_RANGE_PER_LEVEL`, `elevationLevel`,
  `elevationRangeMultiplier`; `isTargetInRange` takes an optional `elevationMultiplier` (default 1).
- `combat.ts` `resolveAttack`: range gate now multiplies the threshold by the elevation range multiplier.
- `combatExplainer.ts`: Range Check step shows the elevation-adjusted threshold; the elevation
  *damage* step is removed. `CombatBreakdown.elevationMultiplier` now means the range multiplier.
- detailPanel relabelled "Elevation (range)".
- **Known follow-up:** the client in-range *highlight* overlay still uses base range
  (the shared `isTargetInRange` default). The authoritative server gate and the attack
  preview both account for elevation, so the player sees the truth on hover.
- COMBAT_RULES §13 + constants table updated. Checkpoint before this work: `cfb31f1`.
- tsc clean, 347 tests pass.

## 2026-06-21 — `maxHealth` renamed to `size`; size is a locked ceiling

**Decision:** The `maxHealth` unit attribute is renamed to `size` (1–5). Size is
**chosen at creation and cannot be refitted** (chassis was already locked). HP
still scales as `size × HP_PER_POINT` (10–50). Size now acts as a **ceiling** on
`kinetic`, `splashAttack`, `antiAir`, `armour`, `defence` (EW), and `repair` —
these may not exceed `size`. `rangeAttack`, movement, and `engineer` are exempt.
Size costs 1 point per size in the point-buy budget.

**Why:** Health-as-an-upgrade was unrealistic and decoupled from frame size. A
single Size dial that also gates how much weaponry/armour a frame can carry is
more intuitive ("can't bolt a range-5 kinetic-5 gun onto a size-1 drone") and
simplifies the model ahead of the remaining combat-rules changes.

**Impact:**
- `UnitAttributes.maxHealth` → `size` (semantic rename across TS; manual fixes in
  `units.ts` ATTRIBUTE_RANGES, `server/combatApi.ts`, client render/panels, tests).
- New `SIZE_CAPPED_ATTRIBUTES` in `units.ts`; `validateAttributes` enforces the ceiling.
- Refit modal: Size shown locked (no slider), capped sliders clamp to `min(5,size)`,
  budget excludes Size (its point stays locked on the frame); Size preserved on confirm.
- Battle generator (`generate-battle-20v20.js`) caps weapon/armour/EW/repair at size.
- Data regenerated: `data/world.json`, `data/world-summary.json`, `data/battle-20v20.json`.
- Debug-snapshot field `maxHealth` and `repair.ts` HP-unit locals intentionally kept.
- COMBAT_RULES §3/§10/§16 + README updated. Checkpoint before this work: `bddd852`.
- tsc clean, 347 tests pass, `npm run validate` PASSED.

## 2026-06-21 — Combat formula consolidated into combatFormula.ts

**Decision:** Damage calculation now lives in a single self-contained file,
`src/world/combatFormula.ts`. It is pure — no imports of `Unit`/`Tile` — and
exposes one entry point, `computeDamage(input: DamageInput): DamageBreakdown`,
plus all tuning constants (curve, scales, chassis modifiers, drone multipliers,
EW effectiveness, elevation). `combatMath.ts` was removed.

`combat.ts` is now the gathering/adapter layer: it reads world state (EW,
terrain, elevation, bearing, distance), packs a clean `DamageInput`, and calls
`computeDamage`. The old `Unit`/`Tile`-taking helpers (`getChassisAttackModifier`,
`calculateModifiedAttackPower`, `calculateElevationMultiplier`,
`applyDroneIncomingDamageModifier`, `getSegmentRangeThreshold`, `getElevationLevel`,
`isDrone`) remain as thin adapters in `combat.ts` for backward compatibility, so
`combatExplainer.ts` and all tests are unchanged.

**Why:** Backbone for the upcoming combat-rules changes (elevation→range, EW
radius/anti-drone, drone range-1, Size ceiling). Each of those alters the
formula's inputs; a clean pure-formula / state-gathering split makes them
isolated, testable edits. To tune balance or change the formula, edit
`combatFormula.ts` only.

**Impact:** Behavior-preserving — `tsc --noEmit` clean, all 347 tests pass.
`WeaponMode` is intentionally NOT exported from `combatFormula.ts` (it stays the
single export from `combat.ts`) to avoid a barrel type-collision in `index.ts`.
Checkpoint before this work: `683ac44`. `combatMath.ts` references updated in
`ARCHITECTURE.md`, `README.md`, `shared/rangeCheck.ts`.

## 2026-06-21 — Defensive formation bonus deprecated

**Decision:** Removed the *defensive formation* term from DefencePower. Adjacent
friendly units no longer reduce incoming damage. `DefencePower = armour + EW + terrain`.

**Why:** Massing units next to each other granting a defence bonus is unrealistic
in modern missile warfare, and the term added complexity to the defence
calculation right before the planned combat-formula refactor (single
self-contained formula file taking clean parameter objects). Removing it now
simplifies that next step.

**Impact:**
- `getAdjacentFriendlySupport` removed from `src/world/combat.ts` (and its tests).
- `getDefencePower` returns `defensiveFormation: 0` (field kept for wire/UI compat).
- Wire type `CombatBreakdown.defFormation` retained as `0` and marked
  `@deprecated`; the client detail panel no longer renders a Formation row.
- Combat explainer no longer shows a Formation term in its breakdown strings.
- `COMBAT_RULES.md` §5/§6/§11/§16 updated. Checkpoint commit before this work: `0adf9db`.
- Damage values are unchanged except that stacked/adjacent defenders lose up to
  −1.0 effective DefencePower, so they now take slightly more damage.

## 2026-06-20 — Rivers carved as a sine wave; guaranteed drainage helper

**Decision:** Rivers are now shaped as a **sine wave with a little randomness**
instead of a near-straight channel. At each step the heading is the seaward
direction (the `oceanDist` gradient projected into the tile's tangent plane)
swung side to side by `sin(phase)`; the river always advances toward the coast
(at most one step away, for the wave crests), so it reads as a clean meander
rather than a self-tangling knot. Amplitude, wavelength and phase are randomised
per river, plus a small per-step jitter. Typical per-segment sinuosity ≈ 1.6–2.2.

Tunables in `generate.ts`: `MEANDER_AMP` (swing width), `MEANDER_FREQ`
(wavelength, rad/tile), `MEANDER_JITTER` (randomness), `MEANDER_CLIMB_TOLERANCE`.

**Why:** The old carver wandered then beelined, so rivers read as straight
lines. A literal "π-rule" sinuosity target was tried but self-intersects on the
hex grid and gets straightened by drainage repair, so it was dropped for a
clean, reliably-draining wave.

**Gotcha (important):** Rivers carry `terrainType === 'ocean'`, so city
sanitisation's ocean→plains doorstep clearing also strips `riverTo` from river
tiles next to a city, orphaning the channel upstream (dead-end). Longer meanders
hit this far more often. Fixed via `ensureRiverDrainage(tiles, forbidden?)`,
which re-routes any river tile that no longer reaches the sea straight down the
(strictly decreasing → acyclic) `oceanDist` gradient, skipping `forbidden`
tiles. Runs inside `generateRivers`, then again after city placement with city
hexes + doorsteps forbidden (rivers route around a city; one a city fully blocks
is truncated cleanly). Terrain reconciled after: river tiles → 'ocean',
truncated tiles → 'plains' (no stray inland ocean).

**Impact:** All rivers drain to the sea (0 cycles, 0 dead-ends); `npm run
validate` passes; 349 unit tests pass. World regenerates on `npm run build`.

## 2026-06-20 — Doubled vertical terrain exaggeration (first-person)

**Decision:** `ELEV_WORLD_SCALE` in `firstPersonView.ts` raised from
`HEX_WORLD_RADIUS * 2.2` to `HEX_WORLD_RADIUS * 4.4` so elevation differences
read as roughly twice as tall.

**Why:** Mountains looked like small hills in the perspective view. The single
scale constant drives all vertex heights, unit placement, cliff skirts and
fallback tops, so changing it alone exaggerates the whole landform consistently.

**Impact:** Client-only, refresh browser (Vite HMR). No data/world regen needed.

## 2026-06-20 — Inland lakes & rivers stay flat with cliff banks (first-person)

**Decision:** In the 3D first-person terrain, inland water (lakes and river
hexes) is now treated as flat water exactly like open ocean: its surface stays
horizontal at its own water level and the surrounding land slopes to the
waterline (or drops as a cliff when the bank is tall) instead of the water being
warped to tilt and blend into the land.

**Why / how:** `firstPersonTerrain.ts` had a *local* `isWaterTile` that matched
only open ocean (`terrain/elevType === 'ocean' && rv === undefined`), so lakes
and rivers fell through to land averaging in `buildVertexHeight` and got warped.
Extended that local helper to mirror `TerrainContext.isWaterTile` (ocean / water
/ lake terrain or elevType, plus `rv !== undefined` river hexes, minus bridged
crossings). This flows automatically into `cliffHeight` (water reads as the
waterline 0, so a tall bank reads as a cliff) and the vertex-cluster water
pinning. `elevationWorldHeight` keeps inland water at its own carved height
(only open ocean drops to -0.25) so a lake on a plateau / a river descending a
valley sits at its real level rather than collapsing to sea level.

**Impact:** First-person view only (2D globe/local map already used the shared
context `isWaterTile`). Cliff banks appear only where the land step exceeds
`MAX_CLIMB_LIMB` (8); gentle shores still slope to the waterline, matching the
existing coastal behaviour.

## 2026-06-20 — "View" first-person available on every segment

**Decision:** The segment right-click menu (no unit selected) now always offers
**👁 View**, which enters the read-only first-person look-around at that segment
— including empty segments with no unit or building. The two previously separate
single-item menus (`CityContextMenu`, `BuildingContextMenu`) were unified into
one `SegmentContextMenu` that conditionally adds **⚙ Refit Building** /
**🏛 City Design** alongside View.

**Why / how:** `FirstPersonView.open(unit)` was refactored into a shared
`enterView(tileIndex, segment, facing, airHeight, selectUnitId)` helper. `open`
derives those from the unit; the new `openAt(tileIndex, segment)` passes
ground-level / facing-north / no-selection so look-around works without a unit.
Wired via `MapViewInterface.onViewSegment` → `LocalMapView.onViewSegment` →
`firstPerson.openAt` in `main.ts`.

**Impact:** Pentagon tiles (no segment subdivision) pass `segment = -1`, which
`openAt` clamps to 0. View is only on the no-unit-selected RMB path; with a unit
selected, RMB still routes to move/attack/unit-context as before.

## 2026-06-20 — Building equipment rendered at 50% relative to body

**Decision:** In `buildBuildingModel`, mountable equipment (gun barrel, splash
launcher, defence dishes, repair mast, anti-air) is grouped and scaled to
`EQUIPMENT_SCALE = 0.5` about the roof surface (`y = BODY_H`). The base block,
roof cap, and wall-bolted armour stay full size.

**Why / how:** Equipment reused the unit-sized add-on builders and looked
oversized on the plain building block. Scaling about the roof surface keeps
roof-mounted bases seated (`equip.position.y = BODY_H * (1 - EQUIPMENT_SCALE)`)
while gear above shrinks toward centre. Armour is excluded because its plates
bolt flush to the walls — shrinking them would float them off the structure.

**Impact:** Applies to both views (FP `place()` and the local-map sprite, both
build from `buildBuildingModel`). Bumped `SPRITE_VERSION` to `bld-v2` in
`buildingRenderer.ts` to invalidate cached sprites. Units are unaffected (shared
add-on builders untouched). Tune `EQUIPMENT_SCALE` to rebalance.

## 2026-06-20 — First-person buildings scale from base block, not full bbox

**Decision:** In the 3D first-person view, buildings are now scaled to a
consistent on-screen size using the bare base-block footprint
(`BUILDING_BASE_FOOTPRINT`, exported from `buildingModel.ts`) instead of the
model's full XZ bounding box.

**Why:** `place()` in `firstPersonView.ts` divided the target footprint by
`Math.max(size.x, size.z)` of the *whole* model. Horizontally-protruding
equipment — long gun barrels (longer with `rangeAttack`) and anti-air dishes —
inflated that extent, shrinking the entire structure so the protrusion fit
inside the hex fraction. Buildings with only vertical gear (antenna, flag,
defence) stayed large. Result: building size tracked loadout, not elevation —
a building closer to the camera could look *smaller* than a farther one.

**Impact:** Every building body now renders at the same size; equipment freely
protrudes past the hex fraction. Units still normalise by full bbox (unchanged);
apply the same fix there if the effect shows up on units. The local-map sprite
renderer (`buildingRenderer.ts`) uses a fixed ortho frustum and is unaffected.

## 2026-06-20 — Home key snaps to selected unit's shoulder (first-person)

**Decision:** In the 3D first-person view, pressing **Home** moves the camera
onto the selected unit's shoulder, looking horizontally (pitch = 0) in the
direction the unit is facing — a quick over-the-shoulder reset.

**Why / how:** Gives the player a one-key way to reorient the free-fly camera
behind the unit it's commanding. Implemented in `client/firstPersonView.ts`:
- `onKeyDown` adds a `Home` branch; it `preventDefault` + `stopImmediatePropagation`
  in the capture phase so the 2D map's Home shortcut (centre on home city) does
  not also fire while first-person owns the keyboard.
- `snapToShoulderOfSelected()` reuses `shoulderWorldPos(unitId)` for the focal
  point and `facingDirection(ft, unit.facing)` for the horizontal heading. It
  sets `yaw` from the facing, `pitch = 0`, and places the eye slightly behind
  and to the right of the shoulder (`back = 0.5·HEX_WORLD_RADIUS`,
  `side = 0.28·HEX_WORLD_RADIUS`), then `applyLook()`.

**Impact:** No-op when nothing is selected. `clampPos()` still bounds the eye to
the field and minimum height.

**Follow-up (same day):** The shoulder-snap leaves the camera *level* with the
shoulder, which exposed an issue in the boom (wheel) zoom: it called
`aimAt(shoulder)` every tick, so once level it re-snapped the pitch to horizontal
on every zoom — and panning away then zooming yanked the view back onto the
unit. Fixed with an explicit `boomFocus` flag: wheel-zoom only dollies toward +
re-aims at the unit's shoulder while focus is armed. Focus is armed by the
explicit framing actions (`open()` and the Home snap) and cleared the moment the
player pans or looks (drag / Ctrl-drag). Once cleared, zoom is a plain forward
dolly that keeps pointing where the player aimed until they re-focus (Home).

## 2026-06-20 — Cliffs at unclimbable / water borders in first-person view

**Decision:** In the 3D first-person view, a hex border renders as a vertical
**cliff** (flat tops + visible skirt wall) when the height step exceeds the
spider climb limit (`|Δheight| > MAX_CLIMB_LIMB`, i.e. a face no ground chassis
can scale). Open water is treated as sea level (height 0) in this test, so a
tall coastal drop becomes a cliff but an ordinary shoreline does not. Separately,
**open water always stays dead flat**: shared vertices on a water cluster are
pinned to the water level, so a lower land neighbour slopes down to the
waterline instead of tilting the water up — no vertical wall for small shore
steps.

**Why / how:** Smooth tilting reads well for gentle grades but misrepresents
sheer faces, and the first cut made *every* land-water border a full cliff —
even a 1-level shore looked like a tall wall (made worse by the ocean's -0.25
dip). The change is isolated to `client/firstPersonTerrain.ts`:
- `isWaterTile` (open ocean, non-river), `cliffHeight` (water reads as 0), and
  `isCliffEdge(a, b)` = `|cliffHeight Δ| > MAX_CLIMB_LIMB`.
- `buildVertexHeight` is now **tile-aware**: it returns `(tileIndex, p) => height`.
  At each shared vertex it clusters touching tiles via union-find, joining only
  pairs that are *not* a cliff edge. A cluster's height is the average of its
  tiles' elevation, **unless it contains water**, in which case it is pinned to
  the water level (kept flat). Tiles split by a cliff resolve to different
  heights at the same point, so the existing darker skirt becomes the cliff wall.
- `buildTerrainMesh` and `sampleSurface` (in `firstPersonView.ts`) updated to
  pass the querying tile index so unit placement samples the same surface.

**Impact:** A single threshold (`MAX_CLIMB_LIMB`) governs all cliffs (land and
coastal), so the visual cut-off tracks the movement rule and the 2D map's
steep-border tiers in `client/terrainRelief.ts`. If coastal cliffs are wanted at
smaller drops than the climb limit, add a separate water threshold.

## 2026-06-20 — City hexes and built-on hexes are never forested

**Decision:** A city's own hex is de-forested at world generation, and any hex
gets its forest cleared the moment a building is placed on it.

**Why / how:** A settled/built hex is a cleared site — leaving forest cover on
it looked wrong and double-counted terrain. Three touch points kept in sync:
- `src/world/generate.ts` (Step 6 city sanitisation) sets `tiles[city.tileIndex].forested = false`.
- `src/world/buildings.ts` `constructBuilding` sets `tile.forested = false` on commit (server-authoritative).
- `client/buildController.ts` `constructBuilding` sets `tile.f = false` (client mirror of compact wire format).

`world.json` regenerated so existing capitals load de-forested.

## 2026-06-20 — Forest scenery in first-person view

**Decision:** Forested hexes (`tile.f`) now scatter low-poly 3D trees in the
first-person view (`client/firstPersonView.ts` → `buildTrees()`), echoing the 2D
map's `terrainFeatures.drawForestCornerTrees`.

**Why / how:** Trees are static decoration, so they're built once on `open()`
and disposed with the rest of the scene on `close()`. Each tree is a trunk
(cylinder) + canopy (cone) drawn as two `InstancedMesh`es (one matrix per
instance shared across both parts) for performance. Placement uses a per-tile
seeded PRNG (`mulberry32(tileIndex)`) so a given forest looks identical each time
the view is opened; trees stand upright (not slope-tilted) at surface-sampled
heights. Tunables: `TREES_PER_HEX`, `TREE_HEX_FRACTION`.

## 2026-06-20 — Player move glide overshot then snapped back to the destination

**Bug:** Moving a player unit on the local map showed the sprite gliding *past*
its destination, then snapping back to the selected segment.

**Root cause:** The glide stored **fixed screen-space** positions in
`unitScreenOverrides` (computed once from start/end centroids). But the move
handler also calls `globe.panToTile(destTile)` to follow the unit; the globe
pan emits view-centre changes that call `localMap.setCentre(...)`, which rebuilds
the local-map projection and resets its pan offsets **mid-glide**. The sprite
kept heading to the now-stale screen target (overshoot), then the override was
removed and the unit was redrawn at the recentred segment centroid (snap-back).

**Fix:** The glide is now driven by eased **progress (0–1)** instead of cached
screen coords. `LocalMapView` stores the origin/destination tile+segment in
`unitMoveAnims`, and `drawUnits` re-projects `lerp(originCentroid, destCentroid,
progress)` through the *current* `worldToScreen` every frame. The path now
follows any mid-glide recentre and lands exactly on the destination centroid.

**Impact:** `CombatAnimator.playMove` now takes `(onStep: (progress) => void)`
(no from/to). `LocalMapView.playMoveAnimation(unitId, fromTile, fromSeg,
newFacing)` replaced the old `(unitId, fromPos, newFacing)`. Move overrides are
world-space-relative now, not screen-space — keep any new glide code
progress-based so it stays recentre-safe.

## 2026-06-20 — End-turn "are you sure?" popup rows didn't select the unit

**Bug:** Clicking a unit row in the end-turn confirmation popup recentred the
camera but did not select/highlight that unit. The row handler called
`localMap.setCentre()` + `setSelected(tileIndex)`, which only sets `selectedTile`
— it never added the unit to `turnManager.selectedUnits`, set `selectedSegment`,
or recomputed the movement-range overlay. So the on-map selection ring stayed on
whatever was previously selected, and players misread which unit was active.

**Fix:** Added `LocalMapView.focusUnit(unitId)`, which mirrors the real
left-click selection path (centre → clear+add `selectedUnits` → set
`selectedTile`/`selectedSegment` → `computeMovementRange()` → render). The popup
row click now calls `focusUnit(unit.id)`. Canonical "select a unit by id"
helper — prefer it over the `setCentre`+`setSelected` pair anywhere a unit
(not just a tile) should become selected.

## 2026-06-20 — First-person rotation cycled 3 facings instead of 6 (double-handled arrow keys)

**Bug:** In first-person view, pressing ←/→ to rotate the selected unit only
visited 3 of the 6 facings (it advanced by 2 each press, landing on even/odd
only). The data was fine — facing genuinely cycled 0–5 — but two `window`
keydown listeners both processed each arrow press: `FirstPersonView.onKeyDown`
AND the 2D map's `MapInputHandler.onKeyDown` (still attached while the overlay
is open). Each rotated the unit once → net +2 per press.

**Fix:** `FirstPersonView` now registers its keydown listener in the **capture
phase** (`addEventListener('keydown', fn, true)`) and calls
`stopImmediatePropagation()` for all arrow keys, so the map's bubble-phase
listener never sees them while first-person is open. ArrowDown is swallowed too
(blocks the map) but is not a first-person command, so it does not rotate.

**Why this approach:** Self-contained in `firstPersonView.ts` — no plumbing of
"is first-person active" through `LocalMapView → MapInputHandler`. `preventDefault`
alone was insufficient; it doesn't stop sibling listeners on the same target.

**Gotcha for future agents:** Both views attach global `window` keydown
listeners. Any new modal/overlay that handles keys must capture + stop
propagation (or otherwise suppress the map handler), or it will double-handle.


**How to use:** Add a new entry at the top whenever you (a) make a design or
balance decision, (b) discover a non-obvious gotcha, or (c) find/fix a bug worth
remembering. Keep entries short. Link to the authoritative doc if one exists
(`COMBAT_RULES.md`, `ARCHITECTURE.md`).

Format: `## YYYY-MM-DD — <short title>` then **Decision / Why / Impact**.

---

## 2026-06-20 — Enemy move indicator + red number for acted enemy units

**Decision:** AI moves now draw an amber "move indicator" (origin ring + origin
dot + dashed arrow to the unit's current position) via `drawMoveHighlight`
(`localMapUnits.ts`), mirroring the existing red/cyan `drawCombatHighlight` used
for attacks. Separately, an enemy unit's number label is drawn in red once it
has moved/acted this AI turn (tracked in `LocalMapView.aiActedUnits`, fed by the
new `markActed` / `highlightMove` AI callbacks in `aiTurn.ts` →
`turnController.ts`).

**Why:** Plain enemy moves had no persistent indicator, so it was hard to see
what moved from where to where. And there was no way to tell at a glance which
enemy units had already taken their action during playback.

**Impact:**
- `drawUnits` param `_actedUnits` is now used (renamed `actedUnits`): label is
  red when `MP === 0 || actedUnits.has(id)`. `localMap.render()` passes
  `aiActedUnits` (not `turnManager.actedUnits`), so **player** unit numbers are
  unchanged (still red only on 0 MP).
- Move/combat highlights are mutually exclusive (each setter clears the other);
  `selectActingUnit` clears the move arrow when focus shifts.
- Both indicators and the red flag are live-only and cleared in
  `LocalMapView.endTurn()`. They do **not** rewind with the playback snapshots
  (same transient behaviour as the pre-existing combat highlight).

---

## 2026-06-20 — First-person view renders buildings; 20v20 ships a player city

**Decision:** `FirstPersonView` now renders buildings, not just terrain + units.
A new `rebuildBuildings()` builds a `buildBuildingModel` per `world.buildings`
entry (solid) and per `world.plannedBuildings` entry (translucent ghost,
opacity 0.35), placed upright at the segment centroid on the sampled terrain
surface, front facing the segment's outer edge. Buildings are scaled by
`BUILDING_HEX_FRACTION` (0.42 of a hex radius) — far larger than the tiny unit
models. Called from `open()` and `refresh()`; geometries AND materials are
disposed on rebuild/close (unlike unit models, `buildBuildingModel` mints fresh
materials per call). The 20v20 generator (`scripts/generate-battle-20v20.js`)
now seeds 3 buildings on the player capital hex (segs 0/1/2, gun / EW-dish /
repair loadouts) plus a garrison player unit on an open segment of that hex.

**Why:** Buildings existed only as 2D sprites (`buildingRenderer.ts`); the 3D
view had no wiring to place them. The 20v20 scenario had no player city cluster
and no unit near the capital, so there was nothing to view quickly.

**Impact:** Press Home → select the garrison unit → V to see the city in 3D.
Ghost (planned) buildings from the City Design planner also show translucent in
3D. The contiguous 3-seg arc leaves segs 3/4/5 open as a through-street.

## 2026-06-20 — Polar ice caps are organic (latitude + noise), not pole-distance rings

**Decision:** Replaced the old/new pole-distance terrain rules in
`generateTerrain` (`src/world/generate.ts`) with an organic ice field. A tile is
tundra when `polarPentagon || (|latitude| + low-freq-noise*ICE_EDGE_WAVE) >=
ICE_LAT_EDGE` (`ICE_LAT_EDGE=0.90`, `ICE_EDGE_WAVE=0.20`). Pole pentagons are
forced ice so a core always survives. The strong polar land bias (`polarLift`)
was relaxed to `|lat|>0.95 ? 0.06 : 0` so the rank-selected ocean mask leaves
organic sea inside the caps; ocean tiles in a cap simply stay ocean.

**Why:** The prior code offered either rigid tundra rings at pole-distance ≤2
plus a forced ocean buffer at distance 3–4 (old), or pentagon-only tundra with
no polar sea (post-Goldberg100 refactor). Neither matched the desired look:
organic ice blobs at both poles with some random sea around them.

**Impact:** Both poles get a wavy ice cap. On the shipped G(100) world each cap
(|lat|>0.85) is ~4.7k tundra + ~1k ocean tiles; zero equatorial tundra. Removed
`POLE_TUNDRA_CAP`. `poleDistances` is still used for mountains/cities. The two
old ring tests in `terrain.test.ts` were replaced by property-based polar tests
(ice present at both poles, organic non-ring edge, polar sea across seeds) that
build a small real Goldberg sphere via `generateGeodesicSphere`+`computeDual`.
Also added `dist/**` to vitest `exclude` so stale compiled tests don't re-run.

## 2026-06-20 — ESLint (typed) added; uses tsconfig.eslint.json

**Decision:** Added flat-config ESLint (`eslint.config.js`) with typed rules:
`no-explicit-any`, `no-unsafe-*`, `no-floating-promises`,
`switch-exhaustiveness-check`, `complexity` (warn >10), `max-lines-per-function`
(warn >60). Test files are exempt from the last two. Run with `npm run lint`.
Type-aware linting points at a dedicated `tsconfig.eslint.json` (extends the base
config, adds `server/**` + `node` types, `noEmit`) so `server/**` files get
type info without changing the build's `tsconfig.json` include list.

**Why:** The build's `tsconfig.json` only includes `src/` + `shared/`; without a
lint-only project, every `server/**` file failed with a parser "not found in
project" error.

**Impact:** Lint is clean (0 errors). 37 complexity/length *warnings* remain on
legitimately large functions (world gen, combat resolution) — left as warnings.

## 2026-06-20 — Gotcha: validate.ts tile reconstruction was masked by `any`

**Decision / Why:** `src/validate.ts` rebuilt `Tile[]` from `world.json` but
omitted `boundary`, `elevationType`, `forested`. This compiled only because
`JSON.parse` returned `any`, which silently satisfied `Tile[]`. Typing the parse
as `WireWorld` exposed the gap. Now reconstructs the full Tile from the wire
fields (`b`, `elevType`, `h`, `f`, `rv`).

**Impact:** `validateWorld` now sees complete tiles. No behavior change to
generation; this only affected the standalone `npm run validate` CLI.

---

## 2026-06-17 — Refactor: context menus extracted from MapInputHandler

**Decision:** `showCityMenu` and `showBuildingMenu` (~100 lines of inline DOM
construction) extracted from `MapInputHandler` into `client/cityContextMenus.ts`
as `CityContextMenu` and `BuildingContextMenu` classes. Both share a
`MenuLifecycle` helper for open/close/Escape lifecycle, following the same
pattern as `UnitContextMenu` in `unitContextMenu.ts`.

`MapInputHandler.closeContextMenu()` now calls `.close()` on all three menu
instances; the three `show*` methods become one-liners.

**Why:** Reduces `mapInput.ts` by ~100 lines and isolates the DOM construction so
adding new menu items (or restyling) doesn't require reading input-routing code.

**Impact:** No behaviour change. All three menus work identically.

---

## 2026-06-17 — Refactor: wire types unified, generate.ts split, pathfinding shared

**Decision:**
1. `shared/wireTypes.ts` — new single source of truth for compact wire shapes
   (WireTile, WireUnit, WireBuilding, WireCity, WireWorld, CompactSave). Replaces
   the hand-maintained parallel definitions in `src/world/compact.ts` and
   `client/worldData.ts`. `TileData` in `client/worldData.ts` now extends
   `WireTile` with client-only `bridge?: boolean`.

2. `shared/pathfinding.ts` — graphDistance / tilesWithinRadius / findPath moved
   here from `src/world/pathfinding.ts`. `src/world/pathfinding.ts` becomes a
   thin adapter (Tile → PathTile). `client/aiTurn.ts` drops its local `bfsDistance`
   / `findPath` duplicates (~80 lines) and imports from shared instead.

3. `src/world/generate.ts` split: `mulberry32` → `rng.ts`, Goldberg geometry
   (icosahedron, subdivision, dual) → `geodesic.ts`. `generate.ts` re-exports
   these and imports from them, reducing how much an agent must read to touch
   only terrain/rivers/cities (sections 2–4, ~1400 lines vs 1822).

**Why:** Eliminate the two most documented drift risks (wire types, duplicated AI
pathfinding) and reduce the single most expensive file to read (generate.ts).

**Impact:** All existing importers still work — compact.ts re-exports old aliases,
worldData.ts re-exports old type aliases, pathfinding.ts re-exports via adapter.
No runtime change.

---

## 2026-06-17 — Boom zoom targets the selected unit's shoulder

**Decision:** In first-person view (`firstPersonView.ts`), mouse-wheel zoom now
dollies toward (and aims at) the selected unit's shoulder rather than along the
camera's forward look vector. Shoulder = `unitWorldPos` mid-body lifted by
`HEX_WORLD_RADIUS * UNIT_HEX_FRACTION * 0.35`. `SHOULDER_STANDOFF` is tiny
(`HEX_WORLD_RADIUS * 0.05`) so the camera comes right up to the model, and the
`clampPos` altitude floor was lowered from `EYE_HEIGHT` to `CAM_MIN_HEIGHT`
(0.3) so the eye can descend to the unit instead of stopping high above it. With
no unit selected it falls back to the old forward dolly.

**Why:** Zooming used to drift along whatever direction you were looking, so the
unit slid out of frame. Centring on the shoulder keeps the selected unit framed
as you zoom in.

**Impact:** `wheel` handler + new `shoulderWorldPos` / `aimAt` helpers. Zoom-out
also follows the shoulder axis.

---

## 2026-06-17 — Wash out terrain textures

**Decision:** Terrain textures are composited weakly instead of full strength.
2D local map (`localMapTerrain.ts` `fillTileTexture`) draws each texture at
`globalAlpha = 0.45` over the solid biome fill (hillsPlains at `0.45 * 0.8`).
First-person 3D (`firstPersonView.ts` `getTerrainTextures`) bakes a 55% white
overlay onto each texture on load.
**Why:** The raw textures read too strong/saturated against the HUD.
**Impact:** Base biome colours now show through; artwork is a subtle overlay.
Tune via `TEXTURE_WASH_ALPHA` (2D) and `WASH_WHITE_ALPHA` (3D).

---

## 2026-06-17 — Building refit + building-attribute wire plumbing

**Decision:** Buildings can now be **refitted** with equipment, mirroring the unit
refit. Right-click a player-owned building (no unit selected) → **⚙ Refit Building**
→ `client/buildingRefitModal.ts`. The seven equipment attributes
(`kinetic, rangeAttack, splashAttack, antiAir, armour, defence, repair`) are
redistributed within a **flat budget** `BUILDING_REFIT_BUDGET = 10` pts
(`buildingRefitModal.ts`). Unlike units (whose budget = sum of current attrs), a
building starts empty, so a fixed pool is used; budget = `max(10, currentSum)` so
points are never lost on a re-refit. Refit re-renders the sprite via
`rerenderBuildingSprite` and is gated on the player's turn.

Building equipment is now **plumbed through the wire format**: `attributes?` added
to `Building` (`src/world/types.ts`), `CompactBuilding` + `toCompactBuilding`
(`src/world/compact.ts`), and the building map in `server/generateApi.ts`. Client
saves already round-trip it (compact save copies `BuildingData`, which carries
`attributes?`).

**Why:** Requested. Buildings should be configurable defensive emplacements using
the same equipment vocabulary as units, minus movement and engineering.

**Impact:** Generated buildings still spawn empty (no attributes set at
construction); refit is how a player equips them. No per-turn cap on refit (unlike
the one-build-per-turn `C` rule). AI does not refit buildings yet.

## 2026-06-17 — Buildings rendered as 3D model sprites (equipment-capable)

**Decision:** Buildings now render from a procedural 3D model
(`client/buildingModel.ts`) via an offscreen renderer (`client/buildingRenderer.ts`),
mirroring the unit sprite pipeline. The base is a deliberately plain block + roof
turret cap. The model reuses the unit attribute add-on builders, so a building can
be equipped with the same gear as a unit — **all attributes except movement and
engineering**: `kinetic`, `rangeAttack`, `splashAttack`, `antiAir`, `armour`,
`defence`, `repair`. `ChassisType` gained a `'building'` member; each add-on in
`unitModelAddons.ts` got a `'building'` placement case.

**Why:** Asked for a basic, detail-free building model that can later be extended
with unit-style equipment. Sharing the add-on builders keeps a single source of
truth for equipment geometry.

**Impact:** Buildings sprite-render at the same camera/scale as units (single
facing — buildings are static). `BuildingData.attributes?` (client-only,
`worldData.ts`) carries the optional loadout; when absent the building is a plain
block. Server/compact wire format is **not yet plumbed** — to actually assign
building equipment in-game, add `attributes` to `Building` (`src/world/types.ts`)
and the compact format (`src/world/compact.ts`). `drawBuildings` falls back to the
old vector block+roof while a sprite is still rendering.

## 2026-06-17 — Capital hex exempt from through-street rule

**Decision:** The **capital hex** of a city is exempt from the per-tile
through-street invariant (Requirement 4). It may hold buildings on all six
segments. The surrounding city hexes remain fully subject to the through-street
and no-courtyard invariants, so the city stays traversable via the ring of hexes
around the capital rather than through it.

**Why:** The capital is the city's dense core; forcing a street through it is
unnecessarily restrictive. Roads flowing around it preserve traversability.

**Impact:** Founding (R1.4) and build-time validation (R4) skip the through-street
check for the capital hex only. R5 (external reachability) is unaffected — a
fully-built capital simply contributes no open segments to the network.



**Decision:** Right-clicking the player's capital hex (with no unit selected)
opens a **City Design** menu → modal planner. The planner shows the capital and
its six neighbour hexes as a schematic segmented "flower"; clicking a segment
toggles a **planned** building. Plans are persisted per world seed in
localStorage (`dd-city-plans-<seed>`, `client/cityPlan.ts`) so they survive
between invocations and sessions. Planned buildings render **greyed/dashed**
(both in the modal and on the main map); real buildings render **solid** in the
faction colour. Built/unit-occupied segments can't be planned.

**Why:** Lets players lay out a city ahead of time without spending turns.

**Mechanics / gotchas:**
- The planner **honours the real placement rules**. Adding a planned building
  validates it via `buildController.validatePlannedPlacement`, which runs the
  shared `validateBuildingPlacement` against a context where the city's
  *planned* buildings count as real ones (`makePlannedContext`). So planned
  buildings must be contiguous, must keep every hex's through-street, and must
  not orphan the street network — illegal plans are rejected with the reason
  shown in the modal status line. Because buildings only shrink open segments,
  validating each add against the current (legal) union keeps the whole plan
  legal, so per-add validation suffices.
- **Removal re-prunes** (`cityPlan.prunePlan`): deleting a planned building can
  disconnect others that only extended off it, so the plan cascades to drop any
  now-non-contiguous planned buildings. (Through-street/reachability can't break
  on removal — fewer buildings = more open segments.)
- Plans are a personal overlay, NOT part of the authoritative save. They sync
  into `world.plannedBuildings` (runtime-only field) via
  `cityPlan.syncPlannedToWorld`, which also prunes any planned segment once it
  is actually built.
- RMB is overloaded (move/attack need a selected unit), so the City Design menu
  only triggers when **no unit is selected** — deselect, then RMB the capital.
- The planner schematic rotates each neighbour hex so the segment facing the
  capital points inward, keeping segment indices faithful to the real tiles.
- `ensureCitiesFounded` (load fallback) can leave a very coastal capital
  unfounded if it has <2 land neighbours (no through-street possible). Generated
  worlds avoid this; only legacy/synthetic scenarios hit it.

---

## 2026-06-17 — Cities & buildings (city-buildings spec)

**Decision:** Implemented the `city-buildings` spec. A `Building` is an immobile
full-segment occupant `(tileIndex, segment)` owned by a faction. Founding places
one free building on each city's capital hex; buildings then grow contiguously,
one per faction per turn. Two traversability invariants are enforced at build
time AND in `npm run validate`:
- **Through-street (R4):** every city hex keeps a connected run of open (unbuilt)
  segments with ≥2 external faces opening onto ground-passable neighbours.
- **External reachability (R5):** the whole-city open-segment network must reach
  the outside world — no sealed courtyard pockets.

The pure rules live in `shared/buildings.ts` (single source of truth, client-
importable). `src/world/buildings.ts` (server) and `client/buildController.ts`
are thin adapters over it. Wire format carries `buildings[]` + `city.ownedHexes`
(`src/world/compact.ts`, mirrored in `client/worldData.ts`). `validateWorld`
gained two city-integrity checks. Per-turn cap lives on `TurnManager`
(`builtFactions` set). Client build action: **C** key builds on the selected
hex+segment.

**Why:** Cities must never wall themselves off; the two invariants guarantee
units can always traverse a city.

**Gotchas / decisions resolved:**
- **Ground-passable = "not ocean"** at tile granularity for the street invariant.
  Steepness is an edge/chassis concern handled by the movement system; the street
  rules use tile-level passability only (mountains are passable terrain here).
- **Units don't block streets.** "Open/street segment" means *no building*; a
  unit may sit on or pass through it. Through-street/reachability consider
  buildings only.
- **Founding happens after city filtering + unit spawn** in `server/generateApi.ts`
  (and `src/generateCli.ts`), so removed cities don't leave stray buildings.
- **Founding-on-load fallback:** `client/buildController.ensureCitiesFounded`
  founds any city that loaded without a building, so pre-buildings saves/scenarios
  still get a starting building.

---

## 2026-06-16 — Flat map orientation tracks the globe camera's screen-up

**Decision:** `buildFlatView` (`client/localMapProjection.ts`) now accepts an
optional `up` vector (the globe camera's screen-up direction in world space) and
builds the tangent-plane basis from it: binormal (map screen-up) = `up` projected
onto the tangent plane, tangent (screen-right) = `binormal × normal` (preserves
`t × b = n`). `globe.ts` `emitViewCentre` extracts the camera's local +Y axis
(`setFromMatrixColumn(matrixWorld, 1)`), passes it through the
`onViewCentreChange(tileIndex, up)` callback, and now fires that callback on a
meaningful **orientation** change (~2° threshold) too, not only on centre-tile
change. `LocalMapView` stores the latest `up` (`viewUp`) and reuses it for
map-drag recentres so orientation stays continuous. When no `up` is supplied
(first-person view, battle centring, goHome), `buildFlatView` falls back to the
old position-derived branch (canonical orientation).
**Why:** The map basis was derived purely from the centre tile's position with a
hard branch at `|ny| = 0.9`. A pure spin at a globe pole left the map static
(tile index unchanged, position-only basis ignores spin), and dragging back
toward the equator crossed the `0.9` threshold, switching tangent branches and
producing a discontinuous "flip" to re-sync.
**Impact:** Map now rotates in step with polar spin and there's no snap-back flip.
At the equator with the default camera the new basis matches the old one, so the
starting view is unchanged. Note: `client/mapProjection.ts` holds a dead,
unimported duplicate of `buildFlatView` with the original branch — not on the
live path, left untouched.

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
