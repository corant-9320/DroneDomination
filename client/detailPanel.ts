/**
 * Detail Panel — shows terrain, units, and building info for the selected hex.
 * Renders into #detail-panel on the right side of the local map.
 */

import { WorldData, TileData, UnitData } from './worldData.js';
import { factionColor } from './factionColors.js';
import { dbg } from './debug.js';

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

  /** Show the detail for a selected tile. */
  showTile(tileIndex: number) {
    const tile = this.world.tiles[tileIndex];
    if (!tile) {
      dbg.detail.warn('showTile: invalid tileIndex', tileIndex);
      this.showEmpty();
      return;
    }

    const city = this.world.cities.find((c) => c.tileIndex === tileIndex);
    const units = (this.world.units ?? []).filter((u) => u.tileIndex === tileIndex);
    dbg.detail.log('showTile:', tileIndex, {
      terrain: tile.terrain,
      elev: tile.elev,
      city: city?.label,
      units: units.length,
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
    html += `<div>Elevation: ${(tile.elev * 100).toFixed(0)}%</div>`;
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
        html += this.renderUnitCard(unit);
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

  private renderUnitCard(unit: UnitData): string {
    const color = factionColor(this.world, unit.ownerId);
    const attrs = unit.attributes;

    let attrLines: string[] = [];
    attrLines.push(`HP: ${unit.currentHealth}/${attrs.maxHealth ?? 1}`);

    if (attrs.meleeAttack) attrLines.push(`Melee: ${attrs.meleeAttack}`);
    if (attrs.rangeAttack) attrLines.push(`Range: ${attrs.rangeAttack}`);
    if (attrs.armour) attrLines.push(`Armour: ${attrs.armour}`);
    if (attrs.wheeledMovement) attrLines.push(`Wheeled: ${attrs.wheeledMovement}`);
    if (attrs.limbMovement) attrLines.push(`Limb: ${attrs.limbMovement}`);
    if (attrs.flightMovement) attrLines.push(`Flight: ${attrs.flightMovement}`);
    if (attrs.repair) attrLines.push(`Repair: ${attrs.repair}`);
    if (attrs.initiative) attrLines.push(`Initiative: ${attrs.initiative}`);

    let html = `<div class="unit-card">`;
    html += `<div class="unit-label" style="color:${color};">${unit.label} <span style="font-weight:normal;color:#888;">(seg ${unit.segment})</span></div>`;
    html += `<div class="unit-attr">${attrLines.join(' · ')}</div>`;
    html += `</div>`;
    return html;
  }

  private showEmpty() {
    this.el.innerHTML = `<div class="section"><h3>Hex Detail</h3><div class="empty-msg">Select a hex to inspect</div></div>`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
