/**
 * Composite Unit Icons — Canvas 2D rendering of unit markers.
 *
 * Each unit is drawn as a composite of visual elements based on its attributes:
 *
 *   Base shape:     Rectangle oriented toward the hex edge (segment direction)
 *   Health bar:     Hovers above the unit in screen space (always horizontal);
 *                   depth (height) proportional to maxHealth, green fill ∝ currentHealth/maxHealth
 *   Border:         Thickness proportional to armour rating
 *   Range stick:    Line from front of rectangle in facing direction, length ∝ rangeAttack
 *   Splash T-bar:   Perpendicular bar across the end of the range stick, ∝ splashAttack
 *   Wheels:         Pair of circles under the rectangle (wheeledMovement)
 *   Legs:           Pair of 'L' shapes under the rectangle (limbMovement)
 *   Defence:        Antenna sticking up from front (windshield), length ∝ defence
 *   Repair cross:   Red + inside the rectangle, next to initiative number
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

  // --- Flight rotor (opposite long side from wheels/legs) ---
  const flight = attrs.flightMovement ?? 0;
  if (flight > 0) {
    drawFlightRotor(ctx, halfW, halfH, flight, size, angle);
  }

  // --- Body rectangle ---
  const armour = attrs.armour ?? 0;
  const borderWidth = Math.max(1, 0.5 + armour * 0.6);

  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = borderWidth;
  ctx.fillRect(-halfW, -halfH, bodyW, bodyH);
  ctx.strokeRect(-halfW, -halfH, bodyW, bodyH);

  // --- Defence antenna (roof side, in front of rotors) ---
  const defence = attrs.defence ?? 0;
  if (defence > 0) {
    drawDefenceAntenna(ctx, halfW, halfH, defence, size, angle);
  }

  // --- Initiative number & Repair cross inside rectangle ---
  const initiative = attrs.initiative ?? 0;
  const repair = attrs.repair ?? 0;
  if (initiative > 0 || repair > 0) {
    drawInteriorMarkers(ctx, initiative, repair, halfW, halfH, size);
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

  ctx.restore();

  // --- Health bar (drawn in screen space so it always hovers above the unit) ---
  // Compute the maximum extent from centre so the bar clears all drawn elements.
  const extents: number[] = [halfH]; // body half-height at minimum

  // Range stick extends from front
  const rangeExt = range > 0 ? halfH + size * 0.5 * Math.max(range, 1) : 0;
  if (rangeExt > 0) extents.push(rangeExt);

  // Rotor strut extends outward from roof
  if (flight > 0) {
    const strutHeight = size * 0.35;
    const rotorSize = size * 0.4 + flight * size * 0.08;
    extents.push(halfW + strutHeight + rotorSize * 0.5);
  }

  // Defence antenna extends outward from roof
  if (defence > 0) {
    const antennaLen = size * 0.3 + defence * size * 0.18;
    extents.push(halfW + antennaLen);
  }

  // Wheels extend sideways
  if (wheeled > 0) {
    const wheelRadius = size * 0.22;
    extents.push(halfW + wheelRadius * 2 + 1);
  }

  // Legs extend sideways
  if (limb > 0 && wheeled === 0) {
    const legLen = size * 0.35;
    extents.push(halfW + 1 + legLen);
  }

  const maxExtent = Math.max(...extents);
  drawHealthBar(ctx, unit, sx, sy, size, maxExtent);
}

// ---------------------------------------------------------------------------
// Sub-drawing functions (all operate in rotated local space)
// ---------------------------------------------------------------------------

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  unit: UnitData,
  sx: number,
  sy: number,
  size: number,
  extent: number,
): void {
  const maxHp = unit.attributes.maxHealth ?? 1;
  const curHp = unit.currentHealth;

  // Bar hovers above the unit in screen space (always horizontal).
  // Width matches body width; depth (height) is proportional to maxHealth.
  // Positioned above the full rendering extent of the unit.
  const barW = size * 1.2; // same as bodyW
  const barH = Math.max(2, size * 0.12 * maxHp); // depth ∝ maxHealth
  const barX = sx - barW / 2;
  const barY = sy - extent - barH - Math.max(3, barH * 0.4); // extra clearance for deeper bars

  // Background (dark)
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(barX, barY, barW, barH);

  // Health fill — green portion proportional to current/max
  const ratio = curHp / maxHp;
  ctx.fillStyle = '#4f4';
  ctx.fillRect(barX, barY, barW * ratio, barH);
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
  angle: number,
): void {
  // Rotor raised from the roof of the vehicle (opposite side from wheels/legs).
  // Sits behind the antenna (toward the rear of the body, local +Y direction).
  const side = -profileSide(angle); // roof side
  const rotorSize = size * 0.4 + flight * size * 0.08;
  const strutHeight = size * 0.35; // raised above the roof edge
  const roofX = side * halfW;
  const strutX = roofX + side * strutHeight;
  const rotorY = halfH * 0.2; // slightly rear-of-centre
  const elongation = 1.4; // stretch along the long axis (Y)

  ctx.strokeStyle = '#555';
  ctx.lineWidth = Math.max(1, size * 0.10);
  ctx.lineCap = 'round';

  // Strut from roof to rotor hub
  ctx.beginPath();
  ctx.moveTo(roofX, rotorY);
  ctx.lineTo(strutX, rotorY);
  ctx.stroke();

  // Elongated 'x' rotor blades at the top of the strut
  ctx.beginPath();
  ctx.moveTo(strutX, rotorY - rotorSize * elongation);
  ctx.lineTo(strutX, rotorY + rotorSize * elongation);
  ctx.moveTo(strutX - rotorSize * 0.5, rotorY - rotorSize * elongation * 0.7);
  ctx.lineTo(strutX + rotorSize * 0.5, rotorY + rotorSize * elongation * 0.7);
  ctx.moveTo(strutX + rotorSize * 0.5, rotorY - rotorSize * elongation * 0.7);
  ctx.lineTo(strutX - rotorSize * 0.5, rotorY + rotorSize * elongation * 0.7);
  ctx.stroke();
}

function drawRepairCross(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  crossSize: number,
): void {
  // Red medical cross
  ctx.strokeStyle = '#f22';
  ctx.lineWidth = Math.max(1.5, crossSize * 0.4);
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(cx, cy - crossSize);
  ctx.lineTo(cx, cy + crossSize);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - crossSize, cy);
  ctx.lineTo(cx + crossSize, cy);
  ctx.stroke();
}

/**
 * Draw initiative number and/or repair cross inside the vehicle body.
 * If both exist, initiative is left-of-centre and repair cross is right-of-centre.
 * If only one exists, it's centred.
 */
