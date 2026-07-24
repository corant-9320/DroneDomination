/**
 * First-person command interaction — screen picking plus the select / move /
 * attack / repair / rotate handlers. These mirror the 2D map's input semantics
 * (`MapInputHandler`) and use the SAME pure pathing logic
 * (`computeMovementRange`, `computeMovementRouteForDestination`,
 * `extractMovePlan`) and the SAME shared `TurnManager`, so MP and unit state stay
 * consistent across views.
 *
 * Extracted verbatim from `firstPersonView.ts`. Handlers take an explicit
 * {@link FpInputHost} — a small view of the view's live state plus the few
 * callbacks that need to reach back into it (selection, route overlay, context
 * menu). The view builds a fresh host per event, so `setWorld()` swaps and
 * selection changes are always current.
 */

import * as THREE from 'three';
import type { UnitData } from './worldData.js';
import { type FlatTile, pointInPoly } from './localMapProjection.js';
import {
  getMovementMode,
  isImpassableTerrain,
  ROTATION_FEE,
} from '../shared/movementConstants.js';
import { findPreferredSegment } from './localMapGeometry.js';
import { rotateHexIndex } from './facing.js';
import {
  computeMovementRange,
  computeMovementRouteForDestination,
  computeContextualAttackRoute,
  extractMovePlan,
  isInWeaponRange,
  weaponRangeInTileHops,
  type MovementRangeResult,
  type MovementCostRoute,
} from './localMapMovement.js';
import type { TurnManager } from './turnManager.js';
import { elevationWorldHeight } from './firstPersonTerrain.js';
import { ELEV_WORLD_SCALE } from './firstPersonConstants.js';
import {
  baryWeights,
  segmentCentroid,
  sampleSurface,
  type FpViewContext,
} from './firstPersonGeometry.js';

/**
 * Command wiring injected by main.ts so first-person can issue the same
 * move/attack/repair commands the 2D map does, against the shared TurnManager.
 * When this is null the view stays read-only (look-around only).
 */
export interface FpCommandContext {
  turnManager: TurnManager;
  /** Current ownerId allowed to command units (the active faction). */
  getActiveFaction: () => string;
  /** Resolve an attack (server round-trip) — same handler the 2D map uses. */
  onAttack: (attackerId: string, targetId: string) => void;
  /** Resolve a repair — same handler the 2D map uses. */
  onRepair: (repairerId: string, targetId: string) => void;
  /** Put a unit to sleep (suppresses end-turn warning) — same handler the map uses. */
  onSleep: (unitId: string) => void;
  /** Open the refit/designer modal for a unit — same handler the map uses. */
  onRefit: (unitId: string) => void;
  /** True only when the authoritative session enables God Mode entity actions. */
  isGodModeEntityEditingEnabled: () => boolean;
  /** Development-only authoritative entity actions shared with the 2D map. */
  onGodModeEditUnit: (unitId: string) => void;
  onGodModeDeleteUnit: (unitId: string) => void;
  /** Create a point-to-point shuttle transport from an owned oil structure — same handler the 2D map uses. */
  onCreateShuttleTransport: (structureId: string) => void;
  /** Stop a shuttle transport's automated movement — same handler the 2D map uses. */
  onStopShuttleTransport: (transportId: string) => void;
  /** Notify main that world/turn state changed so the 2D map + panels refresh. */
  onCommit: () => void;
}

/** The slice of first-person view state the command handlers need. */
export interface FpInputHost {
  /** Live world + projection state. */
  ctx: FpViewContext;
  /** Injected command wiring (null = read-only look-around mode). */
  cmd: FpCommandContext | null;
  /** Currently selected commandable unit (own faction). */
  selectedUnitId: string | null;
  /** Movement range of the selected unit, or null. */
  rangeResult: MovementRangeResult | null;
  /** Raycast a screen point to a tile + hex segment, or null if it missed terrain. */
  pick: (clientX: number, clientY: number) => { tileIndex: number; segment: number } | null;
  /** Remaining movement points for a unit (0 when no command context wired). */
  remainingMP: (unitId: string) => number;
  /** Select a unit (recomputing its range) or clear the selection; refreshes overlays. */
  select: (unitId: string | null) => void;
  /** Draw (or clear) the hover route overlay. */
  showRoute: (route: MovementCostRoute | null) => void;
  /** Open the per-unit right-click context menu. */
  openContextMenu: (clientX: number, clientY: number, unit: UnitData) => void;
}

