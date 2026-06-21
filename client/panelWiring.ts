/**
 * Static UI wiring: curtain toggles, right-curtain tab switching,
 * split-handle drag to resize globe/local panels, system menu dropdown.
 * Returns switchRpTab so main.ts can store it in the GameContext.
 */

import type { GlobeView } from './globe.js';
import type { LocalMapView } from './localMap.js';
import type { CombatPanel } from './combatPanel.js';

export interface PanelRefs {
  globe: GlobeView;
  localMap: LocalMapView;
  combatPanel: CombatPanel;
}

/** Wire curtain toggles, tabs, split-handle, system menu. Returns switchRpTab. */
export function setupPanels(refs: PanelRefs): (tab: 'main' | 'history') => void {
  const { globe, localMap, combatPanel } = refs;

  // ─── Left curtain toggle ────────────────────────────────────────────
  const strategyPanel  = document.getElementById('strategy-panel') as HTMLElement;
  const strategyToggle = strategyPanel.querySelector('.curtain-toggle') as HTMLElement;
  if (strategyToggle) {
    strategyToggle.textContent = strategyPanel.classList.contains('collapsed') ? '›' : '‹';
    strategyToggle.addEventListener('click', () => {
      strategyPanel.classList.toggle('collapsed');
      strategyToggle.textContent = strategyPanel.classList.contains('collapsed') ? '›' : '‹';
    });
  }

  // ─── Right curtain toggle ───────────────────────────────────────────
  const combatLogPanel = document.getElementById('combat-log-panel') as HTMLElement;
  const combatToggle   = combatLogPanel.querySelector('.curtain-toggle') as HTMLElement;
  if (combatToggle) {
    combatToggle.textContent = combatLogPanel.classList.contains('collapsed') ? '›' : '‹';
    combatToggle.addEventListener('click', () => {
      combatLogPanel.classList.toggle('collapsed');
      combatToggle.textContent = combatLogPanel.classList.contains('collapsed') ? '›' : '‹';
    });
  }

  // ─── Right curtain tab switching ────────────────────────────────────
  const rpTabMain       = document.getElementById('rp-tab-main')         as HTMLButtonElement;
  const rpTabHistory    = document.getElementById('rp-tab-history')      as HTMLButtonElement;
  const rpContentMain   = document.getElementById('rp-tab-content-main') as HTMLElement;
  const rpContentHistory = document.getElementById('rp-tab-content-history') as HTMLElement;
  let activeRpTab: 'main' | 'history' = 'main';

  function switchRpTab(tab: 'main' | 'history'): void {
    activeRpTab = tab;
    const showMain = tab === 'main';
    rpContentMain.style.display    = showMain ? '' : 'none';
    rpContentHistory.style.display = showMain ? 'none' : 'flex';
    rpTabMain.classList.toggle('active', showMain);
    rpTabHistory.classList.toggle('active', !showMain);
    combatPanel.renderForTab();
  }

  rpTabMain.addEventListener('click',    () => switchRpTab('main'));
  rpTabHistory.addEventListener('click', () => switchRpTab('history'));
  combatPanel.setIsHistoryTabActive(() => activeRpTab === 'history');

  // ─── System menu dropdown ───────────────────────────────────────────
  const systemMenuBtn      = document.getElementById('system-menu-btn')      as HTMLElement;
  const systemMenuDropdown = document.getElementById('system-menu-dropdown') as HTMLElement;
  if (systemMenuBtn && systemMenuDropdown) {
    systemMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = systemMenuDropdown.classList.toggle('open');
      systemMenuBtn.classList.toggle('open', isOpen);
    });
    document.addEventListener('click', () => {
      systemMenuDropdown.classList.remove('open');
      systemMenuBtn.classList.remove('open');
    });
    systemMenuDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      systemMenuDropdown.classList.remove('open');
      systemMenuBtn.classList.remove('open');
    });
  }

  // ─── Split-handle drag to resize globe / local panels ───────────────
  const splitHandle = document.getElementById('split-handle') as HTMLElement;
  const splitLabel  = document.getElementById('split-label')  as HTMLElement;
  const globePanel  = document.getElementById('globe-panel')  as HTMLElement;
  const localPanel  = document.getElementById('local-panel')  as HTMLElement;
  const appEl       = document.getElementById('app')          as HTMLElement;

  const SPLIT_KEY = 'dd-split-pct';
  const HANDLE_W  = 6;   // px — must match #split-handle width in CSS
  const MIN_PCT   = 15;
  const MAX_PCT   = 75;

  function applyGlobePct(pct: number): void {
    const prevLocalW = localPanel.getBoundingClientRect().width;
    const appW  = appEl.getBoundingClientRect().width;
    const globePx = Math.round((pct / 100) * (appW - HANDLE_W));
    globePanel.style.width = `${globePx}px`;
    splitLabel.textContent = `${Math.round(pct)}%`;
    globe.onResize();
    requestAnimationFrame(() => {
      const newLocalW = localPanel.getBoundingClientRect().width;
      if (prevLocalW > 0 && newLocalW > 0 && prevLocalW !== newLocalW) {
        localMap.scale = Math.max(0.05, localMap.scale * (newLocalW / prevLocalW));
        localMap.render();
      }
    });
  }

  requestAnimationFrame(() => {
    const savedPct = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '');
    const pct = !isNaN(savedPct) ? Math.max(MIN_PCT, Math.min(MAX_PCT, savedPct)) : 40;
    applyGlobePct(pct);
  });

  let dragging = false;
  splitHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    splitHandle.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = appEl.getBoundingClientRect();
    const pct  = Math.max(MIN_PCT, Math.min(MAX_PCT,
      ((e.clientX - rect.left) / rect.width) * 100));
    applyGlobePct(pct);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitHandle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    const appW = appEl.getBoundingClientRect().width;
    const pct  = (globePanel.getBoundingClientRect().width / appW) * 100;
    localStorage.setItem(SPLIT_KEY, String(Math.round(pct * 10) / 10));
  });

  return switchRpTab;
}
