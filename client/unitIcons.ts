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
import { getUnitSpriteAtFacing } from './unitRenderer.js';

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
 * @param facingOverride  Corrected facing index (0–5) to select the right pre-rendered sprite
 * @param currentMP    Remaining movement points this turn
 * @param maxMP        Maximum movement points for this unit
 * @param showStatusBars Whether the health and movement bars are visible
 */
export function drawUnitIcon(
  ctx: CanvasRenderingContext2D,
  unit: UnitData,
  sx: number,
  sy: number,
  size: number,
  color: string,
  facingOverride?: number,
  currentMP?: number,
  maxMP?: number,
  showStatusBars = true,
): void {
  // Scale sprite by max health relative to baseline of 5.
  // Each step below 5 reduces size by 10%: scale = 0.9^(5 - maxHealth)
  const maxHealth = unit.attributes.size ?? 5;
  const healthScale = Math.pow(0.9, 5 - maxHealth);
  // 7.058 = 5.082 * (2.5 / 1.8) — compensates for the wider camera frustum in
  // unitRenderer.ts (2.5 vs the original 1.8) so on-screen model size is unchanged.
  const spriteSize = size * 7.058 * healthScale;

  // Use the corrected facing index if provided, otherwise fall back to unit.facing
  const spriteFacing = facingOverride ?? unit.facing;
  const sprite = getUnitSpriteAtFacing(unit, color, spriteFacing);

  ctx.save();
  ctx.translate(sx, sy);

  if (sprite) {
    // The 3D model is pre-rendered at the correct facing direction.
    // No 2D rotation — we selected the sprite matching the actual screen direction.
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

  if (showStatusBars) {
    // Bars in screen space (always horizontal, above/below the unit)
    const extent = spriteSize / 2;
    const healthBarH = drawHealthBar(ctx, unit, sx, sy, size, extent);
    drawMovementBar(ctx, sx, sy, size, extent, healthBarH, currentMP, maxMP);
  }
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
): number {  // returns the rendered barH so the movement bar can anchor below it
  const maxHp = (unit.attributes.size ?? 1) * 10;
  const curHp = unit.currentHealth;

  const barW = size * 1.2;
  const barH = Math.max(2, size * 0.12);
  const barX = sx - barW / 2;
  const barY = sy - extent - barH - Math.max(3, barH * 0.4);

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(barX, barY, barW, barH);

  // Health fill
  const ratio = curHp / maxHp;
  ctx.fillStyle = '#4f4';
  ctx.fillRect(barX, barY, barW * ratio, barH);

  return barH;
}

// ---------------------------------------------------------------------------
// Movement Bar
// ---------------------------------------------------------------------------

/**
 * Draw a horizontal movement-points bar directly below the health bar.
 *
 * The bar always represents a fixed scale of 0–5 MP.
 * - A unit with maxMP=1 starts 20% full.
 * - A unit with maxMP=4 starts 80% full.
 * - A unit with maxMP=5 starts 100% full.
 * After spending MP the fill shrinks accordingly.
 * A 1px green tick marks the unit's personal max MP position on the scale.
 */
function drawMovementBar(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  size: number,
  extent: number,
  healthBarH: number,
  currentMP: number | undefined,
  maxMP: number | undefined,
): void {
  if (maxMP === undefined || maxMP <= 0) return;
  const cur = Math.max(0, currentMP ?? 0);

  const SCALE = 5; // bar always represents 0–5 MP

  // Same width and X as the health bar
  const barW = size * 1.2;
  const barX = sx - barW / 2;

  // Health bar top Y (same formula as drawHealthBar)
  const healthBarY = sy - extent - healthBarH - Math.max(3, healthBarH * 0.4);

  // Movement bar sits 1px below the health bar, same height
  const mbY = healthBarY + healthBarH + 1;
  const mbH = healthBarH;

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(barX, mbY, barW, mbH);

  // Current MP fill — left-to-right, scaled against SCALE (0–5)
  const curRatio = cur / SCALE;
  ctx.fillStyle = '#48f';
  ctx.fillRect(barX, mbY, barW * curRatio, mbH);

  // Max MP tick — 1px vertical line at the unit's max MP position on the 0–5 scale
  const maxRatio = Math.min(1, maxMP / SCALE);
  const tickX = barX + barW * maxRatio;
  ctx.fillStyle = '#4f4'; // green to match health bar
  ctx.fillRect(tickX - 1, mbY, 1, mbH);
}
