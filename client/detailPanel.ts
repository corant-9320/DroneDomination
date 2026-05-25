/**
 * Detail Panel — shows terrain, units, and building info for the selected hex.
 * Renders into #detail-panel at the bottom of the local map.
 */

import { WorldData, TileData, UnitData } from './worldData.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { readableUnitName } from './unitNames.js';

/** Map facing index (0–5) to compass direction label. */
const FACING_LABELS: Record<number, string> = {
  0: 'N',
  1: 'NE',
  2: 'SE',
  3: 'S',
  4: 'SW',
  5: 'NW',
};

export class DetailPanel {
  private el: HTMLElement;
  private world: WorldData;

  constructor(el: HTMLElement, world: WorldData) {
    // Render into #detail-content sub-element if present, otherwise use el directly
    const content = el.querySelector('#detail-content') as HTMLElement | null;
    this.el = content ?? el;
    this.world = world;
    this.showEmpty();
  }

  /** Show the detail for a selected tile, optionally focusing a specific segment. */
  showTile(tileIndex: number, segment?: number) {
    const tile = this.world.tiles[tileIndex];
    if (!tile) {
      dbg.detail.warn('showTile: invalid tileIndex', tileIndex);
      this.showEmpty();
      return;
    }

    const city = this.world.cities.find((c) => c.tileIndex === tileIndex);
    const units = (this.world.units ?? []).filter((u) => u.tileIndex === tileIndex);
    const focusedUnit = segment !== undefined
      ? units.find((u) => u.segment === segment)
      : undefined;
    dbg.detail.log('showTile:', tileIndex, {
      terrain: tile.terrain,
      elevType: tile.elevType,
      city: city?.label,
      units: units.length,
      focusedSegment: segment,
      focusedUnit: focusedUnit?.label,
    });

    let html = '';

    // Tile header
    html += `<div class="section">`;
    html += `<h3>Tile #${tile.idx}</h3>`;
    html += `<div>${tile.s === 5 ? 'Pentagon' : 'Hexagon'} · ${tile.n.length} neighbours</div>`;
    html += `</div>`;

    // Terrain section
    html += `<div class="section">`;
    html += `<h3>Terrain</h3>`;
    html += `<div>${capitalize(tile.terrain)}</div>`;
    html += `<div>Elevation: ${capitalize(tile.elevType)}</div>`;
    html += `</div>`;

    // City section
    if (city) {
      const color = factionColor(this.world, city.id);
      html += `<div class="section">`;
      html += `<h3>City</h3>`;
      html += `<div style="color:${color}; font-weight:bold;">${city.label}</div>`;
      html += `<div>${city.isPlayerHome ? 'Player Home' : 'Enemy'}</div>`;
      html += `<div>City neighbours: ${city.neighbourCityIds.length}</div>`;
      html += `</div>`;
    }

    // Units section
    html += `<div class="section">`;
    html += `<h3>Units (${units.length})</h3>`;
    if (units.length === 0) {
      html += `<div class="empty-msg">No units on this tile</div>`;
    } else {
      for (const unit of units) {
        const isFocused = focusedUnit && unit.id === focusedUnit.id;
        html += this.renderUnitCard(unit, isFocused);
      }
    }
    html += `</div>`;

    // Building section (placeholder for future)
    html += `<div class="section">`;
    html += `<h3>Building</h3>`;
    html += `<div class="empty-msg">None</div>`;
    html += `</div>`;

    this.el.innerHTML = html;
  }

  private renderUnitCard(unit: UnitData, focused?: boolean): string {
    const color = factionColor(this.world, unit.ownerId);
    const attrs = unit.attributes;

    // Generate the readable name from attributes
    const readableName = readableUnitName(unit);

    const focusStyle = focused
      ? 'border:1px solid #fff; background:rgba(255,255,255,0.08);'
      : '';
    let html = `<div class="unit-card" style="${focusStyle}">`;
    const facing = FACING_LABELS[unit.facing] ?? `seg ${unit.facing}`;
    html += `<div class="unit-label" style="color:${color};">${readableName} <span style="font-weight:normal;color:#888;">(${facing})</span></div>`;

    if (focused) {
      // Detailed per-line view for selected unit — all attributes in parenthesis order
      const mov = attrs.wheeledMovement ?? attrs.limbMovement ?? attrs.flightMovement ?? 0;
      const lines: [string, string][] = [];
      lines.push(['HP', `${unit.currentHealth}/${(attrs.maxHealth ?? 1) * 10}`]);
      lines.push(['Movement', `${mov}`]);
      lines.push(['Attack', `${attrs.attack ?? 0}`]);
      lines.push(['Range', `${attrs.rangeAttack ?? 0}`]);
      lines.push(['Splash', `${attrs.splashAttack ?? 0}`]);
      lines.push(['Armour', `${attrs.armour ?? 0}`]);
      lines.push(['EW', `${attrs.defence ?? 0}`]);
      lines.push(['Repair', `${attrs.repair ?? 0}`]);

      html += `<div class="unit-attr-detail">`;
      for (const [label, value] of lines) {
        html += `<div class="unit-attr-row"><span class="unit-attr-key">${label}</span><span class="unit-attr-val">${value}</span></div>`;
      }
      html += `</div>`;
    } else {
      // Compact parenthesized summary for non-selected units
      const mov = attrs.wheeledMovement ?? attrs.limbMovement ?? attrs.flightMovement ?? 0;
      const att = attrs.attack ?? 0;
      const rng = attrs.rangeAttack ?? 0;
      const spl = attrs.splashAttack ?? 0;
      const arm = attrs.armour ?? 0;
      const ew = attrs.defence ?? 0;
      const rep = attrs.repair ?? 0;
      html += `<div class="unit-attr">HP ${unit.currentHealth}/${(attrs.maxHealth ?? 1) * 10} (Mov ${mov}, Att ${att}, Rng ${rng}, Spl ${spl}, Arm ${arm}, EW ${ew}, Rep ${rep})</div>`;
    }

    html += `</div>`;
    return html;
  }

  private showEmpty() {
    this.el.innerHTML = `<div class="section"><h3>Hex Detail</h3><div class="empty-msg">Select a hex to inspect</div></div>`;
  }
}

function capitalize(s: string | undefined | null): string {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
