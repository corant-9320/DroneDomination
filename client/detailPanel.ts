/**
 * Detail Panel — populates the right curtain's info sections when the player
 * selects a hex or unit, hovers an enemy, or a combat preview arrives.
 *
 * Sections (all in index.html):
 *   #hex-info-desc     — terrain inline in Unit Info header
 *   #unit-info-body    — selected unit: name + full attribute table
 *   #enemy-info-desc   — terrain inline in Enemy Info header
 *   #enemy-info-body   — hovered enemy unit: name + full attribute table
 *   #enemy-hex-body    — other units sharing the enemy's hex (splash context)
 *   #combat-info-body  — combat preview steps (from server)
 */

import { WorldData, TileData, UnitData, BuildingData } from './worldData.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { readableUnitName } from './unitNames.js';
import { esc, capitalize, toneColor } from './htmlUtils.js';
import { renderCombatBreakdownTable } from './combatBreakdownView.js';
import type { ExplainedCombat } from '../shared/combatTypes.js';
import { getMaxMovement } from '../shared/movementConstants.js';
import { tileHeight, HEIGHT_LEVELS } from '../shared/movementConstants.js';
import type { TurnManager } from './turnManager.js';

// ---------------------------------------------------------------------------
// Attribute display config
// ---------------------------------------------------------------------------

type AttrKey = keyof import('../shared/unitTypes.js').UnitAttributes;

interface AttrRow {
  label: string;
  key: AttrKey;
}

const ATTR_ROWS: AttrRow[] = [

  { label: 'Kinetic',   key: 'kinetic' },
  { label: 'Armour',    key: 'armour' },
  { label: 'EW',        key: 'defence' },
  { label: 'Splash',    key: 'splashAttack' },
  { label: 'Range Att', key: 'rangeAttack' },
  { label: 'Anti-Air',  key: 'antiAir' },
  { label: 'Repair',    key: 'repair' },
  { label: 'Engineer',  key: 'engineer' },
  { label: 'Movement',  key: 'wheeledMovement' },
  { label: 'Movement',  key: 'limbMovement' },
  { label: 'Movement',  key: 'flightMovement' },
];

// ---------------------------------------------------------------------------
// DetailPanel
// ---------------------------------------------------------------------------

export class DetailPanel {
  private hexDesc: HTMLElement;
  private enemyDesc: HTMLElement;
  private unitBody: HTMLElement;
  private enemyBody: HTMLElement;
  private enemyHexBody: HTMLElement;
  private combatBody: HTMLElement;
  private world: WorldData;
  private turnManager: TurnManager | null = null;

  /**
   * Callbacks for building actions triggered from the building card.
   * Wired by main.ts after construction.
   */
  onBuildingRefit: ((buildingId: string) => void) | null = null;
  onBuildingAttack: ((buildingId: string) => void) | null = null;
  onBuildingRepair: ((buildingId: string) => void) | null = null;

  constructor(world: WorldData) {
    this.world = world;
    this.hexDesc      = document.getElementById('hex-info-desc')!;
    this.enemyDesc    = document.getElementById('enemy-info-desc')!;
    this.unitBody     = document.getElementById('unit-info-body')!;
    this.enemyBody    = document.getElementById('enemy-info-body')!;
    this.enemyHexBody = document.getElementById('enemy-hex-body')!;
    this.combatBody   = document.getElementById('combat-info-body')!;
    this.clear();
  }

  /** Update world reference after a new world is loaded. */
  setWorld(world: WorldData): void {
    this.world = world;
    this.clear();
  }

  /** Provide the turn manager so movement can be shown as remaining/max. */
  setTurnManager(tm: TurnManager): void {
    this.turnManager = tm;
  }

