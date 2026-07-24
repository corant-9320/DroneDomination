/**
 * Shuttle Transport destination picker — RMB "Create Transport" flow.
 *
 * Shown after the player right-clicks a player-owned oil structure (well /
 * refinery / storage hub) and chooses "🚚 Create Transport". Lists every OTHER
 * owned oil structure as a candidate destination; the server independently
 * validates that a completed road (LogisticsRoute) already connects the two
 * before creating the shuttle, so this modal does not attempt to duplicate
 * that reachability check — it only lets the player pick an endpoint.
 *
 * Mirrors the light modal conventions in `saveLoad.ts`/`newWorldModal.ts`:
 * plain DOM construction, a dark backdrop, Escape/backdrop-click to cancel.
 */

export interface ShuttleDestinationCandidate {
  structureId: string;
  /** Human-readable label, e.g. "Oil Well — Hex #142" or "Storage Hub — Hex #87". */
  label: string;
}

const KIND_ICON: Record<'well' | 'refinery' | 'hub', string> = {
  well: '⛏',
  refinery: '🏭',
  hub: '🏬',
};

/**
 * Build a display label for an oil structure candidate, keyed by its oil
 * hex id (the tile index shown on the map/first-person view as "#N" under
 * every well/refinery/storage-hub/deposit) rather than the internal
 * structure id hash — the hex id is what the player can actually see and
 * recognize on the map.
 */
export function shuttleCandidateLabel(kind: 'well' | 'refinery' | 'hub', tileIndex: number): string {
  const icon = KIND_ICON[kind];
  const name = kind === 'well' ? 'Oil Well' : kind === 'refinery' ? 'Refinery' : 'Storage Hub';
  return `${icon} ${name} — Hex #${tileIndex}`;
}

/**
 * Show the destination-picker modal. Resolves with the chosen destination
 * structure id, or null if the player cancels or there are no candidates.
 */
export function showShuttleDestinationModal(
  candidates: ShuttleDestinationCandidate[],
): Promise<string | null> {
  return new Promise((resolve) => {
    if (candidates.length === 0) {
      window.alert('No other owned oil well, refinery, or storage hub is available as a destination.');
      resolve(null);
      return;
    }

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '3000',
      fontFamily: "'Segoe UI', sans-serif",
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: '#1e1e1e',
      border: '1px solid #444',
      borderRadius: '8px',
      padding: '20px',
      minWidth: '320px',
      maxWidth: '420px',
      maxHeight: '70vh',
      overflowY: 'auto',
      color: '#eee',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px',
    });
    header.innerHTML = `<h2 style="margin:0;font-size:16px;">🚚 Create Transport — Choose Destination</h2>`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', color: '#aaa', fontSize: '18px', cursor: 'pointer',
    });
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const hint = document.createElement('div');
    hint.textContent = 'Requires an existing road connecting the two structures.';
    Object.assign(hint.style, { fontSize: '12px', color: '#888', marginBottom: '10px' });
    modal.appendChild(hint);

    const list = document.createElement('div');
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '6px' });
    for (const candidate of candidates) {
      const item = document.createElement('button');
      item.textContent = candidate.label;
      Object.assign(item.style, {
        padding: '8px 12px',
        background: '#2a2a2a',
        border: '1px solid #444',
        borderRadius: '4px',
        color: '#eee',
        textAlign: 'left',
        cursor: 'pointer',
        font: "13px 'Segoe UI', sans-serif",
      });
      item.addEventListener('mouseenter', () => { item.style.background = '#3a3a3a'; });
      item.addEventListener('mouseleave', () => { item.style.background = '#2a2a2a'; });
      item.addEventListener('click', () => {
        cleanup();
        resolve(candidate.structureId);
      });
      list.appendChild(item);
    }
    modal.appendChild(list);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function cleanup(): void {
      document.body.removeChild(backdrop);
      window.removeEventListener('keydown', onKey);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    }
    window.addEventListener('keydown', onKey);

    closeBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { cleanup(); resolve(null); }
    });
  });
}
