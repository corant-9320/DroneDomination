/**
 * City Design Modal — plan a city's buildings ahead of time.
 *
 * Opened from the capital-city right-click menu. Shows the capital hex and its
 * six neighbours as a schematic "flower" of segmented hexes. The player clicks
 * segments to toggle PLANNED buildings (drawn greyed out / dashed). Segments
 * that already hold a REAL building are drawn solid in the faction colour and
 * cannot be toggled; segments occupied by a unit are blocked.
 *
 * The plan is persisted per seed (see cityPlan.ts), so it is remembered between
 * invocations, and synced into `world.plannedBuildings` so the main map shows
 * the same greyed-out ghosts. `onChange` is fired after every edit so the
 * caller can re-render the map live.
 *
 * The schematic uses the game's segment convention (segment N's outer edge
 * faces neighbours[N]); each neighbour hex is rotated so the segment facing the
 * capital points inward, keeping segment indices faithful to the real tiles.
 */

import { WorldData, CityData } from './worldData.js';
import { factionColor } from './colors.js';
import { pointInTriangle } from './localMapGeometry.js';
import { validatePlannedPlacement, cityFactionId } from './buildController.js';
import {
  togglePlanned,
  isPlanned,
  getCityPlan,
  prunePlan,
  clearCityPlan,
  syncPlannedToWorld,
} from './cityPlan.js';

interface Cell {
  tileIndex: number;
  cx: number;
  cy: number;
  /** Edge angle (deg) of segment 0 for this hex. */
  base: number;
  label: string;
}

const DEG = Math.PI / 180;
const R = 66;          // hex circumradius
const GAP = 1.82;      // centre-to-centre spacing as a multiple of R
const CANVAS = 560;

