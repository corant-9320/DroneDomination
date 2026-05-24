/**
 * Main entry point for the browser client.
 * Sets up both the Globe View and Local Map View.
 */

import { loadWorld, WorldData, applyNewWorld } from './worldData.js';
import { GlobeView } from './globe.js';
import { LocalMapView } from './localMap.js';
import { DetailPanel } from './detailPanel.js';
import { CombatPanel } from './combatPanel.js';
import { showNewWorldModal } from './newWorldModal.js';
import { saveGame, showLoadModal } from './saveLoad.js';
import { executeAiTurn } from './aiTurn.js';
import { AiPlaybackController } from './aiPlayback.js';
import { preRenderUnits } from './unitRenderer.js';
import { dbg } from './debug.js';

async function main() {
  dbg.init.log('main() starting');
  const loadingEl = document.getElementById('loading')!;

  try {
    dbg.init.time('loadWorld');
    const world = await loadWorld();
    dbg.init.timeEnd('loadWorld');
    loadingEl.style.display = 'none';

    dbg.init.log(
      `World loaded: ${world.tileCount} tiles, ${world.pentagonCount} pentagons, ${world.cities.length} cities, ${world.units.length} units`
    );
    dbg.init.log('Seed:', world.seed, '| playerColor:', world.playerColor);

    // Pre-render 3D unit sprites for all unique unit configurations
    preRenderUnits(world.units, world);

    const globeCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement;
    const localCanvas = document.getElementById('local-canvas') as HTMLCanvasElement;
    const detailEl = document.getElementById('detail-panel') as HTMLElement;

    // Detail panel — shows terrain, units, city info for selected tile
    const detailPanel = new DetailPanel(detailEl, world);

    // Combat panel — right curtain on local map, shows one combat at a time with nav
    const combatLogEl = document.getElementById('combat-log-content') as HTMLElement;
    const combatPanel = new CombatPanel(combatLogEl, world);

    // AI playback controller — video-style buttons for enemy turn pacing
    const playbackContainer = document.getElementById('combat-log-content') as HTMLElement;
    const aiPlayback = new AiPlaybackController(playbackContainer);

    // ─── Turn Management ─────────────────────────────────────────────────
    // Derive factions from cities (each city id is a faction/owner id)
    const factions = world.cities.map((c) => c.id);
    const playerFaction = world.cities.find((c) => c.isPlayerHome)?.id ?? factions[0];
    let activeFactionIndex = factions.indexOf(playerFaction);
    if (activeFactionIndex < 0) activeFactionIndex = 0;

    function getActiveFaction(): string {
      return factions[activeFactionIndex];
    }

    function isPlayerTurn(): boolean {
      return getActiveFaction() === playerFaction;
    }

    /** Turn counter */
    let turnNumber = 1;
    const turnIndicator = document.createElement('span');
    turnIndicator.id = 'turn-indicator';
    turnIndicator.style.cssText = 'font-size:13px;font-weight:bold;color:#ccc;pointer-events:none;';
    const turnControls = document.getElementById('turn-controls')!;
    turnControls.insertBefore(turnIndicator, turnControls.firstChild);

    function updateTurnIndicator(): void {
      turnIndicator.textContent = `Turn ${turnNumber}`;
    }

    // Initialize combat panel with player faction
    combatPanel.setActiveFaction(getActiveFaction());
    updateTurnIndicator();

    /**
     * End the player's turn, let all AI factions take their moves,
     * then return control to the player with fresh movement points.
     */
    async function advanceTurn(): Promise<void> {
      if (!isPlayerTurn()) return; // Only the player triggers this

      dbg.input.log('Player ending turn — processing AI factions');
      aiPlayback.begin();

      // Callbacks for visual feedback during AI turns
      const aiCallbacks = {
        highlightCombat(attackerId: string, targetId: string) {
          localMap.setHighlightCombat(attackerId, targetId);
        },
        clearHighlight() {
          localMap.setHighlightCombat(null, null);
        },
        renderMap() {
          localMap.render();
        },
      };

      // Cycle through all non-player factions
      for (let i = 1; i < factions.length; i++) {
        activeFactionIndex = (activeFactionIndex + 1) % factions.length;
        const faction = getActiveFaction();
        if (faction === playerFaction) break; // Back to the player

        dbg.input.log('AI faction turn:', faction);
        await executeAiTurn(world, faction, combatPanel, aiPlayback, aiCallbacks);
      }

      aiPlayback.end();

      // Ensure we land back on the player faction
      activeFactionIndex = factions.indexOf(playerFaction);
      turnNumber++;
      combatPanel.setActiveFaction(getActiveFaction());
      localMap.setActiveFaction(getActiveFaction());
      updateTurnIndicator();
      localMap.endTurn(); // Reset movement points for the new player turn
      localMap.render(); // Refresh map to show AI moves
      dbg.input.log('All AI turns complete — player turn begins, turn:', turnNumber);
    }

    // Shared tile selection handler
    function showTileInfo(tileIndex: number, segment?: number) {
      dbg.input.log('showTileInfo tile:', tileIndex, 'segment:', segment, '| terrain:', world.tiles[tileIndex]?.terrain);
      detailPanel.showTile(tileIndex, segment);
    }

    function onTileSelected(tileIndex: number) {
      dbg.input.log('Globe tile selected:', tileIndex);
      showTileInfo(tileIndex);
      localMap.setSelected(tileIndex);
    }

    function onLocalTileSelected(tileIndex: number, segment?: number) {
      dbg.input.log('LocalMap tile selected:', tileIndex, 'segment:', segment);
      showTileInfo(tileIndex, segment);
      globe.panToTile(tileIndex);
    }

    // Initialize views
    dbg.init.time('GlobeView');
    const globe = new GlobeView(globeCanvas, world, onTileSelected);
    dbg.init.timeEnd('GlobeView');

    dbg.init.time('LocalMapView');
    const localMap = new LocalMapView(localCanvas, world, onLocalTileSelected);
    dbg.init.timeEnd('LocalMapView');

    // Initialize localMap with the starting active faction
    localMap.setActiveFaction(getActiveFaction());

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
      const updatedUnits = await combatPanel.resolveAttack(attackerId, targetId);
      if (updatedUnits) {
        // Sync updated unit state back into the world
        world.units = updatedUnits;
        localMap.render();
        // Re-show detail for selected tile
        if (localMap.getSelectedUnits().size > 0) {
          const unit = world.units.find((u) => localMap.getSelectedUnits().has(u.id));
          if (unit) {
            detailPanel.showTile(unit.tileIndex, unit.segment);
          }
        }
      }
    });

    // Hover-over-enemy attack preview
    localMap.setOnHoverEnemy((attacker, target) => {
      combatPanel.showPreview(attacker, target);
    });

    // Start centred on the player's home city
    const homeCity = world.cities.find((c) => c.isPlayerHome);
    dbg.init.log('Home city:', homeCity?.label, 'tile:', homeCity?.tileIndex);
    localMap.goHome();
    if (homeCity) {
      globe.panToTile(homeCity.tileIndex);
    }

    // Home button
    const homeBtn = document.getElementById('home-btn');
    if (homeBtn) {
      homeBtn.addEventListener('click', () => {
        localMap.goHome();
        if (homeCity) globe.panToTile(homeCity.tileIndex);
      });
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

    // Double-click on local map recenters
    localCanvas.addEventListener('dblclick', (event) => {
      const rect = localCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      // Find nearest tile and recenter on it
      // (The localMap handles this internally via setCentre, but we expose it here)
    });

  } catch (err) {
    loadingEl.textContent = `Error: ${err}`;
    dbg.init.error('Fatal error during startup:', err);
  }
}

main();
