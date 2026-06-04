# Refactoring Designs — Drone Domination

Ten independent refactorings ordered for sequential execution. Each session can
take one section and execute it end-to-end. Later items benefit from earlier
ones being complete, but each is independently viable if predecessors are skipped.

---

## Execution Order Rationale

| Order | ID | Summary | Why this position |
|-------|-----|---------|-------------------|
| 1 | P3 | Extract shared utilities | Foundation — removes duplication that every other file touches |
| 2 | P6 | Extract CSS from index.html | Independent, huge noise reduction |
| 3 | P9 | Remove dead code | Pure cleanup, zero risk |
| 4 | P5 | Delete deprecated combat functions | Clear-cut, frees future combat work |
| 5 | P10 | Split unitModel.ts bolt-on builders | Independent, shrinks a 597-line file |
| 6 | P4 | Consolidate movement helpers | Unifies client/server movement logic before the big split |
| 7 | P7 | Extract pure functions from LocalMapView | Direct stepping stone for P1 |
| 8 | P2 | Deduplicate state (LocalMapView → TurnManager) | Removes duplicate state before the big split |
| 9 | P1 | Split localMap.ts into modules | Biggest structural win, benefits from P4/P7/P2 |
| 10 | P8 | Split src/world/combat.ts | Independent, lower urgency |

---
---

## 1. P3 — Extract Shared Utilities

### Problem

`esc()`, `toneColor()`, and `capitalize()` are copy-pasted between
`detailPanel.ts` and `combatPanel.ts`. `TurretInfo` is defined identically in
four files (`unitModel.ts`, `unitModelWheeled.ts`, `unitModelLimbed.ts`,
`unitModelFlight.ts`).

### Design

Create two new files:

**`client/htmlUtils.ts`**
```ts
/** Escape HTML special characters for safe innerHTML insertion. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Capitalize first letter; return em-dash for nullish/empty strings. */
export function capitalize(s: string | undefined | null): string {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Map combat step tone to a CSS color value. */
export function toneColor(tone: string): string {
  switch (tone) {
    case 'positive': return '#8f8';
    case 'negative': return '#f88';
    case 'critical': return '#fa0';
    default:         return '#ccc';
  }
}
```

**`client/unitModelTypes.ts`**
```ts
/** Turret mounting point info shared by all chassis builders. */
export interface TurretInfo {
  turretY: number;
  turretZ: number;
}
```

### Changes

| File | Action |
|------|--------|
| `client/htmlUtils.ts` | Create |
| `client/unitModelTypes.ts` | Create |
| `client/detailPanel.ts` | Delete local `esc`, `toneColor`, `capitalize`; import from `htmlUtils.ts` |
| `client/combatPanel.ts` | Delete local `esc`, `toneColor`; import from `htmlUtils.ts` |
| `client/unitModel.ts` | Delete local `TurretInfo`; import from `unitModelTypes.ts` |
| `client/unitModelWheeled.ts` | Delete local `TurretInfo`; import from `unitModelTypes.ts` |
| `client/unitModelLimbed.ts` | Delete local `TurretInfo`; import from `unitModelTypes.ts` |
| `client/unitModelFlight.ts` | Delete local `TurretInfo`; import from `unitModelTypes.ts` |

### Risk: Low
### Verify: `npm test` passes; no visual change.

---
---

## 2. P6 — Extract CSS from `index.html`

### Problem

`index.html` contains an 800-line `<style>` block (lines 8–809). Every session
that touches any HTML structure must load 788 lines of CSS it doesn't need.

### Design

1. Create `client/styles.css` containing the full contents of the `<style>` block.
2. Replace the `<style>...</style>` in `index.html` with:
   ```html
   <link rel="stylesheet" href="/client/styles.css" />
   ```
3. Vite serves files from the project root, so `/client/styles.css` resolves
   correctly in dev mode. For production builds, Vite will bundle it automatically.

### Changes

| File | Action |
|------|--------|
| `client/styles.css` | Create (paste 800 lines from index.html) |
| `index.html` | Replace `<style>...</style>` with `<link>` tag |

### Risk: Low
No logic changes. CSS specificity and ordering are unchanged because there is
only one stylesheet.

### Verify: Refresh browser — all HUD elements render identically.

---
---

## 3. P9 — Remove Dead Code

### Problem

- `main.ts` has an empty `dblclick` event listener (lines ~330–337) that does nothing.
- `artifacts/sessions/` contains 14 empty session folders that add directory noise.

### Design

