/**
 * All window-level keyboard shortcuts.
 * Call setupKeyboardShortcuts() once after the GameContext is ready.
 */

import { saveGame, showLoadModal } from './saveLoad.js';
import { constructBuilding } from './buildController.js';
import { buildBridge, buildRoadSegment, clearForest } from './logisticsController.js';
import { syncPlannedToWorld } from './cityPlan.js';
import { dbg } from './debug.js';
import { emitDebugEvent } from './gameDebug.js';
import { advanceTurn } from './turnController.js';
import { toggleEwGlobal } from './ewOverlay.js';
import { cycleEntityOverlayMode } from './localMapUnits.js';
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

  // B — queue an authoritative bridge task. A selected engineer targets an
  // adjacent impassable tile; God Mode may instead target the selected tile.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'b' && e.key !== 'B') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    if (!isPlayerTurn()) {
      dbg.input.log('Build bridge blocked — not player turn');
      return;
    }

    const selected = localMap.getSelectedUnits();
    const playerFaction = turnManager.getPlayerFaction();
    const engineer = world.units.find(
      (u) =>
        selected.has(u.id) &&
        u.ownerId === playerFaction &&
        (u.attributes.engineer ?? 0) >= 1 &&
        turnManager.canAct(u.id),
    );
    const isBridgeable = (idx: number | undefined): idx is number => {
      if (idx === undefined) return false;
      const tile = world.tiles[idx];
      return !!tile && tile.terrain === 'ocean' && !tile.bridge;
    };

    let target = localMap.selectedTile;
    let unitId: string | undefined;
    if (engineer) {
      const tile = world.tiles[engineer.tileIndex];
      const faced = tile?.n[engineer.facing];
      const adjacent = isBridgeable(faced) ? faced : tile?.n.find(isBridgeable);
      if (adjacent === undefined) {
        dbg.input.log('Build bridge: no adjacent impassable tile for the selected engineer');
        return;
      }
      target = adjacent;
      unitId = engineer.id;
    }
    if (!isBridgeable(target)) {
      dbg.input.log('Build bridge: select an impassable target tile, or select an engineer beside one');
      return;
    }

    void (async () => {
      const response = await buildBridge(ctx, target, unitId);
      if (!response?.success) return;
      emitDebugEvent('build-bridge', { unitId: unitId ?? 'god-mode', tile: target }, turnManager.turnNumber);
      dbg.input.log('Bridge task queued on tile', target, 'by', unitId ?? 'God Mode');
      localMap.computeMovementRange();
      localMap.render();
      detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
    })();
  });

  // F — queue an authoritative forest-clearing task. A selected engineer clears
  // its own tile; God Mode may instead clear the selected forest tile remotely.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    if (!isPlayerTurn()) {
      dbg.input.log('Clear forest blocked — not player turn');
      return;
    }

    const selected = localMap.getSelectedUnits();
    const playerFaction = turnManager.getPlayerFaction();
    const engineer = world.units.find(
      (u) =>
        selected.has(u.id) &&
        u.ownerId === playerFaction &&
        (u.attributes.engineer ?? 0) >= 1 &&
        turnManager.canAct(u.id),
    );
    const target = engineer?.tileIndex ?? localMap.selectedTile;
    const tile = world.tiles[target];
    if (!tile || !tile.f || tile.clearedForest) {
      dbg.input.log('Clear forest: select an uncleared forest tile, or select an engineer on one');
      return;
    }

    void (async () => {
      const response = await clearForest(ctx, target, engineer?.id);
      if (!response?.success) return;
      emitDebugEvent('clear-forest', { unitId: engineer?.id ?? 'god-mode', tile: target }, turnManager.turnNumber);
      dbg.input.log('Forest-clearing task queued on tile', target, 'by', engineer?.label ?? 'God Mode');
      localMap.render();
      detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
    })();
  });

  // R — a selected engineer paves the road segment it is standing on. Queue one
  // per segment along a path to build a connecting road (Phase 1 of engineer
  // road building; auto-build over a whole path comes later).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    if (!isPlayerTurn()) {
      dbg.input.log('Build road blocked — not player turn');
      return;
    }

    const selected = localMap.getSelectedUnits();
    const playerFaction = turnManager.getPlayerFaction();
    const engineer = world.units.find(
      (u) =>
        selected.has(u.id) &&
        u.ownerId === playerFaction &&
        (u.attributes.engineer ?? 0) >= 1 &&
        turnManager.canAct(u.id),
    );
    if (!engineer) {
      dbg.input.log('Build road: select an engineer unit that can still act this turn');
      return;
    }

    void (async () => {
      const response = await buildRoadSegment(ctx, engineer.id);
      if (!response?.success) {
        if (response?.error) dbg.input.log('Build road rejected:', response.error);
        return;
      }
      emitDebugEvent(
        'build-road',
        { unitId: engineer.id, tile: engineer.tileIndex, segment: engineer.segment },
        turnManager.turnNumber,
      );
      dbg.input.log('Road task queued at tile', engineer.tileIndex, 'segment', engineer.segment);
      localMap.render();
      detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
    })();
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
    cycleEntityOverlayMode();
    localMap.render();
    if (ctx.firstPerson.isActive) ctx.firstPerson.refresh();
  });

  // Ctrl+S — save; Ctrl+L — load
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveGame(); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); showLoadModal(); }
  });
}
