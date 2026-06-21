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
  /** Show the EW coverage of whatever unit/building occupies this tile+segment (either faction). */
  onShowEwCoverage: ((tileIndex: number, segment: number) => void) | null;
}

/** Which actions are available for the right-clicked segment. */
export interface SegmentMenuActions {
  tileIndex: number;
  segment: number;
  /** Present → show "Refit Building" for this building id. */
  buildingId?: string;
  /** Present → show "City Design" for this city id. */
  cityId?: string;
}

// ─── Shared DOM helpers ───────────────────────────────────────────────────────

/** Create a single menu-row <div>. */
function makeItem(label: string, title: string, onClick: () => void): HTMLDivElement {
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
function makeMenuContainer(clientX: number, clientY: number): HTMLDivElement {
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
class MenuLifecycle {
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