1. Delete the empty `dblclick` handler in `main.ts`.
2. Delete all empty folders under `artifacts/sessions/`.
3. Add `artifacts/sessions/` to `.gitignore` if not already present (these are
   ephemeral session artifacts, not source).

### Changes

| File | Action |
|------|--------|
| `client/main.ts` | Remove the `localCanvas.addEventListener('dblclick', ...)` block |
| `artifacts/sessions/*` | Delete all empty folders |
| `.gitignore` | Add `artifacts/sessions/` |

### Risk: Low — dead code only.
### Verify: `npm test`; game plays normally.

---
---

## 4. P5 — Delete Deprecated Combat Functions

### Problem

`src/world/combat.ts` contains four functions explicitly marked `@deprecated`
with comments "safe to delete once tests are updated":

1. `getEffectiveDefense` (line ~417) — replaced by `getDefencePower`
2. `getBestNearbyDefense` (line ~430) — no longer called
3. `isEncircled` (line ~449) — no longer affects damage formula
4. `calculateDamage` (line ~493) — replaced by `calculateFormulaDamage`

### Design

1. Open `src/world/__tests__/combat.test.ts`.
2. For each deprecated function:
   - If a test imports it, rewrite the test to call the replacement function
     (or delete the test if it only asserts deprecated behaviour).
3. Remove the four deprecated functions from `combat.ts`.
4. Remove their exports from `src/world/index.ts` (if present).

### Migration Table

| Deprecated | Replacement | Test action |
|-----------|-------------|-------------|
| `getEffectiveDefense` | `getDefencePower` | Rewrite assertions to use `getDefencePower` |
| `getBestNearbyDefense` | (none — dead) | Delete test |
| `isEncircled` | (none — dead) | Delete test |
| `calculateDamage` | `calculateFormulaDamage` + `getDefencePower` | Rewrite to use new API |

### Risk: Low — all deprecated, all have clear replacements.
### Verify: `npm test` passes.

---
---

## 5. P10 — Split `unitModel.ts` Bolt-On Builders

### Problem

`client/unitModel.ts` (597 lines) contains the top-level `buildUnitModel`
dispatcher plus 7 "add-on" builder functions (`addGunBarrel`, `addSplashAttack`,
`addArmour`, `addDefence`, `addRepair`, `addAntiAir`, `createRadarDishGeometry`).
The add-ons are independent of each other and of the chassis builders.

### Design

Create **`client/unitModelAddons.ts`** (~450 lines) containing:
- `addGunBarrel`
- `addSplashAttack`
- `addArmour`
- `addDefence`
- `addRepair`
- `addAntiAir`
- `createRadarDishGeometry`

Leave in `unitModel.ts` (~150 lines):
- `initMaterials`, `isTextureReady`
- `UnitModelAttrs` interface
- `buildUnitModel` (imports add-on functions)

### Changes

| File | Action |
|------|--------|
| `client/unitModelAddons.ts` | Create — move 7 add-on functions + radar geometry |
| `client/unitModel.ts` | Remove moved functions; add imports from `unitModelAddons.ts` |

### Risk: Low — mechanical move, no logic changes.
### Verify: 3D unit sprites render identically in browser.

---
---

## 6. P4 — Consolidate Movement Helpers

### Problem

`client/localMap.ts` reimplements `getMaxMovement`, `getMovementMode`,
`isImpassableTerrain`, and `hexEntryCost` as instance methods despite
`shared/movementConstants.ts` already exporting the same logic. The client
versions can silently drift from the server's version.

`client/turnManager.ts` also has its own `getMaxMovement` copy.

### Design

1. **Widen `shared/movementConstants.ts` types** if needed — its `MovementTile`
   interface already accepts both client `TileData` and server `Tile`.
2. **In `localMap.ts`**: replace the 5 movement instance methods with imports
   from `shared/movementConstants.ts`:
   ```ts
   import {
     getMovementMode,
     hexEntryCost,
     getMaxMovement,
     isImpassableTerrain,
   } from '../shared/movementConstants.js';
   ```
   Each method on `LocalMapView` becomes a one-liner delegation:
   ```ts
   getMaxMovement(unit: UnitData): number {
     return getMaxMovement(unit.attributes);
   }
   ```
3. **In `turnManager.ts`**: replace the private `getMaxMovement` with the
   shared import.
4. **Keep `MapViewInterface` stable** — the public method signatures don't change.

### Potential type adjustments

