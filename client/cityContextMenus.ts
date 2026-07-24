/**
 * Segment right-click context menu (no unit selected).
 *
 * A single menu shown for ANY hex segment, built from whichever actions apply
 * to that segment:
 *
 *   👁 View          — always available: look around from this segment in
 *                      first-person. (Works on empty segments too.)
 *   ⚙ Refit Building — when the segment holds a player-owned building.
 *   🏛 City Design   — when the segment is on the player's capital hex.
 *
 * Extracted from MapInputHandler so DOM construction stays separate from input
 * routing (same pattern as UnitContextMenu / unitContextMenu.ts). Shares the
 * popup chrome (dark panel, hover states, Escape / outside-click to close) via
 * the private helpers below.
 */

/** Callbacks the segment menu invokes for its items. */
export interface CityMenuCallbacks {
  onViewSegment: ((tileIndex: number, segment: number) => void) | null;
  onCityDesign: ((cityId: string) => void) | null;
  onBuildingRefit: ((buildingId: string) => void) | null;
  /** Queue a server-authoritative remote bridge task when God Mode permits it. */
  onGodModeBuildBridge: ((tileIndex: number) => void) | null;
  /** Queue a server-authoritative remote forest-clearing task when God Mode permits it. */
  onGodModeClearForest: ((tileIndex: number) => void) | null;
  /** Build a server-authoritative standalone road overlay when God Mode permits it. */
  onGodModeBuildRoad: ((tileIndex: number, segment: number) => void) | null;
  /** Create one well or refinery footprint on the selected segment. */
  onGodModeCreateOilBuilding: ((structure: 'well' | 'refinery', tileIndex: number, segment: number) => void) | null;
  /** Edit the stores and hit points of an oil structure without changing its footprint. */
  onGodModeEditOilBuilding: ((structure: 'well' | 'refinery', structureId: string) => void) | null;
  /** Delete a well or one refinery footprint segment. */
  onGodModeDeleteOilBuilding: ((structure: 'well' | 'refinery', structureId: string, segment: number) => void) | null;
  /** Edit a building through the server-authoritative God Mode intent. */
  onGodModeEditBuilding: ((buildingId: string) => void) | null;
  /** Delete a building through the server-authoritative God Mode intent. */
  onGodModeDeleteBuilding: ((buildingId: string) => void) | null;
  /** Edit a unit through the server-authoritative God Mode intent. */
  onGodModeEditUnit: ((unitId: string) => void) | null;
  /** Delete a unit through the server-authoritative God Mode intent. */
  onGodModeDeleteUnit: ((unitId: string) => void) | null;
  /** Show the EW coverage of whatever unit/building occupies this tile+segment (either faction). */
  onShowEwCoverage: ((tileIndex: number, segment: number) => void) | null;
  /** Create a point-to-point shuttle transport from this owned oil structure. */
  onCreateShuttleTransport: ((structureId: string) => void) | null;
  /** Stop the shuttle transport currently parked on this segment. */
  onStopShuttleTransport: ((transportId: string) => void) | null;
}

/** Which actions are available for the right-clicked segment. */
export interface SegmentMenuActions {
  tileIndex: number;
  segment: number;
  /** Present → show "Refit Building" for this building id. */
  buildingId?: string;
  /** Present → show "City Design" for this city id. */
  cityId?: string;
  /** The selected tile is an unbridged impassable terrain tile. */
  canBuildBridge?: boolean;
  /** The selected tile is a forest that has not been cleared or queued for clearing. */
  canClearForest?: boolean;
  /** The selected segment is empty, traversable land with no road overlay. */
  canBuildRoad?: boolean;
  /** God Mode may create a well on this oil-deposit segment. */
  canCreateOilWell?: boolean;
  /** God Mode may create or extend a refinery on this segment. */
  canCreateRefinery?: boolean;
  /** The well or refinery footprint occupying this exact segment. */
  oilBuilding?: { structure: 'well' | 'refinery'; structureId: string };
  /** Present → include this building in the development-only entity actions. */
  godModeBuildingId?: string;
  /** Present → include this unit in the development-only entity actions. */
  godModeUnitId?: string;
  /** Present → offer "Create Transport" from this owned oil structure (well/refinery/hub). */
  oilStructureId?: string;
  /** Present → offer "Stop Transport" for the shuttle transport parked here. */
  shuttleTransportId?: string;
}

// ─── Shared DOM helpers ───────────────────────────────────────────────────────

/** Create a single menu-row <div>. */
export function makeItem(label: string, title: string, onClick: () => void): HTMLDivElement {
  const item = document.createElement('div');
  Object.assign(item.style, { padding: '6px 14px', cursor: 'pointer' });
  item.textContent = label;
  item.title = title;
  item.addEventListener('mouseenter', () => { item.style.background = '#333'; });
  item.addEventListener('mouseleave', () => { item.style.background = ''; });
  item.addEventListener('click', onClick);
  return item;
}