  /**
   * Show detail for a selected tile + optional focused segment.
   * Populates Hex, Unit, and Squad sections.
   * Clears Enemy and Combat (those are driven by hover).
   */
  showTile(tileIndex: number, segment?: number): void {
    const tile = this.world.tiles[tileIndex];
    if (!tile) {
      dbg.detail.warn('showTile: invalid tileIndex', tileIndex);
      this.clear();
      return;
    }

    const city  = this.world.cities.find((c) => c.tileIndex === tileIndex);
    const units = (this.world.units ?? []).filter((u) => u.tileIndex === tileIndex);

    const focusedUnit = segment !== undefined
      ? units.find((u) => u.segment === segment)
      : undefined;

    dbg.detail.log('showTile:', tileIndex, {
      terrain: tile.terrain,
      city: city?.label,
      units: units.length,
      focusedSegment: segment,
    });

    this.renderHex(tile, city);
    this.renderUnit(focusedUnit);
    // Leave enemy + combat sections as-is (hover-driven)
  }

  /**
   * Show a selected player-owned building in the Unit Info section.
   * Replaces the unit card with a building card that lists its capabilities
   * and available action buttons based on its attribute loadout.
   * Pass null to clear back to "No unit selected".
   */
  showBuilding(building: BuildingData | null): void {
    if (!building) {
      this.unitBody.innerHTML = '<span class="empty-msg">No unit selected</span>';
      return;
    }
    this.renderBuildingCard(this.unitBody, building);
  }

  /**
   * Show the hovered enemy unit in the Enemy Info section.
   * Pass null to clear it.
   */
  showEnemy(unit: UnitData | null): void {
    if (!unit) {
      this.enemyDesc.textContent = '';
      this.enemyBody.innerHTML = '<span class="empty-msg">No enemy in range</span>';
      this.enemyHexBody.innerHTML = '';
      return;
    }
    const tile = this.world.tiles[unit.tileIndex];
    if (tile) {
      const city = this.world.cities.find((c) => c.tileIndex === unit.tileIndex);
      this.enemyDesc.textContent = '— ' + this.buildTerrainDesc(tile, city);
    }
    this.renderUnitCard(this.enemyBody, unit);
    this.renderEnemyHex(unit);
  }

  /**
   * Show a combat preview in the Combat Info section.
   * Pass null to clear it.
   */
  showCombat(preview: ExplainedCombat | null): void {
    if (!preview) {
      this.combatBody.innerHTML = '<span class="empty-msg">Hover an enemy to preview</span>';
      return;
    }
    this.renderCombatPreview(preview);
  }

  /** Clear all sections. */
  clear(): void {
    this.hexDesc.textContent      = '';
    this.enemyDesc.textContent    = '';
    this.unitBody.innerHTML       = '<span class="empty-msg">No unit selected</span>';
    this.enemyBody.innerHTML      = '<span class="empty-msg">No enemy in range</span>';
    this.enemyHexBody.innerHTML   = '';
    this.combatBody.innerHTML     = '<span class="empty-msg">Hover an enemy to preview</span>';
  }

  // ─── Private renderers ────────────────────────────────────────────────────

  private renderHex(
    tile: TileData,
    city?: { id: string; label: string; isPlayerHome?: boolean; neighbourCityIds: string[] },
  ): void {
    this.hexDesc.textContent = '— ' + this.buildTerrainDesc(tile, city);
  }

  private buildTerrainDesc(
    tile: TileData,
    city?: { id: string; label: string; isPlayerHome?: boolean; neighbourCityIds: string[] },
  ): string {
    const parts: string[] = [];
    if (tile.f) parts.push('Forested');
    const h = tile.h ?? 0;
    const elev = h >= 9 ? 'Mountain' : h >= 6 ? 'Hills' : h >= 3 ? 'Rolling' : '';
    const terrain = capitalize(tile.terrain);
    // River hexes are ocean terrain under the hood — label them as rivers.
    if (tile.bridge) {
      parts.push('Bridge (river crossing)');
    } else if (tile.rv !== undefined) {
      parts.push('River');
    } else {
      parts.push(elev ? `${elev} ${terrain}` : terrain);
    }
    // Discrete terrain height (0–11). Open ocean sits at sea level; rivers
    // descend the valley so they report their own height.
    if (tile.terrain === 'ocean' && tile.rv === undefined) {
      parts.push('Height 0/' + (HEIGHT_LEVELS - 1) + ' (sea level)');
    } else {
      parts.push(`Height ${tileHeight(tile)}/${HEIGHT_LEVELS - 1}`);
    }
    if (city) {
      const owner = city.isPlayerHome ? 'Player' : 'Enemy';
      parts.push(`${owner} City: ${city.label}`);
    }
    return parts.join(', ');
  }

