/**
 * terrainRelief.ts — Elevation relief: same-height seam erasure, biome
 * feathering, organic contour/peak/trough shading, and the (currently unused)
 * per-segment elevation shading.
 *
 * Extracted from TerrainRenderer (P1 refactor). Operates through a shared
 * TerrainContext for canvas/world/view-transform access.
 */

import { TileData } from './worldData.js';
import { FlatTile } from './localMapProjection.js';
import { TerrainContext } from './terrainContext.js';
import { mixHexColors } from './terrainColor.js';
import { MAX_CLIMB_WHEELED, MAX_CLIMB_LIMB } from '../shared/movementConstants.js';

export class TerrainRelief {
  constructor(private c: TerrainContext) {}

  /**
   * Hide residual hairline seams between neighbours at the same elevation.
   *
   * This pass exists for the flat-fill fallback (before terrain textures load).
   * Once textures are composited, stroking the flat base fill colour over the
   * textured surface would itself create visible seams — so when textures are
   * ready this pass is skipped entirely and the expanded texture clip in
   * fillTileTexture handles edge coverage instead.
   */
  eraseSameElevationInternalEdges(ftByTile: Map<number, FlatTile>): void {
    // Textures cover the tiles edge-to-edge (clip is expanded outward), so the
    // flat-colour seam stroke is unnecessary and would paint visible lines over
    // the texture. Only run for the pre-texture flat-fill fallback.
    if (this.c.textures && this.c.textures.ready) return;

    const ctx = this.c.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const ft of ftByTile.values()) {
      const tile = this.c.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6 || tile.city) continue;
      const ownLevel = this.c.elevationLevel(tile);
      const color = this.c.terrainFillColor(tile);

