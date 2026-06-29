/**
 * Building attack menu (building-damage feature).
 *
 * Shown when the player right-clicks an in-range enemy building with an
 * attacker selected. Lets the player pick the weapon mode:
 *
 *   💥 Splash Fire        — degrades one random component of every enemy
 *                           building in the hex (and HP-splashes enemy units).
 *   ⚡ Direct Fire → …     — degrades a single attacker-chosen component of the
 *                           targeted building. Expands to a list of the
 *                           building's eligible (value ≥ 1) components.
 *
 * Splash is the default and is offered first (Requirement 2.6). Direct Fire is
 * only offered when the attacker has a kinetic weapon and the building has at
 * least one eligible component to strike.
 *
 * Reuses the shared popup chrome from cityContextMenus.ts.
 */

import { makeItem, makeMenuContainer, MenuLifecycle } from './cityContextMenus.js';
import type { BuildingComponent } from '../shared/buildingComponents.js';

/** Human-readable labels for each component, shown in the Direct Fire submenu. */
const COMPONENT_LABELS: Record<BuildingComponent, string> = {
  kinetic: '🔫 Kinetic',
  rangeAttack: '🎯 Range',
  splashAttack: '💣 Splash',
  antiAir: '🚀 Anti-Air',
  armour: '🛡 Armour',
  defence: '📡 EW / Defence',
  repair: '🔧 Repair',
};

/** What the attacker can do against this building. */
export interface BuildingAttackOptions {
  /** Attacker has a Splash_Fire weapon. */
  hasSplash: boolean;
  /** Attacker has a Direct_Fire (kinetic) weapon. */
  hasDirect: boolean;
  /** The targeted building's components with value ≥ 1 (Direct_Fire choices). */
  eligibleComponents: BuildingComponent[];
}

export class BuildingAttackMenu {
  private lifecycle = new MenuLifecycle();

  /** Close and clean up any open menu. */
  close(): void {
    this.lifecycle.close();
  }

  /**
   * Show the building attack menu. `onChoose` is called with the selected
   * weapon mode (and component for Direct_Fire).
   */
  show(
    clientX: number,
    clientY: number,
    options: BuildingAttackOptions,
    onChoose: (mode: 'splash' | 'direct', component?: BuildingComponent) => void,
  ): void {
    const menu = makeMenuContainer(clientX, clientY);

    if (options.hasSplash) {
      menu.appendChild(makeItem(
        '💥 Splash Fire',
        'Degrade one random component of every enemy building in the hex',
        () => {
          this.close();
          onChoose('splash');
        },
      ));
    }

    if (options.hasDirect && options.eligibleComponents.length > 0) {
      // A header row, then one row per eligible component.
      const header = makeItem('⚡ Direct Fire — choose component:', 'Degrade a single component you select', () => {});
      header.style.cursor = 'default';
      header.style.opacity = '0.7';
      header.style.fontSize = '12px';
      menu.appendChild(header);

      for (const comp of options.eligibleComponents) {
        menu.appendChild(makeItem(
          `   ${COMPONENT_LABELS[comp]}`,
          `Direct Fire — degrade ${comp} by 1`,
          () => {
            this.close();
            onChoose('direct', comp);
          },
        ));
      }
    }

    this.lifecycle.open(menu, () => this.close());
  }
}