  private renderUnit(unit: UnitData | undefined): void {
    if (!unit) {
      this.unitBody.innerHTML = '<span class="empty-msg">No unit selected</span>';
      return;
    }
    this.renderUnitCard(this.unitBody, unit);
  }

  /** Render compact summary rows for all other units sharing the enemy's hex (splash context). */
  private renderEnemyHex(primary: UnitData): void {
    const hexMates = (this.world.units ?? []).filter(
      (u) => u.tileIndex === primary.tileIndex && u.id !== primary.id && u.currentHealth > 0,
    );

    if (hexMates.length === 0) {
      this.enemyHexBody.innerHTML = '';
      return;
    }

    let html = `<div class="dp-enemy-hex-header">💥 Also on hex (${hexMates.length})</div>`;
    for (const unit of hexMates) {
      const color = factionColor(this.world, unit.ownerId);
      const attrs = unit.attributes;
      const maxHp = (attrs.size ?? 1) * 10;
      const arm   = attrs.armour ?? 0;
      const ew    = attrs.defence ?? 0;
      const idSuffix = unit.id.replace(/^unit_/, '');
      html += `<div class="dp-other-unit">`;
      html += `<span class="dp-other-name" style="color:${color};">#${esc(idSuffix)} ${esc(unit.label)}</span>`;
      html += `<span class="dp-other-stats">HP ${unit.currentHealth}/${maxHp} · Arm ${arm} · EW ${ew}</span>`;
      html += `</div>`;
    }

    this.enemyHexBody.innerHTML = html;
  }

  /** Render a building card (capabilities + actions) into a target element. */
  private renderBuildingCard(target: HTMLElement, building: BuildingData): void {
    const color = factionColor(this.world, building.ownerId);
    const attrs = building.attributes ?? {};
    const idSuffix = building.id.replace(/^building_/, '');

    const hasKinetic = (attrs.kinetic ?? 0) > 0;
    const hasSplash  = (attrs.splashAttack ?? 0) > 0;
    const hasAntiAir = (attrs.antiAir ?? 0) > 0;
    const hasRepair  = (attrs.repair ?? 0) > 0;
    const canAttack  = hasKinetic || hasSplash || hasAntiAir;

    // Building attribute rows — the seven equipment attrs only
    const BUILDING_ATTR_ROWS: Array<{ label: string; key: keyof typeof attrs }> = [
      { label: 'Kinetic',   key: 'kinetic' },
      { label: 'Range Att', key: 'rangeAttack' },
      { label: 'Splash',    key: 'splashAttack' },
      { label: 'Anti-Air',  key: 'antiAir' },
      { label: 'Armour',    key: 'armour' },
      { label: 'EW',        key: 'defence' },
      { label: 'Repair',    key: 'repair' },
    ];

    let html = '';

    // Name header
    html += `<div class="dp-unit-name" style="color:${color};">🏛 Building <span style="color:#666;font-size:0.8em;">#${esc(idSuffix)}</span></div>`;

    // Attribute table — only non-zero defined attributes
    html += `<table class="dp-attr-table">`;
    for (const row of BUILDING_ATTR_ROWS) {
      const val = attrs[row.key];
      if (!val || val === 0) continue;
      html += `<tr><td class="dp-key">${row.label}</td><td class="dp-val">${val}</td></tr>`;
    }
    html += `</table>`;

    // Actions section
    html += `<div class="dp-building-actions" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">`;

    if (canAttack) {
      html += `<button class="dp-building-btn dp-building-btn--attack" data-building-id="${esc(building.id)}" title="Select a target to attack (right-click an enemy in range)" style="padding:4px 10px;background:#c0392b;border:none;color:#fff;border-radius:3px;cursor:pointer;font-size:12px;">⚔ Attack</button>`;
    }

    if (hasRepair) {
      html += `<button class="dp-building-btn dp-building-btn--repair" data-building-id="${esc(building.id)}" title="Repair a friendly unit in the same hex" style="padding:4px 10px;background:#2a7d4f;border:none;color:#fff;border-radius:3px;cursor:pointer;font-size:12px;">🔧 Repair</button>`;
    }

    html += `<button class="dp-building-btn dp-building-btn--refit" data-building-id="${esc(building.id)}" title="Reconfigure this building's equipment" style="padding:4px 10px;background:#2a4d8f;border:none;color:#fff;border-radius:3px;cursor:pointer;font-size:12px;">⚙ Refit</button>`;

    html += `</div>`;

    if (!canAttack && !hasRepair) {
      html += `<div style="margin-top:6px;font-size:11px;color:#555;">No combat loadout — use ⚙ Refit to equip weapons.</div>`;
    }

    target.innerHTML = html;

    // Wire action buttons after DOM insertion
    const refitBtn = target.querySelector('.dp-building-btn--refit') as HTMLButtonElement | null;
    if (refitBtn) {
      refitBtn.addEventListener('click', () => {
        this.onBuildingRefit?.(building.id);
      });
    }
    // Attack / Repair buttons are informational hints — the actual action is
    // still triggered by right-clicking a target (same as units). The buttons
    // show a tooltip so players know the building can act.
    const attackBtn = target.querySelector('.dp-building-btn--attack') as HTMLButtonElement | null;
    if (attackBtn) {
      attackBtn.addEventListener('click', () => {
        this.onBuildingAttack?.(building.id);
      });
    }
    const repairBtn = target.querySelector('.dp-building-btn--repair') as HTMLButtonElement | null;
    if (repairBtn) {
      repairBtn.addEventListener('click', () => {
        this.onBuildingRepair?.(building.id);
      });
    }
  }

