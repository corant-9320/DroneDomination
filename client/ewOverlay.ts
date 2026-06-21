/**
 * EW coverage overlay — draws radius-based Electronic Warfare anti-drone
 * screens on the local map.
 *
 * Two modes (mutually exclusive):
 *   - Global: every EW-bearing unit and building (both factions). Toggled by 'e'.
 *   - Focus:  a single entity at a chosen tile+segment. Set via the right-click
 *             "EW coverage" menu item on a unit or building of either faction.
 *
 * State is module-level so the keyboard handler and context menus can flip it
 * without threading it through LocalMapView; the render loop calls
 * drawEwCoverage() every frame and reads the current state.
 *
 * A unit's `defence` value is its coverage radius in tile hops; the circle is
 * drawn with that radius. Overlapping circles visualise stacked protection
 * (see combat.ts getEWProtection / COMBAT_RULES §12).
 */

import type { WorldData } from './worldData.js';
import type { FlatTile } from './localMapProjection.js';
import { factionColor } from './colors.js';

type Focus = { tileIndex: number; segment: number } | null;

let globalOn = false;
let focus: Focus = null;

/** Whether any EW coverage is currently shown. */
export function isEwOverlayActive(): boolean {
  return globalOn || focus !== null;
}

/** Toggle the global "show everyone's EW" overlay. Clears any focus. Returns new state. */
export function toggleEwGlobal(): boolean {
  focus = null;
  globalOn = !globalOn;
  return globalOn;
}

/** Focus the overlay on the single entity at a tile+segment (either faction). */
export function setEwFocus(tileIndex: number, segment: number): void {
  globalOn = false;
  focus = { tileIndex, segment };
}

/** Hide all EW coverage. */
export function clearEwOverlay(): void {
  globalOn = false;
  focus = null;
}

interface EwSource {
  tileIndex: number;
  /** Coverage radius in hops (= the entity's `defence`). */
  radius: number;
  ownerId: string;
}

/** Gather the EW sources to draw based on the current overlay state. */
function collectSources(world: WorldData): EwSource[] {
  const sources: EwSource[] = [];
  const add = (tileIndex: number, defence: number | undefined, ownerId: string): void => {
    if ((defence ?? 0) > 0) sources.push({ tileIndex, radius: defence as number, ownerId });
  };

  if (focus) {
    const unit = world.units.find(
      (u) => u.tileIndex === focus!.tileIndex && u.segment === focus!.segment,
    );
    if (unit) {
      add(unit.tileIndex, unit.attributes.defence, unit.ownerId);
    } else {
      const building = (world.buildings ?? []).find(
        (b) => b.tileIndex === focus!.tileIndex && b.segment === focus!.segment,
      );
      if (building) add(building.tileIndex, building.attributes?.defence, building.ownerId);
    }
  } else if (globalOn) {
    for (const u of world.units) add(u.tileIndex, u.attributes.defence, u.ownerId);
    for (const b of world.buildings ?? []) add(b.tileIndex, b.attributes?.defence, b.ownerId);
  }

  return sources;
}

/**
 * Draw the EW coverage circles for the current overlay state. No-op when the
 * overlay is off or no source is in view. Called from LocalMapView.render().
 */
export function drawEwCoverage(
  ctx: CanvasRenderingContext2D,
  world: WorldData,
  flatTiles: FlatTile[],
  wts: (wx: number, wy: number) => [number, number],
): void {
  const sources = collectSources(world);
  if (sources.length === 0) return;

  const ftByTile = new Map<number, FlatTile>();
  for (const ft of flatTiles) ftByTile.set(ft.tileIndex, ft);

  ctx.save();
  for (const s of sources) {
    const ft = ftByTile.get(s.tileIndex);
    if (!ft) continue; // source not in the current local-map view
    const [sx, sy] = wts(ft.cx, ft.cy);

    // Per-hop screen distance = mean centre-to-centre distance to visible neighbours.
    let perHop = 0;
    let count = 0;
    for (const nIdx of world.tiles[s.tileIndex].n) {
      const nft = ftByTile.get(nIdx);
      if (!nft) continue;
      const [nx, ny] = wts(nft.cx, nft.cy);
      perHop += Math.hypot(nx - sx, ny - sy);
      count++;
    }
    if (count === 0) continue;
    perHop /= count;

    const r = s.radius * perHop;
    const color = factionColor(world, s.ownerId);

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Source marker dot.
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
