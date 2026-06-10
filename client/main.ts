/**
 * Main entry point for the browser client.
 * Sets up both the Globe View and Local Map View.
 */

import { loadWorld, WorldData, applyNewWorld } from './worldData.js';
import { GlobeView } from './globe.js';
import { LocalMapView } from './localMap.js';
import { CombatPanel } from './combatPanel.js';
import { DetailPanel } from './detailPanel.js';
import { showNewWorldModal } from './newWorldModal.js';
import { saveGame, showLoadModal } from './saveLoad.js';
import { executeAiTurn } from './aiTurn.js';
import { AiPlaybackController } from './aiPlayback.js';
import { preRenderUnits } from './unitRenderer.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { TurnManager } from './turnManager.js';

async function main() {
  dbg.init.log('main() starting');
  const loadingEl = document.getElementById('loading')!;
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
      `World loaded: ${world.tileCount} tiles, ${world.pentagonCount} pentagons, ${world.cities.length} cities, ${world.units.length} units`
    );
    dbg.init.log('Seed:', world.seed, '| playerColor:', world.playerColor);

    // Pre-render 3D unit sprites for all unique unit configurations
    setLoadingStatus('Rendering unit sprites…');
    await preRenderUnits(world.units, world);

    const globeCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement;
    const localCanvas = document.getElementById('local-canvas') as HTMLCanvasElement;

    // Detail panel — populates Hex Info / Unit Info / co-located units in the right curtain
    const detailPanel = new DetailPanel(world);

    // Combat panel — right curtain on local map, shows one combat at a time with nav
    const combatLogEl = document.getElementById('combat-log-content') as HTMLElement;
    const combatPanel = new CombatPanel(combatLogEl, world);

    // Wire combat preview results into the detail panel's Combat Preview section
    combatPanel.setOnPreviewReady((preview) => detailPanel.showCombat(preview));

    // AI playback controller — video-style buttons for enemy turn pacing
    // Mounted directly in the combat-log-inner (flex column) so it stays
    // pinned on screen above the Next Turn button during all enemy moves.
    const playbackContainer = document.getElementById('combat-log-inner') as HTMLElement;
    const turnControlsEl = document.getElementById('turn-controls') as HTMLElement;
    const aiPlayback = new AiPlaybackController(playbackContainer, turnControlsEl);

    // ─── Turn Management ─────────────────────────────────────────────────
    // TurnManager owns faction cycling, turn counter, and per-unit MP/action state.
    const turnManager = new TurnManager(world);

    function isPlayerTurn(): boolean {
      return turnManager.isPlayerTurn();
    }

    /** Turn counter display */
    const turnIndicator = document.createElement('span');
    turnIndicator.id = 'turn-indicator';
    turnIndicator.style.cssText = 'font-size:13px;font-weight:bold;color:#ccc;pointer-events:none;';
    const turnControls = document.getElementById('turn-controls')!;
    turnControls.insertBefore(turnIndicator, turnControls.firstChild);

    function updateTurnIndicator(): void {
      turnIndicator.textContent = `Turn ${turnManager.turnNumber}`;
    }

    // Initialize combat panel with player faction
    combatPanel.setActiveFaction(turnManager.getActiveFaction());
    combatPanel.setTurnNumber(turnManager.turnNumber);
    updateTurnIndicator();

    /**
     * Show a confirmation modal if the player has units with MP remaining (not sleeping).
     * Returns true if the player confirms or no units need confirmation.
     */
    function confirmEndTurn(): Promise<boolean> {
      const unmovedUnits = turnManager.getUnmovedAwakeUnits();
      if (unmovedUnits.length === 0) return Promise.resolve(true);

      return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        Object.assign(backdrop.style, {
          position: 'fixed',
          inset: '0',
          background: 'rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          zIndex: '2000',
        });

        const dialog = document.createElement('div');
        Object.assign(dialog.style, {
          background: '#1e1e1e',
          border: '1px solid #444',
          borderRadius: '8px 8px 0 0',
          padding: '16px 24px 20px',
          minWidth: '320px',
          maxWidth: '500px',
          maxHeight: '50vh',
          color: '#eee',
          fontFamily: "'Segoe UI', sans-serif",
          marginBottom: '0',
        });

        const unitListHtml = unmovedUnits.map((u, i) => {
          const name = u.label || u.id;
          const mp = turnManager.getMovementPoints(u.id);
          return `<div class="confirm-unit-row" data-idx="${i}" style="padding:4px 8px;cursor:pointer;border-radius:3px;font-size:12px;color:#ccc;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#eee;">${name}</span>
            <span style="color:#7ec8e3;font-size:11px;">${mp} MP</span>
          </div>`;
        }).join('');

        dialog.innerHTML = `
          <h3 style="margin:0 0 10px;font-size:15px;color:#f0c040;">Are you sure?</h3>
          <p style="margin:0 0 8px;font-size:13px;color:#aaa;">
            ${unmovedUnits.length} unit${unmovedUnits.length > 1 ? 's' : ''} still ha${unmovedUnits.length > 1 ? 've' : 's'} movement remaining:
          </p>
          <div id="confirm-unit-list" style="max-height:30vh;overflow-y:auto;margin-bottom:14px;border:1px solid #333;border-radius:4px;padding:4px 0;">
            ${unitListHtml}
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="confirm-cancel" style="padding:6px 14px;background:#333;border:1px solid #555;color:#ccc;border-radius:4px;cursor:pointer;">Cancel</button>
            <button id="confirm-end" style="padding:6px 14px;background:#c0392b;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">End Turn</button>
          </div>
        `;

        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        // Wire up unit row clicks — navigate to that unit's location
        const rows = dialog.querySelectorAll('.confirm-unit-row');
        rows.forEach((row) => {
          row.addEventListener('mouseenter', () => { (row as HTMLElement).style.background = '#333'; });
          row.addEventListener('mouseleave', () => { (row as HTMLElement).style.background = ''; });
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((row as HTMLElement).dataset.idx!);
            const unit = unmovedUnits[idx];
            if (unit) {
              localMap.setCentre(unit.tileIndex);
              localMap.setSelected(unit.tileIndex);
              onLocalTileSelected(unit.tileIndex, unit.segment);
            }
          });
        });

        function cleanup() {
          document.body.removeChild(backdrop);
        }

        dialog.querySelector('#confirm-cancel')!.addEventListener('click', () => {
          cleanup();
          resolve(false);
        });
        dialog.querySelector('#confirm-end')!.addEventListener('click', () => {
          cleanup();
          resolve(true);
        });
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) { cleanup(); resolve(false); }
        });
        // Escape to cancel
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') { cleanup(); window.removeEventListener('keydown', onKey); resolve(false); }
          if (e.key === 'Enter') { cleanup(); window.removeEventListener('keydown', onKey); resolve(true); }
        };
        window.addEventListener('keydown', onKey);
      });
    }

    /**
     * End the player's turn, let all AI factions take their moves,
     * then return control to the player with fresh movement points.
     */
    async function advanceTurn(): Promise<void> {
      if (!isPlayerTurn()) return; // Only the player triggers this

      // Confirm if player has unmoved, awake units
      const confirmed = await confirmEndTurn();
      if (!confirmed) return;

      dbg.input.log('Player ending turn — processing AI factions');
      const renderMap = () => localMap.render();
      aiPlayback.begin(world, renderMap);

      // Callbacks for visual feedback during AI turns
      const aiCallbacks = {
        highlightCombat(attackerId: string, targetId: string) {
          localMap.setHighlightCombat(attackerId, targetId);
        },
        clearHighlight() {
          localMap.setHighlightCombat(null, null);
        },
        selectActingUnit(unitId: string) {
          const unit = world.units.find((u) => u.id === unitId);
          if (!unit) return;
          // Mirror a player selection: show the unit's hex + unit info and
          // surface its stats in the combat panel's selection view.
          detailPanel.showTile(unit.tileIndex, unit.segment);
          combatPanel.showSelectedUnit(unit);
        },
        showCombatPreview(attackerId: string, targetId: string) {
          const attacker = world.units.find((u) => u.id === attackerId) ?? null;
          const target = world.units.find((u) => u.id === targetId) ?? null;
          // Drives the combat panel preview fetch and the detail panel's
          // Enemy Info + Combat Preview sections (via onPreviewReady).
          detailPanel.showEnemy(target);
          combatPanel.showPreview(attacker, target);
        },
        renderMap,
        async playAttackAnimation(
          attackerId: string,
          targetId: string,
          factionColorHex: string,
          damage: number,
          targetDestroyed: boolean,
          splashVictims: Array<{ unitId: string; damage: number; destroyed: boolean }> = [],
        ) {
          await localMap.playAttackAnimation(attackerId, targetId, factionColorHex, damage, targetDestroyed, splashVictims);
        },
      };

      const factions = turnManager.getFactions();
      const playerFaction = turnManager.getPlayerFaction();

      // Cycle through all non-player factions
      for (let i = 1; i < factions.length; i++) {
        turnManager.activeFactionIndex = (turnManager.activeFactionIndex + 1) % factions.length;
        const faction = turnManager.getActiveFaction();
        if (faction === playerFaction) break; // Back to the player

        dbg.input.log('AI faction turn:', faction);
        await executeAiTurn(world, faction, combatPanel, aiPlayback, aiCallbacks);
      }

      // Signal that all AI computation is done — player can still rewind/replay
      aiPlayback.markComplete();

      // Wait for the player to reach the final snapshot before ending the round
      await aiPlayback.waitUntilDone();
      aiPlayback.end();

      // Ensure we land back on the player faction
      turnManager.activeFactionIndex = factions.indexOf(playerFaction);
      turnManager.turnNumber++;
      combatPanel.setActiveFaction(turnManager.getActiveFaction());
      combatPanel.setTurnNumber(turnManager.turnNumber);
      localMap.setActiveFaction(turnManager.getActiveFaction());
      updateTurnIndicator();
      localMap.endTurn(); // Reset movement points for the new player turn
      localMap.render(); // Refresh map to show AI moves
      dbg.input.log('All AI turns complete — player turn begins, turn:', turnManager.turnNumber);
    }

    // Shared tile selection handler
    function onTileSelected(tileIndex: number) {
      dbg.input.log('Globe tile selected:', tileIndex);
      localMap.setSelected(tileIndex);
    }

    function onLocalTileSelected(tileIndex: number, segment?: number) {
      dbg.input.log('LocalMap tile selected:', tileIndex, 'segment:', segment);
      globe.panToTile(tileIndex);

      // Update detail panel — hex info + selected unit + co-located units
      detailPanel.showTile(tileIndex, segment);

      // Update combat panel with selected unit (shows stats immediately)
      const selected = localMap.getSelectedUnits();
      if (selected.size > 0) {
        const unit = world.units.find((u) => selected.has(u.id));
        combatPanel.showSelectedUnit(unit ?? null);
        // Switch to Selection Info tab so the player sees unit stats immediately
        switchRpTab('main');
      } else {
        combatPanel.showSelectedUnit(null);
      }
    }

    // Initialize views
    setLoadingStatus('Building globe view…');
    dbg.init.time('GlobeView');
    const globe = new GlobeView(globeCanvas, world, onTileSelected);
    dbg.init.timeEnd('GlobeView');

    setLoadingStatus('Building local map…');
    dbg.init.time('LocalMapView');
    const localMap = new LocalMapView(localCanvas, world, onLocalTileSelected);
    dbg.init.timeEnd('LocalMapView');

    // Wire TurnManager into LocalMapView
    localMap.setTurnManager(turnManager);

    // Initialize localMap with the starting active faction
    localMap.setActiveFaction(turnManager.getActiveFaction());

    // ─── Curtain Toggle Setup ───────────────────────────────────────────
    // Left curtain (strategy panel) toggle
    const strategyPanel = document.getElementById('strategy-panel') as HTMLElement;
    const strategyToggle = strategyPanel.querySelector('.curtain-toggle') as HTMLElement;
    if (strategyToggle) {
      // Initialize icon based on current collapsed state
      strategyToggle.textContent = strategyPanel.classList.contains('collapsed') ? '›' : '‹';
      strategyToggle.addEventListener('click', () => {
        strategyPanel.classList.toggle('collapsed');
        strategyToggle.textContent = strategyPanel.classList.contains('collapsed') ? '›' : '‹';
      });
    }

    // Right curtain (combat log panel) toggle
    const combatLogPanel = document.getElementById('combat-log-panel') as HTMLElement;
    const combatToggle = combatLogPanel.querySelector('.curtain-toggle') as HTMLElement;
    if (combatToggle) {
      combatToggle.textContent = combatLogPanel.classList.contains('collapsed') ? '›' : '‹';
      combatToggle.addEventListener('click', () => {
        combatLogPanel.classList.toggle('collapsed');
        combatToggle.textContent = combatLogPanel.classList.contains('collapsed') ? '›' : '‹';
      });
    }

    // Right curtain tab switching (Panel / Combat History)
    const rpTabMain = document.getElementById('rp-tab-main') as HTMLButtonElement;
    const rpTabHistory = document.getElementById('rp-tab-history') as HTMLButtonElement;
    const rpContentMain = document.getElementById('rp-tab-content-main') as HTMLElement;
    const rpContentHistory = document.getElementById('rp-tab-content-history') as HTMLElement;
    let activeRpTab: 'main' | 'history' = 'main';
    function switchRpTab(tab: 'main' | 'history') {
      activeRpTab = tab;
      const showMain = tab === 'main';
      rpContentMain.style.display = showMain ? '' : 'none';
      rpContentHistory.style.display = showMain ? 'none' : 'flex';
      rpTabMain.classList.toggle('active', showMain);
      rpTabHistory.classList.toggle('active', !showMain);
      // Re-render combat panel so it immediately reflects the correct view
      combatPanel.renderForTab();
    }
    rpTabMain.addEventListener('click', () => switchRpTab('main'));
    rpTabHistory.addEventListener('click', () => switchRpTab('history'));

    // Tell the combat panel how to check which tab is active
    combatPanel.setIsHistoryTabActive(() => activeRpTab === 'history');

    // System menu dropdown toggle
    const systemMenuBtn = document.getElementById('system-menu-btn') as HTMLElement;
    const systemMenuDropdown = document.getElementById('system-menu-dropdown') as HTMLElement;
    if (systemMenuBtn && systemMenuDropdown) {
      systemMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = systemMenuDropdown.classList.toggle('open');
        systemMenuBtn.classList.toggle('open', isOpen);
      });
      // Close dropdown when clicking outside
      document.addEventListener('click', () => {
        systemMenuDropdown.classList.remove('open');
        systemMenuBtn.classList.remove('open');
      });
      // Prevent clicks inside dropdown from closing it immediately
      systemMenuDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close after a menu item is clicked
        systemMenuDropdown.classList.remove('open');
        systemMenuBtn.classList.remove('open');
      });
    }

    // Keyboard shortcut: T to toggle the left curtain
    window.addEventListener('keydown', (event) => {
      if (event.key === 't' || event.key === 'T') {
        if ((event.target as HTMLElement).tagName === 'INPUT') return;
        event.preventDefault();
        strategyPanel.classList.toggle('collapsed');
        strategyToggle.textContent = strategyPanel.classList.contains('collapsed') ? '›' : '‹';
      }
    });

    // All heavy initialisation complete — hide loading overlay
    loadingEl.style.display = 'none';

    // ─── Split-handle drag to resize globe / local panels ───────────────
    const splitHandle = document.getElementById('split-handle') as HTMLElement;
    const splitLabel  = document.getElementById('split-label') as HTMLElement;
    const globePanel = document.getElementById('globe-panel') as HTMLElement;
    const localPanel = document.getElementById('local-panel') as HTMLElement;
    const appEl = document.getElementById('app') as HTMLElement;

    const SPLIT_KEY = 'dd-split-pct';
    const HANDLE_W = 6; // px — must match #split-handle width in CSS
    const MIN_PCT = 15;
    const MAX_PCT = 75;

    function applyGlobePct(pct: number): void {
      // Measure the local panel's width BEFORE the resize so we can scale map zoom
      const prevLocalW = localPanel.getBoundingClientRect().width;

      // Set globe panel to an explicit pixel width so Three.js renderer
      // knows the real size; let local panel fill the remainder via flex:1.
      const appW = appEl.getBoundingClientRect().width;
      const globePx = Math.round((pct / 100) * (appW - HANDLE_W));
      globePanel.style.width = `${globePx}px`;

      // Keep the handle label in sync
      splitLabel.textContent = `${Math.round(pct)}%`;

      // Notify the globe renderer so it resizes its WebGL canvas + overlay
      globe.onResize();

      // Scale the local map zoom proportionally so tiles don't slide off screen.
      // We defer one frame so the DOM has applied the new width.
      requestAnimationFrame(() => {
        const newLocalW = localPanel.getBoundingClientRect().width;
        if (prevLocalW > 0 && newLocalW > 0 && prevLocalW !== newLocalW) {
          localMap.scale = Math.max(0.05, localMap.scale * (newLocalW / prevLocalW));
          localMap.render();
        }
      });
    }

    // Restore saved split on load (defer until after layout is painted)
    requestAnimationFrame(() => {
      const savedPct = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '');
      const pct = !isNaN(savedPct) ? Math.max(MIN_PCT, Math.min(MAX_PCT, savedPct)) : 40;
      applyGlobePct(pct);
    });

    let dragging = false;
    splitHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      splitHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = appEl.getBoundingClientRect();
      const pct = Math.max(MIN_PCT, Math.min(MAX_PCT,
        ((e.clientX - rect.left) / rect.width) * 100));
      applyGlobePct(pct);
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist as a percentage of total app width
      const appW = appEl.getBoundingClientRect().width;
      const pct = ((globePanel.getBoundingClientRect().width) / appW) * 100;
      localStorage.setItem(SPLIT_KEY, String(Math.round(pct * 10) / 10));
    });

    // When the user orbits the globe, auto-pan the peeled view to match
    globe.setOnViewCentreChange((tileIndex) => {
      dbg.globe.log('View centre changed → localMap.setCentre:', tileIndex);
      localMap.setCentre(tileIndex);
    });

    // When the user drags the peeled view, spin the globe to match
    localMap.setOnCentreChange((tileIndex) => {
      dbg.localMap.log('Centre changed → globe.panToTile:', tileIndex);
      globe.panToTile(tileIndex);
    });

    // Attack handler: right-click enemy triggers combat via server
    localMap.setOnAttack(async (attackerId, targetId) => {
      if (!isPlayerTurn()) {
        dbg.input.log('Attack blocked — not player turn');
        return;
      }
      dbg.input.log('Attack initiated:', attackerId, '→', targetId);
      const attacker = world.units.find((u) => u.id === attackerId);
      const updatedUnits = await combatPanel.resolveAttack(attackerId, targetId);
      if (updatedUnits) {
        // Switch to Combat History tab to show the result
        switchRpTab('history');

        const { units, combat } = updatedUnits;

        // Determine damage and destruction from the combat result
        const oldTarget = world.units.find((u) => u.id === targetId);
        const newTarget = units.find((u) => u.id === targetId);
        const damage = oldTarget && newTarget
          ? oldTarget.currentHealth - newTarget.currentHealth
          : oldTarget ? oldTarget.currentHealth : 10;
        const targetDestroyed = newTarget ? newTarget.currentHealth <= 0 : true;
        const attackerColor = attacker ? factionColor(world, attacker.ownerId) : '#ffffff';

        // Build splash victim list from the ExplainedCombat splash array
        const splashVictims = combat.splash
          .filter((s) => s.victimId !== targetId)
          .map((s) => ({
            unitId: s.victimId,
            damage: s.damage,
            destroyed: s.victimDestroyed,
          }));

        // Play missile → explosion (all victims in parallel) → smoke animation before syncing state
        await localMap.playAttackAnimation(attackerId, targetId, attackerColor, damage, targetDestroyed, splashVictims);

        // Sync updated unit state back into the world
        world.units = units;
        localMap.render();
      }
    });

    // Hover-over-enemy attack preview
    localMap.setOnHoverEnemy((attacker, target) => {
      detailPanel.showEnemy(target);
      if (!attacker || !target) {
        detailPanel.showCombat(null);
      }
      combatPanel.showPreview(attacker, target);
    });

    // Repair handler: right-click friendly unit in same hex triggers repair via server
    localMap.setOnRepair(async (repairerId, targetId) => {
      if (!isPlayerTurn()) {
        dbg.input.log('Repair blocked — not player turn');
        return;
      }
      dbg.input.log('Repair initiated:', repairerId, '→', targetId);
      const updatedUnits = await combatPanel.resolveRepair(repairerId, targetId);
      if (updatedUnits) {
        // Sync updated unit state back into the world
        world.units = updatedUnits;
        localMap.render();
      }
    });

    // Sleep handler: right-click own unit offers Sleep via context menu
    localMap.setOnSleepUnit((unitId) => {
      dbg.input.log('Unit put to sleep:', unitId);
      turnManager.sleepUnit(unitId);
    });

    // Start centred on the battle gap tile (if present) or the player's home city
    const homeCity = world.cities.find((c) => c.isPlayerHome);
    dbg.init.log('Home city:', homeCity?.label, 'tile:', homeCity?.tileIndex);

    if (world.battleCentreTile !== undefined) {
      // Battle scenario: centre on the gap between the two armies
      dbg.init.log('Battle scenario — centring on gap tile:', world.battleCentreTile);
      localMap.setCentre(world.battleCentreTile, true);
      globe.panToTile(world.battleCentreTile);
    } else {
      localMap.goHome();
      if (homeCity) {
        globe.panToTile(homeCity.tileIndex);
      }
    }

    // Home key (keyboard)
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Home') {
        localMap.goHome();
        if (homeCity) globe.panToTile(homeCity.tileIndex);
      }
    });

    // New World button
    const newWorldBtn = document.getElementById('new-world-btn');
    if (newWorldBtn) {
      newWorldBtn.addEventListener('click', async () => {
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
    }

    // Next Turn button
    const nextTurnBtn = document.getElementById('next-turn-btn');
    if (nextTurnBtn) {
      nextTurnBtn.addEventListener('click', () => {
        dbg.input.log('Next Turn button clicked');
        advanceTurn();
      });
    }

    // Save button
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        dbg.input.log('Save button clicked');
        saveGame();
      });
    }

    // Load button
    const loadBtn = document.getElementById('load-btn');
    if (loadBtn) {
      loadBtn.addEventListener('click', () => {
        dbg.input.log('Load button clicked');
        showLoadModal();
      });
    }

    // Space key ends turn
    window.addEventListener('keydown', (event) => {
      if (event.key === ' ' && (event.target as HTMLElement).tagName !== 'INPUT') {
        event.preventDefault();
        advanceTurn();
      }
    });

    // Ctrl+S saves, Ctrl+L loads
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        saveGame();
      }
      if (event.ctrlKey && event.key === 'l') {
        event.preventDefault();
        showLoadModal();
      }
    });

  } catch (err) {
    loadingEl.classList.add('error');
    const loadingText = loadingEl.querySelector('.loading-text') as HTMLElement;
    if (loadingText) loadingText.textContent = 'Failed to load';
    if (loadingStatus) loadingStatus.textContent = `${err}`;
    dbg.init.error('Fatal error during startup:', err);
  }
}

main();
