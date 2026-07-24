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
import { BuildingAttackMenu } from './buildingAttackMenu.js';
import { BUILDING_COMPONENTS, type BuildingComponent } from '../shared/buildingComponents.js';
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
  readonly onAttackBuilding: ((attackerId: string, buildingId: string, mode: 'splash' | 'direct', component?: string) => void) | null;
  readonly onRepair: ((repairerId: string, targetId: string) => void) | null;
  readonly onHoverEnemy: ((attacker: UnitData | null, target: UnitData | null) => void) | null;
  readonly onBuildingHoverEnemy: ((buildingId: string, target: UnitData | null) => void) | null;
  readonly onCentreChange: ((tileIndex: number) => void) | null;
  readonly onSleepUnit: ((unitId: string) => void) | null;
  readonly onRefit: ((unitId: string) => void) | null;
  readonly onViewUnit: ((unitId: string) => void) | null;
  readonly onViewSegment: ((tileIndex: number, segment: number) => void) | null;
  readonly onCityDesign: ((cityId: string) => void) | null;
  readonly onBuildingRefit: ((buildingId: string) => void) | null;
  readonly onGodModeBuildBridge: ((tileIndex: number) => void) | null;
  readonly onGodModeClearForest: ((tileIndex: number) => void) | null;
  readonly onGodModeBuildRoad: ((tileIndex: number, segment: number) => void) | null;
  readonly onGodModeCreateOilBuilding: ((structure: 'well' | 'refinery', tileIndex: number, segment: number) => void) | null;
  readonly onGodModeEditOilBuilding: ((structure: 'well' | 'refinery', structureId: string) => void) | null;
  readonly onGodModeDeleteOilBuilding: ((structure: 'well' | 'refinery', structureId: string, segment: number) => void) | null;
  readonly onGodModeEditUnit: ((unitId: string) => void) | null;
  readonly onGodModeDeleteUnit: ((unitId: string) => void) | null;
  readonly onGodModeEditBuilding: ((buildingId: string) => void) | null;
  readonly onGodModeDeleteBuilding: ((buildingId: string) => void) | null;
  readonly onBuildingSelected: ((buildingId: string | null) => void) | null;
  /** Create a point-to-point shuttle transport from this owned oil structure (RMB action). */
  readonly onCreateShuttleTransport: ((structureId: string) => void) | null;
  /** Stop the shuttle transport currently parked on this segment (RMB action). */
  readonly onStopShuttleTransport: ((transportId: string) => void) | null;

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

  /** Remaining movement points per unit id (owned by TurnManager). */
  readonly movementPoints: Map<string, number>;

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
  /** Contiguous tile-index path for a planned move (for the session move intent). */
  planMovePath(unit: UnitData, destTile: number, destSegment: number, remainingMP: number): number[];
  /** Fired after a player move is committed (unit id, tile path, arrival segment). */
  onMoveCommitted: ((unitId: string, path: number[], segment: number) => void) | null;
  isImpassableTerrain(terrain: string): boolean;
  /** True only when the active authoritative match permits unit-free terrain tasks. */
  isGodModeRemoteTerrainTasksEnabled(): boolean;
  /** True only when the active authoritative match permits standalone road overlays. */
  isGodModeStandaloneRoadConstructionEnabled(): boolean;
  /** True only when the active authoritative match permits entity editing. */
  isGodModeEntityEditingEnabled(): boolean;
  computeFacingAngle(fromTileIndex: number, toTileIndex: number): number;
  angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5;
}

