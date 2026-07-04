/**
 * terrainTextures.ts — Async terrain texture loader + tile→texture mapping.
 *
 * `LocalMapView` constructs a `TerrainTextures`, calls `load()`, then hands it
 * to the renderer via `TerrainRenderer.setTextures()` and re-renders. The
 * renderer composites the per-tile texture (clipped to the hex polygon) over
 * the solid biome fill in `drawAllTiles`.
 *
 * The terrain artwork lives in `artifacts/*.webp`. They are imported as Vite
 * assets (rather than served from `data/`), so Vite resolves each to a hashed
 * URL in dev and bundles them on build — no manual copy into `publicDir`.
 */

import { TileData, WorldData } from './worldData.js';
import { tileHeight, MAX_CLIMB_LIMB } from '../shared/movementConstants.js';

import oceanUrl from '../artifacts/ocean.webp';
import grassUrl from '../artifacts/grass.webp';
import plainsUrl from '../artifacts/plains.webp';
import desertUrl from '../artifacts/desert.webp';
import tundraUrl from '../artifacts/tundra.webp';
import hillsUrl from '../artifacts/hills.webp';
import hillsPlainsUrl from '../artifacts/HillsPlains.webp';
import mountainUrl from '../artifacts/mountain.webp';
import cliffsUrl from '../artifacts/cliffs.webp';
import roadUrl from '../artifacts/road.webp';
import pavementUrl from '../artifacts/pavement.webp';

/**
 * Texture key → source URL. Most keys are returned by
 * {@link TerrainTextures.keyForTile} and composited per-tile. The `road` key is
 * special: it is never returned by `keyForTile` (cities are not textured as a
 * whole hex) — the local-map terrain renderer fetches it directly via
 * {@link TerrainTextures.get} to paint open street segments inside cities.
 */
const SOURCES: Record<string, string> = {
  ocean: oceanUrl,
  grassland: grassUrl,
  plains: plainsUrl,
  desert: desertUrl,
  tundra: tundraUrl,
  hills: hillsUrl,
  hillsPlains: hillsPlainsUrl,
  mountain: mountainUrl,
  cliffs: cliffsUrl,
  road: roadUrl,
  pavement: pavementUrl,
};

export class TerrainTextures {
  private readonly images = new Map<string, HTMLImageElement>();
  private loaded = false;

  /** Whether textures have finished loading and are ready for use. */
  get ready(): boolean {
    return this.loaded;
  }

  /** Look up a loaded texture image by key (e.g. 'grass', 'mountain'). */
  get(key: string): HTMLImageElement | undefined {
    return this.images.get(key);
  }

  /**
   * Pick the texture key for a tile, mirroring the colour-selection priority
   * in `baseTerrainColor` (water first, then mountain, then hills, then the
   * base terrain biome). Returns null for tiles that should not be textured
   * (e.g. cities, handled by the caller).
   * 
   * Cliffs are detected when a tile is adjacent to terrain at least MAX_CLIMB_LIMB
   * height steps lower, indicating a steep unclimbable face. Cliff texture is
   * prioritized over terrain type to visually emphasize the discontinuity.
   */
  keyForTile(tile: Pick<TileData, 'terrain' | 'h' | 'n'>, world?: WorldData): string | null {
    const terrain = String(tile.terrain ?? '').toLowerCase();

    if (terrain === 'ocean' || terrain === 'water' || terrain === 'lake') {
      return 'ocean';
    }
    
    // Check for cliff edges if world data is available — a tile with a steep
    // unclimbable drop to any neighbor gets the cliff texture overlay.
    if (world && tile.n && tile.n.length > 0) {
      const thisHeight = tileHeight(tile);
      for (const neighborIdx of tile.n) {
        const neighbor = world.tiles[neighborIdx];
        const neighborHeight = tileHeight(neighbor);
        if (Math.abs(thisHeight - neighborHeight) > MAX_CLIMB_LIMB) {
          return 'cliffs';
        }
      }
    }

    const h = tileHeight(tile);
    if (h >= 9 || terrain === 'mountain') return 'mountain';
    if (h >= 6) return terrain === 'plains' ? 'hillsPlains' : 'hills';

    switch (terrain) {
      case 'grassland': return 'grassland';
      case 'plains':    return 'plains';
      case 'desert':    return 'desert';
      case 'tundra':    return 'tundra';
      default:          return 'grassland';
    }
  }

  /**
   * Load all terrain textures. Resolves once every image settles. Individual
   * failures resolve (rather than reject) so one missing asset never blocks the
   * first render.
   */
  async load(): Promise<void> {
    await Promise.all(
      Object.entries(SOURCES).map(
        ([key, url]) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.images.set(key, img);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
          }),
      ),
    );
    this.loaded = true;
  }
}