/** Raycast a screen point to a tile + hex segment, or null if it missed terrain. */
export function pickTileSegment(args: {
  camera: THREE.PerspectiveCamera | null;
  canvas: HTMLCanvasElement | null;
  raycaster: THREE.Raycaster;
  pickMeshes: THREE.Mesh[];
  projScale: number;
  flatTiles: FlatTile[];
  clientX: number;
  clientY: number;
}): { tileIndex: number; segment: number } | null {
  const { camera, canvas, raycaster, pickMeshes, projScale, flatTiles, clientX, clientY } = args;
  if (!camera || !canvas || pickMeshes.length === 0) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(pickMeshes, false);
  if (hits.length === 0) return null;

  // Invert the projection: world (x, _, z) → flat (px, py).
  const p = hits[0].point;
  const px = p.x / projScale;
  const py = -p.z / projScale;

  for (const ft of flatTiles) {
    if (pointInPoly(px, py, ft.poly)) {
      return { tileIndex: ft.tileIndex, segment: segmentAtFlat(ft, px, py) };
    }
  }
  return null;
}

/** Which hex sub-triangle (segment) of a tile contains a flat-space point. */
export function segmentAtFlat(ft: FlatTile, px: number, py: number): number {
  const n = ft.poly.length;
  const a = { x: ft.cx, y: ft.cy };
  for (let s = 0; s < n; s++) {
    const w = baryWeights(px, py, a, ft.poly[s], ft.poly[(s + 1) % n]);
    if (w && w[0] >= -1e-6 && w[1] >= -1e-6 && w[2] >= -1e-6) return s;
  }
  return 0;
}

/**
 * Movement range for a unit with `mp` points left — the shared pure pathing the
 * 2D map uses. Returns null when the unit has no movement left.
 */
export function movementRangeFor(
  ctx: FpViewContext,
  unit: UnitData,
  mp: number,
): MovementRangeResult | null {
  if (mp <= 0) return null;
  return computeMovementRange(ctx.world, unit, mp);
}

/** Left-click: select the own-faction unit under the cursor, else deselect. */
export function handleLeftClick(host: FpInputHost, clientX: number, clientY: number): void {
  if (!host.cmd) return;
  const pick = host.pick(clientX, clientY);
  if (!pick) return;
  const world = host.ctx.world;
  const faction = host.cmd.getActiveFaction();
  const unit = world.units.find(
    (u) => u.tileIndex === pick.tileIndex && u.segment === pick.segment && u.ownerId === faction,
  ) ?? world.units.find((u) => u.tileIndex === pick.tileIndex && u.ownerId === faction);
  if (unit) {
    host.select(unit.id);
  } else {
    // [BLDG-DBG] If a building occupies the clicked segment, log its placement data.
    const bldg = world.buildings.find(
      (b) => b.tileIndex === pick.tileIndex && b.segment === pick.segment,
    );
    if (bldg) logBuildingPlacement(host.ctx, bldg.id);
    host.select(null);
  }
}

/**
 * [BLDG-DBG] Dump the placement inputs for one building — sampled ground height,
 * every polygon vertex height, the segment triangle, and neighbour elevations —
 * so a sunken/floating structure can be diagnosed from the browser console.
 */
