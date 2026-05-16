/**
 * Composite Unit Icons — Canvas 2D rendering of unit markers.
 *
 * Each unit is drawn as a composite of visual elements based on its attributes:
 *
 *   Base shape:     Rectangle oriented toward the hex edge (segment direction)
 *   Health bar:     Width proportional to maxHealth; red/green fill shows current HP
 *   Border:         Thickness proportional to armour rating
 *   Range stick:    Line from front of rectangle in facing direction, length ∝ rangeAttack
 *   Splash T-bar:   Perpendicular bar across the end of the range stick, ∝ splashAttack
 *   Wheels:         Pair of circles under the rectangle (wheeledMovement)
 *   Legs:           Pair of 'L' shapes under the rectangle (limbMovement)
 *   Flight rotor:   Elongated 'x' above the rectangle (flightMovement)
 *   Repair cross:   + behind/inside the rectangle (repair)
 *   Initiative #:   Number rendered inside the rectangle (initiative)
 */

import { UnitData } from './worldData.js';

/**
 * Default facing angle for a segment (screen-space direction).
 * Returns the atan2-style angle (0=right, -π/2=up) for the outward
 * direction of the given hex segment.
 * Segment 0 → up (-π/2), each subsequent rotates 60° clockwise.
 */
export function segmentAngle(segment: number): number {
  return -Math.PI / 2 + (segment * Math.PI) / 3;
}

/**
 * Draw a complete composite unit icon at the given screen position.
 *
 * @param ctx          Canvas 2D context
 * @param unit         Unit data
 * @param sx           Screen x centre
 * @param sy           Screen y centre
 * @param size         Base size (half-width of the rectangle body)
 * @param color        Faction color
 * @param facingAngle  Override facing angle (radians). If provided, all units
 *                     on the tile use this direction instead of their segment angle.
 */
export function drawUnitIcon(
  ctx: CanvasRenderingContext2D,
  unit: UnitData,
  sx: number,
  sy: number,
  size: number,
  color: string,
  facingAngle?: number,
): void {
  const attrs = unit.attributes;
  const screenAngle = facingAngle ?? segmentAngle(unit.segment);
  // We want the front of the unit (local -Y) to point in `screenAngle` direction.
  // canvas rotate(θ) rotates local +X axis to θ. Local -Y is +X rotated -90°.
  // So to make local -Y point at screenAngle, we rotate by screenAngle + π/2.
  const angle = screenAngle + Math.PI / 2;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);

  // Dimensions — portrait: long axis along facing direction, narrow sides at front/back
  const bodyW = size * 1.2;   // width (perpendicular to facing — the narrow side)
  const bodyH = size * 2.0;   // height (along facing direction — the long side)
  const halfW = bodyW / 2;
  const halfH = bodyH / 2;

  // --- Repair cross (behind rectangle) ---
  const repair = attrs.repair ?? 0;
  if (repair > 0) {
    drawRepairCross(ctx, halfW, halfH, repair, size);
  }

  // --- Flight rotor (above rectangle) ---
  const flight = attrs.flightMovement ?? 0;
  if (flight > 0) {
    drawFlightRotor(ctx, halfW, halfH, flight, size);
  }

  // --- Body rectangle ---
  const armour = attrs.armour ?? 0;
  const borderWidth = Math.max(1, 0.5 + armour * 0.6);

  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = borderWidth;
  ctx.fillRect(-halfW, -halfH, bodyW, bodyH);
  ctx.strokeRect(-halfW, -halfH, bodyW, bodyH);

  // --- Defence extension (front edge extends forward proportionally) ---
  const defence = attrs.defence ?? 0;
  if (defence > 0) {
    drawDefenceExtension(ctx, halfW, halfH, defence, size, color, borderWidth);
  }

  // --- Initiative number inside rectangle ---
  const initiative = attrs.initiative ?? 0;
  if (initiative > 0) {
    drawInitiativeNumber(ctx, initiative, halfW, halfH, size);
  }

  // --- Range stick + Splash T-bar (from front of rectangle) ---
  const range = attrs.rangeAttack ?? 0;
  const splash = attrs.splashAttack ?? 0;
  if (range > 0 || splash > 0) {
    drawRangeAndSplash(ctx, range, splash, halfH, size);
  }

  // --- Wheels (pair on one side — side-view profile) ---
  const wheeled = attrs.wheeledMovement ?? 0;
  if (wheeled > 0) {
    drawWheels(ctx, halfW, halfH, size, angle);
  }

  // --- Legs (pair on one side — side-view profile) ---
  const limb = attrs.limbMovement ?? 0;
  if (limb > 0 && wheeled === 0) {
    drawLegs(ctx, halfW, halfH, size, angle);
  }

  // --- Health bar (width ∝ maxHealth) ---
  drawHealthBar(ctx, unit, halfW, halfH, size);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Sub-drawing functions (all operate in rotated local space)
// ---------------------------------------------------------------------------

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  unit: UnitData,
  halfW: number,
  halfH: number,
  size: number,
): void {
  const maxHp = unit.attributes.maxHealth ?? 1;
  const curHp = unit.currentHealth;

  // Bar sits just above the rectangle (in local space, that's at -halfH - gap)
  const barH = Math.max(2, size * 0.2);
  const barMaxW = halfW * 2 * (maxHp / 5); // width proportional to maxHealth
  const barX = -barMaxW / 2;
  const barY = -halfH - barH - 1;

  // Background (dark)
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(barX, barY, barMaxW, barH);

  // Health fill
  const ratio = curHp / maxHp;
  let barColor: string;
  if (ratio > 0.6) barColor = '#4f4';
  else if (ratio > 0.3) barColor = '#fd4';
  else barColor = '#f44';
  ctx.fillStyle = barColor;
  ctx.fillRect(barX, barY, barMaxW * ratio, barH);
}

