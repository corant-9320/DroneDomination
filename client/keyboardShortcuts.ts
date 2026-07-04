/**
 * All window-level keyboard shortcuts.
 * Call setupKeyboardShortcuts() once after the GameContext is ready.
 */

import { saveGame, showLoadModal } from './saveLoad.js';
import { constructBuilding } from './buildController.js';
import { syncPlannedToWorld } from './cityPlan.js';
import { dbg } from './debug.js';
import { emitDebugEvent } from './gameDebug.js';
import { advanceTurn } from './turnController.js';
import { toggleEwGlobal } from './ewOverlay.js';
import { toggleEntityNumbers } from './localMapUnits.js';
import type { GameContext } from './gameContext.js';

export function setupKeyboardShortcuts(ctx: GameContext): void {
  const { world, localMap, globe, detailPanel, turnManager, isPlayerTurn } = ctx;

  // Home — centre on home city
  const homeCity = world.cities.find((c) => c.isPlayerHome);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Home') {
      localMap.goHome();
      if (homeCity) globe.panToTile(homeCity.tileIndex);
    }
  });

  // Space — end turn
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      void advanceTurn(ctx);
    }
  });

  // T — toggle left curtain (strategy panel)
  const strategyPanel  = document.getElementById('strategy-panel') as HTMLElement;
  const strategyToggle = strategyPanel?.querySelector('.curtain-toggle') as HTMLElement | null;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 't' && e.key !== 'T') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    strategyPanel.classList.toggle('collapsed');
    if (strategyToggle) {
      strategyToggle.textContent = strategyPanel.classList.contains('collapsed') ? '›' : '‹';
    }
  });

  // V — toggle first-person view for the selected unit
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'v' && e.key !== 'V') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    const { firstPerson } = ctx;
    if (firstPerson.isActive) {
      firstPerson.close();
      return;
    }
    const selected = localMap.getSelectedUnits();
    if (selected.size === 0) {
      dbg.input.log('First-person view: no unit selected');
      return;
    }
    const unit = world.units.find((u) => selected.has(u.id));
    if (!unit) return;
    firstPerson.setWorld(world);
    firstPerson.open(unit);
  });

  // B — engineer builds a bridge over an adjacent river hex
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'b' && e.key !== 'B') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    if (!isPlayerTurn()) {
      dbg.input.log('Build bridge blocked — not player turn');
      return;
    }

    const selected      = localMap.getSelectedUnits();
    const playerFaction = turnManager.getPlayerFaction();
    const engineer = world.units.find(
      (u) =>
        selected.has(u.id) &&
        u.ownerId === playerFaction &&
        (u.attributes.engineer ?? 0) >= 1 &&
        turnManager.canAct(u.id),
    );
    if (!engineer) {
      dbg.input.log('Build bridge: no selected engineer with an action available');
      return;
    }

    const tile = world.tiles[engineer.tileIndex];
    const isBridgeable = (idx: number | undefined): boolean => {
      if (idx === undefined) return false;
      const t = world.tiles[idx];
      return !!t && t.rv !== undefined && !t.bridge;
    };

    let target = -1;
    const faced = tile.n[engineer.facing];
    if (isBridgeable(faced)) target = faced;
    if (target < 0) {
      const found = tile.n.find(isBridgeable);
      if (found !== undefined) target = found;
    }
    if (target < 0) {
      dbg.input.log('Build bridge: no adjacent river hex to bridge');
      return;
    }

    world.tiles[target].bridge = true;
    turnManager.recordBuildBridge(engineer.id);
    emitDebugEvent('build-bridge', { unitId: engineer.id, tile: target }, turnManager.turnNumber);
    dbg.input.log('Bridge built by', engineer.label, 'on tile', target);

    localMap.computeMovementRange();
    localMap.render();
    detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
  });

  // C — construct a building on the selected tile + segment
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    if (!isPlayerTurn()) {
      dbg.input.log('Build blocked — not player turn');
      return;
    }

    const playerFaction = turnManager.getPlayerFaction();
    if (!turnManager.canBuild(playerFaction)) {
      dbg.input.log('Build blocked — faction already constructed this turn');
      return;
    }

    const tileIndex = localMap.selectedTile;
    const segment   = localMap.selectedSegment;
    if (tileIndex < 0 || segment < 0) {
      dbg.input.log('Build: select a hex segment first');
      return;
    }

    const result = constructBuilding(world, playerFaction, { tileIndex, segment });
    if (!result.success) {
      dbg.input.log('Build rejected:', result.validation.reason, '-', result.validation.message);
      emitDebugEvent('build-rejected', { tileIndex, segment, reason: result.validation.reason }, turnManager.turnNumber);
      return;
    }

    turnManager.recordBuild(playerFaction);
    emitDebugEvent('build', { buildingId: result.building!.id, tileIndex, segment }, turnManager.turnNumber);
    dbg.input.log('Building constructed at tile', tileIndex, 'segment', segment);

    syncPlannedToWorld(world);
    localMap.render();
    detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
  });

  // E — toggle EW coverage circles (all EW-bearing units & buildings)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'e' && e.key !== 'E') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    toggleEwGlobal();
    localMap.render();
  });

  // N — toggle unit/building number labels in 2D and 3D views
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    toggleEntityNumbers();
    localMap.render();
    if (ctx.firstPerson.isActive) ctx.firstPerson.refresh();
  });

  // Ctrl+S — save; Ctrl+L — load
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveGame(); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); showLoadModal(); }
  });
}
