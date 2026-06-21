/**
 * MapInputHandler — owns all 8 canvas/window input event listeners for the
 * local map view. Extracted from LocalMapView so the renderer stays focused
 * on drawing.
 */

import { UnitData, WorldData } from './worldData.js';
import { ROTATION_FEE } from '../shared/movementConstants.js';
import type { MovePlan } from './localMapMovement.js';
import { rotateHexIndex } from './facing.js';
import { UnitContextMenu } from './unitContextMenu.js';
import { SegmentContextMenu } from './cityContextMenus.js';
import { setEwFocus } from './ewOverlay.js';
import { TurnManager } from './turnManager.js';

/** Minimal polygon tile reference needed by the input handler. */
export interface FlatTileRef {
  tileIndex: number;
  cx: number;
  cy: number;
  poly: { x: number; y: number }[];
  distance: number;
}

/**
 * Minimal interface that MapInputHandler needs from LocalMapView.
 * Exposed as public methods/properties on LocalMapView.
 */
export interface MapViewInterface {
  // World data (read-only reference)
  readonly world: WorldData;

  // Flat tile list (read + write)
  flatTiles: FlatTileRef[];

  // View transform state (read + write)
  offsetX: number;
  offsetY: number;
  scale: number;
  centreTileIndex: number;
  isProgrammaticCentre: boolean;
  lastEmittedCentreTile: number;
  radius: number;

  // Drag state (read + write)
  dragging: boolean;
  mouseDownPos: { x: number; y: number } | null;
  lastMouse: { x: number; y: number };
  dragEmitPending: boolean;

  // Selection state (read + write)
  selectedTile: number;
  selectedSegment: number;
  hoveredTile: number;

  // Unit / faction state (read + write)
  activeFaction: string;

  // Hover-enemy tracking (read + write)
  lastHoveredEnemyId: string | null;

  // Callbacks (read-only from handler's perspective)
  readonly onTileSelectCb: (tileIndex: number, segment?: number) => void;
  readonly onTurnEnd: (() => void) | null;
  readonly onAttack: ((attackerId: string, targetId: string) => void) | null;
  readonly onRepair: ((repairerId: string, targetId: string) => void) | null;
  readonly onHoverEnemy: ((attacker: UnitData | null, target: UnitData | null) => void) | null;
  readonly onCentreChange: ((tileIndex: number) => void) | null;
  readonly onSleepUnit: ((unitId: string) => void) | null;
  readonly onRefit: ((unitId: string) => void) | null;
  readonly onViewUnit: ((unitId: string) => void) | null;
  readonly onViewSegment: ((tileIndex: number, segment: number) => void) | null;
  readonly onCityDesign: ((cityId: string) => void) | null;
  readonly onBuildingRefit: ((buildingId: string) => void) | null;

  // Coordinate conversion
  worldToScreen(wx: number, wy: number): [number, number];
  screenToWorld(sx: number, sy: number): [number, number];

  // Hit testing
  findTileAt(sx: number, sy: number): number;
  findSegmentAt(sx: number, sy: number, ft: FlatTileRef): number;

  // Rendering
  render(): void;
  computeMovementRange(): void;
  computeMovementCostRouteForHover(destTile: number, destSegment: number): void;
  clearMovementCostRoute(): void;
  buildFlatView(centreIdx: number, radius: number): FlatTileRef[];
  screenHexRadius(ft: FlatTileRef): number;
  /** Check if an enemy tile+segment is within immediate attack range (no movement needed). */
  isInAttackRange(enemyTile: number, enemySegment?: number): boolean;

  /** Animate a unit gliding from its origin tile/segment to its current position. */
  playMoveAnimation(unitId: string, fromTile: number, fromSeg: number, newFacing: 0 | 1 | 2 | 3 | 4 | 5): Promise<void>;

  /** Get the current screen position of a unit (null if not visible). */
  getUnitScreenPos(unitId: string): { x: number; y: number } | null;

