/**
 * MapInputHandler — owns all 8 canvas/window input event listeners for the
 * local map view. Extracted from LocalMapView so the renderer stays focused
 * on drawing.
 */

import { UnitData, TileData, WorldData } from './worldData.js';
import { dbg } from './debug.js';

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
  selectedUnits: Set<string>;
  movementPoints: Map<string, number>;
  actedUnits: Set<string>;

  // Hover-enemy tracking (read + write)
  lastHoveredEnemyId: string | null;

  // Callbacks (read-only from handler's perspective)
  readonly onTileSelectCb: (tileIndex: number, segment?: number) => void;
  readonly onTurnEnd: (() => void) | null;
  readonly onAttack: ((attackerId: string, targetId: string) => void) | null;
  readonly onRepair: ((repairerId: string, targetId: string) => void) | null;
  readonly onHoverEnemy: ((attacker: UnitData | null, target: UnitData | null) => void) | null;
  readonly onCentreChange: ((tileIndex: number) => void) | null;

  // Coordinate conversion
  worldToScreen(wx: number, wy: number): [number, number];
  screenToWorld(sx: number, sy: number): [number, number];

  // Hit testing
  findTileAt(sx: number, sy: number): number;
  findSegmentAt(sx: number, sy: number, ft: FlatTileRef): number;

  // Rendering
  render(): void;
  computeMovementRange(): void;
  buildFlatView(centreIdx: number, radius: number): FlatTileRef[];
  screenHexRadius(ft: FlatTileRef): number;

  // Movement helpers
  getMaxMovement(unit: UnitData): number;
  getMovementMode(unit: UnitData): 'wheeled' | 'limb' | 'flight';
  hexEntryCost(tile: TileData, mode: 'wheeled' | 'limb' | 'flight', isFirstHex: boolean): number;
  affordableHops(path: number[], unit: UnitData, remainingMP: number, hexesAlreadyMoved: number): number;
  mpSpentForHops(path: number[], unit: UnitData, hops: number, hexesAlreadyMoved: number): number;
  findPreferredSegment(sourceSegment: number, occupied: Set<number>): number;
  findPathBFS(from: number, to: number): number[] | null;
  isImpassableTerrain(terrain: string): boolean;
  computeFacingAngle(fromTileIndex: number, toTileIndex: number): number;
  angleToFacing(angle: number): 0 | 1 | 2 | 3 | 4 | 5;
}

export class MapInputHandler {
  private canvas: HTMLCanvasElement;
  private view: MapViewInterface;

