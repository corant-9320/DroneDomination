/**
 * Save / Load game state using localStorage.
 * Each save is keyed by a timestamp-based name.
 */

import { getCompactSave, applyNewWorld } from './worldData.js';
import { dbg } from './debug.js';

const SAVE_PREFIX = 'drone-domination-save-';

interface SaveEntry {
  key: string;
  timestamp: number;
  label: string;
  seed: number;
  cities: number;
  units: number;
}

/** Bundled save files available from the data directory. */
interface BundledSave {
  filename: string;
  label: string;
  description: string;
}

const BUNDLED_SAVES: BundledSave[] = [
  {
    filename: 'default-scenario.json',
    label: 'Default (populated)',
    description: 'Two big cities with dozens of buildings, a siege of each, and open-field battles — the heavily-populated default world',
  },
  {
    filename: 'battle-20v20.json',
    label: 'Battle (20v20)',
    description: '20 player vs 20 enemy — randomized 27-point units, 5 hexes wide formation',
  },
];

/** Save the current world to localStorage in compact format (no tiles). */
export function saveGame(): void {
  const compact = getCompactSave();
  if (!compact) {
    dbg.world.warn('saveGame: no world loaded');
    return;
  }

  const now = Date.now();
  const key = SAVE_PREFIX + now;
  const payload = JSON.stringify(compact);

  try {
    localStorage.setItem(key, payload);
    dbg.world.log('Game saved (compact):', key, `(${(payload.length / 1024).toFixed(1)} KB)`);
    showToast('Game saved');
  } catch (e) {
    dbg.world.error('Failed to save game:', e);
    showToast('Save failed — storage full?');
  }
}

/** List all saved games, newest first. */
function listSaves(): SaveEntry[] {
  const entries: SaveEntry[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SAVE_PREFIX)) continue;
    const tsStr = key.slice(SAVE_PREFIX.length);
    const timestamp = parseInt(tsStr, 10);
    if (isNaN(timestamp)) continue;

    // Peek at minimal metadata without full parse
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      entries.push({
        key,
        timestamp,
        label: formatTimestamp(timestamp),
        seed: data.seed,
        cities: data.cities?.length ?? 0,
        units: data.units?.length ?? 0,
      });
    } catch {
      // Corrupted entry — skip
    }
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

/** Load a saved game by key — replaces current world and reloads. */
function loadSave(key: string): void {
  const raw = localStorage.getItem(key);
  if (!raw) {
    dbg.world.error('loadSave: key not found:', key);
    return;
  }
  dbg.world.log('Loading save:', key);
  const data = JSON.parse(raw);
  applyNewWorld(data);
}

/** Delete a save by key. */
function deleteSave(key: string): void {
  localStorage.removeItem(key);
  dbg.world.log('Deleted save:', key);
}

/** Load a bundled save file from the data directory and apply it. */
async function loadBundledSave(filename: string): Promise<void> {
  dbg.world.log('Loading bundled save:', filename);
  try {
    const response = await fetch(`/${filename}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    applyNewWorld(data);
  } catch (e) {
    dbg.world.error('Failed to load bundled save:', e);
    showToast('Failed to load scenario');
  }
}

/** Show the load-game modal with a list of saves. */
export function showLoadModal(): void {
  const saves = listSaves();

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.style.cssText =
    'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:2000;display:flex;align-items:center;justify-content:center;';

  // Modal
  const modal = document.createElement('div');
  modal.style.cssText =
    'background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:20px;min-width:360px;max-width:480px;max-height:70vh;display:flex;flex-direction:column;color:#eee;font-family:Segoe UI,sans-serif;';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
  header.innerHTML = `<h2 style="margin:0;font-size:16px;">Load Game</h2>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;';
  closeBtn.onclick = () => backdrop.remove();
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // List container
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;flex:1;';

  // ─── Bundled Scenarios Section ─────────────────────────────────────────
  const scenarioHeader = document.createElement('div');
  scenarioHeader.style.cssText = 'font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;padding:6px 10px;border-bottom:1px solid #333;';
  scenarioHeader.textContent = 'Scenarios';
  list.appendChild(scenarioHeader);

  for (const bundled of BUNDLED_SAVES) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #333;';

    const info = document.createElement('div');
    info.innerHTML = `
      <div style="font-size:13px;font-weight:bold;">${bundled.label}</div>
      <div style="font-size:11px;color:#999;">${bundled.description}</div>
    `;

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.style.cssText =
      'background:#268;border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
    loadBtn.onclick = () => loadBundledSave(bundled.filename);

    row.appendChild(info);
    row.appendChild(loadBtn);
    list.appendChild(row);
  }

  // ─── User Saves Section ────────────────────────────────────────────────
  const savesHeader = document.createElement('div');
  savesHeader.style.cssText = 'font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;padding:6px 10px;margin-top:8px;border-bottom:1px solid #333;';
  savesHeader.textContent = 'Your Saves';
  list.appendChild(savesHeader);

  if (saves.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#666;font-style:italic;padding:12px 10px;';
    empty.textContent = 'No saved games yet.';
    list.appendChild(empty);
  } else {
    for (const save of saves) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #333;';

      const info = document.createElement('div');
      info.innerHTML = `
        <div style="font-size:13px;font-weight:bold;">${save.label}</div>
        <div style="font-size:11px;color:#999;">Seed ${save.seed} · ${save.cities} cities · ${save.units} units</div>
      `;

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;';

      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.style.cssText =
        'background:#2a6;border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
      loadBtn.onclick = () => loadSave(save.key);

      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Delete this save';
      delBtn.style.cssText =
        'background:#633;border:none;color:#faa;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;';
      delBtn.onclick = () => {
        deleteSave(save.key);
        row.remove();
      };

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  modal.appendChild(list);
  backdrop.appendChild(modal);

  // Close on backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  // Close on Escape
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      backdrop.remove();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
}

/** Brief toast notification. */
function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,0.95);color:#eee;padding:8px 18px;border-radius:6px;font-size:13px;z-index:3000;pointer-events:none;transition:opacity 0.4s;';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, 1800);
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}
