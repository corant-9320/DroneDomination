/**
 * Detail Panel — populates the right curtain's info sections when the player
 * selects a hex or unit, hovers an enemy, or a combat preview arrives.
 *
 * Sections (all in index.html):
 *   #hex-info-body     — terrain, elevation, city
 *   #unit-info-body    — selected unit: name + full attribute table
 *   #squad-info-body   — other friendly units on the same hex
 *   #enemy-info-body   — hovered enemy unit: name + full attribute table
 *   #combat-info-body  — combat preview steps (from server)
 */

import { WorldData, TileData, UnitData } from './worldData.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { readableUnitName } from './unitNames.js';
import { esc, capitalize, toneColor } from './htmlUtils.js';
import type { ExplainedCombat } from '../shared/combatTypes.js';

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
  { label: 'Wheeled',   key: 'wheeledMovement' },
  { label: 'Limb',      key: 'limbMovement' },
  { label: 'Flight',    key: 'flightMovement' },
];

// ---------------------------------------------------------------------------
// DetailPanel
// ---------------------------------------------------------------------------

export class DetailPanel {
  private hexDesc: HTMLElement;
  private unitBody: HTMLElement;
  private squadBody: HTMLElement;
  private enemyBody: HTMLElement;
  private combatBody: HTMLElement;
  private world: WorldData;

  constructor(world: WorldData) {
    this.world = world;
    this.hexDesc    = document.getElementById('hex-info-desc')!;
    this.unitBody   = document.getElementById('unit-info-body')!;
    this.squadBody  = document.getElementById('squad-info-body')!;
    this.enemyBody  = document.getElementById('enemy-info-body')!;
    this.combatBody = document.getElementById('combat-info-body')!;
    this.clear();
  }

  /** Update world reference after a new world is loaded. */
  setWorld(world: WorldData): void {
    this.world = world;
    this.clear();
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
    this.renderSquad(units, focusedUnit);
    // Leave enemy + combat sections as-is (hover-driven)
  }

  /**
   * Show the hovered enemy unit in the Enemy Info section.
   * Pass null to clear it.
   */
  showEnemy(unit: UnitData | null): void {
    if (!unit) {
      this.enemyBody.innerHTML = '<span class="empty-msg">No enemy in range</span>';
      return;
    }
    this.renderUnitCard(this.enemyBody, unit);
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

  /** Clear all five sections. */
  clear(): void {
    this.hexDesc.textContent  = '— select a hex';
    this.unitBody.innerHTML   = '<span class="empty-msg">No unit selected</span>';
    this.squadBody.innerHTML  = '<span class="empty-msg">No squad mates</span>';
    this.enemyBody.innerHTML  = '<span class="empty-msg">No enemy in range</span>';
    this.combatBody.innerHTML = '<span class="empty-msg">Hover an enemy to preview</span>';
  }

  // ─── Private renderers ────────────────────────────────────────────────────

  private renderHex(
    tile: TileData,
    city?: { id: string; label: string; isPlayerHome?: boolean; neighbourCityIds: string[] },
  ): void {
    // Build a short descriptive sentence, e.g. "Forested, Rolling Grassland (Player City: Haven)"
    const parts: string[] = [];
    if (tile.f) parts.push('Forested');
    const elev = capitalize(tile.elevType);
    const terrain = capitalize(tile.terrain);
    // Combine elevation + terrain into one phrase, avoiding redundancy
    parts.push(elev === 'Flat' ? terrain : `${elev} ${terrain}`);
    if (city) {
      const owner = city.isPlayerHome ? 'Player' : 'Enemy';
      parts.push(`${owner} City: ${city.label}`);
    }
    this.hexDesc.textContent = '— ' + parts.join(', ');
  }

  private renderUnit(unit: UnitData | undefined): void {
    if (!unit) {
      this.unitBody.innerHTML = '<span class="empty-msg">No unit selected</span>';
      return;
    }
    this.renderUnitCard(this.unitBody, unit);
  }

  private renderSquad(allUnits: UnitData[], focused: UnitData | undefined): void {
    // Squad = same-faction units on the hex that are NOT the focused unit
    const focusedFaction = focused?.ownerId;
    const mates = allUnits.filter(
      (u) => u.id !== focused?.id && u.ownerId === focusedFaction,
    );

    if (mates.length === 0) {
      this.squadBody.innerHTML = '<span class="empty-msg">No squad mates</span>';
      return;
    }

    let html = '';
    for (const unit of mates) {
      const color = factionColor(this.world, unit.ownerId);
      const name  = readableUnitName(unit);
      const attrs = unit.attributes;
      const maxHp = (attrs.maxHealth ?? 1) * 10;
      const mov   = attrs.wheeledMovement ?? attrs.limbMovement ?? attrs.flightMovement ?? 0;
      const att   = attrs.kinetic ?? 0;
      const rng   = attrs.rangeAttack ?? 0;
      const arm   = attrs.armour ?? 0;

      const idSuffix = unit.id.replace(/^unit_/, '');
      html += `<div class="dp-other-unit">`;
      html += `<span class="dp-other-name" style="color:${color};">${esc(name)} <span style="color:#666;font-size:0.8em;">#${esc(idSuffix)}</span></span>`;
      html += `<span class="dp-other-stats">HP ${unit.currentHealth}/${maxHp} · Mov ${mov} · Kin ${att} · Rng ${rng} · Arm ${arm}</span>`;
      html += `</div>`;
    }

    this.squadBody.innerHTML = html;
  }

  /** Render a full unit card (name + HP bar + attribute table) into a target element. */
  private renderUnitCard(target: HTMLElement, unit: UnitData): void {
    const color = factionColor(this.world, unit.ownerId);
    const name  = readableUnitName(unit);
    const attrs = unit.attributes;
    const maxHp = (attrs.maxHealth ?? 1) * 10;
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
      html += `<tr><td class="dp-key">${row.label}</td><td class="dp-val">${val}</td></tr>`;
    }
    html += `</table>`;

    target.innerHTML = html;
  }