`shared/movementConstants.ts` currently takes `UnitAttributes` for
`getMovementMode` and a `MovementTile` for `hexEntryCost`. The client's
`TileData` must satisfy `MovementTile` — confirm the shape matches:
```ts
interface MovementTile { terrain: string; f?: boolean; elevType?: string; }
```
Client's `TileData` has `terrain`, `f`, and `elevType` — ✓ compatible.

### Changes

| File | Action |
|------|--------|
| `shared/movementConstants.ts` | Add `getMaxMovement(attrs)` and `isImpassableTerrain(terrain)` if not already exported |
| `client/localMap.ts` | Remove 5 method bodies; import + delegate |
| `client/turnManager.ts` | Remove private `getMaxMovement`; import from shared |

### Risk: Low–Medium
The `hexEntryCost` values must be identical between client and server. Confirm
with a quick diff that the logic matches before deleting the client copy.

### Verify: `npm test`; movement overlay unchanged; AI turn produces same paths.

---
---

## 7. P7 — Extract Pure Functions from `LocalMapView`

### Problem

Several methods on `LocalMapView` don't use `this` beyond accessing
`this.world.tiles` — they are pure geometry/pathfinding functions trapped inside
a class.

### Design

Create **`client/localMapGeometry.ts`** containing:

```ts
export function findPathBFS(from: number, to: number, tiles: TileData[]): number[] | null;
export function computeFacingAngle(fromTile: number, toTile: number, tiles: TileData[]): number;
export function angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5;
export function findPreferredSegment(sourceSegment: number, occupied: Set<number>): number;
export function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): boolean;
export function findSegmentAt(
  sx: number, sy: number, ft: FlatTileRef,
  worldToScreen: (wx: number, wy: number) => [number, number]
): number;
```

After P4, also include `affordableHops` and `mpSpentForHops` here (they become
pure once `hexEntryCost` is imported from shared).

In `localMap.ts`, each method becomes a one-liner delegation:
```ts
findPathBFS(from: number, to: number): number[] | null {
  return findPathBFS(from, to, this.world.tiles);
}
```

### Changes

| File | Action |
|------|--------|
| `client/localMapGeometry.ts` | Create — ~180 lines of pure functions |
| `client/localMap.ts` | Remove method bodies; import + delegate |

### Risk: Low — pure function extraction, no state change.
### Verify: `npm test`; movement and pathfinding unchanged. Can add vitest unit
tests for the pure functions as a bonus.

---
---

## 8. P2 — Deduplicate State (LocalMapView → TurnManager)

### Problem

`LocalMapView` maintains its own `movementPoints`, `actedUnits`, and
`selectedUnits` fields, duplicating the same state that `TurnManager` already
tracks. Both are updated in parallel via `setTurnManager()` wiring — drift is
possible and confusing for future sessions.

### Design

1. Remove `movementPoints`, `actedUnits`, `selectedUnits` fields from
   `LocalMapView`.
2. All reads of those fields go through `this.turnManager!.*` instead.
3. Update `MapViewInterface` — currently exposes these as direct properties.
   Change to getter methods (or retain the property signatures backed by
   TurnManager):
   ```ts
   get movementPoints(): Map<string, number> { return this.turnManager!.movementPoints; }
   get actedUnits(): Set<string> { return this.turnManager!.actedUnits; }
   get selectedUnits(): Set<string> { return this.turnManager!.selectedUnits; }
   ```