function logBuildingPlacement(ctx: FpViewContext, buildingId: string): void {
  const world = ctx.world;
  const bldg = world.buildings.find((b) => b.id === buildingId);
  if (!bldg) return;
  const bIdx = world.buildings.indexOf(bldg);
  const ft = ctx.tileById.get(bldg.tileIndex);
  const dbgTile = world.tiles[bldg.tileIndex];
  const fallbackTopDbg = elevationWorldHeight(dbgTile, ELEV_WORLD_SCALE);
  if (!ft) return;

  const cen = segmentCentroid(ft, bldg.segment);
  const { height: groundY } = sampleSurface(ft, cen.x, cen.y, ctx.toWorld, ctx.heightOf, fallbackTopDbg);
  const sampleHitFallback = Math.abs(groundY - fallbackTopDbg) < 1e-4;
  console.log(
    `[BLDG-POS] #${bIdx} id=${bldg.id} tile=${bldg.tileIndex} seg=${bldg.segment}` +
    ` h=${dbgTile?.h ?? 0}` +
    ` ss[seg]=${dbgTile?.ss?.[bldg.segment]?.toFixed(3) ?? 'n/a'}` +
    ` fallbackTop=${fallbackTopDbg.toFixed(3)}` +
    ` groundY=${groundY.toFixed(3)}` +
    ` sampleHitFallback=${sampleHitFallback}`,
  );
  // Dump heights of every polygon vertex so we can see which one is dragging groundY down.
  const n = ft.poly.length;
  for (let i = 0; i < n; i++) {
    const vp = ft.poly[i];
    const vh = ctx.heightOf(ft.tileIndex, vp);
    console.log(
      `[BLDG-VERT] tile=${ft.tileIndex} vert=${i}` +
      ` pos=(${vp.x.toFixed(3)},${vp.y.toFixed(3)})` +
      ` height=${vh.toFixed(3)}` +
      ` inSeg=${i === bldg.segment || i === (bldg.segment + 1) % n ? 'YES' : 'no'}`,
    );
  }
  // Also log the segment's three triangle vertices (centre + two edge verts).
  const va = ft.poly[bldg.segment % n];
  const vb = ft.poly[(bldg.segment + 1) % n];
  const hCen = ctx.heightOf(ft.tileIndex, { x: ft.cx, y: ft.cy });
  const hA   = ctx.heightOf(ft.tileIndex, va);
  const hB   = ctx.heightOf(ft.tileIndex, vb);
  console.log(
    `[BLDG-TRI] seg=${bldg.segment}` +
    ` centre=(${ft.cx.toFixed(3)},${ft.cy.toFixed(3)}) h=${hCen.toFixed(3)}` +
    ` vA=(${va.x.toFixed(3)},${va.y.toFixed(3)}) h=${hA.toFixed(3)}` +
    ` vB=(${vb.x.toFixed(3)},${vb.y.toFixed(3)}) h=${hB.toFixed(3)}`,
  );
  for (let ni = 0; ni < (dbgTile.n?.length ?? 0); ni++) {
    const nIdx = dbgTile.n[ni];
    const nTile = world.tiles[nIdx];
    if (nTile) {
      console.log(
        `[BLDG-NBR] neighbour[${ni}]=${nIdx}` +
        ` terrain=${nTile.terrain}` +
        ` h=${nTile.h ?? 0}` +
        ` elevH=${elevationWorldHeight(nTile, ELEV_WORLD_SCALE).toFixed(3)}`,
      );
    }
  }
}

/**
 * Right-click command dispatcher — mirrors the priority order of the 2D map's
 * onRightClick: attack → repair → move. Uses the shared TurnManager so MP and
 * acted-unit state stay consistent across both views.
 */
export function handleCommand(host: FpInputHost, clientX: number, clientY: number): void {
  if (!host.cmd || !host.selectedUnitId) return;
  const world = host.ctx.world;
  const unit = world.units.find((u) => u.id === host.selectedUnitId);
  if (!unit) return;

  const pick = host.pick(clientX, clientY);
  if (!pick) return;
  const { tileIndex: targetTile, segment: targetSegment } = pick;

  // --- Context menu: right-click on the selected unit's own segment ---
  if (targetTile === unit.tileIndex && targetSegment === unit.segment) {
    host.openContextMenu(clientX, clientY, unit);
    return;
  }

  const tm = host.cmd.turnManager;
  const units = world.units;
  const playerOwner = unit.ownerId;

  // --- Attack ---
  const enemyTarget =
    units.find((u) => u.tileIndex === targetTile && u.segment === targetSegment && u.ownerId !== playerOwner) ??
    units.find((u) => u.tileIndex === targetTile && u.ownerId !== playerOwner);

  if (enemyTarget) {
    const canAct = (tm.movementPoints.get(unit.id) ?? 0) >= 1 && !tm.actedUnits.has(unit.id);
    if (!canAct) return;
    if (!isInWeaponRange(world.tiles, unit, enemyTarget)) return;
    tm.actedUnits.add(unit.id);
    tm.movementPoints.set(unit.id, Math.max(0, (tm.movementPoints.get(unit.id) ?? 0) - 1));
    host.cmd.onAttack(unit.id, enemyTarget.id);
    // MP changed — refresh range; main calls refresh() once the attack resolves.
    host.select(unit.id);
    host.cmd.onCommit();
    return;
  }

  // --- Repair (friendly damaged unit in the same hex) ---
  const repairCapable = (unit.attributes.repair ?? 0) >= 1;
  if (repairCapable && (tm.movementPoints.get(unit.id) ?? 0) > 0 && !tm.actedUnits.has(unit.id)) {
    const maxHp = (target: UnitData) => (target.attributes.size ?? 1) * 10;
    const friendly =
      units.find((u) => u.tileIndex === targetTile && u.segment === targetSegment && u.ownerId === playerOwner && u.id !== unit.id && u.currentHealth < maxHp(u)) ??
      units.find((u) => u.tileIndex === targetTile && u.ownerId === playerOwner && u.id !== unit.id && u.currentHealth < maxHp(u));
    if (friendly && unit.tileIndex === friendly.tileIndex) {
      tm.actedUnits.add(unit.id);
      tm.movementPoints.set(unit.id, Math.max(0, (tm.movementPoints.get(unit.id) ?? 0) - 1));
      host.cmd.onRepair(unit.id, friendly.id);
      host.select(unit.id);
      host.cmd.onCommit();
      return;
    }
  }

  // --- Move ---
  commitMove(host, unit, targetTile, targetSegment);
}