  private renderCombatPreview(c: ExplainedCombat): void {
    const b = c.breakdown;
    if (!b) {
      // Fallback: no structured breakdown available
      this.combatBody.innerHTML = '<span class="empty-msg">No preview data</span>';
      return;
    }

    const weaponLabel: Record<string, string> = {
      kinetic: 'Kinetic',
      splash: 'Splash',
      antiAir: 'Anti-Air',
      none: '—',
    };

    const rangeCol = b.inRange ? '#8f8' : '#f66';
    const rangeNote = b.inRange
      ? `✓ In range (${b.distance}/${b.attackRange})`
      : `✗ Out of range (${b.distance}/${b.attackRange})`;

    let html = `<table class="dp-combat-table">`;

    // ── Attack section ───────────────────────────────────────────────────
    html += `<tr><td colspan="2" class="dp-combat-section">Attack (${weaponLabel[b.weaponMode]})</td></tr>`;
    html += cpRow('Range',            `<span style="color:${rangeCol};">${rangeNote}</span>`);
    html += cpRow('Base weapon',      b.baseWeapon);
    html += cpRow(`${b.chassisLabel} ×`, b.chassisModifier.toFixed(2));
    html += cpRow('Range efficiency', b.rangeEfficiency.toFixed(2));
    html += cpRow('Orientation',      `${b.orientationLabel ?? ''} +${b.orientationBonus}`);
    html += `<tr><td class="dp-combat-total" colspan="2">Attack total&nbsp;&nbsp;<span class="dp-combat-total-val">${b.attackTotal.toFixed(2)}</span></td></tr>`;

    // ── Defence section ──────────────────────────────────────────────────
    html += `<tr><td colspan="2" class="dp-combat-section">Defence</td></tr>`;
    html += cpRow('Armour',    b.defArmour);
    const ewLabel = b.defEWMultiplier < 1
      ? `EW ${b.defEWRaw} ×${b.defEWMultiplier}`
      : 'EW';
    html += cpRow(ewLabel, b.defEW.toFixed(2));
    html += cpRow('Formation', b.defFormation);
    html += cpRow('Terrain',   b.defTerrain);
    if (b.droneEvasion > 0) {
      html += cpRow('Drone target evasion −', b.droneEvasion);
    }
    const defRaw = b.defArmour + b.defEW + b.defFormation + b.defTerrain;
    html += `<tr><td class="dp-combat-total" colspan="2">Defence power&nbsp;&nbsp;<span class="dp-combat-total-val">${defRaw.toFixed(2)}</span></td></tr>`;

    // ── Summary (Damage + HP Remaining + Target Destroyed) ─────────────
    const targetUnit = this.world.units.find((u) => u.id === c.targetId);
    const targetMaxHp = targetUnit ? (targetUnit.attributes.maxHealth ?? 1) * 10 : '?';
    const dmgCol = b.netDamage >= 15 ? '#f66' : b.netDamage >= 5 ? '#fa0' : '#fff';
    html += `<tr><td colspan="2" class="dp-combat-section dp-combat-summary-header">Summary</td></tr>`;
    html += `<tr><td colspan="2" class="dp-combat-summary">`;
    if (b.inRange) {
      html += `<div class="dp-combat-summary-damage" style="color:${dmgCol};">⚔ ${b.netDamage} damage</div>`;
      html += `<div class="dp-combat-summary-health">❤ ${c.targetHealthAfter}/${targetMaxHp} HP remaining</div>`;
    } else {
      html += `<div class="dp-combat-summary-damage" style="color:#999;">— Out of range</div>`;
    }
    if (c.targetDestroyed) {
      html += `<div class="dp-combat-summary-destroyed">☠ Target destroyed</div>`;
    }
    html += `</td></tr>`;

    // ── How the two totals become damage ─────────────────────────────────
    if (b.inRange) {
      html += this.buildDamageExplanation(b);
    }

    html += `</table>`;
    this.combatBody.innerHTML = html;
  }

