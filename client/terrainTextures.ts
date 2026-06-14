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

import { TileData } from './worldData.js';

import oceanUrl from '../artifacts/ocean.webp';
import grassUrl from '../artifacts/grass.webp';
import plainsUrl from '../artifacts/plains.webp';
import desertUrl from '../artifacts/desert.webp';
import tundraUrl from '../artifacts/tundra.webp';
import hillsUrl from '../artifacts/hills.webp';
import hillsPlainsUrl from '../artifacts/HillsPlains.webp';
import mountainUrl from '../artifacts/mountain.webp';

/** Texture key → source URL. Keys are returned by {@link TerrainTextures.keyForTile}. */
const SOURCES: Record<string, string> = {
  ocean: oceanUrl,
  grassland: grassUrl,
  plains: plainsUrl,
  desert: desertUrl,
  tundra: tundraUrl,
  hills: hillsUrl,
  hillsPlains: hillsPlainsUrl,
  mountain: mountainUrl,
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
   */
  keyForTile(tile: Pick<TileData, 'terrain' | 'elevType'>): string | null {
    const terrain = String(tile.terrain ?? '').toLowerCase();
    const elev = String(tile.elevType ?? '').toLowerCase();

    if (terrain === 'ocean' || terrain === 'water' || terrain === 'lake' ||
        elev === 'ocean' || elev === 'water' || elev === 'lake') {
      return 'ocean';
    }
    if (elev === 'mountain' || terrain === 'mountain') return 'mountain';
    if (elev === 'hills') return terrain === 'plains' ? 'hillsPlains' : 'hills';

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