  // Bound listener references (needed for removeEventListener)
  private boundClick: (e: MouseEvent) => void;
  private boundRightClick: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: () => void;
  private boundMouseLeave: () => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, view: MapViewInterface) {
    this.canvas = canvas;
    this.view = view;

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
      dbg.localMap.log('Click hit tile:', tileIdx, 'segment:', segment, '| terrain:', v.world.tiles[tileIdx]?.terrain);
      v.selectedTile = tileIdx;
      v.selectedSegment = segment;

      // Unit selection: select units on this tile (only active faction)
      const tileUnits = v.world.units.filter((u) => u.tileIndex === tileIdx);
      if (event.shiftKey) {
        // Shift+click: select all active-faction units on the hex
        v.selectedUnits.clear();
        for (const u of tileUnits) {
          if (u.ownerId === v.activeFaction) {
            v.selectedUnits.add(u.id);
          }
        }
      } else if (segment >= 0) {
        // Normal click on segment: select unit in that segment (if it's active faction)
        v.selectedUnits.clear();
        const segUnit = tileUnits.find((u) => u.segment === segment);
        if (segUnit && segUnit.ownerId === v.activeFaction) {
          v.selectedUnits.add(segUnit.id);
        }
      } else {
        // Click on empty area of the tile
        v.selectedUnits.clear();
      }

      dbg.localMap.log('Selected units:', [...v.selectedUnits]);
      v.computeMovementRange();
      v.onTileSelectCb(tileIdx, segment >= 0 ? segment : undefined);
      if (v.selectedUnits.size === 0) this.canvas.style.cursor = '';
      v.render();
    } else {
      dbg.localMap.log('Click missed (no tile at position)');
      v.selectedUnits.clear();
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
    if (v.onHoverEnemy && v.selectedUnits.size > 0) {
      const tileIdx = v.findTileAt(x, y);
      if (tileIdx >= 0) {
        const ft = v.flatTiles.find((f) => f.tileIndex === tileIdx);
        const segment = ft ? v.findSegmentAt(x, y, ft) : -1;

        const playerUnits = v.world.units.filter((u) => v.selectedUnits.has(u.id));
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
            return;
          }
        }
      }
      // No enemy under cursor — clear preview and reset cursor
      this.canvas.style.cursor = '';
      if (v.lastHoveredEnemyId !== null) {
        v.lastHoveredEnemyId = null;
        v.onHoverEnemy(null, null);
      }
    } else {
      this.canvas.style.cursor = '';
    }
  }

  private onWheel(event: WheelEvent): void {
    const v = this.view;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    v.scale *= factor;
    v.scale = Math.max(0.3, Math.min(15, v.scale));
    dbg.localMap.log('Zoom scale:', v.scale.toFixed(2));
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
        unit.facing = 0 as 0 | 1 | 2 | 3 | 4 | 5;
      }
      dbg.localMap.log('All units face North');
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
        tileUnits[i].facing = seg as 0 | 1 | 2 | 3 | 4 | 5;
      }
      dbg.localMap.log('Defensive orientation: units spread outward');
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
          unit.segment = ((unit.segment + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
        }
        dbg.localMap.log('Whole-hex Shift-rotate segments (facing preserved), dir:', direction);
      } else {
        for (const unit of tileUnits) {
          unit.facing = ((unit.facing + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
        }
        dbg.localMap.log('Whole-hex rotate facing, dir:', direction);
      }
    } else {
      if (event.shiftKey) {
        const selectedUnit = tileUnits.find((u) => u.segment === v.selectedSegment);
        const selectedFacing = selectedUnit ? selectedUnit.facing : 0;
        for (const unit of tileUnits) {
          unit.segment = ((unit.segment + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
          unit.facing = selectedFacing;
        }
        v.selectedSegment = ((v.selectedSegment + direction + 6) % 6);
        dbg.localMap.log('Single-unit Shift-rotate segments (facing copies selected), dir:', direction);
      } else {
        const selectedUnit = tileUnits.find((u) => u.segment === v.selectedSegment);
        if (selectedUnit) {
          selectedUnit.facing = ((selectedUnit.facing + direction + 6) % 6) as 0 | 1 | 2 | 3 | 4 | 5;
          dbg.localMap.log('Single-unit rotate facing:', selectedUnit.label, 'dir:', direction);
        }
      }
    }

    v.onTileSelectCb(v.selectedTile, v.selectedSegment >= 0 ? v.selectedSegment : undefined);
    v.render();
  }

  private onRightClick(event: MouseEvent): void {
    event.preventDefault();
    const v = this.view;

    if (v.selectedUnits.size === 0) return;

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

    // --- Attack check ---
    const unitsOnTarget = v.world.units.filter((u) => u.tileIndex === targetTile);
    const playerUnits = v.world.units.filter((u) => v.selectedUnits.has(u.id));
    if (playerUnits.length > 0) {
      const playerOwner = playerUnits[0].ownerId;

      let enemyTarget: UnitData | undefined;
      if (targetSegment >= 0) {
        enemyTarget = unitsOnTarget.find((u) => u.segment === targetSegment && u.ownerId !== playerOwner);
      }
      if (!enemyTarget) {
        enemyTarget = unitsOnTarget.find((u) => u.ownerId !== playerOwner);
      }

      if (enemyTarget && v.onAttack) {
        const attacker = playerUnits.find(
          (u) => (v.movementPoints.get(u.id) ?? 0) >= 1 && !v.actedUnits.has(u.id)
        );
        if (!attacker) {
          dbg.localMap.log('Attack blocked — no eligible attacker (no MP or already acted)');
          return;
        }
        dbg.localMap.log('Attack command:', attacker.label, '→', enemyTarget.label);
        v.actedUnits.add(attacker.id);
        v.movementPoints.set(attacker.id, 0);
        v.onAttack(attacker.id, enemyTarget.id);
        return;
      }

      // --- Repair check ---
      if (!enemyTarget && v.onRepair) {
        const repairer = playerUnits.find(
          (u) =>
            (u.attributes.repair ?? 0) >= 1 &&
            (v.movementPoints.get(u.id) ?? 0) > 0 &&
            !v.actedUnits.has(u.id)
        );
        if (repairer) {
          let friendlyTarget: UnitData | undefined;
          if (targetSegment >= 0) {
            friendlyTarget = unitsOnTarget.find(
              (u) =>
                u.segment === targetSegment &&
                u.ownerId === playerOwner &&
                u.id !== repairer.id &&
                u.currentHealth < (u.attributes.maxHealth ?? 1) * 10
            );
          }
          if (!friendlyTarget) {
            friendlyTarget = unitsOnTarget.find(
              (u) =>
                u.ownerId === playerOwner &&
                u.id !== repairer.id &&
                u.currentHealth < (u.attributes.maxHealth ?? 1) * 10
            );
          }
          if (friendlyTarget && repairer.tileIndex === friendlyTarget.tileIndex) {
            dbg.localMap.log('Repair command:', repairer.label, '→', friendlyTarget.label);
            v.actedUnits.add(repairer.id);
            v.movementPoints.set(repairer.id, 0);
            v.onRepair(repairer.id, friendlyTarget.id);
            return;
          }
        }
      }
    }

    // --- Movement ---
    const units = v.world.units;
    const movingUnits = units.filter(
      (u) => v.selectedUnits.has(u.id) && (v.movementPoints.get(u.id) ?? 0) > 0
    );
    if (movingUnits.length === 0) return;

    if (v.isImpassableTerrain(targetTileData.terrain)) {
      const allFlight = movingUnits.every((u) => v.getMovementMode(u) === 'flight');
      if (!allFlight) {
        dbg.localMap.log('Movement blocked: impassable tile');
        return;
      }
    }

    const originTile = movingUnits[0].tileIndex;
    const allSameOrigin = movingUnits.every((u) => u.tileIndex === originTile);

    if (allSameOrigin) {
      const path = v.findPathBFS(originTile, targetTile);
      if (!path || path.length < 2) return;

      const groupHops = Math.min(
        ...movingUnits.map((u) => {
          const remaining = v.movementPoints.get(u.id) ?? 0;
          const totalMP = v.getMaxMovement(u);
          const alreadyMoved = totalMP - remaining > 0 ? 1 : 0;
          return v.affordableHops(path, u, remaining, alreadyMoved);
        })
      );

      if (groupHops === 0) return;

      const hops = Math.min(groupHops, path.length - 1);
      const destTileIndex = path[hops];
      const prevTileIndex = path[hops - 1];

      const existingAtDest = units.filter(
        (u) => u.tileIndex === destTileIndex && !v.selectedUnits.has(u.id)
      );
      if (existingAtDest.length + movingUnits.length > 5) {
        dbg.localMap.log('Movement blocked: destination tile would exceed 5 units');
        return;
      }

      const facingAngle = v.computeFacingAngle(prevTileIndex, destTileIndex);
      const moveFacing = v.angleToFacing(facingAngle);
      dbg.localMap.log(
        'Facing: from tile', prevTileIndex, '→ to tile', destTileIndex,
        '| angle (rad):', facingAngle.toFixed(3),
        '| angle (deg):', (facingAngle * 180 / Math.PI).toFixed(1),
        '| facing idx:', moveFacing
      );

      const reachedTarget = destTileIndex === targetTile;
      const useTargetSegment = reachedTarget && targetSegment >= 0 && movingUnits.length === 1;
      const occupiedSegments = new Set<number>(existingAtDest.map((u) => u.segment));
      for (const unit of movingUnits) {
        const preferred = useTargetSegment ? targetSegment : unit.segment;
        const freeSegment = v.findPreferredSegment(preferred, occupiedSegments);
        if (freeSegment < 0) break;

        const remaining = v.movementPoints.get(unit.id) ?? 0;
        const totalMP = v.getMaxMovement(unit);
        const alreadyMoved = totalMP - remaining > 0 ? 1 : 0;
        const mpCost = v.mpSpentForHops(path, unit, hops, alreadyMoved);

        unit.tileIndex = destTileIndex;
        unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
        unit.facing = moveFacing;
        v.movementPoints.set(unit.id, Math.max(0, remaining - mpCost));
        occupiedSegments.add(freeSegment as 0 | 1 | 2 | 3 | 4 | 5);

        dbg.localMap.log(
          'Moved', unit.label, '→ tile', destTileIndex,
          'segment', freeSegment, '| MP spent:', mpCost, '| points left:', v.movementPoints.get(unit.id)
        );
      }
    } else {
      for (const unit of movingUnits) {
        const path = v.findPathBFS(unit.tileIndex, targetTile);
        if (!path || path.length < 2) continue;

        const remaining = v.movementPoints.get(unit.id) ?? 0;
        const totalMP = v.getMaxMovement(unit);
        const alreadyMoved = totalMP - remaining > 0 ? 1 : 0;
        const maxHops = v.affordableHops(path, unit, remaining, alreadyMoved);
        if (maxHops === 0) continue;

        const hops = Math.min(maxHops, path.length - 1);
        const destTileIndex = path[hops];
        const prevTileIndex = path[hops - 1];

        const unitsAtDest = units.filter((u) => u.tileIndex === destTileIndex && u.id !== unit.id);
        if (unitsAtDest.length >= 5) continue;

        const reachedTarget = destTileIndex === targetTile;
        const useTarget = reachedTarget && targetSegment >= 0 && movingUnits.length === 1;
        const preferred = useTarget ? targetSegment : unit.segment;
        const occupiedSegments = new Set<number>(unitsAtDest.map((u) => u.segment));
        const freeSegment = v.findPreferredSegment(preferred, occupiedSegments);
        if (freeSegment < 0) continue;

        const mpCost = v.mpSpentForHops(path, unit, hops, alreadyMoved);

        unit.tileIndex = destTileIndex;
        unit.segment = freeSegment as 0 | 1 | 2 | 3 | 4 | 5;
        unit.facing = v.angleToFacing(v.computeFacingAngle(prevTileIndex, destTileIndex));
        v.movementPoints.set(unit.id, Math.max(0, remaining - mpCost));

        dbg.localMap.log(
          'Moved', unit.label, '→ tile', destTileIndex,
          'segment', freeSegment, '| MP spent:', mpCost, '| points left:', v.movementPoints.get(unit.id)
        );
      }
    }

    // Move selection to follow the units that just moved
    if (movingUnits.length > 0) {
      const dest = movingUnits[0].tileIndex;
      v.selectedTile = dest;
      v.selectedSegment = movingUnits.length === 1 ? movingUnits[0].segment : -1;
    } else {
      v.selectedTile = -1;
      v.selectedSegment = -1;
    }

    v.computeMovementRange();
    v.render();
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
        dbg.localMap.log('Recentering during drag (low zoom):', v.scale.toFixed(2));
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
          dbg.localMap.log(
            'Recentering after drag: distance =', dist.toFixed(3),
            'threshold =', threshold.toFixed(3),
            'zoom =', v.scale.toFixed(2)
          );
          v.centreTileIndex = tileIdx;
          v.flatTiles = v.buildFlatView(tileIdx, v.radius);
          v.offsetX = 0;
          v.offsetY = 0;
          v.render();
        }
      }
    }
  }
}