  /**
   * Build the worked "how damage is calculated" footnote.
   *
   * Shows how Attack total and Defence power feed the damage formula,
   * including the ×0.75 effective-defence constant.
   */
  private buildDamageExplanation(b: NonNullable<ExplainedCombat['breakdown']>): string {
    const ap = b.attackTotal;
    const defRaw = b.defArmour + b.defEW + b.defFormation + b.defTerrain;
    const ed = defRaw * 0.75;
    const ceiling = Math.min(30, 6 * ap);
    const apSq = ap * ap;
    const edSq = ed * ed;
    const share = apSq + edSq > 0 ? apSq / (apSq + edSq) : 1;
    // Raw formula damage, before any drone-evasion reduction (droneEvasion = raw − net).
    const formulaDamage = b.netDamage + b.droneEvasion;

    let html = `<tr><td colspan="2" class="dp-combat-section">How damage is calculated</td></tr>`;
    html += cpNote(
      `Damage is a ratio of Attack total to Defence power, not a subtraction. ` +
      `A bigger gap lands a bigger share of the damage ceiling.`,
    );
    html += cpCalc(`Effective defence = Defence power × 0.75 = ${defRaw.toFixed(2)} × 0.75 = ${ed.toFixed(2)}`);
    html += cpCalc(`Ceiling = min(30, 6 × ${ap.toFixed(2)}) = ${ceiling.toFixed(1)}`);
    html += cpCalc(
      `Share landed = AP² / (AP² + ED²) = ${apSq.toFixed(2)} / (${apSq.toFixed(2)} + ${edSq.toFixed(2)}) = ${(share * 100).toFixed(0)}%`,
    );
    html += cpCalc(
      `Damage = 1 + (${ceiling.toFixed(1)} − 1) × ${(share * 100).toFixed(0)}% ≈ ${formulaDamage}`,
    );
    if (b.droneEvasion > 0) {
      html += cpCalc(`Drone evasion: ${formulaDamage} × ${b.droneEvasion > 0 ? (b.netDamage / formulaDamage).toFixed(2) : '1.00'} = ${b.netDamage}`);
    }
    return html;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dpRow(label: string, value: string): string {
  return `<div class="dp-row"><span class="dp-key">${label}</span><span class="dp-val">${value}</span></div>`;
}

function cpRow(label: string, value: string | number): string {
  return `<tr><td class="dp-key">${label}</td><td class="dp-val">${value}</td></tr>`;
}

/** Explanatory note row spanning both columns, shown under a table section. */
function cpNote(text: string): string {
  return `<tr><td colspan="2" class="dp-combat-note">${text}</td></tr>`;
}

/** Monospace worked-calculation row spanning both columns. */
function cpCalc(text: string): string {
  return `<tr><td colspan="2" class="dp-combat-calc">${esc(text)}</td></tr>`;
}