/**
 * Commit a move using the exact pathing the hover preview shows
 * (computeMovementRouteForDestination + extractMovePlan). Mirrors the 2D map's
 * move-commit block. Returns true if the unit moved.
 */
export function commitMove(
  host: FpInputHost,
  unit: UnitData,
  targetTile: number,
  targetSegment: number,
): boolean {
  if (!host.cmd || !host.rangeResult) return false;
  const world = host.ctx.world;
  const remaining = host.remainingMP(unit.id);
  if (remaining <= 0) return false;

  const targetTileData = world.tiles[targetTile];
  if (
    isImpassableTerrain(targetTileData.terrain) &&
    !targetTileData.bridge &&
    getMovementMode(unit.attributes) !== 'flight'
  ) {
    return false;
  }

  const preferredSegment = targetSegment >= 0 ? targetSegment : unit.segment;
  const route = computeMovementRouteForDestination(
    world, unit, targetTile, preferredSegment, remaining, host.rangeResult,
  );
  const plan = extractMovePlan(route, world.tiles);
  if (!plan) return false;
  if (plan.destTile === unit.tileIndex && plan.destSegment === unit.segment) return false;

  const units = world.units;
  const existingAtDest = units.filter((u) => u.tileIndex === plan.destTile && u.id !== unit.id);
  if (plan.destTile !== unit.tileIndex && existingAtDest.length >= 5) return false;

  const occupied = new Set<number>(existingAtDest.map((u) => u.segment));
  const free = findPreferredSegment(plan.destSegment, occupied);
  if (free < 0) return false;

  const travelFacing = (plan.facing ?? unit.facing) as 0 | 1 | 2 | 3 | 4 | 5;
  unit.tileIndex = plan.destTile;
  unit.segment = free as 0 | 1 | 2 | 3 | 4 | 5;
  unit.facing = travelFacing;
  host.cmd.turnManager.movementPoints.set(unit.id, Math.max(0, remaining - plan.mpCost));

  // Recompute range from the new position + refresh overlays/models.
  host.select(unit.id);
  host.cmd.onCommit();
  return true;
}

/** Hover preview — recompute and draw the route line to the hovered tile. */
export function handleHover(host: FpInputHost, clientX: number, clientY: number): void {
  if (!host.cmd || !host.selectedUnitId || !host.rangeResult) {
    host.showRoute(null);
    return;
  }
  const world = host.ctx.world;
  const unit = world.units.find((u) => u.id === host.selectedUnitId);
  if (!unit) { host.showRoute(null); return; }
  const remaining = host.remainingMP(unit.id);
  if (remaining <= 0) { host.showRoute(null); return; }

  const pick = host.pick(clientX, clientY);
  if (!pick) { host.showRoute(null); return; }
  const seg = pick.segment >= 0 ? pick.segment : 0;
  if (pick.tileIndex === unit.tileIndex && seg === unit.segment) { host.showRoute(null); return; }

  const enemy = world.units.find(
    (u) => u.tileIndex === pick.tileIndex && u.segment === seg && u.ownerId !== unit.ownerId,
  );
  const route = enemy
    ? computeContextualAttackRoute(
        world, unit, pick.tileIndex, seg, remaining,
        weaponRangeInTileHops(unit.attributes), host.rangeResult,
      )
    : computeMovementRouteForDestination(
        world, unit, pick.tileIndex, seg, remaining, host.rangeResult,
      );
  host.showRoute(route);
}

