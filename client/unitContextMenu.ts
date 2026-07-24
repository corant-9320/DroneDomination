/**
 * UnitContextMenu — builds and manages the right-click context menu for a
 * player-owned unit on the local map.
 *
 * Extracted from MapInputHandler so that DOM construction stays separate from
 * input routing.
 */

import type { UnitData } from './worldData.js';
import { rotateHexIndex } from './facing.js';
import { setEwFocus } from './ewOverlay.js';

/** Minimal slice of MapInputHandler that UnitContextMenu needs to call back into. */
export interface ContextMenuHost {
  chargeRotation(unitId: string): boolean;
  closeContextMenu(): void;
  readonly view: {
    selectedTile: number;
    selectedSegment: number;
    onTileSelectCb: (tileIndex: number, segment?: number) => void;
    render(): void;
    getMaxMovement(unit: UnitData): number;
    movementPoints: Map<string, number>;
    onRefit: ((unitId: string) => void) | null;
    isGodModeEntityEditingEnabled: () => boolean;
    onGodModeEditUnit: ((unitId: string) => void) | null;
    onGodModeDeleteUnit: ((unitId: string) => void) | null;
    onSleepUnit: ((unitId: string) => void) | null;
    onViewUnit: ((unitId: string) => void) | null;
  };
}

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

export class UnitContextMenu {
  private el: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  /** Close and remove any open menu. */
  close(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
    }
  }

  /** Show a right-click context menu for a player-owned unit. */
  show(clientX: number, clientY: number, unit: UnitData, host: ContextMenuHost): void {
    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'fixed',
      left: clientX + 'px',
      top: clientY + 'px',
      background: '#1e1e1e',
      border: '1px solid #555',
      borderRadius: '4px',
      padding: '4px 0',
      minWidth: '120px',
      zIndex: '3000',
      fontFamily: "'Segoe UI', sans-serif",
      fontSize: '13px',
      color: '#eee',
      boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
    });

    const v = host.view;

    // Rotate Left
    menu.appendChild(makeItem('↺ Rotate L', 'Rotate unit counter-clockwise (costs 0.25 MP once per turn)', () => {
      if (host.chargeRotation(unit.id)) {
        unit.facing = rotateHexIndex(unit.facing, -1);
        v.onTileSelectCb(v.selectedTile, v.selectedSegment >= 0 ? v.selectedSegment : undefined);
        v.render();
      }
      host.closeContextMenu();
    }));

    // Rotate Right
    menu.appendChild(makeItem('↻ Rotate R', 'Rotate unit clockwise (costs 0.25 MP once per turn)', () => {
      if (host.chargeRotation(unit.id)) {
        unit.facing = rotateHexIndex(unit.facing, 1);
        v.onTileSelectCb(v.selectedTile, v.selectedSegment >= 0 ? v.selectedSegment : undefined);
        v.render();
      }
      host.closeContextMenu();
    }));

    // Divider
    const divider = document.createElement('div');
    Object.assign(divider.style, { borderTop: '1px solid #444', margin: '2px 0' });
    menu.appendChild(divider);

    // Refit — only available when the unit has full MP (hasn't moved this turn)
    const maxMP = v.getMaxMovement(unit);
    const currentMP = v.movementPoints.get(unit.id) ?? 0;
    const canRefit = currentMP >= maxMP;
    if (canRefit && v.onRefit) {
      menu.appendChild(makeItem('⚙ Refit', 'Reconfigure this unit (costs all MP, restores full HP)', () => {
        if (v.onRefit) {
          v.onRefit(unit.id);
        }
        host.closeContextMenu();
      }));
    } else {
      const grayItem = document.createElement('div');
      Object.assign(grayItem.style, { padding: '6px 14px', color: '#555', cursor: 'default' });
      grayItem.textContent = '⚙ Refit';
      grayItem.title = 'Unit must not have moved this turn';
      menu.appendChild(grayItem);
    }

    if (v.isGodModeEntityEditingEnabled() && (v.onGodModeEditUnit || v.onGodModeDeleteUnit)) {
      const godModeDivider = document.createElement('div');
      Object.assign(godModeDivider.style, { borderTop: '1px solid #555', margin: '4px 0 2px' });
      menu.appendChild(godModeDivider);

      const godModeHeading = document.createElement('div');
      Object.assign(godModeHeading.style, {
        padding: '3px 14px',
        color: '#c9a84c',
        fontSize: '11px',
        fontWeight: 'bold',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      });
      godModeHeading.textContent = 'God Mode';
      menu.appendChild(godModeHeading);

      if (v.onGodModeEditUnit) {
        menu.appendChild(makeItem('⚙ Edit Unit', 'Edit this unit through the development server', () => {
          host.closeContextMenu();
          v.onGodModeEditUnit?.(unit.id);
        }));
      }
      if (v.onGodModeDeleteUnit) {
        menu.appendChild(makeItem('🗑 Delete Unit', 'Delete this unit through the development server', () => {
          host.closeContextMenu();
          v.onGodModeDeleteUnit?.(unit.id);
        }));
      }
    }

    // Sleep
    menu.appendChild(makeItem('💤 Sleep', 'Put this unit to sleep (suppresses end-turn warning)', () => {
      if (v.onSleepUnit) {
        v.onSleepUnit(unit.id);
      }
      host.closeContextMenu();
    }));

    // View — enter the read-only first-person look-around at this unit
    if (v.onViewUnit) {
      menu.appendChild(makeItem('👁 View', 'Look around from this unit in first-person (Esc to exit)', () => {
        if (v.onViewUnit) {
          v.onViewUnit(unit.id);
        }
        host.closeContextMenu();
      }));
    }

    // EW coverage — show this unit's anti-drone screen radius
    menu.appendChild(makeItem('📡 EW coverage', "Show this unit's EW anti-drone screen (toggle off with 'e')", () => {
      setEwFocus(unit.tileIndex, unit.segment);
      host.closeContextMenu();
      v.render();
    }));

    document.body.appendChild(menu);
    this.el = menu;

    // Close on next click anywhere or Escape
    const closeHandler = () => host.closeContextMenu();
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') host.closeContextMenu(); };
    // Delay to avoid catching the current right-click release
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
}