  /** Render a full unit card (name + HP bar + attribute table) into a target element. */
  private renderUnitCard(target: HTMLElement, unit: UnitData): void {
    const color = factionColor(this.world, unit.ownerId);
    const name  = readableUnitName(unit);
    const attrs = unit.attributes;
    const maxHp = (attrs.size ?? 1) * 10;
    const hpRatio = Math.max(0, Math.min(1, unit.currentHealth / maxHp));

    let html = '';

    // Name in faction colour, with unit ID suffix
    const idSuffix = unit.id.replace(/^unit_/, '');
    html += `<div class="dp-unit-name" style="color:${color};">${esc(name)} <span style="color:#666;font-size:0.8em;">#${esc(idSuffix)}</span></div>`;

    // HP bar
    html += `<div class="dp-hp-bar-wrap">`;
    html += `  <div class="dp-hp-bar-fill" style="width:${(hpRatio * 100).toFixed(1)}%;"></div>`;
    html += `</div>`;
    html += dpRow('HP', `${unit.currentHealth} / ${maxHp}`);

    // Attribute table — only non-zero defined attributes
    html += `<table class="dp-attr-table">`;
    for (const row of ATTR_ROWS) {
      const val = attrs[row.key];
      if (val === undefined || val === 0) continue;
      // Movement rows: show remaining/max when TurnManager is available
      const isMovementRow = row.key === 'wheeledMovement' || row.key === 'limbMovement' || row.key === 'flightMovement';
      let displayVal: string;
      if (isMovementRow && this.turnManager) {
        const max = getMaxMovement(attrs);
        const remaining = this.turnManager.getMovementPoints(unit.id);
        displayVal = `${remaining}/${max}`;
      } else {
        displayVal = String(val);
      }
      html += `<tr><td class="dp-key">${row.label}</td><td class="dp-val">${displayVal}</td></tr>`;
    }
    html += `</table>`;

    target.innerHTML = html;
  }

  private renderCombatPreview(c: ExplainedCombat): void {
    const html = renderCombatBreakdownTable(c, this.world);
    this.combatBody.innerHTML = html ?? '<span class="empty-msg">No preview data</span>';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dpRow(label: string, value: string): string {
  return `<div class="dp-row"><span class="dp-key">${label}</span><span class="dp-val">${value}</span></div>`;
}