      for (let seg = 0; seg < ft.poly.length; seg++) {
        const neighbour = this.c.neighbourAcrossSegment(tile, ft, seg, ftByTile);
        if (!neighbour || neighbour.city) continue;
        const neighbourIdx = this.c.tileIndexOf(neighbour);
        if (neighbourIdx < 0 || ft.tileIndex > neighbourIdx) continue;
        if (this.c.elevationLevel(neighbour) !== ownLevel) continue;

        const nColor = this.c.terrainFillColor(neighbour);
        const sameVisualFill =
          nColor === color &&
          neighbour.terrain === tile.terrain &&
          Math.floor((neighbour.h ?? 0) / 3) === Math.floor((tile.h ?? 0) / 3) &&
          neighbour.f === tile.f;

        const v0 = ft.poly[seg];
        const v1 = ft.poly[(seg + 1) % ft.poly.length];
        const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
        const [bx, by] = this.c.worldToScreen(v1.x, v1.y);

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = sameVisualFill ? color : mixHexColors(color, nColor, 0.5);
        ctx.globalAlpha = sameVisualFill ? 1.0 : 0.78;
        ctx.lineWidth = sameVisualFill ? 2.2 : 4.2;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Soften hard biome edges by washing a mixed colour along shared borders.
   * Low-alpha pass: map remains readable as hexes, but adjacent terrain no
   * longer looks like cut paper.
   */
  drawFeathering(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.c.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const ft of ftByTile.values()) {
      const tile = this.c.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      const color = this.c.terrainFillColor(tile);

      for (let seg = 0; seg < ft.poly.length; seg++) {
        const neighbour = this.c.neighbourAcrossSegment(tile, ft, seg, ftByTile);
        if (!neighbour) continue;
        const neighbourIdx = this.c.world.tiles.indexOf(neighbour);
        if (neighbourIdx >= 0 && ft.tileIndex > neighbourIdx) continue;

        const ownLevel = this.c.elevationLevel(tile);
        const neighbourLevel = this.c.elevationLevel(neighbour);

        // v6: do not feather same-elevation internal edges. Those are erased by
        // eraseSameElevationInternalEdges(), so this pass cannot reintroduce a
        // visible same-height hex boundary. Feathering is now reserved for true
        // height transitions only, where it supports the organic relief.
        if (ownLevel === neighbourLevel) continue;

        const nColor = this.c.terrainFillColor(neighbour);
        if (
          nColor === color &&
          neighbour.terrain === tile.terrain &&
          Math.floor((neighbour.h ?? 0) / 3) === Math.floor((tile.h ?? 0) / 3)
        ) continue;

        const v0 = ft.poly[seg];
        const v1 = ft.poly[(seg + 1) % ft.poly.length];
        const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
        const [bx, by] = this.c.worldToScreen(v1.x, v1.y);

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = mixHexColors(color, nColor, 0.5);
        ctx.globalAlpha = 0.075;
        ctx.lineWidth = 7.5;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Draw a broad, rounded edge wash instead of a rectangular quad.
   * A blurred stroke keeps the original contrast but removes the hard blocky band.
   */
  private strokeOrganicEdgeWash(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    offsetX: number,
    offsetY: number,
    width: number,
    color: string,
    blur: number,
  ): void {
    const ctx = this.c.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax + offsetX, ay + offsetY);
    ctx.lineTo(bx + offsetX, by + offsetY);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Soft organic relief for a high/low boundary.
   *
   * The previous implementation used rectangular gradient bands. This keeps the
   * same sun-vector intensity, but paints the light and shadow as clipped,
   * blurred strokes following the shared hex edge, so the result reads like
   * terrain relief rather than a blocky overlay.
   */
  private drawContourEdgeRelief(
    ft: FlatTile,
    tile: TileData,
    segment: number,
    level: number,
    neighbour: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const ctx = this.c.ctx;
    const SUN_X = -0.707;
    const SUN_Y = -0.707;

    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
    const [bx, by] = this.c.worldToScreen(v1.x, v1.y);
    const [csx, csy] = this.c.worldToScreen(ft.cx, ft.cy);

    const midX = (ax + bx) / 2;
    const midY = (ay + by) / 2;
    const outX = midX - csx;
    const outY = midY - csy;
    const outLen = Math.sqrt(outX * outX + outY * outY);
    if (outLen < 1e-6) return;

    const nx = outX / outLen;       // from high tile centre towards the lower side
    const ny = outY / outLen;
    const highNx = -nx;             // back into the high tile
    const highNy = -ny;

    // Shadow strength scales with the true 0–11 height drop (cliff size), not
    // just the 4-way band difference, so a tall cliff casts a deeper shadow.
    const heightDrop = Math.max(1, this.c.height12(tile) - this.c.height12(neighbour));
    const radius = this.c.screenHexRadius(ft);

    const strength = Math.min(1, 0.36 + heightDrop * 0.22 + level * 0.08);
    const edgeFacesSun = nx * SUN_X + ny * SUN_Y;
    const awayFromSun = Math.max(0, -edgeFacesSun);
    const towardSun = Math.max(0, edgeFacesSun);

    const neighbourIdx = this.c.tileIndexOf(neighbour);
    const nft = neighbourIdx >= 0 ? ftByTile.get(neighbourIdx) : undefined;

    const broadWidth = Math.max(7, radius * (0.42 + heightDrop * 0.055));
    const tightWidth = Math.max(2.5, radius * (0.060 + heightDrop * 0.012));
    const blur = Math.max(0.65, radius * 0.030);
    const broadOffset = Math.max(1.5, radius * 0.055);
    const lipOffset = Math.max(0.8, radius * 0.022);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Lower-side shadow: clipped to the lower tile when visible. This keeps the
    // falloff directional without drawing a rectangular extrusion beyond the edge.
    if (awayFromSun > 0.04) {
      const shadowAlpha = Math.min(0.66, (0.38 + level * 0.070) * strength * awayFromSun);
      const tightAlpha = Math.min(0.44, shadowAlpha * 0.58);

      ctx.save();
      if (nft) this.c.clipToTile(nft);
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        nx * broadOffset, ny * broadOffset,
        broadWidth,
        `rgba(5,8,14,${shadowAlpha.toFixed(3)})`,
        blur,
      );
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        nx * lipOffset, ny * lipOffset,
        tightWidth,
        `rgba(0,0,0,${tightAlpha.toFixed(3)})`,
        Math.max(0.25, blur * 0.35),
      );
      ctx.restore();
    }

    // High-side highlight: clipped to the high tile and nudged inward. This
    // preserves the original sun-position lighting but avoids a hard rectangle.
    if (towardSun > 0.04) {
      const highlightAlpha = Math.min(0.74, (0.46 + level * 0.084) * strength * towardSun);
      const rimAlpha = Math.min(0.50, highlightAlpha * 0.62);

      ctx.save();
      this.c.clipToTile(ft);
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        highNx * broadOffset, highNy * broadOffset,
        broadWidth * 0.90,
        `rgba(255,252,218,${highlightAlpha.toFixed(3)})`,
        blur,
      );
      this.strokeOrganicEdgeWash(
        ax, ay, bx, by,
        highNx * lipOffset, highNy * lipOffset,
        tightWidth,
        `rgba(255,255,240,${rimAlpha.toFixed(3)})`,
        Math.max(0.25, blur * 0.30),
      );
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Draw organic height relief on real elevation boundaries only.
   * Centre-to-centre contour traces are deliberately omitted for this style.
   */
  drawContourRelief(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.c.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // First pass: relief on actual high/low hex boundaries.
    for (let level = 1; level <= 3; level++) {
      for (const ft of ftByTile.values()) {
        const tile = this.c.world.tiles[ft.tileIndex];
        if (tile.s !== 6 || this.c.elevationLevel(tile) < level || ft.poly.length < 6) continue;

        for (let seg = 0; seg < ft.poly.length; seg++) {
          const neighbour = this.c.neighbourAcrossSegment(tile, ft, seg, ftByTile);
          if (!neighbour || this.c.elevationLevel(neighbour) >= level) continue;
          this.drawContourEdgeRelief(ft, tile, seg, level, neighbour, ftByTile);
        }
      }
    }

    // Second pass: softened local peaks/troughs with continuous gradients rather
    // than segment-by-segment triangular facets.
    for (const ft of ftByTile.values()) {
      const tile = this.c.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;
      this.drawPeakOrganicRelief(ft, tile);
      this.drawSingleHexRelief(ft, tile);
    }

    // Third pass: a solid dark-brown line along the high side of every border
    // too steep for ground chassis. Drawn last so it reads on top of the
    // continuous relief shading.
    this.drawSteepBorderLines(ftByTile);

    ctx.restore();
  }

  /**
   * Outline the borders whose raw height step is impassable to ground units.
   * The continuous relief shading already conveys "how tall" a cliff is; this
   * pass adds an explicit, readable cue at the two gameplay breakpoints by
   * stroking a solid dark-brown line along the hex boundary on the *high* side:
   *
   *   • step > MAX_CLIMB_WHEELED (4+)  — blocks tanks        → thin line
   *   • step > MAX_CLIMB_LIMB    (9+)  — blocks tanks+spiders → thick line
   */
  private drawSteepBorderLines(ftByTile: Map<number, FlatTile>): void {
    const ctx = this.c.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const ft of ftByTile.values()) {
      const tile = this.c.world.tiles[ft.tileIndex];
      if (tile.s !== 6 || ft.poly.length < 6) continue;

      const ownHeight = this.c.height12(tile);

      for (let seg = 0; seg < ft.poly.length; seg++) {
        const neighbour = this.c.neighbourAcrossSegment(tile, ft, seg, ftByTile);
        if (!neighbour) continue;

        // Draw each steep border exactly once — from the higher tile only.
        const drop = ownHeight - this.c.height12(neighbour);
        if (drop <= MAX_CLIMB_WHEELED) continue;

        const heavy = drop > MAX_CLIMB_LIMB;
        this.drawSteepBorderLine(ft, seg, heavy);
      }
    }

    ctx.restore();
  }

  /**
   * Stroke a solid line along one tile edge, nudged slightly inward onto the
   * high tile and clipped to it so the line hugs the boundary on the high side.
   * Tier is conveyed by line weight: the impassable-to-all tier is thicker.
   */
  private drawSteepBorderLine(ft: FlatTile, segment: number, heavy: boolean): void {
    const ctx = this.c.ctx;

    const v0 = ft.poly[segment % ft.poly.length];
    const v1 = ft.poly[(segment + 1) % ft.poly.length];
    const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
    const [bx, by] = this.c.worldToScreen(v1.x, v1.y);
    const [csx, csy] = this.c.worldToScreen(ft.cx, ft.cy);

    const midX = (ax + bx) / 2;
    const midY = (ay + by) / 2;
    let outX = midX - csx;
    let outY = midY - csy;
    const outLen = Math.sqrt(outX * outX + outY * outY);
    if (outLen < 1e-6) return;
    outX /= outLen;                 // outward normal (high centre → lower tile)
    outY /= outLen;

    const radius = this.c.screenHexRadius(ft);
    const lineWidth = Math.max(2.4, radius * (heavy ? 0.1125 : 0.06));
    // Nudge the stroke inward by half its width so it sits fully inside the
    // high tile, hugging the boundary rather than straddling it.
    const inset = lineWidth * 0.5;

    ctx.save();
    this.c.clipToTile(ft);
    ctx.strokeStyle = `rgba(38,24,14,${heavy ? 0.9 : 0.5})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(ax - outX * inset, ay - outY * inset);
    ctx.lineTo(bx - outX * inset, by - outY * inset);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Smooth summit relief for local high points.
   * Keeps the original peak cue, but uses clipped whole-hex gradients so the
   * result is rounded instead of a six-sided pyramid.
   */
  private drawPeakOrganicRelief(ft: FlatTile, tile: TileData): void {
    if (ft.poly.length < 6) return;

    const ownLevel = this.c.elevationLevel(tile);
    if (ownLevel <= 0) return;

    const neighbourLevels = tile.n.map((nIdx: number) => this.c.elevationLevel(this.c.world.tiles[nIdx]));
    const lowerCount = neighbourLevels.filter((h) => h < ownLevel).length;
    if (lowerCount < 4) return;

    const maxDrop = Math.max(0, ...neighbourLevels.map((h) => ownLevel - h));
    const peakStrength = Math.min(1, 0.56 + (lowerCount - 4) * 0.15 + maxDrop * 0.12);

    const [csx, csy] = this.c.worldToScreen(ft.cx, ft.cy);
    const radius = this.c.screenHexRadius(ft);
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const ctx = this.c.ctx;

    const lightAlpha = Math.min(0.40, (0.16 + ownLevel * 0.055) * peakStrength);
    const shadowAlpha = Math.min(0.46, (0.18 + ownLevel * 0.060) * peakStrength);
    const domeAlpha = Math.min(0.16, (0.06 + ownLevel * 0.020) * peakStrength);

    ctx.save();
    this.c.clipToTile(ft);
    ctx.globalCompositeOperation = 'source-over';

    // Broad light from the sun side.
    const lightGrad = ctx.createRadialGradient(
      csx + SUN_X * radius * 0.42,
      csy + SUN_Y * radius * 0.42,
      radius * 0.06,
      csx + SUN_X * radius * 0.18,
      csy + SUN_Y * radius * 0.18,
      radius * 1.25,
    );
    lightGrad.addColorStop(0.00, `rgba(255,252,220,${lightAlpha.toFixed(3)})`);
    lightGrad.addColorStop(0.44, `rgba(255,252,220,${(lightAlpha * 0.28).toFixed(3)})`);
    lightGrad.addColorStop(1.00, 'rgba(255,252,220,0.000)');
    ctx.fillStyle = lightGrad;
    this.c.traceTilePath(ft);
    ctx.fill();

    // Broad shadow on the lee side.
    const shadowGrad = ctx.createRadialGradient(
      csx - SUN_X * radius * 0.55,
      csy - SUN_Y * radius * 0.55,
      radius * 0.02,
      csx - SUN_X * radius * 0.20,
      csy - SUN_Y * radius * 0.20,
      radius * 1.22,
    );
    shadowGrad.addColorStop(0.00, `rgba(7,12,22,${shadowAlpha.toFixed(3)})`);
    shadowGrad.addColorStop(0.48, `rgba(7,12,22,${(shadowAlpha * 0.30).toFixed(3)})`);
    shadowGrad.addColorStop(1.00, 'rgba(7,12,22,0.000)');
    ctx.fillStyle = shadowGrad;
    this.c.traceTilePath(ft);
    ctx.fill();

    // Soft central dome, very low alpha, to prevent the hex reading as a flat plate.
    const dome = ctx.createRadialGradient(csx, csy, 0, csx, csy, radius * 0.85);
    dome.addColorStop(0.00, `rgba(255,252,225,${domeAlpha.toFixed(3)})`);
    dome.addColorStop(0.45, `rgba(255,252,225,${(domeAlpha * 0.38).toFixed(3)})`);
    dome.addColorStop(1.00, 'rgba(255,252,225,0.000)');
    ctx.fillStyle = dome;
    this.c.traceTilePath(ft);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Smooth relief for one-hex local troughs. Kept subtle, but continuous.
   */
  private drawSingleHexRelief(ft: FlatTile, tile: TileData): void {
    if (ft.poly.length < 6) return;

    const ownLevel = this.c.elevationLevel(tile);
    const neighbourLevels = tile.n.map((nIdx: number) => this.c.elevationLevel(this.c.world.tiles[nIdx]));
    const isTrough = neighbourLevels.every((h) => h > ownLevel);
    if (!isTrough) return;

    const [csx, csy] = this.c.worldToScreen(ft.cx, ft.cy);
    const radius = this.c.screenHexRadius(ft);
    const SUN_X = -0.707;
    const SUN_Y = -0.707;
    const level = Math.max(1, Math.min(3, Math.max(...neighbourLevels) - ownLevel));
    const ctx = this.c.ctx;

    ctx.save();
    this.c.clipToTile(ft);

    const shadowAlpha = Math.min(0.34, 0.16 + level * 0.055);
    const lightAlpha = Math.min(0.24, 0.10 + level * 0.035);

    const shadow = ctx.createRadialGradient(
      csx + SUN_X * radius * 0.18,
      csy + SUN_Y * radius * 0.18,
      radius * 0.08,
      csx,
      csy,
      radius * 0.95,
    );
    shadow.addColorStop(0.00, `rgba(8,13,24,${shadowAlpha.toFixed(3)})`);
    shadow.addColorStop(0.55, `rgba(8,13,24,${(shadowAlpha * 0.35).toFixed(3)})`);
    shadow.addColorStop(1.00, 'rgba(8,13,24,0.000)');
    ctx.fillStyle = shadow;
    this.c.traceTilePath(ft);
    ctx.fill();

    const rim = ctx.createRadialGradient(
      csx - SUN_X * radius * 0.45,
      csy - SUN_Y * radius * 0.45,
      radius * 0.04,
      csx - SUN_X * radius * 0.20,
      csy - SUN_Y * radius * 0.20,
      radius * 1.10,
    );
    rim.addColorStop(0.00, `rgba(255,250,220,${lightAlpha.toFixed(3)})`);
    rim.addColorStop(0.46, `rgba(255,250,220,${(lightAlpha * 0.25).toFixed(3)})`);
    rim.addColorStop(1.00, 'rgba(255,250,220,0.000)');
    ctx.fillStyle = rim;
    this.c.traceTilePath(ft);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw elevation shading using a local height field.
   * This method is available for future use but is currently not called from
   * drawAllTiles (elevation is handled by drawContourRelief instead).
   */
  drawElevationShading(
    ft: FlatTile,
    tile: TileData,
    ftByTile: Map<number, FlatTile>,
  ): void {
    if (ft.poly.length < 6) return;

    const [csx, csy] = this.c.worldToScreen(ft.cx, ft.cy);

    let avgRadius = 0;
    for (const v of ft.poly) {
      const [vx, vy] = this.c.worldToScreen(v.x, v.y);
      avgRadius += Math.sqrt((vx - csx) ** 2 + (vy - csy) ** 2);
    }
    avgRadius /= ft.poly.length;
    if (avgRadius < 5) return;

    const SUN_X = -0.707;
    const SUN_Y = -0.707;

    const centreHeight = this.c.elevationHeight(tile);

    let peakPull: number;
    let litAlpha: number;
    let shadowAlpha: number;

    switch (true) {
      case (tile.h ?? 0) >= 9:
        peakPull = 0.62; litAlpha = 0.93; shadowAlpha = 0.63;
        break;
      case (tile.h ?? 0) >= 6:
        peakPull = 0.38; litAlpha = 0.57; shadowAlpha = 0.36;
        break;
      case (tile.h ?? 0) >= 3:
        peakPull = 0.18; litAlpha = 0.27; shadowAlpha = 0.18;
        break;
      default:
        peakPull = 0.62; litAlpha = 0.93; shadowAlpha = 0.63;
        break;
    }

    const ctx = this.c.ctx;
    ctx.save();

    for (let seg = 0; seg < ft.poly.length; seg++) {
      const v0 = ft.poly[seg];
      const v1 = ft.poly[(seg + 1) % ft.poly.length];

      const [ax, ay] = this.c.worldToScreen(v0.x, v0.y);
      const [bx, by] = this.c.worldToScreen(v1.x, v1.y);

      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const outX = midX - csx;
      const outY = midY - csy;
      const outLen = Math.sqrt(outX * outX + outY * outY);
      if (outLen < 1e-6) continue;
      const normX = outX / outLen;
      const normY = outY / outLen;

      const neighbour = this.c.neighbourAcrossSegment(tile, ft, seg, ftByTile);
      const neighbourHeight = neighbour ? this.c.elevationHeight(neighbour) : centreHeight;
      const heightDelta = centreHeight - neighbourHeight;

      const slopeSign = Math.abs(heightDelta) < 0.03 ? 1 : Math.sign(heightDelta);
      const sunFacing = (normX * SUN_X + normY * SUN_Y) * slopeSign;

      const slopeStrength = Math.min(1, Math.abs(heightDelta) * 1.8 + centreHeight * 0.25);
      const dot = sunFacing * (0.35 + 0.65 * slopeStrength);

      const neighbourPull = heightDelta < -0.03 ? Math.min(0.18, Math.abs(heightDelta) * 0.12) : 0;
      const facePeakPull = Math.min(0.78, peakPull + neighbourPull);
      const apexX = csx + (midX - csx) * facePeakPull;
      const apexY = csy + (midY - csy) * facePeakPull;

      const grad = ctx.createLinearGradient(apexX, apexY, midX, midY);

      if (dot >= 0) {
        const a = dot * litAlpha;
        grad.addColorStop(0,    `rgba(255,252,240,${(a * 1.0).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(255,252,240,${(a * 0.35).toFixed(3)})`);
        grad.addColorStop(1,    'rgba(255,252,240,0.00)');
      } else {
        const a = (-dot) * shadowAlpha;
        grad.addColorStop(0,    `rgba(20,30,50,${(a * 1.0).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(20,30,50,${(a * 0.55).toFixed(3)})`);
        grad.addColorStop(1,    'rgba(20,30,50,0.00)');
      }

      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      const relief = Math.min(1, Math.abs(heightDelta) * 2.0 + centreHeight * 0.15);
      const ridgeAlpha = dot >= 0
        ? dot * relief * ((tile.h ?? 0) >= 9 ? 0.63 : (tile.h ?? 0) >= 6 ? 0.36 : 0.18)
        : 0.038 * relief;
      ctx.strokeStyle = `rgba(255,255,255,${ridgeAlpha.toFixed(3)})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(csx, csy); ctx.lineTo(ax, ay);
      ctx.moveTo(csx, csy); ctx.lineTo(bx, by);
      ctx.stroke();
    }

    ctx.restore();
  }
}
