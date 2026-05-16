/** Terrain type to color mapping */
export const TERRAIN_COLORS: Record<string, string> = {
  ocean: '#1a5276',
  plains: '#a8c686',
  grassland: '#6b9b37',
  forest: '#2d6a2d',
  hills: '#8b7355',
  mountain: '#6b6b6b',
  desert: '#d4a843',
  tundra: '#b8c9d4',
};

export function terrainColor(terrain: string): string {
  return TERRAIN_COLORS[terrain] || '#555555';
}

export function terrainColorRGB(terrain: string): [number, number, number] {
  const hex = terrainColor(terrain);
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}