export function showCityDesignModal(
  world: WorldData,
  city: CityData,
  onChange: () => void,
): void {
  const seed = world.seed;
  const cityId = city.id;
  const factionId = cityFactionId(city);
  const color = factionColor(world, city.ownerId ?? city.id);

  // ── Build the flower of cells (capital + 6 neighbours) ──────────────────
  const capIdx = city.tileIndex;
  const capTile = world.tiles[capIdx];
  const ox = CANVAS / 2;
  const oy = CANVAS / 2 + 8;
  const D = R * GAP;

  const cells: Cell[] = [{ tileIndex: capIdx, cx: ox, cy: oy, base: 30, label: 'Capital' }];
  if (capTile) {
    for (let k = 0; k < 6; k++) {
      const nIdx = capTile.n[k];
      if (nIdx === undefined) continue;
      const nTile = world.tiles[nIdx];
      if (!nTile || nTile.s !== 6) continue;
      const ang = (30 + 60 * k) * DEG;
      const ncx = ox + D * Math.cos(ang);
      const ncy = oy + D * Math.sin(ang);
      const mk = nTile.n.indexOf(capIdx);
      const base = mk >= 0 ? 210 + 60 * k - 60 * mk : 30;
      cells.push({ tileIndex: nIdx, cx: ncx, cy: ncy, base, label: '' });
    }
  }

  function vertex(cell: Cell, i: number): [number, number] {
    const a = (cell.base - 30 + 60 * i) * DEG;
    return [cell.cx + R * Math.cos(a), cell.cy + R * Math.sin(a)];
  }

  // ── DOM scaffold ────────────────────────────────────────────────────────
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.8)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '3000', fontFamily: "'Segoe UI', sans-serif",
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background: '#1a1a2e', border: '1px solid #555', borderRadius: '8px',
    display: 'flex', flexDirection: 'column', color: '#eee', overflow: 'hidden',
    maxWidth: '96vw',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '12px 16px', borderBottom: '1px solid #333',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  });
  header.innerHTML = `
    <span style="font-size:15px;font-weight:bold;">🏛 City Design — ${city.label}</span>
    <span style="font-size:12px;color:#888;">Click a segment to plan a building</span>
  `;
  modal.appendChild(header);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  Object.assign(canvas.style, { display: 'block', background: '#14141f', cursor: 'pointer' });
  modal.appendChild(canvas);

  // Status line — placement feedback (why a plan was rejected, etc.)
  const status = document.createElement('div');
  Object.assign(status.style, {
    padding: '6px 16px', fontSize: '12px', minHeight: '18px',
    borderTop: '1px solid #333', color: '#8a8',
  });
  status.textContent = 'Click an empty segment to plan a building.';
  modal.appendChild(status);

  function setStatus(msg: string, isError: boolean): void {
    status.textContent = msg;
    status.style.color = isError ? '#e88' : '#8a8';
  }

  // Legend
  const legend = document.createElement('div');
  Object.assign(legend.style, {
    padding: '8px 16px', borderTop: '1px solid #333', fontSize: '12px',
    color: '#bbb', display: 'flex', gap: '18px', alignItems: 'center',
  });
  legend.innerHTML = `
    <span><span style="display:inline-block;width:12px;height:12px;background:${color};border:1px solid #000;vertical-align:middle;"></span> Built</span>
    <span><span style="display:inline-block;width:12px;height:12px;background:rgba(180,180,180,0.6);border:1px dashed #eee;vertical-align:middle;"></span> Planned</span>
    <span><span style="display:inline-block;width:12px;height:12px;background:rgba(120,120,140,0.5);border:1px solid #555;border-radius:50%;vertical-align:middle;"></span> Unit (blocked)</span>
  `;
  modal.appendChild(legend);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '10px 16px', borderTop: '1px solid #333',
    display: 'flex', gap: '8px', justifyContent: 'flex-end',
  });
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '🗑 Clear Plan';
  Object.assign(clearBtn.style, {
    padding: '6px 14px', background: '#333', border: '1px solid #555',
    color: '#ccc', borderRadius: '4px', cursor: 'pointer',
  });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, {
    padding: '6px 16px', background: '#2a9d8f', border: 'none',
    color: '#fff', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold',
  });
  footer.appendChild(clearBtn);
  footer.appendChild(closeBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const ctx = canvas.getContext('2d')!;

  // ── Rendering ───────────────────────────────────────────────────────────
  function buildingAt(tileIndex: number, seg: number): boolean {
    return world.buildings.some((b) => b.tileIndex === tileIndex && b.segment === seg);
  }
  function unitAt(tileIndex: number, seg: number): boolean {
    return world.units.some((u) => u.tileIndex === tileIndex && u.segment === seg);
  }

  function drawBlock(cx: number, cy: number, solid: boolean): void {
    const w = 26, h = 22;
    ctx.beginPath();
    ctx.rect(cx - w / 2, cy - h / 2, w, h);
    if (solid) {
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(180,180,180,0.55)';
      ctx.strokeStyle = 'rgba(235,235,235,0.85)';
      ctx.setLineDash([4, 3]);
    }
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    // Roof
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy - h / 2);
    ctx.lineTo(cx, cy - h / 2 - 9);
    ctx.lineTo(cx + w / 2, cy - h / 2);
    ctx.closePath();
    ctx.fillStyle = solid ? 'rgba(0,0,0,0.45)' : 'rgba(120,120,120,0.5)';
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function redraw(): void {
    ctx.clearRect(0, 0, CANVAS, CANVAS);

    for (const cell of cells) {
      const owned = world.tiles[cell.tileIndex]?.city === cityId;
      for (let seg = 0; seg < 6; seg++) {
        const [ax, ay] = vertex(cell, seg);
        const [bx, by] = vertex(cell, seg + 1);

        // Segment triangle
        ctx.beginPath();
        ctx.moveTo(cell.cx, cell.cy);
        ctx.lineTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.closePath();
        ctx.fillStyle = owned ? 'rgba(60,70,95,0.55)' : 'rgba(38,40,52,0.5)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,90,110,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Centroid for the marker
        const mx = (cell.cx + ax + bx) / 3;
        const my = (cell.cy + ay + by) / 3;

        if (buildingAt(cell.tileIndex, seg)) {
          drawBlock(mx, my, true);
        } else if (unitAt(cell.tileIndex, seg)) {
          ctx.beginPath();
          ctx.arc(mx, my, 7, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(120,120,140,0.6)';
          ctx.strokeStyle = '#555';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        } else if (isPlanned(seed, cityId, cell.tileIndex, seg)) {
          drawBlock(mx, my, false);
        }
      }

      // Hex outline + label
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const [vx, vy] = vertex(cell, i);
        if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
      ctx.strokeStyle = cell.tileIndex === capIdx ? color : 'rgba(140,140,160,0.8)';
      ctx.lineWidth = cell.tileIndex === capIdx ? 2.5 : 1.5;
      ctx.stroke();

      if (cell.label) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cell.label, cell.cx, cell.cy);
      }
    }
  }

  redraw();

  // ── Interaction ─────────────────────────────────────────────────────────
  function onCanvasClick(e: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    for (const cell of cells) {
      for (let seg = 0; seg < 6; seg++) {
        const [ax, ay] = vertex(cell, seg);
        const [bx, by] = vertex(cell, seg + 1);
        if (!pointInTriangle(x, y, cell.cx, cell.cy, ax, ay, bx, by)) continue;

        // Hit this segment.
        if (buildingAt(cell.tileIndex, seg)) {
          setStatus('That segment already holds a built structure.', true);
          return;
        }
        if (unitAt(cell.tileIndex, seg)) {
          setStatus('That segment is occupied by a unit.', true);
          return;
        }

        if (isPlanned(seed, cityId, cell.tileIndex, seg)) {
          // Remove — then re-prune, since removing may disconnect other planned
          // buildings that only extended off this one.
          togglePlanned(seed, cityId, cell.tileIndex, seg);
          const pruned = prunePlan(world, city);
          setStatus(
            pruned > 0
              ? `Removed planned building (and ${pruned} now-disconnected one${pruned > 1 ? 's' : ''}).`
              : 'Removed planned building.',
            false,
          );
        } else {
          // Add — only if it honours the real placement rules against the
          // current plan + actual buildings.
          const plan = getCityPlan(seed, cityId);
          const result = validatePlannedPlacement(world, factionId, plan, {
            tileIndex: cell.tileIndex,
            segment: seg,
          });
          if (!result.legal) {
            setStatus(result.message ?? 'That placement is not allowed.', true);
            return;
          }
          togglePlanned(seed, cityId, cell.tileIndex, seg);
          setStatus('Building planned.', false);
        }

        syncPlannedToWorld(world);
        redraw();
        onChange();
        return;
      }
    }
  }
  canvas.addEventListener('click', onCanvasClick);

  // ── Close handling ──────────────────────────────────────────────────────
  function cleanup(): void {
    canvas.removeEventListener('click', onCanvasClick);
    window.removeEventListener('keydown', onKey);
    document.body.removeChild(backdrop);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') cleanup();
  }
  window.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
  closeBtn.addEventListener('click', cleanup);
  clearBtn.addEventListener('click', () => {
    clearCityPlan(seed, cityId);
    syncPlannedToWorld(world);
    redraw();
    onChange();
  });
}
