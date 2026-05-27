/**
 * Unit Icons — renders 3D unit models on the 2D map canvas.
 *
 * Uses the offscreen Three.js renderer (unitRenderer.ts) to produce cached
 * sprite bitmaps from procedural 3D models, then draws them onto the map
 * with a faction-coloured circle behind and a health bar above.
 *
 * The old 2D vector composite drawing is fully deprecated and removed.
 */

import { UnitData } from './worldData.js';
import { getUnitSprite } from './unitRenderer.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default facing angle for a segment (screen-space direction).
 * Segment 0 → up (-π/2), each subsequent rotates 60° clockwise.
 */
export function segmentAngle(segment: number): number {
  return -Math.PI / 2 + (segment * Math.PI) / 3;
}

/**
 * Draw a unit at the given screen position using its cached 3D sprite.
 *
 * @param ctx          Canvas 2D context
 * @param unit         Unit data
 * @param sx           Screen x centre
 * @param sy           Screen y centre
 * @param size         Base size (half-width reference for scaling)
 * @param color        Faction color
 * @param facingAngle  Override facing angle (radians) — used for rotating the sprite
 */
export function drawUnitIcon(
  ctx: CanvasRenderingContext2D,
  unit: UnitData,
  sx: number,
  sy: number,
  size: number,
  color: string,
  _facingAngle?: number,
): void {
  const spriteSize = size * 5.082;  // 20% larger than previous (4.235 * 1.2)
  const sprite = getUnitSprite(unit, color);

  ctx.save();
  ctx.translate(sx, sy);

  if (sprite) {
    // The 3D model is pre-rendered at the correct facing direction,
    // so we draw it without rotation. Enable high-quality smoothing.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      sprite,
      -spriteSize / 2,
      -spriteSize / 2,
      spriteSize,
      spriteSize,
    );
  } else {
    // Sprite not yet cached — draw a placeholder silhouette
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.arc(0, 0, spriteSize * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Health bar in screen space (always horizontal, above the unit)
  const extent = spriteSize / 2;
  drawHealthBar(ctx, unit, sx, sy, size, extent);
}

// ---------------------------------------------------------------------------
// Health Bar
// ---------------------------------------------------------------------------

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  unit: UnitData,
  sx: number,
  sy: number,
  size: number,
  extent: number,
): void {
  const maxHp = (unit.attributes.maxHealth ?? 1) * 10;
  const curHp = unit.currentHealth;

  const barW = size * 1.2;
  const barH = Math.max(2, size * 0.12 * (unit.attributes.maxHealth ?? 1));
  const barX = sx - barW / 2;
  const barY = sy - extent - barH - Math.max(3, barH * 0.4);

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(barX, barY, barW, barH);

  // Health fill
  const ratio = curHp / maxHp;
  ctx.fillStyle = '#4f4';
  ctx.fillRect(barX, barY, barW * ratio, barH);
}