/** Build the shared dark popup container positioned at (clientX, clientY). */
export function makeMenuContainer(clientX: number, clientY: number): HTMLDivElement {
  const menu = document.createElement('div');
  Object.assign(menu.style, {
    position: 'fixed',
    left: clientX + 'px',
    top: clientY + 'px',
    background: '#1e1e1e',
    border: '1px solid #555',
    borderRadius: '4px',
    padding: '4px 0',
    minWidth: '140px',
    zIndex: '3000',
    fontFamily: "'Segoe UI', sans-serif",
    fontSize: '13px',
    color: '#eee',
    boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
  });
  return menu;
}

// ─── Shared open/close lifecycle ─────────────────────────────────────────────

/**
 * Shared menu lifecycle manager. Tracks the DOM element and its event
 * cleanup so both CityContextMenu and BuildingContextMenu can share the
 * same open/close pattern without duplicating state.
 */
export class MenuLifecycle {
  el: HTMLElement | null = null;
  cleanup: (() => void) | null = null;

  /** Append a menu element and wire up Escape + outside-click dismissal. */
  open(menu: HTMLElement, onClose: () => void): void {
    document.body.appendChild(menu);
    this.el = menu;

    const closeHandler = () => onClose();
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };

    // Delay to avoid catching the triggering right-click release
    setTimeout(() => {
      document.addEventListener('click', closeHandler, { once: true });
      document.addEventListener('contextmenu', closeHandler, { once: true });
    }, 0);
    window.addEventListener('keydown', keyHandler);

    this.cleanup = () => {
      document.removeEventListener('click', closeHandler);
      document.removeEventListener('contextmenu', closeHandler);
      window.removeEventListener('keydown', keyHandler);
    };
  }

  /** Remove the menu element and detach listeners. */
  close(): void {
    this.el?.remove();
    this.el = null;
    this.cleanup?.();
    this.cleanup = null;
  }
}

// ─── Segment context menu ─────────────────────────────────────────────────────

/**
 * Right-click popup for any hex segment (no unit selected). Always offers a
 * "View" item; conditionally adds "Refit Building" / "City Design" based on the
 * `actions` passed in.
 */
export class SegmentContextMenu {
  private lifecycle = new MenuLifecycle();

  /** Close and clean up any open menu. */
  close(): void {
    this.lifecycle.close();
  }