function drawRangeAndSplash(
  ctx: CanvasRenderingContext2D,
  range: number,
  splash: number,
  halfH: number,
  size: number,
): void {
  // Range stick extends from the front of the rectangle (top in local space = -halfH)
  const stickLength = size * 0.5 * Math.max(range, 1);
  const stickStartY = -halfH;
  const stickEndY = stickStartY - stickLength;

  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, size * 0.15);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, stickStartY);
  ctx.lineTo(0, stickEndY);
  ctx.stroke();

  // Splash T-bar across the end of the range stick
  if (splash > 0) {
    const tBarHalfW = size * 0.3 * splash;
    ctx.beginPath();
    ctx.moveTo(-tBarHalfW, stickEndY);
    ctx.lineTo(tBarHalfW, stickEndY);
    ctx.stroke();
  }
}

/**
 * Determine which side (+1 or -1 in local X) to draw wheels/legs on
 * so they appear below the vehicle body in screen space.
 *
 * After rotation by `angle`, local +X direction in screen coords is
 * (cos(angle), sin(angle)). We pick the side whose screen-Y is positive
 * (pointing downward on screen). If both are equal (facing exactly left/right),
 * default to +1.
 */
function profileSide(angle: number): number {
  // sin(angle) > 0 means local +X points screen-downward
  return Math.sin(angle) >= 0 ? 1 : -1;
}

function drawWheels(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  size: number,
  angle: number,
): void {
  // Both wheels on the same side — side-view profile of a vehicle
  const side = profileSide(angle);
  const wheelRadius = size * 0.22;
  const sideX = side * (halfW + wheelRadius + 1);
  const spacing = halfH * 0.5;

  ctx.fillStyle = '#333';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 0.5;

  // Front wheel (toward -Y in local space = front of vehicle)
  ctx.beginPath();
  ctx.arc(sideX, -spacing, wheelRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Rear wheel (toward +Y = back of vehicle)
  ctx.beginPath();
  ctx.arc(sideX, spacing, wheelRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawLegs(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  size: number,
  angle: number,
): void {
  // Both legs on the same side — side-view profile, feet face the gun (local -Y)
  const side = profileSide(angle);
  const legLen = size * 0.35;
  const footLen = size * 0.2;
  const sideX = side * (halfW + 1);
  const spacing = halfH * 0.4;

  ctx.strokeStyle = '#333';
  ctx.lineWidth = Math.max(1, size * 0.12);
  ctx.lineCap = 'round';

  // Front leg — foot toward gun (-Y direction)
  ctx.beginPath();
  ctx.moveTo(sideX, -spacing);
  ctx.lineTo(sideX + side * legLen, -spacing);
  ctx.lineTo(sideX + side * legLen, -spacing - footLen);
  ctx.stroke();

  // Rear leg — foot toward gun (-Y direction)
  ctx.beginPath();
  ctx.moveTo(sideX, spacing);
  ctx.lineTo(sideX + side * legLen, spacing);
  ctx.lineTo(sideX + side * legLen, spacing - footLen);
  ctx.stroke();
}

function drawFlightRotor(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  flight: number,
  size: number,
): void {
  // Elongated 'x' above the rectangle (like a rotor)
  const rotorSize = size * 0.4 + flight * size * 0.08;
  const rotorY = -halfH - size * 0.5;
  const elongation = 1.6; // stretch horizontally

  ctx.strokeStyle = '#555';
  ctx.lineWidth = Math.max(1, size * 0.12);
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(-rotorSize * elongation, rotorY - rotorSize * 0.6);
  ctx.lineTo(rotorSize * elongation, rotorY + rotorSize * 0.6);
  ctx.moveTo(rotorSize * elongation, rotorY - rotorSize * 0.6);
  ctx.lineTo(-rotorSize * elongation, rotorY + rotorSize * 0.6);
  ctx.stroke();
}

function drawRepairCross(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  repair: number,
  size: number,
): void {
  // Cross (+) behind the rectangle — drawn first so it appears behind
  const crossSize = size * 0.35 + repair * size * 0.06;

  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = Math.max(1.5, size * 0.18);
  ctx.lineCap = 'round';

  // Vertical bar of cross
  ctx.beginPath();
  ctx.moveTo(0, -crossSize);
  ctx.lineTo(0, crossSize);
  ctx.stroke();

  // Horizontal bar of cross
  ctx.beginPath();
  ctx.moveTo(-crossSize, 0);
  ctx.lineTo(crossSize, 0);
  ctx.stroke();
}

function drawInitiativeNumber(
  ctx: CanvasRenderingContext2D,
  initiative: number,
  halfW: number,
  halfH: number,
  size: number,
): void {
  const fontSize = Math.max(6, size * 0.8);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${initiative}`, 0, 0);
}

function drawDefenceExtension(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  defence: number,
  size: number,
  color: string,
  borderWidth: number,
): void {
  // Extend the front edge of the rectangle forward proportionally to defence.
  // This creates a raised shield/prow shape at the front of the unit.
  const extHeight = size * 0.2 * defence; // proportional to defence (0–5)
  const extTop = -halfH - extHeight;

  // Draw the extension as a filled rectangle spanning the full front width
  ctx.fillStyle = color;
  ctx.fillRect(-halfW, extTop, halfW * 2, extHeight);

  // Border matching armour thickness
  ctx.strokeStyle = '#000';
  ctx.lineWidth = borderWidth;
  ctx.strokeRect(-halfW, extTop, halfW * 2, extHeight);
}