function drawInteriorMarkers(
  ctx: CanvasRenderingContext2D,
  initiative: number,
  repair: number,
  halfW: number,
  halfH: number,
  size: number,
): void {
  const hasBoth = initiative > 0 && repair > 0;
  const fontSize = Math.max(6, size * 0.8);

  if (initiative > 0) {
    const numX = hasBoth ? -halfW * 0.35 : 0;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${initiative}`, numX, 0);
  }

  if (repair > 0) {
    const crossX = hasBoth ? halfW * 0.35 : 0;
    const crossSize = size * 0.25;
    drawRepairCross(ctx, crossX, 0, crossSize);
  }
}

function drawDefenceAntenna(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  defence: number,
  size: number,
  angle: number,
): void {
  // Antenna on the roof side (opposite from wheels/legs), toward the front of the vehicle.
  // Sits in front of the rotors.
  const side = -profileSide(angle); // roof side
  const roofX = side * halfW;
  const antennaLen = size * 0.3 + defence * size * 0.18;
  const tipX = roofX + side * antennaLen;
  const antennaY = -halfH * 0.5; // front half of the body

  ctx.strokeStyle = '#333';
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.lineCap = 'round';

  // Stalk from roof outward
  ctx.beginPath();
  ctx.moveTo(roofX, antennaY);
  ctx.lineTo(tipX, antennaY);
  ctx.stroke();

  // Small ball at tip
  const tipRadius = Math.max(1, size * 0.08);
  ctx.fillStyle = '#555';
  ctx.beginPath();
  ctx.arc(tipX, antennaY, tipRadius, 0, Math.PI * 2);
  ctx.fill();
}
