/**
 * Combat Log Panel — positioned in the right curtain of the tactical (local) map.
 *
 * Renders a scrollable history list.  Each entry is a summary row with an
 * expand toggle that reveals the full step-by-step breakdown.
 *
 * History entry kinds:
 *   'combat'   — player-initiated attack
 *   'reaction' — reaction fire triggered by a move
 *   'repair'   — repair action
 */

import { WorldData, UnitData, TileData, BuildingData } from './worldData.js';
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
// History entry union
// ---------------------------------------------------------------------------

type HistoryEntry =
  | { kind: 'combat';   turn: number; data: ExplainedCombat }
  | { kind: 'reaction'; turn: number; data: ExplainedCombat }
  | { kind: 'repair';   turn: number; data: ExplainedRepair };

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export class CombatPanel {
  private el: HTMLElement;
  private world: WorldData;
  private history: HistoryEntry[] = [];
  private viewIndex: number = 0; // kept for API compatibility, not used for rendering
  private readonly MAX_HISTORY = 50;
  /** Set of history indices whose detail section is currently expanded. */
  private expandedIndices: Set<number> = new Set();
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
  /** Incremented on each attack to invalidate in-flight preview fetches. */
  private previewGeneration: number = 0;
  /** Current turn number — stamped onto each history entry when it is pushed. */
  private currentTurn: number = 1;
  /**
   * Returns true when the History tab is the currently visible tab.
   * When true, render() always shows the history list — targeting state is
   * shown elsewhere (Main tab) and must never clobber the history list.
   */
  private isHistoryTabActive: () => boolean = () => false;

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

  /** Update the current turn number so new entries are stamped correctly. */
  setTurnNumber(n: number): void {
    this.currentTurn = n;
  }

  /**
   * Register a callback that the panel calls to check whether the History
   * tab is currently visible.  When it returns true, render() always shows
   * the history list and ignores targeting/preview state.
   */
  setIsHistoryTabActive(fn: () => boolean): void {
    this.isHistoryTabActive = fn;
  }

  /**
   * Called by main.ts when the active tab changes so the panel can
   * immediately switch between targeting view and history list.
   */
  renderForTab(): void {
    this.render();
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
    const generation = this.previewGeneration;
    const payload = {
      action: 'preview',
      attackerId,
      targetId,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
      buildings: this.world.buildings,
    };

    try {
      const resp = await fetch('/api/combat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: CombatResponse = await resp.json();

      // Discard stale response if an attack was initiated while this was in-flight
      if (generation !== this.previewGeneration) return;

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
      if (generation !== this.previewGeneration) return;
      this.preview = null;
      this.render();
    }
  }

  /**
   * Request combat resolution from the server and display the breakdown.
   * Returns the updated units and the explained combat result (for animation).
   */
  async resolveAttack(attackerId: string, targetId: string): Promise<{ units: UnitData[]; buildings?: BuildingData[]; combat: ExplainedCombat } | null> {
    dbg.detail.log('CombatPanel.resolveAttack:', attackerId, '→', targetId);

    // Invalidate any in-flight preview fetches
    this.previewGeneration++;

    const payload = {
      action: 'attack',
      attackerId,
      targetId,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
      buildings: this.world.buildings,
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
        this.history.unshift({ kind: 'combat', turn: this.currentTurn, data: c });
      }
      for (const r of data.reactions) {
        this.history.unshift({ kind: 'reaction', turn: this.currentTurn, data: r });
      }
      while (this.history.length > this.MAX_HISTORY) {
        this.history.pop();
      }

      // Shift existing expanded indices down by the number of new entries added.
      const newCount = data.combats.length + data.reactions.length;
      const shifted = new Set<number>();
      for (const idx of this.expandedIndices) {
        shifted.add(idx + newCount);
      }
      this.expandedIndices = shifted;

      // Clear preview/targeting state
      this.preview = null;
      this.selectedUnit = null;
      this.hoveredEnemy = null;
      this.render();
      return { units: data.updatedUnits, buildings: data.updatedBuildings as BuildingData[] | undefined, combat: data.combats[0] };
    } catch (err) {
      dbg.detail.error('CombatPanel fetch error:', err);
      this.renderError(`Network error: ${err}`);
      return null;
    }
  }

  /**
   * Request resolution of an attack against an enemy building (building-damage
   * feature). `mode` is the weapon mode ('splash' or 'direct'); `component` is
   * required for Direct_Fire. Returns updated units/buildings and the explained
   * result, and pushes the result into the combat history.
   */
  async resolveBuildingAttack(
    attackerId: string,
    buildingId: string,
    mode: 'splash' | 'direct',
    component?: string,
  ): Promise<{ units: UnitData[]; buildings?: BuildingData[]; combat: ExplainedCombat } | null> {
    dbg.detail.log('CombatPanel.resolveBuildingAttack:', attackerId, '→', buildingId, mode, component ?? '');
    this.previewGeneration++;

    const payload = {
      action: 'attack',
      attackerId,
      targetBuildingId: buildingId,
      weaponMode: mode,
      component,
      activeFaction: this.activeFaction,
      units: this.world.units,
      tiles: this.world.tiles.map(minimalTile),
      buildings: this.world.buildings,
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

      for (const c of data.combats) {
        this.history.unshift({ kind: 'combat', turn: this.currentTurn, data: c });
      }
      while (this.history.length > this.MAX_HISTORY) this.history.pop();

      const newCount = data.combats.length;
      const shifted = new Set<number>();
      for (const idx of this.expandedIndices) shifted.add(idx + newCount);
      this.expandedIndices = shifted;

      this.preview = null;
      this.selectedUnit = null;
      this.hoveredEnemy = null;
      this.render();
      return {
        units: data.updatedUnits,
        buildings: data.updatedBuildings as BuildingData[] | undefined,
        combat: data.combats[0],
      };
    } catch (err) {
      dbg.detail.error('CombatPanel building attack error:', err);
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
      buildings: this.world.buildings,
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
        this.history.unshift({ kind: 'reaction', turn: this.currentTurn, data: r });
      }
      while (this.history.length > this.MAX_HISTORY) {
        this.history.pop();
      }

      if (data.reactions.length > 0) {
        const newCount = data.reactions.length;
        const shifted = new Set<number>();
        for (const idx of this.expandedIndices) {
          shifted.add(idx + newCount);
        }
        this.expandedIndices = shifted;
        this.render();
      }

      return data.updatedUnits;
    } catch (err) {
      dbg.detail.error('CombatPanel move error:', err);
      this.renderError(`Network error: ${err}`);
      return null;
    }
  }

  /**
   * Push precomputed combat/reaction explanations into the history list
   * (server-authoritative AI replay — outcomes already resolved server-side).
   * Mirrors the history bookkeeping done by resolveAttack/resolveMove.
   */
  recordHistory(combats: ExplainedCombat[], reactions: ExplainedCombat[]): void {
    for (const c of combats) this.history.unshift({ kind: 'combat', turn: this.currentTurn, data: c });
    for (const r of reactions) this.history.unshift({ kind: 'reaction', turn: this.currentTurn, data: r });
    while (this.history.length > this.MAX_HISTORY) this.history.pop();

    const newCount = combats.length + reactions.length;
    if (newCount > 0) {
      const shifted = new Set<number>();
      for (const idx of this.expandedIndices) shifted.add(idx + newCount);
      this.expandedIndices = shifted;
    }
    this.render();
  }

  /**
   * Push a precomputed repair explanation into the history list (authoritative
   * session replay). Mirrors the bookkeeping done by resolveRepair.
   */
  recordRepairHistory(r: ExplainedRepair): void {
    this.history.unshift({ kind: 'repair', turn: this.currentTurn, data: r });
    while (this.history.length > this.MAX_HISTORY) this.history.pop();
    const shifted = new Set<number>();
    for (const idx of this.expandedIndices) shifted.add(idx + 1);
    this.expandedIndices = shifted;
    this.render();
  }

  /** Clear the combat log. */
  clear(): void {
    this.history = [];
    this.viewIndex = 0;
    this.expandedIndices.clear();
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

      // Push repair event into the history list
      if (data.repair) {
        this.history.unshift({ kind: 'repair', turn: this.currentTurn, data: data.repair });
        while (this.history.length > this.MAX_HISTORY) this.history.pop();

        const shifted = new Set<number>();
        for (const idx of this.expandedIndices) shifted.add(idx + 1);
        this.expandedIndices = shifted;
        this.render();
      }

      return data.updatedUnits;
    } catch (err) {
      dbg.detail.error('CombatPanel repair error:', err);
      this.renderError(`Network error: ${err}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    // History tab is always the history list — targeting/preview state lives
    // on the Main tab and must never overwrite the history list.
    if (this.isHistoryTabActive()) {
      if (this.history.length === 0) {
        this.el.innerHTML = this.buildEmptyHtml();
      } else {
        this.el.innerHTML = this.buildHistoryListHtml();
        this.bindExpandToggles();
      }
      return;
    }

    // Main tab: show preview or targeting state when active
    if (this.preview) {
      this.el.innerHTML = this.buildPreviewHtml();
      return;
    }

    if (this.selectedUnit) {
      this.el.innerHTML = this.buildSelectionHtml();
      return;
    }

    if (this.history.length === 0) {
      this.el.innerHTML = this.buildEmptyHtml();
      return;
    }

    this.el.innerHTML = this.buildHistoryListHtml();
    this.bindExpandToggles();
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
      const enemyIdSuffix = enemy.id.replace(/^unit_/, '');
      html += `<div class="cl-vs-name" style="color:${esc(enemyColor)};">#${esc(enemyIdSuffix)} ${esc(enemy.label)}</div>`;
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
    s += `<span>HP: ${unit.currentHealth}/${(a.size ?? 1) * 10}</span>`;
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

    if (c.wasValid) {
      // Find target unit to get maxHP
      const target = this.world.units.find((u) => u.id === c.targetId);
      const maxHp = target ? (target.attributes.size ?? 1) * 10 : '?';
      const hpAfter = c.targetHealthAfter;

      if (c.targetDestroyed) {
        body += `<div class="cl-step" style="color:#f44;padding:2px 0;">☠ ${esc(c.targetLabel)} destroyed (${c.directDamage} dmg)</div>`;
      } else {
        body += `<div class="cl-step" style="color:#fa0;padding:2px 0;">`;
        body += `⚔ ${esc(c.targetLabel)}: <span style="color:#8cf;">${hpAfter}/${maxHp} HP</span>`;
        body += ` <span style="color:#aaa;">(−${c.directDamage})</span>`;
        body += `</div>`;
      }

      // Show elevation modifier when it's not 1.0
      if (c.breakdown && c.breakdown.elevationMultiplier !== 1.0) {
        const elevPct = Math.round((c.breakdown.elevationMultiplier - 1) * 100);
        const sign = elevPct > 0 ? '+' : '';
        const col = elevPct > 0 ? '#4f8' : '#f88';
        body += `<div class="cl-step" style="color:${col};padding:1px 0;">⛰ Elevation ${sign}${elevPct}%</div>`;
      }

      if (c.splash.length > 0) {
        body += `<div class="cl-step" style="color:#fa0;padding:1px 0;">💥 Splash → ${c.splash.length} nearby unit${c.splash.length > 1 ? 's' : ''}</div>`;
        for (const s of c.splash) {
          if (s.victimId === c.targetId) continue; // already shown above
          const v = this.world.units.find((u) => u.id === s.victimId);
          const vMax = v ? (v.attributes.size ?? 1) * 10 : '?';
          if (s.victimDestroyed) {
            body += `<div class="cl-step" style="color:#f44;padding:1px 0;margin-left:8px;">☠ ${esc(s.victimLabel)}</div>`;
          } else {
            body += `<div class="cl-step" style="color:#aaa;padding:1px 0;margin-left:8px;">${esc(s.victimLabel)}: ${s.victimHealthAfter}/${vMax} HP (−${s.damage})</div>`;
          }
        }
      }
    } else {
      body += `<div class="cl-step" style="color:#f66;padding:2px 0;">✗ ${esc(c.reasonInvalid ?? 'Invalid')}</div>`;
    }

    body += `</div>`;
    return body;
  }

  /** Build the full scrollable history list, grouped by turn number. */
  private buildHistoryListHtml(): string {
    let html = '';
    let lastTurn = -1;

    for (let i = 0; i < this.history.length; i++) {
      const entry = this.history[i];

      // Emit a turn divider whenever the turn number changes
      if (entry.turn !== lastTurn) {
        // Add bottom margin to previous group by closing it
        if (lastTurn !== -1) html += `</div>`;
        html += `<div class="cl-turn-group">`;
        html += `<div class="cl-turn-divider"><span class="cl-turn-label">Turn ${entry.turn}</span></div>`;
        lastTurn = entry.turn;
      }

      if (entry.kind === 'repair') {
        html += this.buildRepairRowHtml(entry.data, i);
      } else {
        html += this.buildCombatRowHtml(entry.data, i, entry.kind === 'reaction');
      }
    }

    // Close the last open group
    if (lastTurn !== -1) html += `</div>`;

    return html;
  }

  /** Build one summary row for a combat or reaction entry. */
  private buildCombatRowHtml(c: ExplainedCombat, index: number, isReaction: boolean): string {
    const isExpanded = this.expandedIndices.has(index);
    const expandIcon = isExpanded ? '▾' : '▸';

    // ── Summary sentence ──────────────────────────────────────────────
    let summaryHtml: string;
    if (!c.wasValid) {
      summaryHtml = `<span style="color:#f66;">✗ Invalid</span>`;
    } else {
      const weaponIcon = weaponModeIcon(c.breakdown?.weaponMode);
      const atkSuffix = c.attackerId.replace(/^unit_/, '');
      const tgtSuffix = c.targetId.replace(/^unit_/, '');
      // Max HP: use live world if available, else fall back to healthBefore
      const tgtUnit = this.world.units.find((u) => u.id === c.targetId);
      const maxHp = tgtUnit
        ? (tgtUnit.attributes.size ?? 1) * 10
        : c.targetHealthBefore > c.targetHealthAfter ? c.targetHealthBefore : '?';

      const atkColor = factionColorForUnit(this.world, c.attackerId);
      const tgtColor = factionColorForUnit(this.world, c.targetId);

      if (isReaction) {
        summaryHtml = `<span class="cl-tag cl-tag--reaction">↩ reaction</span> `;
      } else {
        summaryHtml = '';
      }

      summaryHtml += `${weaponIcon} `;
      summaryHtml += `<span style="color:${esc(atkColor)};">#${esc(atkSuffix)} ${esc(c.attackerLabel)}</span>`;
      summaryHtml += `<span style="color:#999;"> → </span>`;
      summaryHtml += `<span style="color:${esc(tgtColor)};">#${esc(tgtSuffix)} ${esc(c.targetLabel)}</span>`;

      const bd = c.buildingDamage ?? [];
      if (bd.length > 0) {
        // Building attack: report component degradation instead of HP.
        const parts = bd.map((d) =>
          d.destroyed
            ? `<span style="color:#f44;">${esc(d.component)} ✕</span>`
            : `<span style="color:#fa0;">${esc(d.component)}→${d.newValue}</span>`,
        );
        summaryHtml += ` <span style="font-size:0.9em;">🏛 ${parts.join(', ')}</span>`;
        if (c.splash.length > 0) {
          summaryHtml += ` <span style="color:#fa0;font-size:0.85em;">💥×${c.splash.length}</span>`;
        }
      } else {
        summaryHtml += ` <span class="cl-summary-dmg">−${c.directDamage}</span>`;

        if (c.targetDestroyed) {
          summaryHtml += ` <span style="color:#f44;">☠</span>`;
        } else {
          summaryHtml += ` <span class="cl-summary-hp">${c.targetHealthAfter}/${maxHp} HP</span>`;
        }

        if (c.splash.length > 0) {
          summaryHtml += ` <span style="color:#fa0;font-size:0.85em;">💥×${c.splash.length}</span>`;
        }
      }
    }

    // ── Expanded detail section ────────────────────────────────────────
    let detailHtml = '';
    if (isExpanded) {
      detailHtml = `<div class="cl-detail">`;
      if (!c.wasValid) {
        detailHtml += `<div class="cl-step"><span style="color:#f66;">Invalid: ${esc(c.reasonInvalid ?? '')}</span></div>`;
      } else {
        // Build label→short-ref map so step descriptions don't repeat full names
        const labelMap = buildLabelMap(this.world, [
          { id: c.attackerId, label: c.attackerLabel },
          { id: c.targetId,   label: c.targetLabel },
        ]);
        for (const step of c.steps) {
          detailHtml += this.renderStep(step, labelMap);
        }
        if (c.splash.length > 0) {
          detailHtml += `<div class="cl-splash-header">💥 Splash (${c.splash.length} victim${c.splash.length > 1 ? 's' : ''})</div>`;
          for (const s of c.splash) {
            const vUnit = this.world.units.find((u) => u.id === s.victimId);
            const vMax = vUnit ? (vUnit.attributes.size ?? 1) * 10 : '?';
            const vSuffix = s.victimId.replace(/^unit_/, '');
            const vColor = factionColorForUnit(this.world, s.victimId);
            detailHtml += `<div class="cl-step"><span class="cl-step-title"><span style="color:${esc(vColor)};">#${esc(vSuffix)}</span></span> <span style="color:#999;">${s.victimHealthBefore}→${s.victimHealthAfter}/${vMax} HP</span>`;
            if (s.victimDestroyed) detailHtml += ` <span style="color:#f44;">☠</span>`;
            detailHtml += `</div>`;
            // Splash steps: include victim in the label map too
            const splashLabelMap = buildLabelMap(this.world, [
              { id: c.attackerId, label: c.attackerLabel },
              { id: c.targetId,   label: c.targetLabel },
              { id: s.victimId,   label: s.victimLabel },
            ]);
            for (const step of s.steps) {
              detailHtml += this.renderStep(step, splashLabelMap);
            }
          }
        }
      }
      detailHtml += `</div>`;
    }

    return `<div class="cl-history-row ${isExpanded ? 'cl-history-row--expanded' : ''}" data-index="${index}">
      <div class="cl-summary">
        <span class="cl-summary-text">${summaryHtml}</span>
        <button class="cl-expand-btn" data-index="${index}" title="${isExpanded ? 'Collapse' : 'Expand'}">${expandIcon}</button>
      </div>
      ${detailHtml}
    </div>`;
  }

  /** Build one summary row for a repair entry. */
  private buildRepairRowHtml(r: ExplainedRepair, index: number): string {
    const isExpanded = this.expandedIndices.has(index);
    const expandIcon = isExpanded ? '▾' : '▸';

    // ── Summary sentence ──────────────────────────────────────────────
    let summaryHtml: string;
    if (!r.wasValid) {
      summaryHtml = `<span class="cl-tag cl-tag--repair">🔧 repair</span> <span style="color:#f66;">✗ ${esc(r.reasonInvalid ?? 'Invalid')}</span>`;
    } else {
      const repColor = factionColorForUnit(this.world, r.repairerId);
      const tgtColor = factionColorForUnit(this.world, r.targetId);
      const tgtUnit  = this.world.units.find((u) => u.id === r.targetId);
      const maxHp    = tgtUnit ? (tgtUnit.attributes.size ?? 1) * 10 : r.targetHealthAfter;

      const repSuffix = r.repairerId.replace(/^unit_/, '');
      const tgtSuffix = r.targetId.replace(/^unit_/, '');

      summaryHtml  = `<span class="cl-tag cl-tag--repair">🔧 repair</span> `;
      summaryHtml += `<span style="color:${esc(repColor)};">#${esc(repSuffix)} ${esc(r.repairerLabel)}</span>`;
      summaryHtml += `<span style="color:#999;"> → </span>`;
      summaryHtml += `<span style="color:${esc(tgtColor)};">#${esc(tgtSuffix)} ${esc(r.targetLabel)}</span>`;
      summaryHtml += ` <span class="cl-summary-repair">+${r.repairAmount}</span>`;
      summaryHtml += ` <span class="cl-summary-hp">${r.targetHealthAfter}/${maxHp} HP</span>`;
    }

    // ── Expanded detail section ────────────────────────────────────────
    let detailHtml = '';
    if (isExpanded && r.wasValid) {
      detailHtml = `<div class="cl-detail">`;
      const labelMap = buildLabelMap(this.world, [
        { id: r.repairerId, label: r.repairerLabel },
        { id: r.targetId,   label: r.targetLabel },
      ]);
      for (const step of r.steps) {
        detailHtml += this.renderStep(step, labelMap);
      }
      detailHtml += `</div>`;
    }

    return `<div class="cl-history-row ${isExpanded ? 'cl-history-row--expanded' : ''}" data-index="${index}">
      <div class="cl-summary">
        <span class="cl-summary-text">${summaryHtml}</span>
        <button class="cl-expand-btn" data-index="${index}" title="${isExpanded ? 'Collapse' : 'Expand'}">${expandIcon}</button>
      </div>
      ${detailHtml}
    </div>`;
  }

  private renderStep(step: ExplanationStep, labelMap?: Map<string, string>): string {
    const col = toneColor(step.tone);
    const fmt = (text: string) => labelMap ? substituteLabels(text, labelMap) : esc(text);
    let html = `<div class="cl-step">`;
    html += `<span class="cl-step-title">${esc(step.title)}</span>`;
    html += `<span class="cl-step-desc">${fmt(step.description)}</span>`;
    if (step.formula) {
      html += `<br><span class="cl-step-formula">${fmt(step.formula)}</span>`;
    }
    html += `<br><span class="cl-step-result" style="color:${col};">${fmt(step.result)}</span>`;
    html += `</div>`;
    return html;
  }

  private bindExpandToggles(): void {
    this.el.querySelectorAll<HTMLButtonElement>('.cl-expand-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset['index'] ?? '-1', 10);
        if (idx < 0) return;
        if (this.expandedIndices.has(idx)) {
          this.expandedIndices.delete(idx);
        } else {
          this.expandedIndices.add(idx);
        }
        this.render();
        // Restore scroll position so the toggled row stays in view
        const row = this.el.querySelector<HTMLElement>(`.cl-history-row[data-index="${idx}"]`);
        row?.scrollIntoView({ block: 'nearest' });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalTile(t: TileData): { idx: number; s: 5 | 6; n: number[]; t: string; elev: string; f?: boolean; h?: number; pos: [number, number, number]; b: [number, number, number][] } {
  return { idx: t.idx, s: t.s, n: t.n, t: t.terrain, elev: t.elevType, f: t.f || undefined, h: t.h, pos: t.pos, b: t.b };
}

/** Return the faction colour for a unit, looking it up from the live world. */
function factionColorForUnit(world: WorldData, unitId: string): string {
  const unit = world.units.find((u) => u.id === unitId);
  return unit ? factionColor(world, unit.ownerId) : '#aaa';
}

/** Small emoji/symbol to visually indicate weapon mode at a glance. */
function weaponModeIcon(mode?: string): string {
  switch (mode) {
    case 'kinetic':  return '⚡';
    case 'splash':   return '💥';
    case 'antiAir':  return '🎯';
    default:         return '⚔';
  }
}

/**
 * Build a Map of full unit label → coloured `#N` HTML snippet.
 * Used to replace verbose labels inside step descriptions with compact refs.
 */
function buildLabelMap(world: WorldData, units: Array<{ id: string; label: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const { id, label } of units) {
    if (!label) continue;
    const suffix = id.replace(/^unit_/, '');
    const color = factionColorForUnit(world, id);
    map.set(label, `<span style="color:${color};">#${esc(suffix)}</span>`);
  }
  return map;
}

/**
 * Replace all occurrences of known unit labels in `text` with their coloured
 * `#N` HTML equivalents.  Longer labels are replaced first to avoid partial
 * matches when one label is a prefix of another.
 */
function substituteLabels(text: string, labelMap: Map<string, string>): string {
  // Sort by label length descending so longer labels match first
  const entries = [...labelMap.entries()].sort((a, b) => b[0].length - a[0].length);
  // Split into segments to avoid double-escaping
  // Strategy: escape the whole string first, then replace escaped label occurrences
  let result = esc(text);
  for (const [label, html] of entries) {
    // esc() escapes & < > " ' — we need to match the escaped form of the label
    const escapedLabel = esc(label);
    result = result.split(escapedLabel).join(html);
  }
  return result;
}