/**
 * Charge the once-per-turn rotation fee for a facing change. Returns true if
 * the rotation is allowed (already paid this turn, or paid now). Mirrors
 * MapInputHandler.chargeRotation against the shared TurnManager.
 */
export function chargeRotation(host: FpInputHost, unitId: string): boolean {
  if (!host.cmd) return false;
  const tm = host.cmd.turnManager;
  if (tm.rotatedUnits.has(unitId)) return true;
  const remaining = tm.movementPoints.get(unitId) ?? 0;
  if (remaining < ROTATION_FEE) return false;
  tm.movementPoints.set(unitId, remaining - ROTATION_FEE);
  tm.rotatedUnits.add(unitId);
  return true;
}

/**
 * Arrow-key rotation for the selected unit:
 *  · ←/→        rotate facing one step (charges the once-per-turn fee)
 *  · Shift+←/→  shift the unit to the adjacent hex segment (free re-position)
 *  · ↑          reset facing to neighbour index 0 (charges the fee)
 * Returns true if it handled the key.
 */
export function handleRotateKey(host: FpInputHost, e: KeyboardEvent): boolean {
  if (!host.cmd || !host.selectedUnitId) return false;
  const unit = host.ctx.world.units.find((u) => u.id === host.selectedUnitId);
  if (!unit) return false;

  if (e.key === 'ArrowUp') {
    if (unit.facing !== 0 && chargeRotation(host, unit.id)) {
      unit.facing = 0;
      host.select(unit.id);
    }
    return true;
  }

  const direction = e.key === 'ArrowRight' ? 1 : -1;
  if (e.shiftKey) {
    // Re-position within the hex (segment change) — free, like the 2D map.
    unit.segment = rotateHexIndex(unit.segment, direction);
    host.select(unit.id);
  } else if (chargeRotation(host, unit.id)) {
    unit.facing = rotateHexIndex(unit.facing, direction);
    host.select(unit.id);
  }
  return true;
}

/**
 * Right-click with no unit selected: mirrors the 2D map's "no unit
 * selected" segment menu (`MapInputHandler.onRightClick`), but scoped to
 * the one action that needs identical RMB behaviour in both views —
 * creating/stopping a shuttle transport on an owned oil structure hex.
 * Other segment-menu items (View, Refit, City Design, God Mode) remain
 * 2D-map-only.
 */
export function handleSegmentCommand(host: FpInputHost, clientX: number, clientY: number): void {
  if (!host.cmd) return;
  const pick = host.pick(clientX, clientY);
  if (!pick) return;
  const { tileIndex, segment } = pick;
  const playerFaction = host.cmd.getActiveFaction();
  const logistics = host.ctx.world.logistics;
  if (!logistics) return;

  const well = logistics.wells.find((w) => w.tileIndex === tileIndex && w.segment === segment);
  const refinery = logistics.refineries.find(
    (r) => r.tileIndex === tileIndex && r.segments.includes(segment),
  );
  const hub = logistics.hubs.find((h) => h.tileIndex === tileIndex && h.segment === segment);
  const oilStructure = well ?? refinery ?? hub;

  const shuttle = logistics.transports.find((transport) => {
    if (!transport.shuttleMode || transport.shuttleStopped) return false;
    if (transport.ownerId !== playerFaction) return false;
    const path = transport.shuttlePath ?? [];
    if (path.length === 0) return false;
    const idx = Math.max(0, Math.min(path.length - 1, transport.shuttlePosition ?? 0));
    const key = path[idx];
    return Math.floor(key / 6) === tileIndex && key % 6 === segment;
  });

  if (shuttle) {
    host.cmd.onStopShuttleTransport(shuttle.id);
    return;
  }
  if (oilStructure && oilStructure.ownerId === playerFaction) {
    host.cmd.onCreateShuttleTransport(oilStructure.id);
  }
}
