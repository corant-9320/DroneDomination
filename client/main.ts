/**
 * Main entry point for the browser client.
 * Sets up both the Globe View and Local Map View.
 */

import { loadWorld, WorldData, applyNewWorld } from './worldData.js';
import { GlobeView } from './globe.js';
import { LocalMapView } from './localMap.js';
import { showNewWorldModal } from './newWorldModal.js';
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

    const globeCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement;
    const localCanvas = document.getElementById('local-canvas') as HTMLCanvasElement;

    // Shared tile selection handler
    function showTileInfo(tileIndex: number) {
      // Detail panel handled by DetailPanel if available
      dbg.input.log('showTileInfo tile:', tileIndex, '| terrain:', world.tiles[tileIndex]?.terrain);
    }

    function onTileSelected(tileIndex: number) {
      dbg.input.log('Globe tile selected:', tileIndex);
      showTileInfo(tileIndex);
      localMap.setSelected(tileIndex);
    }

    function onLocalTileSelected(tileIndex: number) {
      dbg.input.log('LocalMap tile selected:', tileIndex);
      showTileInfo(tileIndex);
      globe.panToTile(tileIndex);
    }

    // Initialize views
    dbg.init.time('GlobeView');
    const globe = new GlobeView(globeCanvas, world, onTileSelected);
    dbg.init.timeEnd('GlobeView');

    dbg.init.time('LocalMapView');
    const localMap = new LocalMapView(localCanvas, world, onLocalTileSelected);
    dbg.init.timeEnd('LocalMapView');

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
      homeBtn.addEventListener('click', () => localMap.goHome());
    }

    // Home key (keyboard)
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Home') {
        localMap.goHome();
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
