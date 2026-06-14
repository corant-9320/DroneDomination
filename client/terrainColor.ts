/**
 * terrainColor.ts — Pure colour helpers used by terrain shading.
 *
 * Extracted from TerrainRenderer (P1 refactor). These functions have no
 * canvas/world dependencies, so they live as standalone pure exports.
 */

/** Convert a #rrggbb colour into RGB components. */
export function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  const match = color.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

/** Blend two CSS hex colours. Falls back to the first colour if parsing fails. */
export function mixHexColors(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const clamped = Math.max(0, Math.min(1, t));
  const r  = Math.round(ca.r + (cb.r - ca.r) * clamped);
  const g  = Math.round(ca.g + (cb.g - ca.g) * clamped);
  const bl = Math.round(ca.b + (cb.b - ca.b) * clamped);
  return `rgb(${r},${g},${bl})`;
}

/** Deterministic pseudo-random helper for tiny water-sparkle placement. */
export function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
