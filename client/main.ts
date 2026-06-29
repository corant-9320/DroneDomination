/**
 * Main entry point for the browser client.
 * Loads world data, constructs views, wires them together, then delegates
 * all controller logic to focused modules.
 */

import { loadWorld, applyNewWorld } from './worldData.js';
import { GlobeView } from './globe.js';
import { LocalMapView } from './localMap.js';
import { CombatPanel } from './combatPanel.js';
import { DetailPanel } from './detailPanel.js';
import { showNewWorldModal } from './newWorldModal.js';
import { saveGame, showLoadModal } from './saveLoad.js';
import { executeAiTurn as _executeAiTurn } from './aiTurn.js';
import { AiPlaybackController } from './aiPlayback.js';
import { preRenderUnits } from './unitRenderer.js';
import { preRenderBuildings } from './buildingRenderer.js';
import { FirstPersonView } from './firstPersonView.js';
import { dbg } from './debug.js';
import { installErrorCapture, installDebugState } from './debugState.js';
import { installGameDebug } from './gameDebug.js';
import { TurnManager } from './turnManager.js';
import { showCityDesignModal } from './cityDesignModal.js';
import { syncPlannedToWorld } from './cityPlan.js';
import { setupPanels } from './panelWiring.js';
import { setupKeyboardShortcuts } from './keyboardShortcuts.js';
import { advanceTurn } from './turnController.js';
import {
  handlePlayerAttack,
  handlePlayerBuildingAttack,
  handlePlayerRepair,
  handlePlayerSleep,
  handlePlayerRefit,
  handlePlayerBuildingRefit,
} from './playerActions.js';
import type { GameContext } from './gameContext.js';

