/**
 * Faction color palette — one bold, easily distinguishable color per faction.
 * The player chooses their color from the shared palette at world creation.
 * Enemy factions are assigned the remaining colors in order.
 */

import { WorldData } from './worldData.js';

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

  // Enemy palette = full palette minus the player's chosen color
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

/**
 * Get the faction color as an RGB triple [0–1] for Three.js usage.
 */
export function factionColorRGB(world: WorldData, ownerId: string): [number, number, number] {
  const hex = factionColor(world, ownerId);
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

/** Get the player color for the current world (useful for legends/UI). */
export function getPlayerColor(world: WorldData): string {
  return world.playerColor ?? DEFAULT_PLAYER_COLOR;
}
