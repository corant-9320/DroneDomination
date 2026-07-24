/**
 * New World modal — thin client form that POSTs config to /api/generate.
 * Keeps logic minimal; the server decides the world.
 */

import { FACTION_PALETTE } from './colors.js';
import { dbg } from './debug.js';
import { expectBoolean, expectObject, expectString } from './world/validation.js';

/** Must match CITY_COUNT in src/world/cities.ts. World always generates this many cities. */
const MAX_CITIES = 12;
const MIN_SPACING = 20;
const MAX_SPACING = 45;

export interface NewWorldResult {
  world: unknown;
  playerColor: string;
}

/**
 * Shape of the JSON response from POST /api/generate. Mirrors
 * `server/generateApi.ts::GenerateResult` — `world` stays `unknown` here too
 * (the generated-world bootstrap payload is handed to `applyNewWorld`, which
 * normalizes it through `client/world/codec.ts::decodeWorldInput`; this modal
 * does not decode the world body itself beyond debug logging).
 */
interface GenerateApiResponse {
  success: boolean;
  world?: unknown;
  error?: string;
}

/**
 * Validate just enough of the `/api/generate` envelope to decide whether the
 * request succeeded and to safely read `error`/`world`: `success` must be a
 * boolean, and a failure response must carry a usable string `error`. The
 * `world` bootstrap payload itself is validated later by
 * `client/world/codec.ts::decodeWorldBootstrap` (via `applyNewWorld`) — this
 * envelope check is not a duplicate of that decoder.
 */
function decodeGenerateApiResponse(value: unknown): GenerateApiResponse {
  const o = expectObject(value, '');
  const success = expectBoolean(o.success, 'success');
  if (!success) {
    return { success, error: expectString(o.error, 'error') };
  }
  return { success, world: o.world };
}

/**
 * Show the New World modal. Resolves with the generated world JSON
 * or null if cancelled.
 */
export function showNewWorldModal(): Promise<NewWorldResult | null> {
  return new Promise((resolve) => {
    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'new-world-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '2000',
    });

    // Modal
    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: '#1e1e1e',
      border: '1px solid #444',
      borderRadius: '8px',
      padding: '24px',
      minWidth: '320px',
      color: '#eee',
      fontFamily: "'Segoe UI', sans-serif",
    });

    const maxEnemies = MAX_CITIES - 1;

    modal.innerHTML = `
      <h2 style="margin:0 0 16px;font-size:18px;">New World</h2>
      <label style="display:block;margin-bottom:12px;">
        <span style="display:block;margin-bottom:4px;font-size:13px;color:#aaa;">Enemy Cities (0–${maxEnemies}; 0 = Sandbox)</span>
        <input id="nw-enemies" type="range" min="0" max="${maxEnemies}" value="3"
          style="width:100%;" />
        <span id="nw-enemies-val" style="font-size:13px;">3</span>
      </label>
      <div id="nw-spacing-section">
        <label style="display:block;margin-bottom:12px;">
          <span style="display:block;margin-bottom:4px;font-size:13px;color:#aaa;">
            Distance from Home (${MIN_SPACING}–${MAX_SPACING} tiles)
          </span>
          <input id="nw-spacing" type="range" min="${MIN_SPACING}" max="${MAX_SPACING}" value="${MIN_SPACING}"
            style="width:100%;" />
          <span id="nw-spacing-val" style="font-size:13px;">${MIN_SPACING}</span>
        </label>
      </div>
      <div style="margin-bottom:12px;">
        <span style="display:block;margin-bottom:6px;font-size:13px;color:#aaa;">Your Colour</span>
        <div id="nw-color-picker" style="display:flex;flex-wrap:wrap;gap:6px;">
          ${FACTION_PALETTE.map((c, i) => `<button class="nw-color-swatch" data-color="${c}" style="width:28px;height:28px;border-radius:4px;border:2px solid ${i === 0 ? '#fff' : 'transparent'};background:${c};cursor:pointer;padding:0;"></button>`).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="nw-cancel" style="padding:6px 14px;background:#333;border:1px solid #555;color:#ccc;border-radius:4px;cursor:pointer;">Cancel</button>
        <button id="nw-generate" style="padding:6px 14px;background:#2a9d8f;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">Generate</button>
      </div>
      <div id="nw-status" style="margin-top:12px;font-size:12px;color:#888;"></div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Elements
    const enemiesInput = modal.querySelector('#nw-enemies') as HTMLInputElement;
    const enemiesVal = modal.querySelector('#nw-enemies-val') as HTMLSpanElement;
    const spacingSection = modal.querySelector('#nw-spacing-section') as HTMLDivElement;
    const spacingInput = modal.querySelector('#nw-spacing') as HTMLInputElement;
    const spacingVal = modal.querySelector('#nw-spacing-val') as HTMLSpanElement;
    const cancelBtn = modal.querySelector('#nw-cancel') as HTMLButtonElement;
    const generateBtn = modal.querySelector('#nw-generate') as HTMLButtonElement;
    const statusEl = modal.querySelector('#nw-status') as HTMLDivElement;

    function updateUI() {
      const enemies = parseInt(enemiesInput.value);
      enemiesVal.textContent = String(enemies);

      // Spacing is irrelevant with no enemies or when every city is active.
      if (enemies === 0 || enemies >= maxEnemies) {
        spacingSection.style.display = 'none';
      } else {
        spacingSection.style.display = 'block';
      }

      spacingVal.textContent = spacingInput.value;
    }

    enemiesInput.addEventListener('input', updateUI);
    spacingInput.addEventListener('input', updateUI);
    updateUI();

    // Color picker
    let selectedColor = FACTION_PALETTE[0];
    const swatches = modal.querySelectorAll('.nw-color-swatch') as NodeListOf<HTMLButtonElement>;
    swatches.forEach((swatch) => {
      swatch.addEventListener('click', () => {
        // Remove border highlight from all
        swatches.forEach((s) => (s.style.border = '2px solid transparent'));
        // Highlight selected
        swatch.style.border = '2px solid #fff';
        selectedColor = swatch.dataset.color!;
      });
    });

    function cleanup() {
      document.body.removeChild(backdrop);
    }

    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        cleanup();
        resolve(null);
      }
    });

    generateBtn.addEventListener('click', async () => {
      const enemies = parseInt(enemiesInput.value);
      const spacing = parseInt(spacingInput.value);

      dbg.modal.log('Generate clicked:', { enemies, spacing, selectedColor });
      generateBtn.disabled = true;
      statusEl.textContent = 'Generating...';

      try {
        dbg.api.time('POST /api/generate');
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enemies, spacing }),
        });
        dbg.api.timeEnd('POST /api/generate');
        dbg.api.log('Response status:', res.status);
        const rawJson: unknown = await res.json();
        const data = decodeGenerateApiResponse(rawJson);
        if (!data.success) {
          dbg.api.error('Generate failed:', data.error);
          statusEl.textContent = `Error: ${data.error}`;
          generateBtn.disabled = false;
          return;
        }
        dbg.api.log('Generate success, world:', data.world);
        cleanup();
        resolve({ world: data.world, playerColor: selectedColor });
      } catch (err) {
        dbg.api.error('Generate fetch error:', err);
        statusEl.textContent = `Error: ${err}`;
        generateBtn.disabled = false;
      }
    });
  });
}
