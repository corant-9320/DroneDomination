/**
 * Main entry point for the browser client.
 * Sets up both the Globe View and Local Map View.
 */

import { loadWorld, WorldData, applyNewWorld } from './worldData.js';
import { GlobeView } from './globe.js';
import { LocalMapView } from './localMap.js';
import { showNewWorldModal } from './newWorldModal.js';

async function main() {
  const loadingEl = document.getElementById('loading')!;

  try {
    const world = await loadWorld();
    loadingEl.style.display = 'none';

    console.log(
      `World loaded: ${world.tileCount} tiles, ${world.pentagonCount} pentagons, ${world.cities.length} cities`
    );

    const globeCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement;
    const localCanvas = document.getElementById('local-canvas') as HTMLCanvasElement;
    const tileInfoEl = document.getElementById('tile-info')!;

    // Shared tile selection handler
    function showTileInfo(tileIndex: number) {
      const tile = world.tiles[tileIndex];
      const city = world.cities.find((c) => c.tileIndex === tileIndex);

      let html = `<strong>Tile #${tile.idx}</strong><br>`;
      html += `Sides: ${tile.s} (${tile.s === 5 ? 'Pentagon' : 'Hexagon'})<br>`;
      html += `Terrain: ${tile.terrain}<br>`;
      html += `Elevation: ${(tile.elev * 100).toFixed(0)}%<br>`;
      html += `Neighbours: ${tile.n.length}<br>`;
      html += `Position: (${tile.pos[0].toFixed(3)}, ${tile.pos[1].toFixed(3)}, ${tile.pos[2].toFixed(3)})`;

      if (city) {
        html += `<br><br><strong>City: ${city.label}</strong>`;
        html += `<br>Neighbours: ${city.neighbourCityIds.length}`;
      }

      tileInfoEl.innerHTML = html;
    }

    function onTileSelected(tileIndex: number) {
      showTileInfo(tileIndex);
      localMap.setSelected(tileIndex);
    }

    function onLocalTileSelected(tileIndex: number) {
      showTileInfo(tileIndex);
    }

    // Initialize views
    const globe = new GlobeView(globeCanvas, world, onTileSelected);
    const localMap = new LocalMapView(localCanvas, world, onLocalTileSelected);

    // Start centred on the player's home city
    localMap.goHome();
    const homeCity = world.cities.find((c) => c.isPlayerHome);
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
        const result = await showNewWorldModal();
        if (result) {
          const worldData = result.world as Record<string, unknown>;
          worldData.playerColor = result.playerColor;
          applyNewWorld(worldData);
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
    console.error(err);
  }
}

main();
