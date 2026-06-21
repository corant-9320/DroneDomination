/**
 * Building Refit Modal — reconfigure a building's equipment loadout.
 *
 * Mirrors the unit refit modal (refitModal.ts) but for static structures:
 *  - No chassis and no movement (buildings are immobile).
 *  - No engineering (buildings never build bridges).
 *  - The seven combat/support attributes can be freely redistributed within a
 *    fixed points budget (see BUILDING_REFIT_BUDGET). A fresh building starts
 *    empty, so the budget is a flat pool rather than "sum of current" (which
 *    would be 0 and leave nothing to spend).
 *
 * Returns the chosen attributes, or null if the player cancels.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildBuildingModel } from './buildingModel.js';
import type { BuildingModelAttrs } from './buildingModel.js';
import type { UnitAttributes } from '../shared/unitTypes.js';

/**
 * Points a building may distribute across its equipment in a refit.
 * Buildings are stationary emplacements, so they get a flat, generous pool.
 */
export const BUILDING_REFIT_BUDGET = 10;

/** The seven equipment attributes a building can mount (no movement, no engineer). */
const BUILDING_ATTRS: (keyof BuildingModelAttrs)[] = [
  'kinetic',
  'rangeAttack',
  'splashAttack',
  'antiAir',
  'armour',
  'defence',
  'repair',
];

const LABELS: Record<keyof BuildingModelAttrs, string> = {
  kinetic: 'Kinetic',
  rangeAttack: 'Range Atk',
  splashAttack: 'Splash',
  antiAir: 'Anti-Air',
  armour: 'Armour',
  defence: 'Defence',
  repair: 'Repair',
};

const DESCS: Record<keyof BuildingModelAttrs, string> = {
  kinetic: 'Direct-fire gun. Full damage to ground; only 33% vs drones.',
  rangeAttack: 'Extends weapon reach. 0 = melee only; each point adds ~0.5 hex.',
  splashAttack: 'Area-of-effect attack hitting all enemies in the target hex.',
  antiAir: 'Dedicated anti-drone weapon. No drone penalty; triggers reaction fire.',
  armour: 'Passive damage reduction added to DefencePower.',
  defence: 'Electronic Warfare. Stacks with same-hex allies; strongest vs anti-air.',
  repair: 'Restores ×10 HP to a friendly unit per repair action.',
};

export interface BuildingRefitResult {
  /** New equipment attributes (only the seven building attrs, zeros omitted). */
  attributes: UnitAttributes;
}

/**
 * Show the building refit modal. Resolves with the new attributes, or null on cancel.
 *
 * @param building    Label + current equipment attributes (UnitAttributes subset).
 * @param factionHex  Optional faction colour to tint the 3D preview.
 */