  // Movement helpers
  getMaxMovement(unit: UnitData): number;
  getMovementMode(unit: UnitData): 'wheeled' | 'limb' | 'flight';
  findPreferredSegment(sourceSegment: number, occupied: Set<number>): number;
  /**
   * Compute the executable move plan for a unit toward a destination tile,
   * using the same route the preview line draws. Returns null if there is
   * nothing to move.
   */
  planMove(unit: UnitData, destTile: number, destSegment: number, remainingMP: number): MovePlan | null;
  isImpassableTerrain(terrain: string): boolean;
  computeFacingAngle(fromTileIndex: number, toTileIndex: number): number;
  angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5;
}

export class MapInputHandler {
  private canvas: HTMLCanvasElement;
  private view: MapViewInterface;
  private tm: TurnManager;
  private contextMenu = new UnitContextMenu();
  private segmentMenu = new SegmentContextMenu();

  // Bound listener references (needed for removeEventListener)
  private boundClick: (e: MouseEvent) => void;
  private boundRightClick: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: () => void;
  private boundMouseLeave: () => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, view: MapViewInterface, tm: TurnManager) {
    this.canvas = canvas;
    this.view = view;
    this.tm = tm;

    this.boundClick = this.onClick.bind(this);
    this.boundRightClick = this.onRightClick.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundWheel = this.onWheel.bind(this);
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundMouseLeave = this.onMouseLeave.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);

    canvas.addEventListener('click', this.boundClick);
    canvas.addEventListener('contextmenu', this.boundRightClick);
    canvas.addEventListener('mousemove', this.boundMouseMove);
    canvas.addEventListener('wheel', this.boundWheel);
    canvas.addEventListener('mousedown', this.boundMouseDown);
    canvas.addEventListener('mouseup', this.boundMouseUp);
    canvas.addEventListener('mouseleave', this.boundMouseLeave);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  /** Remove all event listeners. Call when the view is destroyed. */
  dispose(): void {
    this.canvas.removeEventListener('click', this.boundClick);
    this.canvas.removeEventListener('contextmenu', this.boundRightClick);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    this.canvas.removeEventListener('wheel', this.boundWheel);
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mouseleave', this.boundMouseLeave);
    window.removeEventListener('keydown', this.boundKeyDown);
  }

  // ─── Event handlers ────────────────────────────────────────────────────────

  private onClick(event: MouseEvent): void {
    const v = this.view;
    // Suppress click if the user dragged before releasing
    if (v.mouseDownPos) {
      const dx = event.clientX - v.mouseDownPos.x;
      const dy = event.clientY - v.mouseDownPos.y;
      if (dx * dx + dy * dy > 9) { // > 3px movement = drag, not click
        v.mouseDownPos = null;
        return;
      }
    }
    v.mouseDownPos = null;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const tileIdx = v.findTileAt(x, y);
    if (tileIdx >= 0) {
      const ft = v.flatTiles.find((f) => f.tileIndex === tileIdx);
      let segment = -1;
      // Shift+click selects the whole hex (no segment)
      if (!event.shiftKey && ft && v.world.tiles[tileIdx].s === 6) {
        segment = v.findSegmentAt(x, y, ft);
      }
      v.selectedTile = tileIdx;
      v.selectedSegment = segment;

      // Unit selection: prefer active-faction unit in the segment; fall back to any unit
      // so enemy units can be selected for movement-range display.
      const tileUnits = v.world.units.filter((u) => u.tileIndex === tileIdx);
      if (event.shiftKey) {
        // Shift+click: select all active-faction units on the hex
        this.tm.selectedUnits.clear();
        for (const u of tileUnits) {
          if (u.ownerId === v.activeFaction) {
            this.tm.selectedUnits.add(u.id);
          }
        }
      } else if (segment >= 0) {
        // Normal click on segment: select whatever unit is in that segment
        this.tm.selectedUnits.clear();
        const segUnit = tileUnits.find((u) => u.segment === segment);
        if (segUnit) {
          this.tm.selectedUnits.add(segUnit.id);
        }
      } else {
        // Click on empty area of the tile
        this.tm.selectedUnits.clear();
      }

      v.computeMovementRange();
      v.onTileSelectCb(tileIdx, segment >= 0 ? segment : undefined);
      if (this.tm.selectedUnits.size === 0) this.canvas.style.cursor = '';
      v.render();
    } else {
      this.tm.selectedUnits.clear();
      v.computeMovementRange();
      this.canvas.style.cursor = '';
      v.render();
    }
  }

  private onMouseMove(event: MouseEvent): void {
    const v = this.view;
    if (v.dragging) {
      const dx = event.clientX - v.lastMouse.x;
      const dy = event.clientY - v.lastMouse.y;
      v.offsetX += dx;
      v.offsetY += dy;
      v.lastMouse = { x: event.clientX, y: event.clientY };
      v.isProgrammaticCentre = false;
      v.render();
      this.emitDragCentreThrottled();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Attack preview: when player has a unit selected, hovering an enemy shows preview
    if (v.onHoverEnemy && this.tm.selectedUnits.size > 0) {
      const tileIdx = v.findTileAt(x, y);
      if (tileIdx >= 0) {
        const ft = v.flatTiles.find((f) => f.tileIndex === tileIdx);
        const segment = ft ? v.findSegmentAt(x, y, ft) : -1;

        const playerUnits = v.world.units.filter((u) => this.tm.selectedUnits.has(u.id));
        if (playerUnits.length > 0) {
          const playerOwner = playerUnits[0].ownerId;
          const enemy = v.world.units.find(
            (u) => u.tileIndex === tileIdx && u.segment === segment && u.ownerId !== playerOwner
          );
          if (enemy) {
            this.canvas.style.cursor = 'crosshair';
            if (v.lastHoveredEnemyId !== enemy.id) {
              v.lastHoveredEnemyId = enemy.id;
              v.onHoverEnemy(playerUnits[0], enemy);
            }
            // Show extended route overlay to the enemy (attack range visualization)
            v.computeMovementCostRouteForHover(tileIdx, segment);
            v.render();
            return;
          }

          // No enemy — check if hovering a reachable tile for movement cost overlay
          if (segment >= 0 && (tileIdx !== playerUnits[0].tileIndex || segment !== playerUnits[0].segment)) {
            v.computeMovementCostRouteForHover(tileIdx, segment);
            v.render();
          } else if (tileIdx !== playerUnits[0].tileIndex) {
            // Even without a specific segment, still trigger overlay for radial tracking
            v.computeMovementCostRouteForHover(tileIdx, 0);
            v.render();
          } else {
            v.clearMovementCostRoute();
          }
        }
      } else {
        v.clearMovementCostRoute();
      }
      // No enemy under cursor — clear preview and reset cursor
      this.canvas.style.cursor = '';
      if (v.lastHoveredEnemyId !== null) {
        v.lastHoveredEnemyId = null;
        v.onHoverEnemy(null, null);
      }
    } else {
      this.canvas.style.cursor = '';
      v.clearMovementCostRoute();
    }
  }

  private onWheel(event: WheelEvent): void {
    const v = this.view;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    v.scale *= factor;
    v.scale = Math.max(0.3, Math.min(15, v.scale));
    v.render();
  }

  private onMouseDown(event: MouseEvent): void {
    const v = this.view;
    if (event.button === 0) {
      v.dragging = true;
      v.mouseDownPos = { x: event.clientX, y: event.clientY };
      v.lastMouse = { x: event.clientX, y: event.clientY };
    }
  }

  private onMouseUp(): void {
    const v = this.view;
    if (v.dragging) {
      v.dragging = false;
      this.recenterIfNeeded();
    }
  }

  private onMouseLeave(): void {
    this.onMouseUp();
  }

  /**
   * Charge the once-per-turn rotation fee for a unit's facing change.
   * Returns true if the rotation is allowed (fee already paid this turn, or
   * paid now), false if the unit cannot afford the flat ROTATION_FEE.
   */
  private chargeRotation(unitId: string): boolean {
    if (this.tm.rotatedUnits.has(unitId)) return true; // already paid this turn → free
    const remaining = this.tm.movementPoints.get(unitId) ?? 0;
    if (remaining < ROTATION_FEE) return false;  // cannot afford
    this.tm.movementPoints.set(unitId, remaining - ROTATION_FEE);
    this.tm.rotatedUnits.add(unitId);
    return true;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const v = this.view;
    if (v.selectedTile < 0) return;
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp'
    ) return;

    // ArrowUp with whole hex: all units face North (facing = 0)
    if (event.key === 'ArrowUp') {
      if (v.selectedSegment >= 0) return;
      const units = v.world.units;
      if (!units) return;
      const tileUnits = units.filter((u) => u.tileIndex === v.selectedTile);
      if (tileUnits.length === 0) return;
      event.preventDefault();
      for (const unit of tileUnits) {
        if (unit.facing === 0) continue;            // no change
        if (!this.chargeRotation(unit.id)) continue; // can't afford the fee
        unit.facing = 0 as 0 | 1 | 2 | 3 | 4 | 5;
      }
      v.onTileSelectCb(v.selectedTile, undefined);
      v.render();
      return;
    }

    // ArrowDown with whole hex: defensive orientation
    if (event.key === 'ArrowDown') {
      if (v.selectedSegment >= 0) return;
      const units = v.world.units;
      if (!units) return;
      const tileUnits = units.filter((u) => u.tileIndex === v.selectedTile);
      if (tileUnits.length === 0) return;
      event.preventDefault();
      const step = Math.floor(6 / tileUnits.length);
      for (let i = 0; i < tileUnits.length; i++) {
        const seg = (i * step) % 6;
        tileUnits[i].segment = seg as 0 | 1 | 2 | 3 | 4 | 5;
        // Facing change costs the once-per-turn rotation fee.
        if (tileUnits[i].facing !== seg && this.chargeRotation(tileUnits[i].id)) {
          tileUnits[i].facing = seg as 0 | 1 | 2 | 3 | 4 | 5;
        }
      }
      v.onTileSelectCb(v.selectedTile, undefined);
      v.render();
      return;
    }

    const units = v.world.units;
    if (!units) return;

    const tileUnits = units.filter((u) => u.tileIndex === v.selectedTile);
    if (tileUnits.length === 0) return;

    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const wholeHexSelected = v.selectedSegment < 0;

    if (wholeHexSelected) {
      if (event.shiftKey) {
        for (const unit of tileUnits) {
          unit.segment = rotateHexIndex(unit.segment, direction);
        }
      } else {
        for (const unit of tileUnits) {
          if (!this.chargeRotation(unit.id)) continue;
          unit.facing = rotateHexIndex(unit.facing, direction);
        }
      }
    } else {
      if (event.shiftKey) {
        const selectedUnit = tileUnits.find((u) => u.segment === v.selectedSegment);
        const selectedFacing = selectedUnit ? selectedUnit.facing : 0;
        for (const unit of tileUnits) {
          unit.segment = rotateHexIndex(unit.segment, direction);
          // Copying the selected unit's facing is a rotation — charge the fee.
          if (unit.facing !== selectedFacing && this.chargeRotation(unit.id)) {
            unit.facing = selectedFacing;
          }
        }
        v.selectedSegment = rotateHexIndex(v.selectedSegment, direction);
      } else {
        const selectedUnit = tileUnits.find((u) => u.segment === v.selectedSegment);
        if (selectedUnit && this.chargeRotation(selectedUnit.id)) {
          selectedUnit.facing = rotateHexIndex(selectedUnit.facing, direction);
        }
      }
    }

    v.onTileSelectCb(v.selectedTile, v.selectedSegment >= 0 ? v.selectedSegment : undefined);
    v.render();
  }

  private onRightClick(event: MouseEvent): void {
    event.preventDefault();
    const v = this.view;

    // Close any existing context menu
    this.closeContextMenu();

    // With no unit selected, a right-click on any hex segment opens the segment
    // menu. It always offers "View" (first-person look-around) and, when
    // applicable, "Refit Building" (player-owned building on the segment) or
    // "City Design" (player capital hex). Movement/attack RMB needs a selected
    // unit, so there is no conflict here.
    if (this.tm.selectedUnits.size === 0) {
      const rect0 = this.canvas.getBoundingClientRect();
      const cx = event.clientX - rect0.left;
      const cy = event.clientY - rect0.top;
      const capTile = v.findTileAt(cx, cy);
      if (capTile < 0) return;

      const tileData = v.world.tiles[capTile];
      let seg = -1;
      if (tileData && tileData.s === 6) {
        const ft = v.flatTiles.find((f) => f.tileIndex === capTile);
        if (ft) seg = v.findSegmentAt(cx, cy, ft);
      }

      const homeCity = v.world.cities.find((c) => c.isPlayerHome);
      const playerFaction = homeCity ? (homeCity.ownerId ?? homeCity.id) : null;

      const building = seg >= 0 && playerFaction
        ? v.world.buildings.find(
            (b) => b.tileIndex === capTile && b.segment === seg && b.ownerId === playerFaction,
          )
        : undefined;

      const city = v.world.cities.find((c) => c.tileIndex === capTile && c.isPlayerHome);

      this.showSegmentMenu(event.clientX, event.clientY, {
        tileIndex: capTile,
        segment: seg,
        buildingId: building ? building.id : undefined,
        cityId: city && !building ? city.id : undefined,
      });
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const targetTile = v.findTileAt(x, y);
    if (targetTile < 0) return;

    const targetTileData = v.world.tiles[targetTile];

    let targetSegment: number = -1;
    if (targetTileData.s === 6) {
      const ft = v.flatTiles.find((f) => f.tileIndex === targetTile);
      if (ft) {
        targetSegment = v.findSegmentAt(x, y, ft);
      }
    }

    // --- Context menu: right-click on own selected unit's segment ---
    const playerUnits = v.world.units.filter((u) => this.tm.selectedUnits.has(u.id));
    if (playerUnits.length > 0 && targetSegment >= 0) {
      const clickedUnit = v.world.units.find(
        (u) => u.tileIndex === targetTile && u.segment === targetSegment && this.tm.selectedUnits.has(u.id)
      );
      if (clickedUnit) {
        // Right-clicked on the player's own selected unit — show context menu
        this.showContextMenu(event.clientX, event.clientY, clickedUnit);
        return;
      }
    }

    // --- Attack check ---
    const unitsOnTarget = v.world.units.filter((u) => u.tileIndex === targetTile);
    if (playerUnits.length > 0) {
      const playerOwner = playerUnits[0].ownerId;

      let enemyTarget: UnitData | undefined;
      if (targetSegment >= 0) {
        // Only attack if the clicked segment specifically contains an enemy.
        // If the player clicked an empty segment in an enemy-occupied hex, fall
        // through to movement so they can move into that free segment.
        enemyTarget = unitsOnTarget.find((u) => u.segment === targetSegment && u.ownerId !== playerOwner);
      } else {
        // No specific segment identified (pentagon tile or shift-click) — pick any enemy.
        enemyTarget = unitsOnTarget.find((u) => u.ownerId !== playerOwner);
      }

      if (enemyTarget && v.onAttack) {
        // Range check: only allow attack if enemy is within weapon range from current position
        if (!v.isInAttackRange(enemyTarget.tileIndex, enemyTarget.segment)) {
          return;
        }
        const attacker = playerUnits.find(
          (u) => (this.tm.movementPoints.get(u.id) ?? 0) >= 1 && !this.tm.actedUnits.has(u.id)
        );
        if (!attacker) {
          return;
        }
        this.tm.actedUnits.add(attacker.id);
        this.tm.movementPoints.set(attacker.id, Math.max(0, (this.tm.movementPoints.get(attacker.id) ?? 0) - 1));
        v.onAttack(attacker.id, enemyTarget.id);
        return;
      }

      // --- Repair check ---
      if (!enemyTarget && v.onRepair) {
        const repairer = playerUnits.find(
          (u) =>
            (u.attributes.repair ?? 0) >= 1 &&
            (this.tm.movementPoints.get(u.id) ?? 0) > 0 &&
            !this.tm.actedUnits.has(u.id)
        );
        if (repairer) {
          let friendlyTarget: UnitData | undefined;
          if (targetSegment >= 0) {
            friendlyTarget = unitsOnTarget.find(
              (u) =>
                u.segment === targetSegment &&
                u.ownerId === playerOwner &&
                u.id !== repairer.id &&
                u.currentHealth < (u.attributes.size ?? 1) * 10
            );
          }
          if (!friendlyTarget) {
            friendlyTarget = unitsOnTarget.find(
              (u) =>
                u.ownerId === playerOwner &&
                u.id !== repairer.id &&
                u.currentHealth < (u.attributes.size ?? 1) * 10
            );
          }
          if (friendlyTarget && repairer.tileIndex === friendlyTarget.tileIndex) {
            this.tm.actedUnits.add(repairer.id);
            this.tm.movementPoints.set(repairer.id, Math.max(0, (this.tm.movementPoints.get(repairer.id) ?? 0) - 1));
            v.onRepair(repairer.id, friendlyTarget.id);
            return;
          }
        }
      }
    }

    // --- Movement (single unit) ---
    // NOTE: Group movement is deprecated. Only the primary selected unit moves.
    // The destination and cost come from planMove(), which uses the exact same
    // route computation that draws the on-screen movement line — so the unit
    // always travels precisely where the preview line shows.
    const units = v.world.units;
    const unit = units.find(
      (u) => this.tm.selectedUnits.has(u.id) && (this.tm.movementPoints.get(u.id) ?? 0) > 0,
    );
    if (!unit) return;

    if (v.isImpassableTerrain(targetTileData.terrain) && !targetTileData.bridge && v.getMovementMode(unit) !== 'flight') {
      return;
    }

    const remaining = this.tm.movementPoints.get(unit.id) ?? 0;
    const preferredSegment = targetSegment >= 0 ? targetSegment : unit.segment;

    const plan = v.planMove(unit, targetTile, preferredSegment, remaining);
    if (!plan) return;

    // Nothing to do if the plan keeps the unit exactly where it is
    if (plan.destTile === unit.tileIndex && plan.destSegment === unit.segment) return;

    // Destination occupancy: max 5 units per tile (only when changing tiles)
    const existingAtDest = units.filter(
      (u) => u.tileIndex === plan.destTile && u.id !== unit.id,
    );
    if (plan.destTile !== unit.tileIndex && existingAtDest.length >= 5) {
      return;
    }

    const occupiedSegments = new Set<number>(existingAtDest.map((u) => u.segment));
    const freeSegment = v.findPreferredSegment(plan.destSegment, occupiedSegments);
    if (freeSegment < 0) return;

    // Capture origin tile/segment BEFORE updating world state. The glide is
    // re-projected each frame from these, so it stays correct even if selecting
    // the moved unit recentres the map (globe pan-to-tile) mid-animation.
    const fromTile = unit.tileIndex;
    const fromSeg = unit.segment;

    // Compute travel facing toward the destination tile.
    // plan.facing is the neighbour index in destTile's neighbour array pointing
    // forward (most aligned with the travel direction). See extractMovePlan.
    const travelFacing = plan.facing ?? unit.facing;  // null = intra-hex: keep current facing

    // Update world state (MP, position) — the animation will interpolate from
    // fromPos to the unit's new screen position
    unit.tileIndex = plan.destTile;
    unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
    this.tm.movementPoints.set(unit.id, Math.max(0, remaining - plan.mpCost));

    // Move selection to follow the unit that just moved
    v.selectedTile = unit.tileIndex;
    v.selectedSegment = unit.segment;

    v.computeMovementRange();
    // Refresh detail panel (unit info, squad mates) to reflect the unit's new tile
    v.onTileSelectCb(v.selectedTile, v.selectedSegment);

    // Animate the glide, then lock in the final facing.
    v.playMoveAnimation(unit.id, fromTile, fromSeg, travelFacing).then(() => {
      unit.facing = travelFacing;
      v.render();
    });
  }

  // ─── Drag helpers ──────────────────────────────────────────────────────────

  /**
   * Throttled callback during drag to sync the globe view.
   * At low zoom, also recenter the local map to prevent drift.
   */
  private emitDragCentreThrottled(): void {
    const v = this.view;
    if (v.dragEmitPending) return;
    if (v.isProgrammaticCentre) return;
    v.dragEmitPending = true;
    requestAnimationFrame(() => {
      v.dragEmitPending = false;
      const rect = this.canvas.getBoundingClientRect();
      const centreX = rect.width / 2;
      const centreY = rect.height / 2;
      const tileIdx = v.findTileAt(centreX, centreY);
      if (tileIdx < 0) return;
      if (tileIdx === v.lastEmittedCentreTile) return;
      v.lastEmittedCentreTile = tileIdx;

      if (v.scale < 1.5 && tileIdx !== v.centreTileIndex) {
        v.centreTileIndex = tileIdx;
        // Rebuild flat view in-place via the view's buildFlatView
        v.flatTiles = v.buildFlatView(tileIdx, v.radius);
        v.offsetX = 0;
        v.offsetY = 0;
        v.render();
      }

      if (v.onCentreChange) {
        v.onCentreChange(tileIdx);
      }
    });
  }

  /**
   * Recenter the flat view when the user has dragged far enough.
   * Called on mouse up.
   */
  private recenterIfNeeded(): void {
    const v = this.view;
    const rect = this.canvas.getBoundingClientRect();
    const centreX = rect.width / 2;
    const centreY = rect.height / 2;
    const tileIdx = v.findTileAt(centreX, centreY);
    if (tileIdx < 0) return;

    if (tileIdx !== v.centreTileIndex) {
      const currentCentre = v.flatTiles.find((ft) => ft.tileIndex === v.centreTileIndex);
      const newCentre = v.flatTiles.find((ft) => ft.tileIndex === tileIdx);

      if (currentCentre && newCentre) {
        const dist = Math.sqrt(
          (newCentre.cx - currentCentre.cx) ** 2 +
          (newCentre.cy - currentCentre.cy) ** 2
        );
        const avgRadius =
          v.screenHexRadius(currentCentre) /
          (v.scale * Math.min(rect.width, rect.height) * 3.5);

        const threshold = v.scale < 1.0 ? avgRadius * 1.0 : avgRadius * 3.0;

        if (dist > threshold) {
          v.centreTileIndex = tileIdx;
          v.flatTiles = v.buildFlatView(tileIdx, v.radius);
          v.offsetX = 0;
          v.offsetY = 0;
          v.render();
        }
      }
    }
  }

  // ─── Context menu ──────────────────────────────────────────────────────────

  /** Close and remove any open context menu. */
  private closeContextMenu(): void {
    this.contextMenu.close();
    this.segmentMenu.close();
  }

  /** Show the segment menu (View + optional building/city actions). */
  private showSegmentMenu(
    clientX: number,
    clientY: number,
    actions: { tileIndex: number; segment: number; buildingId?: string; cityId?: string },
  ): void {
    this.segmentMenu.show(clientX, clientY, actions, {
      onViewSegment: this.view.onViewSegment,
      onCityDesign: this.view.onCityDesign,
      onBuildingRefit: this.view.onBuildingRefit,
      onShowEwCoverage: (tileIndex, segment) => {
        setEwFocus(tileIndex, segment);
        this.view.render();
      },
    });
  }

  /** Show a right-click context menu for the player's own unit. */
  private showContextMenu(clientX: number, clientY: number, unit: UnitData): void {
    this.contextMenu.show(clientX, clientY, unit, {
      chargeRotation: (id) => this.chargeRotation(id),
      closeContextMenu: () => this.closeContextMenu(),
      view: this.view,
    });
  }
}