  /** Show the segment menu at the given screen coordinates. */
  show(clientX: number, clientY: number, actions: SegmentMenuActions, callbacks: CityMenuCallbacks): void {
    const menu = makeMenuContainer(clientX, clientY);

    if (callbacks.onViewSegment) {
      menu.appendChild(makeItem(
        '👁 View',
        'Look around from this segment in first-person (Esc to exit)',
        () => {
          this.close();
          callbacks.onViewSegment?.(actions.tileIndex, actions.segment);
        },
      ));
    }

    if (actions.buildingId && callbacks.onBuildingRefit) {
      const buildingId = actions.buildingId;
      menu.appendChild(makeItem(
        '⚙ Refit Building',
        "Reconfigure this building's equipment",
        () => {
          this.close();
          callbacks.onBuildingRefit?.(buildingId);
        },
      ));
    }

    if (actions.cityId && callbacks.onCityDesign) {
      const cityId = actions.cityId;
      menu.appendChild(makeItem(
        '🏛 City Design',
        "Plan this city's buildings ahead of time",
        () => {
          this.close();
          callbacks.onCityDesign?.(cityId);
        },
      ));
    }

    if (actions.oilStructureId && callbacks.onCreateShuttleTransport) {
      const structureId = actions.oilStructureId;
      menu.appendChild(makeItem(
        '🚚 Create Transport',
        'Create a point-to-point shuttle transport along an existing road to another owned oil structure',
        () => {
          this.close();
          callbacks.onCreateShuttleTransport?.(structureId);
        },
      ));
    }

    if (actions.shuttleTransportId && callbacks.onStopShuttleTransport) {
      const transportId = actions.shuttleTransportId;
      menu.appendChild(makeItem(
        '⏹ Stop Transport',
        'Stop this shuttle transport\u2019s automated back-and-forth movement',
        () => {
          this.close();
          callbacks.onStopShuttleTransport?.(transportId);
        },
      ));
    }

    const canBuildBridge = actions.canBuildBridge && callbacks.onGodModeBuildBridge;
    const canClearForest = actions.canClearForest && callbacks.onGodModeClearForest;
    const canBuildRoad = actions.canBuildRoad && callbacks.onGodModeBuildRoad;
    const canCreateOilWell = actions.canCreateOilWell && callbacks.onGodModeCreateOilBuilding;
    const canCreateRefinery = actions.canCreateRefinery && callbacks.onGodModeCreateOilBuilding;
    const canEditOilBuilding = actions.oilBuilding && callbacks.onGodModeEditOilBuilding;
    const canDeleteOilBuilding = actions.oilBuilding && callbacks.onGodModeDeleteOilBuilding;
    const canEditBuilding = actions.godModeBuildingId && callbacks.onGodModeEditBuilding;
    const canDeleteBuilding = actions.godModeBuildingId && callbacks.onGodModeDeleteBuilding;
    const canEditUnit = actions.godModeUnitId && callbacks.onGodModeEditUnit;
    const canDeleteUnit = actions.godModeUnitId && callbacks.onGodModeDeleteUnit;
    if (canBuildBridge || canClearForest || canBuildRoad || canCreateOilWell || canCreateRefinery
      || canEditOilBuilding || canDeleteOilBuilding || canEditBuilding || canDeleteBuilding || canEditUnit || canDeleteUnit) {
      const divider = document.createElement('div');
      Object.assign(divider.style, { borderTop: '1px solid #555', margin: '4px 0 2px' });
      menu.appendChild(divider);

      const heading = document.createElement('div');
      Object.assign(heading.style, {
        padding: '3px 14px',
        color: '#c9a84c',
        fontSize: '11px',
        fontWeight: 'bold',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      });
      heading.textContent = 'God Mode';
      menu.appendChild(heading);

      if (actions.godModeUnitId && canEditUnit) {
        const unitId = actions.godModeUnitId;
        menu.appendChild(makeItem('⚙ Edit Unit', 'Edit this unit through the development server', () => {
          this.close();
          callbacks.onGodModeEditUnit?.(unitId);
        }));
      }

      if (actions.godModeUnitId && canDeleteUnit) {
        const unitId = actions.godModeUnitId;
        menu.appendChild(makeItem('🗑 Delete Unit', 'Delete this unit through the development server', () => {
          this.close();
          callbacks.onGodModeDeleteUnit?.(unitId);
        }));
      }

      if (actions.godModeBuildingId && canEditBuilding) {
        const buildingId = actions.godModeBuildingId;
        menu.appendChild(makeItem('⚙ Edit Building', 'Edit this building through the development server', () => {
          this.close();
          callbacks.onGodModeEditBuilding?.(buildingId);
        }));
      }

      if (actions.godModeBuildingId && canDeleteBuilding) {
        const buildingId = actions.godModeBuildingId;
        menu.appendChild(makeItem('🗑 Delete Building', 'Delete this building through the development server', () => {
          this.close();
          callbacks.onGodModeDeleteBuilding?.(buildingId);
        }));
      }

      if (actions.oilBuilding && canEditOilBuilding) {
        const { structure, structureId } = actions.oilBuilding;
        menu.appendChild(makeItem(
          `⚙ Edit ${structure === 'well' ? 'Oil Well' : 'Refinery'}`,
          'Edit this oil structure through the development server',
          () => {
            this.close();
            callbacks.onGodModeEditOilBuilding?.(structure, structureId);
          },
        ));
      }

      if (actions.oilBuilding && canDeleteOilBuilding) {
        const { structure, structureId } = actions.oilBuilding;
        menu.appendChild(makeItem(
          `🗑 Delete ${structure === 'well' ? 'Oil Well' : 'Refinery Segment'}`,
          'Delete this selected oil-structure segment through the development server',
          () => {
            this.close();
            callbacks.onGodModeDeleteOilBuilding?.(structure, structureId, actions.segment);
          },
        ));
      }

      if (canCreateOilWell) {
        menu.appendChild(makeItem('🛢 Build Oil Well', 'Create a well on this oil-deposit segment', () => {
          this.close();
          callbacks.onGodModeCreateOilBuilding?.('well', actions.tileIndex, actions.segment);
        }));
      }

      if (canCreateRefinery) {
        menu.appendChild(makeItem('🏭 Build Refinery Segment', 'Create or extend a refinery on this segment', () => {
          this.close();
          callbacks.onGodModeCreateOilBuilding?.('refinery', actions.tileIndex, actions.segment);
        }));
      }

      if (canBuildBridge) {
        menu.appendChild(makeItem('🌉 Build Bridge', 'Queue a timed bridge task without an engineer', () => {
          this.close();
          callbacks.onGodModeBuildBridge?.(actions.tileIndex);
        }));
      }

      if (canClearForest) {
        menu.appendChild(makeItem('🌲 Clear Forest', 'Queue a timed forest-clearing task without an engineer', () => {
          this.close();
          callbacks.onGodModeClearForest?.(actions.tileIndex);
        }));
      }

      if (canBuildRoad) {
        menu.appendChild(makeItem('🛣 Build Road', 'Build a standalone development road on this empty segment', () => {
          this.close();
          callbacks.onGodModeBuildRoad?.(actions.tileIndex, actions.segment);
        }));
      }
    }

    if (callbacks.onShowEwCoverage) {
      menu.appendChild(makeItem(
        '📡 EW coverage',
        "Show the EW anti-drone screen of the unit/building here (toggle off with 'e')",
        () => {
          this.close();
          callbacks.onShowEwCoverage?.(actions.tileIndex, actions.segment);
        },
      ));
    }

    this.lifecycle.open(menu, () => this.close());
  }
}
