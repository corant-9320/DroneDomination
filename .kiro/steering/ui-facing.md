---
inclusion: fileMatch
fileMatchPattern: "{client/facing.ts,client/unitRenderer.ts,client/unitIcons.ts,client/unitModel.ts,client/localMapUnits.ts,client/movementDraw.ts,client/localMapProjection.ts,client/firstPerson*.ts,src/world/combatFacing.ts}"
---

# Unit Facing & Rendering

**Purpose:** Keep the combat-math facing frame and the render facing frame in sync.
**Scope:** Facing conversions, sprite/model orientation, and the renderers that consume them.
**Audience:** Agents editing facing, unit rendering, or first-person orientation.
**Related:** `ui-defaults.md` (HUD/layout — loads for all `client/**`) · `conventions.md` (cross-file sync table)

Not needed for HUD, panel, modal, or menu work.

## The Two Coordinate Systems

1. **Combat math** (`src/world/combatFacing.ts`): uses `tile.neighbours[facing]` — the
   facing index selects which neighbour the unit points toward. The orientation bonus
   comes from the bearing between 3D tile positions on the unit sphere via
   tangent-plane projection.
2. **Rendering** (`client/unitRenderer.ts`): pre-renders 6 isometric sprites per unit
   type, one per facing direction. The 3D model is rotated around Y by
   `-(facing × π/3) + π/4`, which assumes facing 0 = screen-north, facing 1 = 60°
   clockwise, and so on.

## The Mismatch, and the Fix

On a sphere, `tile.neighbours[0]` is **not** guaranteed to point screen-north — its
screen direction depends on the tile's position on the globe and the local map's
tangent-plane projection. Uncorrected, a unit's visual direction can differ from its
combat-math direction by up to 60°.

`drawUnits` therefore computes the actual screen angle toward the faced hex edge (from
the tile's projected polygon) and quantizes it to the nearest pre-rendered sprite (0°,
60°, 120°, …) via `spriteFacingForRender` in `facing.ts`. The sprite is drawn with no
2D rotation, preserving isometric perspective.

**Critical rule:** Never apply 2D canvas rotation to isometric sprites — it breaks the
3D perspective ("tumbling"). Always select the nearest pre-rendered facing instead.

**Quantization error:** with only 6 pre-rendered directions there is up to ±30° of
visual error. Combat math always uses the exact continuous bearing (0–2 bonus), so the
numbers stay precise; only the visual is approximate.

## The Three Facing Frames

Integers that look alike but are not interchangeable:

1. **NeighbourFacing** — index into `tile.neighbours[]`. Tile-relative: the same integer
   means a different world direction on every tile. This is what `unit.facing` stores.
   **Never reuse a NeighbourFacing computed for one tile on a different tile.**
2. **ScreenAngle** — radians, north-clockwise (0 = up). Continuous, view-dependent.
3. **SpriteFacing** — index into the pre-rendered sprite set, fixed screen mapping
   (0 = up, +60°/step). What the renderer expects. **Never store a SpriteFacing in
   `unit.facing`.**

## File Responsibilities

| File | Role |
|------|------|
| `client/facing.ts` | **Single source of truth** for all facing conversions — `facingFromTravel`, `rotateHexIndex`, `screenAngleBetweenTiles`, `screenAngleToSpriteFacing`, `spriteFacingForRender`, and the continuous `facingDirection` used to orient 3D models and aim the first-person camera. No other file may do raw `.neighbours.indexOf()` or `(facing ± n) % 6`. |
| `src/world/combatFacing.ts` | Authoritative bearing/bonus math (tangent-plane, continuous) |
| `client/unitRenderer.ts` | Pre-renders 6 isometric sprites per unit type (Y rotation in 3D) |
| `client/unitIcons.ts` | `drawUnitIcon` — draws the sprite at the given corrected facing |
| `client/localMapUnits.ts` | Calls `spriteFacingForRender` from `facing.ts` to map data facing to screen sprite |
| `client/firstPersonScene.ts` | Orients 3D unit/building/logistics models via `facingDirection` (continuous — no sprite quantization in 3D) |