export class MapInputHandler {
  private canvas: HTMLCanvasElement;
  private view: MapViewInterface;
  private tm: TurnManager;
  private contextMenu = new UnitContextMenu();
  private segmentMenu = new SegmentContextMenu();
  private buildingMenu = new BuildingAttackMenu();

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
        this.tm.clearBuilding();
        for (const u of tileUnits) {
          if (u.ownerId === v.activeFaction) {
            this.tm.selectedUnits.add(u.id);
          }
        }
      } else if (segment >= 0) {
        // Normal click on segment: select whatever unit is in that segment
        this.tm.selectedUnits.clear();
        this.tm.clearBuilding();
        const segUnit = tileUnits.find((u) => u.segment === segment);
        if (segUnit) {
          this.tm.selectedUnits.add(segUnit.id);
        } else {
          // No unit in this segment — check for a player-owned building
          const homeCity = v.world.cities.find((c) => c.isPlayerHome);
          const playerFaction = homeCity ? (homeCity.ownerId ?? homeCity.id) : null;
          if (playerFaction) {
            const segBuilding = v.world.buildings.find(
              (b) => b.tileIndex === tileIdx && b.segment === segment && b.ownerId === playerFaction,
            );
            if (segBuilding) {
              this.tm.selectBuilding(segBuilding);
            }
          }
        }
      } else {
        // Click on empty area of the tile
        this.tm.selectedUnits.clear();
        this.tm.clearBuilding();
      }

      v.computeMovementRange();
      v.onBuildingSelected?.(this.tm.selectedBuilding?.id ?? null);
      v.onTileSelectCb(tileIdx, segment >= 0 ? segment : undefined);
      if (this.tm.selectedUnits.size === 0 && !this.tm.selectedBuilding) this.canvas.style.cursor = '';
      v.render();
    } else {
      this.tm.selectedUnits.clear();
      this.tm.clearBuilding();
      v.computeMovementRange();
      v.onBuildingSelected?.(null);
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
    } else if (this.tm.selectedBuilding) {
      // Building selected: show red attack-range line to enemies within weapon range
      const tileIdx = v.findTileAt(x, y);
      if (tileIdx >= 0) {
        const ft = v.flatTiles.find((f) => f.tileIndex === tileIdx);
        const segment = ft ? v.findSegmentAt(x, y, ft) : -1;

        if (segment >= 0) {
          const bOwner = this.tm.selectedBuilding.ownerId;
          const enemy = v.world.units.find(
            (u) => u.tileIndex === tileIdx && u.segment === segment && u.ownerId !== bOwner
          );
          if (enemy && v.isInAttackRange(enemy.tileIndex, enemy.segment)) {
            this.canvas.style.cursor = 'crosshair';
            if (v.lastHoveredEnemyId !== enemy.id) {
              v.lastHoveredEnemyId = enemy.id;
              v.onBuildingHoverEnemy?.(this.tm.selectedBuilding.id, enemy);
            }
            v.computeMovementCostRouteForHover(tileIdx, segment);
            v.render();
            return;
          }
        }
      }
      // No enemy in range under cursor — clear
      this.canvas.style.cursor = '';
      if (v.lastHoveredEnemyId !== null) {
        v.lastHoveredEnemyId = null;
        v.onBuildingHoverEnemy?.(this.tm.selectedBuilding!.id, null);
      }
      v.clearMovementCostRoute();
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
      if (tileData) {
        const ft = v.flatTiles.find((f) => f.tileIndex === capTile);
        if (ft) seg = v.findSegmentAt(cx, cy, ft);
      }

      // Buildings are fully automated (they fire at end of turn via the
      // building-turn resolver) — no manual offensive fire from the UI.

      const homeCity = v.world.cities.find((c) => c.isPlayerHome);
      const playerFaction = homeCity ? (homeCity.ownerId ?? homeCity.id) : null;
      const entityEditingEnabled = v.isGodModeEntityEditingEnabled();

      const building = seg >= 0 && playerFaction
        ? v.world.buildings.find(
            (b) => b.tileIndex === capTile && b.segment === seg && b.ownerId === playerFaction,
          )
        : undefined;
      const godModeBuilding = seg >= 0
        ? v.world.buildings.find((b) => b.tileIndex === capTile && b.segment === seg)
        : undefined;
      const godModeUnit = seg >= 0
        ? v.world.units.find((u) => u.tileIndex === capTile && u.segment === seg)
        : undefined;
      const oilWell = seg >= 0
        ? (v.world.logistics?.wells ?? []).find((well) => well.tileIndex === capTile && well.segment === seg)
        : undefined;
      const refinery = seg >= 0
        ? (v.world.logistics?.refineries ?? []).find(
            (candidate) => candidate.tileIndex === capTile && candidate.segments.includes(seg),
          )
        : undefined;
      const oilHub = seg >= 0
        ? (v.world.logistics?.hubs ?? []).find((hub) => hub.tileIndex === capTile && hub.segment === seg)
        : undefined;
      const oilBuilding = oilWell
        ? { structure: 'well' as const, structureId: oilWell.id }
        : refinery ? { structure: 'refinery' as const, structureId: refinery.id } : undefined;
      // "Create Transport" is offered on any owned well/refinery/storage-hub
      // segment. "Stop Transport" is offered when a shuttle transport is
      // currently parked exactly on this segment.
      const oilStructure = oilWell ?? refinery ?? oilHub;
      const oilStructureId = oilStructure && oilStructure.ownerId === playerFaction
        ? oilStructure.id
        : undefined;
      const shuttleAtSegment = seg >= 0
        ? (v.world.logistics?.transports ?? []).find((transport) => {
            if (!transport.shuttleMode || transport.shuttleStopped) return false;
            if (transport.ownerId !== playerFaction) return false;
            const path = transport.shuttlePath ?? [];
            if (path.length === 0) return false;
            const idx = Math.max(0, Math.min(path.length - 1, transport.shuttlePosition ?? 0));
            const key = path[idx];
            return Math.floor(key / 6) === capTile && key % 6 === seg;
          })
        : undefined;
      // Pending well tasks reserve their target segment and tile designation so
      // the menu cannot offer a conflicting refinery or consume the last road slot.
      const tileOilWells = [
        ...(v.world.logistics?.wells ?? []).filter((well) => well.tileIndex === capTile),
        ...(v.world.logistics?.tasks ?? []).filter(
          (task) => task.kind === 'well' && task.tileIndex === capTile,
        ),
      ];
      const tileRefinerySegments = (v.world.logistics?.refineries ?? [])
        .filter((candidate) => candidate.tileIndex === capTile)
        .reduce((count, candidate) => count + candidate.segments.length, 0);
      const tileStorageSegments = (v.world.logistics?.hubs ?? []).filter(
        (hub) => hub.tileIndex === capTile,
      ).length;
      const oilTileDesignation = tileOilWells.length > 0
        ? 'well'
        : tileRefinerySegments > 0
          ? 'refinery'
          : tileStorageSegments > 0 ? 'storage' : null;
      const maxOilBuildingSegments = Math.max(0, (tileData?.s ?? 0) - 1);

      const city = v.world.cities.find((c) => c.tileIndex === capTile && c.isPlayerHome);
      const remoteTerrainTasksEnabled = v.isGodModeRemoteTerrainTasksEnabled();
      const standaloneRoadConstructionEnabled = v.isGodModeStandaloneRoadConstructionEnabled();
      const roadSegmentKey = capTile * 6 + seg;
      const roadSegmentOccupied = seg < 0
        || godModeBuilding !== undefined
        || godModeUnit !== undefined
        || (v.world.logistics?.wells ?? []).some(
          (well) => well.tileIndex === capTile && well.segment === seg,
        )
        || (v.world.logistics?.refineries ?? []).some(
          (refinery) => refinery.tileIndex === capTile && refinery.segments.includes(seg),
        )
        || (v.world.logistics?.hubs ?? []).some(
          (hub) => hub.tileIndex === capTile && hub.segment === seg,
        )
        || (v.world.logistics?.tasks ?? []).some(
          (task) =>
            (task.kind === 'well' || task.kind === 'road')
            && task.tileIndex === capTile
            && task.segment === seg,
        )
        || (v.world.logistics?.routes ?? []).some((route) => route.segments.includes(roadSegmentKey))
        || (v.world.logistics?.standaloneRoadSegments ?? []).includes(roadSegmentKey);
      const hasPendingBridge = v.world.logistics?.tasks.some(
        (task) => task.kind === 'bridge' && task.tileIndex === capTile,
      ) ?? false;
      const hasPendingForestClear = v.world.logistics?.tasks.some(
        (task) => task.kind === 'clearForest' && task.tileIndex === capTile,
      ) ?? false;

      this.showSegmentMenu(event.clientX, event.clientY, {
        tileIndex: capTile,
        segment: seg,
        buildingId: building ? building.id : undefined,
        cityId: city && !building ? city.id : undefined,
        canBuildBridge: remoteTerrainTasksEnabled
          && !!tileData
          && v.isImpassableTerrain(tileData.terrain)
          && !tileData.bridge
          && !hasPendingBridge,
        canClearForest: remoteTerrainTasksEnabled
          && !!tileData
          && tileData.f === true
          && !tileData.clearedForest
          && !hasPendingForestClear,
        canBuildRoad: standaloneRoadConstructionEnabled
          && !!tileData
          && seg >= 0
          && seg < tileData.s
          && !roadSegmentOccupied
          && !(tileData.f === true && !tileData.clearedForest)
          && !(v.isImpassableTerrain(tileData.terrain) && !tileData.bridge),
        canCreateOilWell: entityEditingEnabled
          && !!tileData
          && seg >= 0
          && seg < tileData.s
          && tileData.resourceType === 'oil'
          && (oilTileDesignation === null || oilTileDesignation === 'well')
          && tileOilWells.length < maxOilBuildingSegments
          && !roadSegmentOccupied,
        canCreateRefinery: entityEditingEnabled
          && !!tileData
          && seg >= 0
          && seg < tileData.s
          && (oilTileDesignation === null || oilTileDesignation === 'refinery')
          && tileRefinerySegments < maxOilBuildingSegments
          && tileData.terrain !== 'ocean'
          && !(tileData.f === true && !tileData.clearedForest)
          && !roadSegmentOccupied,
        oilBuilding: entityEditingEnabled ? oilBuilding : undefined,
        godModeBuildingId: entityEditingEnabled ? godModeBuilding?.id : undefined,
        godModeUnitId: entityEditingEnabled ? godModeUnit?.id : undefined,
        oilStructureId,
        shuttleTransportId: shuttleAtSegment?.id,
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

      // --- Building attack check (building-damage feature) ---
      // No enemy unit in the clicked segment, but an enemy building there can
      // be targeted to degrade its components.
      if (!enemyTarget && v.onAttackBuilding && targetSegment >= 0) {
        const enemyBuilding = v.world.buildings.find(
          (b) => b.tileIndex === targetTile && b.segment === targetSegment && b.ownerId !== playerOwner,
        );
        if (enemyBuilding) {
          if (!v.isInAttackRange(enemyBuilding.tileIndex, enemyBuilding.segment)) {
            return;
          }
          const bAttacker = playerUnits.find(
            (u) =>
              (this.tm.movementPoints.get(u.id) ?? 0) >= 1 &&
              !this.tm.actedUnits.has(u.id) &&
              (((u.attributes.kinetic ?? 0) > 0) || ((u.attributes.splashAttack ?? 0) > 0)),
          );
          if (!bAttacker) {
            return;
          }

          const hasDirect = (bAttacker.attributes.kinetic ?? 0) > 0;
          const hasSplash = (bAttacker.attributes.splashAttack ?? 0) > 0;
          const eligible = BUILDING_COMPONENTS.filter(
            (c) => (enemyBuilding.attributes?.[c] ?? 0) >= 1,
          );

          const fire = (mode: 'splash' | 'direct', component?: BuildingComponent): void => {
            this.tm.actedUnits.add(bAttacker.id);
            this.tm.movementPoints.set(
              bAttacker.id,
              Math.max(0, (this.tm.movementPoints.get(bAttacker.id) ?? 0) - 1),
            );
            v.onAttackBuilding?.(bAttacker.id, enemyBuilding.id, mode, component);
          };

          // Only Splash available, or building has no component for Direct to
          // strike → fire Splash immediately (no choice to make).
          if (hasSplash && (!hasDirect || eligible.length === 0)) {
            fire('splash');
          } else if (!hasSplash && hasDirect && eligible.length === 0) {
            // Direct-only attacker vs a plain building — valid but no effect.
            fire('direct');
          } else {
            // A real choice exists (Direct component pick, or Splash vs Direct).
            this.buildingMenu.show(
              event.clientX,
              event.clientY,
              { hasSplash, hasDirect, eligibleComponents: eligible },
              (mode, component) => fire(mode, component),
            );
          }
          return;
        }
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
      (u) => this.tm.selectedUnits.has(u.id) && u.ownerId === v.activeFaction && (this.tm.movementPoints.get(u.id) ?? 0) > 0,
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

    // Capture the tile-index path BEFORE mutating position, for the
    // authoritative session move intent (skipped for pure intra-hex moves).
    const movePath = v.planMovePath(unit, targetTile, preferredSegment, remaining);

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

    // Animate the glide, then lock in the final facing (fire-and-forget; the
    // animation promise resolves after the visual glide completes).
    void v.playMoveAnimation(unit.id, fromTile, fromSeg, travelFacing).then(() => {
      unit.facing = travelFacing;
      v.render();
    });

    // Mirror the move to the authoritative session (server-authority Phase 3).
    if (movePath.length >= 2) v.onMoveCommitted?.(unit.id, movePath, freeSegment);
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
    this.buildingMenu.close();
  }

  /** Show the segment menu (View + optional building/city actions). */
  private showSegmentMenu(
    clientX: number,
    clientY: number,
    actions: {
      tileIndex: number;
      segment: number;
      buildingId?: string;
      cityId?: string;
      canBuildBridge?: boolean;
      canClearForest?: boolean;
      canBuildRoad?: boolean;
      canCreateOilWell?: boolean;
      canCreateRefinery?: boolean;
      oilBuilding?: { structure: 'well' | 'refinery'; structureId: string };
      godModeBuildingId?: string;
      godModeUnitId?: string;
      oilStructureId?: string;
      shuttleTransportId?: string;
    },
  ): void {
    this.segmentMenu.show(clientX, clientY, actions, {
      onViewSegment: this.view.onViewSegment,
      onCityDesign: this.view.onCityDesign,
      onBuildingRefit: this.view.onBuildingRefit,
      onGodModeBuildBridge: this.view.onGodModeBuildBridge,
      onGodModeClearForest: this.view.onGodModeClearForest,
      onGodModeBuildRoad: this.view.onGodModeBuildRoad,
      onGodModeCreateOilBuilding: this.view.onGodModeCreateOilBuilding,
      onGodModeEditOilBuilding: this.view.onGodModeEditOilBuilding,
      onGodModeDeleteOilBuilding: this.view.onGodModeDeleteOilBuilding,
      onGodModeEditBuilding: this.view.onGodModeEditBuilding,
      onGodModeDeleteBuilding: this.view.onGodModeDeleteBuilding,
      onGodModeEditUnit: this.view.onGodModeEditUnit,
      onGodModeDeleteUnit: this.view.onGodModeDeleteUnit,
      onShowEwCoverage: (tileIndex, segment) => {
        setEwFocus(tileIndex, segment);
        this.view.render();
      },
      onCreateShuttleTransport: this.view.onCreateShuttleTransport,
      onStopShuttleTransport: this.view.onStopShuttleTransport,
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