async function main() {
  installErrorCapture();
  dbg.init.log('main() starting');
  const loadingEl     = document.getElementById('loading')!;
  const loadingStatus = loadingEl.querySelector('.loading-status') as HTMLElement;

  function setLoadingStatus(text: string) {
    if (loadingStatus) loadingStatus.textContent = text;
  }

  try {
    setLoadingStatus('Loading world data…');
    dbg.init.time('loadWorld');
    const world = await loadWorld();
    dbg.init.timeEnd('loadWorld');
    setLoadingStatus('Preparing renderers…');

    dbg.init.log(
      `World loaded: ${world.tileCount} tiles, ${world.pentagonCount} pentagons, ${world.cities.length} cities, ${world.units.length} units`,
    );
    dbg.init.log('Seed:', world.seed, '| playerColor:', world.playerColor);

    setLoadingStatus('Rendering unit sprites…');
    await preRenderUnits(world.units, world);

    setLoadingStatus('Rendering building sprites…');
    await preRenderBuildings(world.buildings, world);

    const globeCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement;
    const localCanvas = document.getElementById('local-canvas') as HTMLCanvasElement;

    // ─── Core views ─────────────────────────────────────────────────────
    const detailPanel  = new DetailPanel(world);
    const combatLogEl  = document.getElementById('combat-log-content') as HTMLElement;
    const combatPanel  = new CombatPanel(combatLogEl, world);

    combatPanel.setOnPreviewReady((preview) => detailPanel.showCombat(preview));

    const playbackContainer = document.getElementById('combat-log-inner') as HTMLElement;
    const turnControlsEl    = document.getElementById('turn-controls')    as HTMLElement;
    const aiPlayback = new AiPlaybackController(playbackContainer, turnControlsEl);

    // ─── Turn management ─────────────────────────────────────────────────
    const turnManager = new TurnManager(world);
    detailPanel.setTurnManager(turnManager);

    const turnIndicator = document.createElement('span');
    turnIndicator.id        = 'turn-indicator';
    turnIndicator.style.cssText = 'font-size:13px;font-weight:bold;color:#ccc;pointer-events:none;';
    const turnControls = document.getElementById('turn-controls')!;
    turnControls.insertBefore(turnIndicator, turnControls.firstChild);

    function updateTurnIndicator(): void {
      turnIndicator.textContent = `Turn ${turnManager.turnNumber}`;
    }

    combatPanel.setActiveFaction(turnManager.getActiveFaction());
    combatPanel.setTurnNumber(turnManager.turnNumber);
    updateTurnIndicator();

    // ─── Tile selection handlers ─────────────────────────────────────────
    function onTileSelected(tileIndex: number) {
      dbg.input.log('Globe tile selected:', tileIndex);
      localMap.setSelected(tileIndex);
    }

    function onLocalTileSelected(tileIndex: number, segment?: number) {
      globe.panToTile(tileIndex);
      detailPanel.showTile(tileIndex, segment);
      const selected = localMap.getSelectedUnits();
      if (selected.size > 0) {
        const unit = world.units.find((u) => selected.has(u.id));
        combatPanel.showSelectedUnit(unit ?? null);
        ctx.switchRpTab('main');
      } else {
        combatPanel.showSelectedUnit(null);
      }
    }

    // ─── Construct views ─────────────────────────────────────────────────
    setLoadingStatus('Building globe view…');
    dbg.init.time('GlobeView');
    const globe = new GlobeView(globeCanvas, world, onTileSelected);
    dbg.init.timeEnd('GlobeView');

    setLoadingStatus('Building local map…');
    dbg.init.time('LocalMapView');
    const localMap = new LocalMapView(localCanvas, world, onLocalTileSelected, turnManager);
    dbg.init.timeEnd('LocalMapView');

    localMap.setActiveFaction(turnManager.getActiveFaction());

    // ─── First-person view ───────────────────────────────────────────────
    const firstPerson = new FirstPersonView(world);
    (window as unknown as { __DD_FIRSTPERSON__?: unknown }).__DD_FIRSTPERSON__ = firstPerson;

    localMap.setOnViewUnit((unitId) => {
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return;
      firstPerson.setWorld(world);
      firstPerson.open(unit);
    });

    localMap.setOnViewSegment((tileIndex, segment) => {
      firstPerson.setWorld(world);
      firstPerson.openAt(tileIndex, segment);
    });

    // ─── City design ─────────────────────────────────────────────────────
    syncPlannedToWorld(world);
    localMap.setOnCityDesign((cityId) => {
      const city = world.cities.find((c) => c.id === cityId);
      if (!city) return;
      showCityDesignModal(world, city, () => { localMap.render(); });
    });

    // ─── Panel wiring (curtains, tabs, split-handle, system menu) ────────
    const switchRpTab = setupPanels({ globe, localMap, combatPanel });

    // ─── Assemble the shared context ─────────────────────────────────────
    // ctx is used by controllers below; onLocalTileSelected references ctx.switchRpTab
    // so we declare it with `let` and assign immediately after construction.
    const ctx: GameContext = {
      world,
      globe,
      localMap,
      combatPanel,
      detailPanel,
      firstPerson,
      aiPlayback,
      turnManager,
      switchRpTab,
      isPlayerTurn: () => turnManager.isPlayerTurn(),
      updateTurnIndicator,
    };

    // ─── View cross-wiring ───────────────────────────────────────────────
    globe.setOnViewCentreChange((tileIndex, up) => {
      localMap.setCentre(tileIndex, false, up);
    });
    localMap.setOnCentreChange((tileIndex) => {
      globe.panToTile(tileIndex);
    });

    // ─── Player action wiring ─────────────────────────────────────────────
    localMap.setOnAttack((attackerId, targetId) => {
      void handlePlayerAttack(ctx, attackerId, targetId);
    });
    localMap.setOnAttackBuilding((attackerId, buildingId, mode, component) => {
      void handlePlayerBuildingAttack(ctx, attackerId, buildingId, mode, component);
    });
    localMap.setOnHoverEnemy((attacker, target) => {
      detailPanel.showEnemy(target);
      if (!attacker || !target) detailPanel.showCombat(null);
      combatPanel.showPreview(attacker, target);
    });
    localMap.setOnRepair((repairerId, targetId) => {
      void handlePlayerRepair(ctx, repairerId, targetId);
    });
    localMap.setOnSleepUnit((unitId) => {
      handlePlayerSleep(ctx, unitId);
    });
    localMap.setOnRefit((unitId) => {
      void handlePlayerRefit(ctx, unitId);
    });
    localMap.setOnBuildingRefit((buildingId) => {
      void handlePlayerBuildingRefit(ctx, buildingId);
    });

    // First-person view uses the same action handlers as the 2D map
    firstPerson.setCommandContext({
      turnManager,
      getActiveFaction: () => turnManager.getActiveFaction(),
      onAttack:  (a, t) => { void handlePlayerAttack(ctx, a, t); },
      onRepair:  (r, t) => { void handlePlayerRepair(ctx, r, t); },
      onSleep:   (id)   => { handlePlayerSleep(ctx, id); },
      onRefit:   (id)   => { void handlePlayerRefit(ctx, id); },
      onCommit:  ()     => { localMap.render(); },
    });

    // ─── Button wiring ───────────────────────────────────────────────────
    document.getElementById('new-world-btn')?.addEventListener('click', async () => {
      dbg.modal.log('New World button clicked');
      const result = await showNewWorldModal();
      if (result) {
        dbg.modal.log('New world generated, applying. playerColor:', result.playerColor);
        const worldData = result.world as Record<string, unknown>;
        worldData.playerColor = result.playerColor;
        applyNewWorld(worldData);
      } else {
        dbg.modal.log('New world cancelled');
      }
    });

    document.getElementById('next-turn-btn')?.addEventListener('click', () => {
      dbg.input.log('Next Turn button clicked');
      void advanceTurn(ctx);
    });

    document.getElementById('save-btn')?.addEventListener('click', () => {
      dbg.input.log('Save button clicked');
      saveGame();
    });

    document.getElementById('load-btn')?.addEventListener('click', () => {
      dbg.input.log('Load button clicked');
      showLoadModal();
    });

    // ─── Keyboard shortcuts ──────────────────────────────────────────────
    setupKeyboardShortcuts(ctx);

    // ─── Initial map position ────────────────────────────────────────────
    loadingEl.style.display = 'none';

    const homeCity = world.cities.find((c) => c.isPlayerHome);
    dbg.init.log('Home city:', homeCity?.label, 'tile:', homeCity?.tileIndex);

    if (world.battleCentreTile !== undefined) {
      dbg.init.log('Battle scenario — centring on gap tile:', world.battleCentreTile);
      localMap.setCentre(world.battleCentreTile, true);
      globe.panToTile(world.battleCentreTile);
    } else {
      localMap.goHome();
      if (homeCity) globe.panToTile(homeCity.tileIndex);
    }

    // ─── Debug instrumentation ───────────────────────────────────────────
    installDebugState({ world, localMap, turnManager });
    installGameDebug({ world, localMap, turnManager });

  } catch (err) {
    loadingEl.classList.add('error');
    const loadingText = loadingEl.querySelector('.loading-text') as HTMLElement;
    if (loadingText) loadingText.textContent = 'Failed to load';
    if (loadingStatus) loadingStatus.textContent = `${err}`;
    dbg.init.error('Fatal error during startup:', err);
  }
}

main();
