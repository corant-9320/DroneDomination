/**
 * Shared structured combat-breakdown table renderer.
 *
 * Used by BOTH the hover preview (DetailPanel's Combat Info section, before
 * an attack resolves) and the combat log history (CombatPanel's expanded
 * detail rows, after an attack resolves). Both paths carry an
 * `ExplainedCombat.breakdown` produced by the same server-side
 * `explainAttack()` call — unifying the two consumers means the player sees
 * the identical layout whether they're aiming or reviewing what happened.
 *
 * Falls back to `null` when no `breakdown` is present (reaction fire and
 * building-component attacks don't carry one) — callers should fall back to
 * the step-by-step `ExplanationStep[]` renderer in that case.
 */

import { WorldData } from './worldData.js';
import { esc } from './htmlUtils.js';
import { factionColor } from './colors.js';
import type { ExplainedCombat } from '../shared/combatTypes.js';

const WEAPON_LABEL: Record<string, string> = {
  kinetic: 'Kinetic',
  splash: 'Splash',
  antiAir: 'Anti-Air',
  none: '—',
};

/**
 * Render the structured combat breakdown table.
 * Returns null when `c.breakdown` is absent — the caller should fall back
 * to rendering `c.steps` (reaction fire, building-component attacks).
 */
export function renderCombatBreakdownTable(c: ExplainedCombat, world: WorldData): string | null {
  const b = c.breakdown;
  if (!b) return null;

  const rangeCol = b.inRange ? '#8f8' : '#f66';
  const rangeNote = b.inRange
    ? `✓ In range (${b.distance.toFixed(2)}/${b.attackRange.toFixed(2)})`
    : `✗ Out of range (${b.distance.toFixed(2)}/${b.attackRange.toFixed(2)})`;

  let html = `<table class="dp-combat-table">`;

  // ── Attack section ───────────────────────────────────────────────────
  html += `<tr><td colspan="2" class="dp-combat-section">Attack (${WEAPON_LABEL[b.weaponMode]})</td></tr>`;
  html += cpRow('Range',            `<span style="color:${rangeCol};">${rangeNote}</span>`);
  html += cpRow('Base weapon',      b.baseWeapon);
  html += cpRow(`${b.chassisLabel} ×`, b.chassisModifier.toFixed(2));
  html += cpRow('Range efficiency', b.rangeEfficiency.toFixed(2));
  html += `<tr><td class="dp-combat-total" colspan="2">Attack total&nbsp;&nbsp;<span class="dp-combat-total-val">${b.attackTotal.toFixed(2)}</span></td></tr>`;

  // ── Defence section ──────────────────────────────────────────────────
  html += `<tr><td colspan="2" class="dp-combat-section">Defence</td></tr>`;
  html += cpRow('Armour', b.defArmour);
  const penalty = b.orientationArmourPenalty ?? 0;
  const effArmour = Math.max(0, b.defArmour - penalty);
  if (penalty > 0) {
    html += cpRow(`Orientation (${b.orientationLabel ?? ''})`, `−${penalty.toFixed(1)} armour`);
  }
  const ewLabel = b.defEWMultiplier >= 1
    ? `EW screen (anti-drone)`
    : `EW ${b.defEWRaw.toFixed(1)} (n/a vs ground)`;
  html += cpRow(ewLabel, b.defEW.toFixed(2));
  html += cpRow('Terrain', b.defTerrain);
  if (b.droneEvasion > 0) {
    html += cpRow('Drone target evasion −', b.droneEvasion);
  }
  const defRaw = effArmour + b.defEW + b.defTerrain;
  html += `<tr><td class="dp-combat-total" colspan="2">Defence power&nbsp;&nbsp;<span class="dp-combat-total-val">${defRaw.toFixed(2)}</span></td></tr>`;

  // ── Elevation range modifier (only shown when it has an effect) ──────
  if (b.elevationMultiplier !== 1.0) {
    const elevPct = Math.round((b.elevationMultiplier - 1) * 100);
    const sign = elevPct > 0 ? '+' : '';
    const elevCol = elevPct > 0 ? '#4f8' : '#f88';
    html += `<tr><td colspan="2" class="dp-combat-section">Elevation (range)</td></tr>`;
    html += cpRow('⛰ Elevation range', `<span style="color:${elevCol};">${sign}${elevPct}% (×${b.elevationMultiplier.toFixed(2)})</span>`);
  }

  // ── Summary (Damage + HP Remaining + Target Destroyed) ─────────────
  const targetUnit = world.units.find((u) => u.id === c.targetId);
  const targetMaxHp = targetUnit
    ? (targetUnit.attributes.size ?? 1) * 10
    : c.targetHealthBefore > c.targetHealthAfter ? c.targetHealthBefore : '?';
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

  // ── Splash victims (only present once an attack has actually resolved —
  //     the hover preview never populates c.splash) ─────────────────────
  if (c.splash.length > 0) {
    const others = c.splash.filter((s) => s.victimId !== c.targetId);
    if (others.length > 0) {
      html += `<tr><td colspan="2" class="dp-combat-section">💥 Splash (${others.length} other victim${others.length > 1 ? 's' : ''})</td></tr>`;
      for (const s of others) {
        const vUnit = world.units.find((u) => u.id === s.victimId);
        const vMax = vUnit ? (vUnit.attributes.size ?? 1) * 10 : '?';
        const vColor = vUnit ? factionColor(world, vUnit.ownerId) : '#aaa';
        html += `<tr><td colspan="2" class="dp-combat-summary" style="padding:4px 8px !important;">`;
        html += `<span style="color:${vColor};">${esc(s.victimLabel)}</span> `;
        if (s.victimDestroyed) {
          html += `<span style="color:#f44;">☠ destroyed (−${s.damage})</span>`;
        } else {
          html += `<span style="color:#4cf;">${s.victimHealthAfter}/${vMax} HP</span> <span style="color:#aaa;">(−${s.damage})</span>`;
        }
        html += `</td></tr>`;
      }
    }
  }

  // ── Building component damage (co-located enemy building hit by splash) ─
  if (c.buildingDamage && c.buildingDamage.length > 0) {
    html += `<tr><td colspan="2" class="dp-combat-section">🏛 Building Damage</td></tr>`;
    for (const d of c.buildingDamage) {
      html += cpRow(d.component, d.destroyed ? `<span style="color:#f44;">✕ destroyed</span>` : `→ ${d.newValue}`);
    }
  }

  html += `</table>`;
  return html;
}

function cpRow(label: string, value: string | number): string {
  return `<tr><td class="dp-key">${label}</td><td class="dp-val">${value}</td></tr>`;
}
