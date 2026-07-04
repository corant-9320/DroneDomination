/**
 * Color utilities — terrain palette + faction palette in one place.
 * Shared hex→RGB conversion eliminates duplication.
 */

import { WorldData, TileData } from './worldData.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Convert a hex color string (#RRGGBB) to an RGB triple in [0–1] range. */
function hexToRGB(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

// ---------------------------------------------------------------------------
// Tile identity
// ---------------------------------------------------------------------------

/**
 * Canonical identity key for a tile — combines terrain type, height band,
 * and forestry presence into a single string.
 *
 * Format: "<terrain>:<band>[:forested]"
 * where band = 'mountain' (h>=9) | 'hills' (h>=6) | 'rolling' (h>=3) | 'low' (h<3)
 *
 * Use this key to look up per-combination colours.
 * The colour lookup falls back from most-specific to least-specific:
 *   full key → terrain:band → band → terrain → '#555555'
 */
function heightBandLabel(tile: Pick<TileData, 'h'>): string {
  const h = tile.h ?? 0;
  if (h >= 9) return 'mountain';
  if (h >= 6) return 'hills';
  if (h >= 3) return 'rolling';
  return 'low';
}

export function tileIdentity(tile: Pick<TileData, 'terrain' | 'h' | 'f'>): string {
  const base = `${tile.terrain}:${heightBandLabel(tile)}`;
  return tile.f ? `${base}:forested` : base;
}

/** River water colour — distinct from the deeper ocean blue. */
export const RIVER_COLOR = '#2f8fd8';

/** Bridge deck colour — a wooden crossing over a river hex. */
export const BRIDGE_COLOR = '#8a5a2b';

// ---------------------------------------------------------------------------
// Terrain colors
// ---------------------------------------------------------------------------

/**
 * Color table keyed by tile identity (most-specific first) or terrain/elevType alone.
 *
 * Lookup order in tileColor():
 *   1. Full identity  e.g. "plains:rolling:forested"
 *   2. terrain:elev   e.g. "plains:rolling"
 *   3. elevType alone e.g. "rolling"
 *   4. terrain alone  e.g. "plains"
 *   5. fallback       '#555555'
 *
 * Elevation type takes visual priority over terrain for non-ocean tiles:
 *   mountain → white, hills → grey, rolling → dark brown, lowlands → terrain colour
 */
export const TILE_COLORS: Record<string, string> = {
  // --- elevation type overrides ---
  // Only mountain gets a colour override (snow-capped white).
  // Hills and rolling use the base terrain colour so the landscape reads clearly.
  'mountain': '#ffffff', // white / snow-capped

  // --- base terrain colours (used for all non-mountain elevations, and ocean) ---
  'ocean':     '#1a5276',
  'grassland': '#6b9b37',
  'plains':    '#c8a96e', // pale brown — arid, open land
  'desert':    '#d4a843',
  'tundra':    '#b8c9d4',

  // --- rolling plains: greenish milk-chocolate brown ---
  'plains:rolling': '#7a6a42',

  // --- plains hills: light brown foothills ---
  'plains:hills': '#b3895a',

  // --- forested variants (grassland only — plains never forested) ---
  'grassland:low:forested':    '#3a7a1a',
  'grassland:rolling:forested': '#3a6a1a',
  'grassland:hills:forested':   '#3a6a1a',
};

/**
 * Elevation brightness multipliers applied on top of the base terrain colour.
 * Mountain is already white so it gets no tint.
 * Ocean and tundra are excluded — their colour carries meaning on its own.
 */
const ELEVATION_TINT: Record<string, number> = {
  low:      1.00,
  rolling:  1.10,
  hills:    1.22,
  mountain: 1.00, // already white
};

/**
 * Brighten a hex colour by a multiplier (clamped to #ffffff).
 * Only applied when multiplier > 1.
 */
function brightenHex(hex: string, factor: number): string {
  if (factor === 1) return hex;
  const [r, g, b] = hexToRGB(hex);
  const clamp = (v: number) => Math.min(255, Math.round(v * factor * 255));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`;
}

/**
 * Return the display color for a tile.
 * Falls back through: full identity → terrain:band → band → terrain → default.
 * Then applies an elevation brightness tint (rolling +10%, hills +22%).
 *
 * Ocean and tundra always use their terrain color — elevation does not override them.
 */
export function tileColor(tile: Pick<TileData, 'terrain' | 'h' | 'f' | 'rv' | 'bridge'>): string {
  // A bridged river hex is a wooden crossing — render as the bridge deck.
  if (tile.bridge) return BRIDGE_COLOR;
  // River hexes render as water regardless of their underlying land terrain.
  if (tile.rv !== undefined) return RIVER_COLOR;
  const identity = tileIdentity(tile);
  if (TILE_COLORS[identity]) return TILE_COLORS[identity];

  const band = heightBandLabel(tile);
  const terrainBand = `${tile.terrain}:${band}`;
  if (TILE_COLORS[terrainBand]) return TILE_COLORS[terrainBand];

  // Ocean and tundra: terrain color takes priority over elevation override
  if (tile.terrain === 'ocean' || tile.terrain === 'tundra') {
    return TILE_COLORS[tile.terrain];
  }

  if (TILE_COLORS[band]) return TILE_COLORS[band];

  const base = TILE_COLORS[tile.terrain] ?? '#555555';

  // Apply elevation brightness tint for non-mountain land tiles
  const tintFactor = ELEVATION_TINT[band] ?? 1;
  return brightenHex(base, tintFactor);
}

export function tileColorRGB(tile: Pick<TileData, 'terrain' | 'h' | 'f' | 'rv' | 'bridge'>): [number, number, number] {
  return hexToRGB(tileColor(tile));
}

// ---------------------------------------------------------------------------
// Legacy shims — keep callers that pass terrain string directly working
// ---------------------------------------------------------------------------

/**
 * Return the base terrain color without any elevation tint.
 * Use this for the local map's base fill; elevation is shown via triangle shading.
 */
export function baseTerrainColor(tile: Pick<TileData, 'terrain' | 'h' | 'f' | 'rv' | 'bridge'>): string {
  // A bridged river hex is a wooden crossing — render as the bridge deck.
  if (tile.bridge) return BRIDGE_COLOR;
  // River hexes render as water regardless of their underlying land terrain.
  if (tile.rv !== undefined) return RIVER_COLOR;
  // Check for specific identity (forested variants)
  const identity = tileIdentity(tile);
  if (TILE_COLORS[identity]) return TILE_COLORS[identity];

  // Check terrain:band combination
  const band = heightBandLabel(tile);
  const terrainBand = `${tile.terrain}:${band}`;
  if (TILE_COLORS[terrainBand]) return TILE_COLORS[terrainBand];

  // Ocean and tundra: terrain color only
  if (tile.terrain === 'ocean' || tile.terrain === 'tundra') {
    return TILE_COLORS[tile.terrain];
  }

  // Mountain is already white in TILE_COLORS
  if ((tile.h ?? 0) >= 9) return TILE_COLORS['mountain'];

  // Otherwise return base terrain color (no tint)
  return TILE_COLORS[tile.terrain] ?? '#555555';
}



// ---------------------------------------------------------------------------
// Faction colors
// ---------------------------------------------------------------------------

/** Default player faction color if none was chosen. */
const DEFAULT_PLAYER_COLOR = '#00e5ff';

/**
 * Full palette of maximally distinct faction colors.
 * Shared between player and enemies — the player picks one, enemies get the rest.
 */
export const FACTION_PALETTE: string[] = [
  '#00e5ff', // cyan (default player)
  '#ff1744', // vivid red
  '#ff9100', // bright orange
  '#ffea00', // electric yellow
  '#d500f9', // bold purple
  '#76ff03', // lime green
  '#f50057', // hot pink
  '#651fff', // deep violet
  '#00b0ff', // sky blue
  '#ff6d00', // dark orange
  '#1de9b6', // mint/aqua
  '#c6ff00', // chartreuse
  '#ff4081', // rose
  '#304ffe', // royal blue
];

/** Cached mapping from city id to color. Built once per world. */
let colorMap: Map<string, string> | null = null;
let lastWorldSeed: number | null = null;
let lastPlayerColor: string | null = null;

/**
 * Build (or return cached) faction color map for the current world.
 * Player city gets their chosen color; enemies cycle through the remaining palette entries.
 */
function buildColorMap(world: WorldData): Map<string, string> {
  const playerColor = world.playerColor ?? DEFAULT_PLAYER_COLOR;

  if (colorMap && lastWorldSeed === world.seed && lastPlayerColor === playerColor) return colorMap;

  colorMap = new Map<string, string>();
  lastWorldSeed = world.seed;
  lastPlayerColor = playerColor;

  const enemyPalette = FACTION_PALETTE.filter((c) => c !== playerColor);

  let enemyIndex = 0;
  for (const city of world.cities) {
    if (city.isPlayerHome) {
      colorMap.set(city.id, playerColor);
    } else {
      colorMap.set(city.id, enemyPalette[enemyIndex % enemyPalette.length]);
      enemyIndex++;
    }
  }

  return colorMap;
}

/**
 * Get the faction color for a given owner/city id.
 * Call with the full world so the map can be built on first use.
 */
export function factionColor(world: WorldData, ownerId: string): string {
  const map = buildColorMap(world);
  return map.get(ownerId) ?? '#888888';
}

/** Get the faction color as an RGB triple [0–1] for Three.js usage. */
export function factionColorRGB(world: WorldData, ownerId: string): [number, number, number] {
  return hexToRGB(factionColor(world, ownerId));
}

/** Get the player color for the current world (useful for legends/UI). */
export function getPlayerColor(world: WorldData): string {
  return world.playerColor ?? DEFAULT_PLAYER_COLOR;
}