export function showBuildingRefitModal(
  building: { label: string; attributes?: UnitAttributes },
  factionHex?: string,
): Promise<BuildingRefitResult | null> {
  return new Promise((resolve) => {
    const attrs0 = building.attributes ?? {};
    const current: Record<keyof BuildingModelAttrs, number> = {
      kinetic: attrs0.kinetic ?? 0,
      rangeAttack: attrs0.rangeAttack ?? 0,
      splashAttack: attrs0.splashAttack ?? 0,
      antiAir: attrs0.antiAir ?? 0,
      armour: attrs0.armour ?? 0,
      defence: attrs0.defence ?? 0,
      repair: attrs0.repair ?? 0,
    };

    const currentSum = BUILDING_ATTRS.reduce((s, k) => s + current[k], 0);
    const budget = Math.max(BUILDING_REFIT_BUDGET, currentSum);

    // ── Backdrop + modal shell ───────────────────────────────────────────
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.8)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '3000', fontFamily: "'Segoe UI', sans-serif",
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: '#1a1a2e', border: '1px solid #555', borderRadius: '8px',
      width: '1100px', maxWidth: '96vw', height: '88vh', maxHeight: '88vh',
      display: 'flex', flexDirection: 'column', color: '#eee', overflow: 'hidden',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '12px 16px', borderBottom: '1px solid #333',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: '0',
    });
    header.innerHTML = `
      <div>
        <span style="font-size:15px;font-weight:bold;">⚙ Refit Building: ${building.label}</span>
        <span style="font-size:12px;color:#888;margin-left:12px;">Budget: <strong>${budget}</strong> pts</span>
      </div>
      <div id="brm-points-remaining" style="font-size:13px;font-weight:bold;"></div>
    `;
    modal.appendChild(header);

    const bodyEl = document.createElement('div');
    Object.assign(bodyEl.style, { display: 'flex', flex: '1', overflow: 'hidden', minHeight: '0' });

    const viewportEl = document.createElement('div');
    Object.assign(viewportEl.style, { flex: '1', background: '#2a2a3e', position: 'relative', minWidth: '0' });
    const canvas3d = document.createElement('canvas');
    Object.assign(canvas3d.style, { display: 'block', width: '100%', height: '100%' });
    viewportEl.appendChild(canvas3d);
    bodyEl.appendChild(viewportEl);

    const controlsEl = document.createElement('div');
    Object.assign(controlsEl.style, {
      width: '420px', flexShrink: '0', overflowY: 'auto', padding: '14px',
      borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', gap: '10px',
    });

    const confirmBtn = document.createElement('button');
    const pointsRemainingEl = header.querySelector('#brm-points-remaining') as HTMLElement;

    function updatePointsRemaining(): void {
      const used = BUILDING_ATTRS.reduce((s, k) => s + current[k], 0);
      const remaining = budget - used;
      pointsRemainingEl.textContent = remaining >= 0
        ? `${remaining} pts remaining`
        : `${Math.abs(remaining)} pts over budget!`;
      pointsRemainingEl.style.color = remaining < 0 ? '#ff6b6b' : remaining === 0 ? '#7fdbca' : '#f7b731';
      confirmBtn.disabled = remaining < 0;
      confirmBtn.style.opacity = remaining < 0 ? '0.5' : '1';
      confirmBtn.style.cursor = remaining < 0 ? 'not-allowed' : 'pointer';
    }

    for (const attr of BUILDING_ATTRS) {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', flexDirection: 'column', gap: '2px' });

      const topRow = document.createElement('div');
      Object.assign(topRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
      const labelEl = document.createElement('span');
      labelEl.textContent = LABELS[attr];
      Object.assign(labelEl.style, { fontSize: '12px', color: '#aaa' });
      const valEl = document.createElement('span');
      valEl.textContent = String(current[attr]);
      Object.assign(valEl.style, { fontSize: '12px', color: '#7ec8e3', fontWeight: 'bold', minWidth: '14px', textAlign: 'right' });
      topRow.appendChild(labelEl);
      topRow.appendChild(valEl);
      row.appendChild(topRow);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '5';
      slider.value = String(current[attr]);
      Object.assign(slider.style, { width: '100%', accentColor: '#2a9d8f' });

      slider.addEventListener('input', () => {
        const newVal = parseInt(slider.value);
        const otherUsed = BUILDING_ATTRS.reduce((s, k) => s + (k !== attr ? current[k] : 0), 0);
        if (otherUsed + newVal > budget) {
          const maxAllowed = Math.max(0, budget - otherUsed);
          slider.value = String(maxAllowed);
          current[attr] = maxAllowed;
        } else {
          current[attr] = newVal;
        }
        valEl.textContent = String(current[attr]);
        updatePointsRemaining();
        rebuild3d();
      });

      row.appendChild(slider);

      const descEl = document.createElement('div');
      descEl.textContent = DESCS[attr];
      Object.assign(descEl.style, { fontSize: '10px', color: '#666', lineHeight: '1.4', paddingLeft: '2px' });
      row.appendChild(descEl);

      controlsEl.appendChild(row);
    }

    bodyEl.appendChild(controlsEl);
    modal.appendChild(bodyEl);

    // ── Footer ───────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '10px 16px', borderTop: '1px solid #333',
      display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: '0',
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, {
      padding: '6px 14px', background: '#333', border: '1px solid #555',
      color: '#ccc', borderRadius: '4px', cursor: 'pointer',
    });
    confirmBtn.textContent = '✔ Confirm Refit';
    Object.assign(confirmBtn.style, {
      padding: '6px 16px', background: '#2a9d8f', border: 'none',
      color: '#fff', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold',
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    updatePointsRemaining();

    // ── Three.js preview ───────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2a3e);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(3, 2.6, 3);

    const orbit = new OrbitControls(camera, canvas3d);
    orbit.target.set(0, 0.6, 0);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    orbit.minDistance = 2;
    orbit.maxDistance = 12;
    orbit.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(3, 5, 2);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x8888ff, 0.3);
    fillLight.position.set(-2, 1, -3);
    scene.add(fillLight);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshStandardMaterial({ color: 0x2a2a3e, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    scene.add(ground);
    scene.add(new THREE.GridHelper(4, 8, 0x444466, 0x333355));

    let group: THREE.Group = new THREE.Group();
    scene.add(group);

    function rebuild3d(): void {
      group.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      });
      scene.remove(group);
      group = buildBuildingModel({ ...current }, factionHex);
      scene.add(group);
    }

    const resizeObserver = new ResizeObserver(() => {
      const w = viewportEl.clientWidth;
      const h = viewportEl.clientHeight;
      if (w > 0 && h > 0) {
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    });
    resizeObserver.observe(viewportEl);

    let animFrameId = 0;
    function animate(): void {
      animFrameId = requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
    }
    rebuild3d();
    animate();

    // ── Cleanup + wiring ─────────────────────────────────────────────────
    function cleanup(): void {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      renderer.dispose();
      document.body.removeChild(backdrop);
    }

    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { cleanup(); resolve(null); }
    });
    window.addEventListener('keydown', function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', onKey);
        cleanup();
        resolve(null);
      }
    });

    confirmBtn.addEventListener('click', () => {
      const newAttrs: UnitAttributes = {};
      for (const attr of BUILDING_ATTRS) {
        const v = current[attr];
        if (v > 0) (newAttrs as Record<string, number>)[attr] = v;
      }
      cleanup();
      resolve({ attributes: newAttrs });
    });
  });
}