4. Move `selectedUnits` into `TurnManager` (it's turn-scoped state).
5. Remove `resetMovementPoints()`, `consumeMovement()`, `recordAction()`,
   `hasActed()`, `getRemainingMovement()` from `LocalMapView` — they become
   pass-throughs to TurnManager or are already there.

### Changes

| File | Action |
|------|--------|
| `client/localMap.ts` | Remove 3 state fields + 5 methods; add getters delegating to TurnManager |
| `client/turnManager.ts` | Add `selectedUnits: Set<string>`; ensure all methods exist |
| `client/mapInput.ts` | Update `MapViewInterface` — fields become readonly getters (type-compatible) |

### Risk: Medium
`mapInput.ts` writes to `selectedUnits` and `movementPoints` directly. Those
writes must be redirected to TurnManager mutators. Carefully audit all
assignments in `mapInput.ts`.

### Verify: `npm test`; full play-test (select units, move, attack, end turn, AI turn).

---
---

## 9. P1 — Split `localMap.ts` into Modules

### Problem

`client/localMap.ts` is 1901 lines with 60+ methods. After P4/P7/P2, many
methods are already one-liner delegations — but the terrain rendering and unit
drawing still live inline.

### Design

#### Target structure (post P4/P7/P2):

```
client/
  localMap.ts              ~200 lines — class shell, constructor, render() orchestrator
  localMapProjection.ts    ~120 lines — buildFlatView, worldToScreen, screenToWorld, findTileAt, pointInPoly
  localMapTerrain.ts       ~650 lines — all terrain fill/shading/contour/water/forest drawing
  localMapUnits.ts         ~200 lines — drawUnits, drawCombatHighlight, getSegmentCentroid, getSegmentIconSize
  localMapMovement.ts      ~350 lines — computeMovementRange, drawMovementRange, drawZoneBoundary, drawTileOverlay
  localMapGeometry.ts      (already exists from P7)
```

#### Module responsibilities

**`localMapProjection.ts`** — pure coordinate math:
```ts
export function buildFlatView(world: WorldData, centreIdx: number, radius: number): FlatTile[];
export function worldToScreen(wx: number, wy: number, canvasRect: DOMRect, scale: number, offsetX: number, offsetY: number): [number, number];
export function screenToWorld(sx: number, sy: number, canvasRect: DOMRect, scale: number, offsetX: number, offsetY: number): [number, number];
export function findTileAt(flatTiles: FlatTile[], sx: number, sy: number, wts: WorldToScreenFn): number;
export function pointInPoly(px: number, py: number, poly: {x:number;y:number}[]): boolean;
```

**`localMapTerrain.ts`** — stateless class receiving ctx + view params:
```ts
export class TerrainRenderer {
  constructor(ctx: CanvasRenderingContext2D, world: WorldData);
  setViewTransform(scale: number, offsetX: number, offsetY: number, canvasRect: DOMRect): void;
  drawAllTiles(flatTiles: FlatTile[], selectedTile: number, selectedSegment: number): void;
}
```
Internals: `drawTerrainFeathering`, `drawContourRelief`, `drawWaterSurfaceLighting`,
`drawPeakTriangularRelief`, `drawSingleHexRelief`, `drawContourEdgeRelief`,
`drawElevationShading`, `drawForestCornerTrees`, `drawSegmentLines`,
`drawSegmentHighlight`, `drawTreeIcon`, `drawWaterBoundaryEdges`,
`elevationHeight`, `elevationLevel`, `isWaterTile`, `terrainFillColor`,
`neighbourAcrossSegment`, `isContourBandTile`, `hash01`, `hexToRgb`,
`mixHexColors`, `clipToTile`, `fillContourGradientBand`, `strokeContourSegment`.

**`localMapUnits.ts`** — unit rendering:
```ts
export function drawUnits(ctx, world, flatTiles, selectedUnits, movementPoints, activeFaction, hiddenUnits, wts): void;
export function drawCombatHighlight(ctx, world, flatTiles, attackerId, targetId, wts): void;
export function getSegmentCentroid(ft, segment, wts): {x:number;y:number} | null;
export function getSegmentIconSize(ft, segment, wts): number;
```

**`localMapMovement.ts`** — range computation + overlay rendering:
```ts
export function computeMovementRange(world, unit, remainingMP, mode, maxMP): { moveRange, attackReady, weaponRange };
export function drawMovementRange(ctx, flatTiles, moveRange, attackReady, weaponRange, wts): void;
```

#### Migration steps (within this session)

| Step | Extract | Verify |
|------|---------|--------|
| 1 | `localMapProjection.ts` | Map renders, panning works |
| 2 | `localMapTerrain.ts` | Terrain visually identical |
| 3 | `localMapUnits.ts` | Units render correctly |
| 4 | `localMapMovement.ts` | Movement overlay unchanged |
| 5 | Slim `localMap.ts` — wire imports | Full play-test |

#### Interface stability

`LocalMapView` still implements `MapViewInterface`. Each extracted method
becomes a delegation:
```ts
worldToScreen(wx: number, wy: number): [number, number] {
  return worldToScreen(wx, wy, this.canvasRect, this.scale, this.offsetX, this.offsetY);
}
```

No changes to `mapInput.ts` or any other consumer.

#### Dependency graph (post-split)

```
localMap.ts
  ├── localMapProjection.ts    (pure)
  ├── localMapTerrain.ts       (rendering → projection, colors, worldData)
  ├── localMapUnits.ts         (rendering → projection, unitIcons, colors)
  ├── localMapMovement.ts      (compute + render → projection, geometry)
  ├── localMapGeometry.ts      (pure, from P7)
  ├── combatAnimations.ts      (existing)
  └── mapInput.ts              (existing, unchanged)
```

No circular dependencies.

### Risk: High (largest change, most files touched)
### Mitigations:
- Execute after P2/P4/P7 so the file is already ~300 lines smaller.
- Keep `render()` call order identical to prevent draw-order regressions.
- Screenshot-diff before/after for terrain and unit rendering.

### Verify: `npm test`; visual comparison at multiple zoom levels; play-test
movement, attack, AI turn.

### Success criteria:
- `localMap.ts` ≤ 250 lines.
- No new module > 700 lines.
- All methods still callable via `LocalMapView`.
- Zero visual diff.

---
---

## 10. P8 — Split `src/world/combat.ts`

### Problem

`src/world/combat.ts` is 967 lines mixing:
- Damage math (pure formulas)
- Facing/arc geometry (directional calculations)
- Combat resolution (orchestrates the above + applies state)

### Design

Split into three files:

**`src/world/combatMath.ts`** (~200 lines) — pure damage formulas:
```ts
export function calculateRangeEfficiency(distance: number): number;
export function calculateModifiedAttackPower(unit, distance): number;
export function applyDroneIncomingDamageModifier(damage, unit): number;
export function calculateFormulaDamage(attackPower, effectiveDefence): number;
export function calculateDirectDamage(...): number;
export function calculateSplashDamage(...): { damage, events };
export function applyDamage(currentHealth, damage): number;
export function clamp(value, min, max): number;
export function getChassisAttackModifier(unit): number;
export function isDrone(unit): boolean;
```

**`src/world/combatFacing.ts`** (~180 lines) — arc/orientation geometry:
```ts
export function getDirectionBetweenAdjacentHexes(fromTile, toTile, tiles): number;
export function getApproachDirection(attackerTile, targetTile, tiles): number;
export function classifyAttackArc(approachDirection, targetFacing): AttackArc;
export function getFacingModifier(arc): number;
export function getOrientationBonus(orientation): number;
export function getCrossfireBonus(attackers, target, tiles): number;
```

**`src/world/combat.ts`** (~580 lines) — resolution + support logic:
```ts
// Imports from combatMath and combatFacing
export function resolveAttack(...): CombatResult;
export function resolveReactionFire(...): ...;
export function resolveAntiAirReactionFireForTile(...): ...;
export function resolveSimultaneousAttacks(...): ...;
export function calculateAntiAirReactionDamage(...): number;
export function chooseWeaponOption(options, target): WeaponOption;
export function getAdjacentFriendlySupport(...): number;
export function getEWDefense(...): number;
export function getTerrainDefense(tile): number;
export function getDefencePower(...): number;
export function isEncircled(...): boolean; // if not deleted in P5
// Interfaces: SplashEvent, CombatResult, WeaponOption
```

**`src/world/index.ts`** — update barrel exports to re-export from all three.

### Changes

| File | Action |
|------|--------|
| `src/world/combatMath.ts` | Create |
| `src/world/combatFacing.ts` | Create |
| `src/world/combat.ts` | Slim down; import from new siblings |
| `src/world/index.ts` | Add re-exports |
| `server/combat.ts` | Update imports if needed |
| `server/combatExplainer.ts` | Update imports if needed |

### Risk: Medium
The seams are clean (math vs geometry vs orchestration), but `combat.test.ts`
(831 lines) imports many functions — all import paths need updating.

### Verify: `npm test` (combat tests are comprehensive); AI turn plays correctly.

---
---

## Summary Checklist

| # | ID | ~Lines saved from context | Key new files |
|---|-----|--------------------------|---------------|
| 1 | P3 | ~20 (duplication) | `htmlUtils.ts`, `unitModelTypes.ts` |
| 2 | P6 | ~800 (from index.html) | `styles.css` |
| 3 | P9 | ~10 | — |
| 4 | P5 | ~120 | — |
| 5 | P10 | ~450 (from unitModel.ts) | `unitModelAddons.ts` |
| 6 | P4 | ~50 (duplication) | — |
| 7 | P7 | ~180 (from localMap.ts) | `localMapGeometry.ts` |
| 8 | P2 | ~80 (from localMap.ts) | — |
| 9 | P1 | ~1650 (from localMap.ts) | `localMapProjection.ts`, `localMapTerrain.ts`, `localMapUnits.ts`, `localMapMovement.ts` |
| 10 | P8 | ~380 (from combat.ts) | `combatMath.ts`, `combatFacing.ts` |

**Total context reduction per typical session:** 60–80% fewer tokens loaded for
any single-feature change to terrain, units, movement, or combat.
