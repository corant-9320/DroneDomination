/**
 * Combat Log Panel — positioned in the right curtain of the tactical (local) map.
 *
 * Shows one combat entry at a time with ◀/▶ navigation through history.
 * When the player hovers over an enemy while a unit is selected, shows
 * an attack preview instead.
 */

import { WorldData, UnitData, TileData } from './worldData.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { esc, toneColor } from './htmlUtils.js';
import type {
  ExplanationStep,
  SplashExplanation,
  ExplainedCombat,
  ExplainedRepair,
  CombatResponse as CombatResponseBase,
} from '../shared/combatTypes.js';

type CombatResponse = CombatResponseBase<UnitData>;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export class CombatPanel {
  private el: HTMLElement;
  private world: WorldData;
  private history: ExplainedCombat[] = [];
  private viewIndex: number = 0; // which entry is currently displayed (0 = most recent)
  private readonly MAX_HISTORY = 50;
  /** The faction currently allowed to act. */
  private activeFaction: string = '';
  /** Current attack preview (shown when hovering an enemy). */
  private preview: ExplainedCombat | null = null;
  /** Currently selected attacker unit (shown immediately on selection). */
  private selectedUnit: UnitData | null = null;
  /** Currently hovered enemy unit (shown in VS section). */
  private hoveredEnemy: UnitData | null = null;
  /** Optional callback fired when a server preview arrives. */
  private onPreviewReady: ((preview: ExplainedCombat | null) => void) | null = null;

  constructor(el: HTMLElement, world: WorldData) {
    this.el = el;
    this.world = world;
    this.render();
  }

  /** Set the active faction (ownerId) whose turn it is. */
  setActiveFaction(factionId: string): void {
    this.activeFaction = factionId;
  }

  /** Get the active faction. */
  getActiveFaction(): string {
    return this.activeFaction;
  }

  /**
   * Register a callback that fires whenever a server preview result arrives.
   * Used by the detail panel to populate its Combat Preview section.
   */
  setOnPreviewReady(cb: (preview: ExplainedCombat | null) => void): void {
    this.onPreviewReady = cb;
  }

  /**
   * Show the currently selected player unit in the preview area.
   * Pass null to clear it (unit deselected).
   */
  showSelectedUnit(unit: UnitData | null): void {
    this.selectedUnit = unit;
    if (!unit) {
      this.hoveredEnemy = null;
      this.preview = null;
    }
    this.render();
  }

  /**
   * Show an attack preview by fetching predicted combat from the server.
   * Pass null to clear the preview.
   */
  showPreview(attacker: UnitData | null, target: UnitData | null): void {
    if (!attacker || !target) {
      this.hoveredEnemy = null;
      if (this.preview) {
        this.preview = null;
        this.render();
        this.onPreviewReady?.(null);
      } else if (this.selectedUnit) {
        // Still showing selected unit, re-render to remove VS section
        this.render();
      }
      return;
    }

    this.selectedUnit = attacker;
    this.hoveredEnemy = target;
    // Show the VS header immediately while fetching combat prediction
    this.render();
    // Fetch prediction from server (fire-and-forget; update on response)
    this.fetchPreview(attacker.id, target.id);
  }

  private async fetchPreview(attackerId: string, targetId: string): Promise<void> {
    const payload = {
      action: 'preview',
      attackerId,
      targetId,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
    };

    try {
      const resp = await fetch('/api/combat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: CombatResponse = await resp.json();

      if (!data.success || data.combats.length === 0) {
        this.preview = null;
        this.render();
        this.onPreviewReady?.(null);
        return;
      }

      this.preview = data.combats[0];
      this.render();
      this.onPreviewReady?.(this.preview);
    } catch {
      // Silently fail — preview is non-critical
      this.preview = null;
      this.render();
    }
  }

  /**
   * Request combat resolution from the server and display the breakdown.
   * Returns the updated units array so the caller can sync local state.
   */
  async resolveAttack(attackerId: string, targetId: string): Promise<UnitData[] | null> {
    dbg.detail.log('CombatPanel.resolveAttack:', attackerId, '→', targetId);

    const payload = {
      action: 'attack',
      attackerId,
      targetId,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
    };

    try {
      const resp = await fetch('/api/combat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: CombatResponse = await resp.json();

      if (!data.success) {
        this.renderError(data.error ?? 'Unknown error');
        return null;
      }

      // Add to history (most recent first)
      for (const c of data.combats) {
        this.history.unshift(c);
      }
      for (const r of data.reactions) {
        this.history.unshift(r);
      }
      while (this.history.length > this.MAX_HISTORY) {
        this.history.pop();
      }

      // Reset view to show latest
      this.viewIndex = 0;
      this.preview = null;
      this.render();
      return data.updatedUnits;
    } catch (err) {
      dbg.detail.error('CombatPanel fetch error:', err);
      this.renderError(`Network error: ${err}`);
      return null;
    }
  }

  /**
   * Request movement resolution (with reaction fire) from the server.
   */
  async resolveMove(unitId: string, path: number[]): Promise<UnitData[] | null> {
    dbg.detail.log('CombatPanel.resolveMove:', unitId, 'path:', path);

    const payload = {
      action: 'move',
      unitId,
      path,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
    };

    try {
      const resp = await fetch('/api/combat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: CombatResponse = await resp.json();

      if (!data.success) {
        this.renderError(data.error ?? 'Unknown error');
        return null;
      }

      // Only add reaction events to history
      for (const r of data.reactions) {
        this.history.unshift(r);
      }
      while (this.history.length > this.MAX_HISTORY) {
        this.history.pop();
      }

      if (data.reactions.length > 0) {
        this.viewIndex = 0;
        this.render();
      }

      return data.updatedUnits;
    } catch (err) {
      dbg.detail.error('CombatPanel move error:', err);
      this.renderError(`Network error: ${err}`);
      return null;
    }
  }

  /** Clear the combat log. */
  clear(): void {
    this.history = [];
    this.viewIndex = 0;
    this.preview = null;
    this.selectedUnit = null;
    this.hoveredEnemy = null;
    this.render();
  }

  /**
   * Request repair resolution from the server and display the breakdown.
   * Returns the updated units array so the caller can sync local state.
   */
  async resolveRepair(repairerId: string, targetId: string): Promise<UnitData[] | null> {
    dbg.detail.log('CombatPanel.resolveRepair:', repairerId, '→', targetId);

    const payload = {
      action: 'repair',
      repairerId,
      repairTargetId: targetId,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
    };

    try {
      const resp = await fetch('/api/combat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: CombatResponse = await resp.json();

      if (!data.success) {
        this.renderError(data.error ?? 'Unknown error');
        return null;
      }

      // Show repair result in the panel
      if (data.repair) {
        this.renderRepairResult(data.repair);
      }

      return data.updatedUnits;
    } catch (err) {
      dbg.detail.error('CombatPanel repair error:', err);
      this.renderError(`Network error: ${err}`);
      return null;
    }
  }

  /** Render repair result inline. */
  private renderRepairResult(repair: ExplainedRepair): void {
    let html = `<div class="cl-toolbar"><span class="cl-header" style="color:#4f8;">🔧 Repair</span></div>`;
    html += `<div class="cl-body">`;

    if (!repair.wasValid) {
      html += `<div class="cl-step"><span style="color:#f66;">✗ ${esc(repair.reasonInvalid ?? 'Invalid')}</span></div>`;
    } else {
      html += `<div class="cl-step" style="color:#8f8;padding:2px 0;">`;
      html += `<span class="cl-step-title">${esc(repair.repairerLabel)}</span>`;
      html += ` → <span style="color:#4cf;">${esc(repair.targetLabel)}</span>`;
      html += `</div>`;
      for (const step of repair.steps) {
        const col = toneColor(step.tone);
        html += `<div class="cl-step" style="padding:1px 0;border:none;">`;
        html += `<span class="cl-step-title">${esc(step.title)}</span> `;
        html += `<span style="color:${col};">${esc(step.result)}</span>`;
        if (step.formula) {
          html += `<br><span class="cl-step-formula">${esc(step.formula)}</span>`;
        }
        html += `</div>`;
      }
    }

    html += `</div>`;
    this.el.innerHTML = html;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    // If showing a preview, display that instead of history
    if (this.preview) {
      this.el.innerHTML = this.buildPreviewHtml();
      return;
    }

    // If a unit is selected (with or without hovered enemy), show VS panel
    if (this.selectedUnit) {
      this.el.innerHTML = this.buildSelectionHtml();
      return;
    }

    if (this.history.length === 0) {
      this.el.innerHTML = this.buildEmptyHtml();
      return;
    }

    const entry = this.history[this.viewIndex];
    if (!entry) {
      this.el.innerHTML = this.buildEmptyHtml();
      return;
    }

    this.el.innerHTML = this.buildEntryHtml(entry);
    this.bindNav();
  }

  private renderError(msg: string): void {
    this.el.innerHTML = `
      <div class="cl-toolbar"><span style="color:#f66;">⚠ ${esc(msg)}</span></div>
      <div class="cl-body"></div>`;
  }

  private buildEmptyHtml(): string {
    return `<div class="cl-toolbar"><span class="cl-header">⚔ Combat Log</span></div>
      <div class="cl-body"><div class="cl-empty">No combat yet — attack an enemy to see results</div></div>`;
  }

  /**
   * Build HTML showing the targeting panel.
   * Only shows enemy stats when hovering; player unit info lives in the
   * bottom detail panel's "Unit Info" section exclusively.
   */
  private buildSelectionHtml(): string {
    let html = `<div class="cl-toolbar"><span class="cl-header" style="color:#fa0;">⚔ Targeting</span></div>`;
    html += `<div class="cl-body" style="overflow:hidden;">`;

    if (this.hoveredEnemy) {
      // Show enemy stats only
      const enemy = this.hoveredEnemy;
      const enemyColor = factionColor(this.world, enemy.ownerId);
      html += `<div class="cl-vs-unit" style="color:${esc(enemyColor)};">`;
      html += `<div class="cl-vs-name">${esc(enemy.label)}</div>`;
      html += this.buildUnitStats(enemy);
      html += `</div>`;
    } else {
      html += `<div class="cl-empty">Hover an enemy to see targeting info</div>`;
    }

    html += `</div>`;
    return html;
  }

  /** Render compact stat block for a unit. */
  private buildUnitStats(unit: UnitData): string {
    const a = unit.attributes;
    let s = `<div class="cl-vs-stats">`;
    s += `<span>HP: ${unit.currentHealth}/${(a.maxHealth ?? 1) * 10}</span>`;
    if (a.kinetic) s += ` <span>KIN: ${a.kinetic}</span>`;
    if (a.rangeAttack) s += ` <span>RNG: ${a.rangeAttack}</span>`;
    if (a.splashAttack) s += ` <span>SPL: ${a.splashAttack}</span>`;
    if (a.defence) s += ` <span>DEF: ${a.defence}</span>`;
    if (a.armour) s += ` <span>ARM: ${a.armour}</span>`;
    if (a.wheeledMovement) s += ` <span>MOV: ${a.wheeledMovement}</span>`;
    if (a.limbMovement) s += ` <span>MOV: ${a.limbMovement}</span>`;
    if (a.flightMovement) s += ` <span>FLY: ${a.flightMovement}</span>`;
    s += `</div>`;
    return s;
  }

  private buildPreviewHtml(): string {
    const c = this.preview!;

    let body = `<div class="cl-body" style="overflow:hidden;">`;

    // Filtered preview: show only Orientation, Weapon Selection, then Net Damage + Health
    for (const step of c.steps) {
      // Orientation step — show arc label with bonus
      if (step.title.includes('Orientation')) {
        const col = toneColor(step.tone);
        body += `<div class="cl-step" style="padding:1px 0;border:none;">`;
        body += `<span class="cl-step-title">${esc(step.title)}</span> `;
        body += `<span style="color:${col};">${esc(step.result)}</span>`;
        body += `</div>`;
        continue;
      }

      // Weapon Selection step — keep as-is
      if (step.title.includes('Weapon Selection')) {
        const col = toneColor(step.tone);
        body += `<div class="cl-step" style="padding:1px 0;border:none;">`;
        body += `<span class="cl-step-title">${esc(step.title)}</span> `;
        body += `<span style="color:${col};">${esc(step.result)}</span>`;
        body += `</div>`;
        continue;
      }

      // Skip everything else (Range Check, Defence Power, Chassis Modifier, Kinetic/Splash/AA Fire, Health Update)
    }

    // Net Damage + Health Update as emphasised pair
    if (c.wasValid && c.directDamage > 0) {
      const dmgCol = c.directDamage >= 15 ? '#f66' : c.directDamage >= 5 ? '#fa0' : '#8f8';
      const hpAfter = c.targetHealthAfter;
      body += `<div class="cl-preview-result">`;
      body += `<div class="cl-preview-damage" style="color:${dmgCol};">⚔ ${c.directDamage} damage</div>`;
      body += `<div class="cl-preview-health">❤ ${hpAfter} HP remaining</div>`;
      body += `</div>`;
    }

    if (c.wasValid) {
      if (c.targetDestroyed) {
        body += `<div class="cl-step" style="color:#f44;padding:2px 0;font-weight:bold;">☠ Target destroyed</div>`;
      }
      if (c.splash.length > 0) {
        body += `<div class="cl-step" style="color:#fa0;padding:1px 0;">💥 Splash → ${c.splash.length} nearby unit${c.splash.length > 1 ? 's' : ''}</div>`;
      }
    }

    body += `</div>`;
    return body;
  }

  private buildEntryHtml(c: ExplainedCombat): string {
    const canBack = this.viewIndex < this.history.length - 1;
    const canFwd = this.viewIndex > 0;
    const counter = `${this.viewIndex + 1}/${this.history.length}`;

    let toolbar = `<div class="cl-toolbar">`;
    toolbar += `<div class="cl-nav">`;
    toolbar += `<button class="cl-back" title="Previous" ${canBack ? '' : 'disabled'}>◀</button>`;
    toolbar += `<button class="cl-fwd" title="Next" ${canFwd ? '' : 'disabled'}>▶</button>`;
    toolbar += `</div>`;
    toolbar += `<span class="cl-header">`;
    toolbar += `<span style="color:#f88;">${esc(c.attackerLabel)}</span>`;
    toolbar += `<span style="color:#666;"> → </span>`;
    toolbar += `<span style="color:#8cf;">${esc(c.targetLabel)}</span>`;
    if (c.targetDestroyed) toolbar += ` <span style="color:#f44;">☠</span>`;
    toolbar += `</span>`;
    toolbar += `<span class="cl-counter">${counter}</span>`;
    toolbar += `</div>`;

    let body = `<div class="cl-body">`;

    if (!c.wasValid) {
      body += `<div class="cl-step"><span style="color:#f66;">Invalid: ${esc(c.reasonInvalid ?? '')}</span></div>`;
    } else {
      for (const step of c.steps) {
        body += this.renderStep(step);
      }
      if (c.splash.length > 0) {
        body += `<div class="cl-splash-header">💥 Splash (${c.splash.length} victim${c.splash.length > 1 ? 's' : ''})</div>`;
        for (const s of c.splash) {
          body += `<div class="cl-step"><span class="cl-step-title">${esc(s.victimLabel)}</span> <span style="color:#999;">${s.victimHealthBefore}→${s.victimHealthAfter} HP</span>`;
          if (s.victimDestroyed) body += ` <span style="color:#f44;">☠</span>`;
          body += `</div>`;
          for (const step of s.steps) {
            body += this.renderStep(step);
          }
        }
      }
    }

    body += `</div>`;
    return toolbar + body;
  }

  private renderStep(step: ExplanationStep): string {
    const col = toneColor(step.tone);
    let html = `<div class="cl-step">`;
    html += `<span class="cl-step-title">${esc(step.title)}</span>`;
    html += `<span class="cl-step-desc">${esc(step.description)}</span>`;
    if (step.formula) {
      html += `<br><span class="cl-step-formula">${esc(step.formula)}</span>`;
    }
    html += `<br><span class="cl-step-result" style="color:${col};">${esc(step.result)}</span>`;
    html += `</div>`;
    return html;
  }

  private bindNav(): void {
    const backBtn = this.el.querySelector('.cl-back') as HTMLButtonElement | null;
    const fwdBtn = this.el.querySelector('.cl-fwd') as HTMLButtonElement | null;

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (this.viewIndex < this.history.length - 1) {
          this.viewIndex++;
          this.render();
        }
      });
    }
    if (fwdBtn) {
      fwdBtn.addEventListener('click', () => {
        if (this.viewIndex > 0) {
          this.viewIndex--;
          this.render();
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalTile(t: TileData): { idx: number; s: 5 | 6; n: number[]; t: string; f?: boolean; pos: [number, number, number] } {
  return { idx: t.idx, s: t.s, n: t.n, t: t.terrain, f: t.f || undefined, pos: t.pos };
}


