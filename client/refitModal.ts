/**
 * Refit Modal — opens the 3D unit designer in refit mode.
 *
 * Rules:
 *  - Chassis cannot be changed (locked to the unit's current chassis).
 *  - Points budget is the sum of the unit's current upgrade costs
 *    (all attributes except the movement attribute, which is chassis-fixed).
 *  - On confirm: caller receives the new UnitAttributes; caller is responsible
 *    for zeroing MP and restoring HP to the new size.
 *
 * Returns null if the player cancels.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildUnitModel, initMaterials } from './unitModel.js';
import type { ChassisType, UnitChassisType } from './unitModel.js';
import type { UnitAttributes } from '../shared/unitTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Determine the chassis type from a unit's movement attributes. */
function chassisOf(attrs: UnitAttributes): UnitChassisType {
  if ((attrs.flightMovement ?? 0) > 0) return 'flight';
  if ((attrs.limbMovement ?? 0) > 0) return 'limbed';
  return 'wheeled';
}

/** The movement attribute key for a given chassis. */
function movementKey(chassis: ChassisType): keyof UnitAttributes {
  if (chassis === 'flight') return 'flightMovement';
  if (chassis === 'limbed') return 'limbMovement';
  return 'wheeledMovement';
}

/**
 * Upgrade attributes (everything except the chassis movement attribute and
 * Size). Size and chassis are locked at design time and cannot be refitted.
 * These are the attributes that cost points and can be redistributed.
 */
const UPGRADE_ATTRS: (keyof UnitAttributes)[] = [
  'kinetic',
  'rangeAttack',
  'splashAttack',
  'antiAir',
  'armour',
  'defence',
  'repair',
  'engineer',
];

/**
 * Attributes whose maximum is capped by the unit's Size (it's unrealistic to
 * fit heavy systems on a tiny frame). rangeAttack and engineer are NOT capped.
 */
const CAPPED_BY_SIZE: ReadonlySet<keyof UnitAttributes> = new Set<keyof UnitAttributes>([
  'kinetic', 'splashAttack', 'antiAir', 'armour', 'defence', 'repair',
]);

/** Sum of current upgrade attribute values = the refit points budget. */
function computeBudget(attrs: UnitAttributes): number {
  return UPGRADE_ATTRS.reduce((sum, key) => sum + (attrs[key] ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface RefitResult {
  /** New UnitAttributes with the same chassis movement as the original. */
  attributes: UnitAttributes;
}

export interface RefitOptions {
  /** Development-only: allow the caller to change a unit's size. */
  allowSizeEdit?: boolean;
  /** Development-only: allow every editable attribute to use its full 0–5 range. */
  allowUnrestrictedBudget?: boolean;
}

/**
 * Show the refit modal for a unit. Resolves with new attributes or null if
 * the player cancels. Normal refits keep the chassis and size locked; God Mode
 * may opt into size editing.
 */
export function showRefitModal(
  unit: { label: string; attributes: UnitAttributes },
  options: RefitOptions = {},
): Promise<RefitResult | null> {
  return new Promise((resolve) => {
    const chassis = chassisOf(unit.attributes);
    const movKey = movementKey(chassis);
    const movValue = (unit.attributes[movKey] as number) ?? 1;
    let sizeVal = (unit.attributes.size as number) ?? 1;
    const budget = options.allowUnrestrictedBudget
      ? UPGRADE_ATTRS.length * 5
      : computeBudget(unit.attributes);

    // ── Working state (mirrors the designer's currentAttrs) ──────────────
    const current: Record<keyof UnitAttributes, number> = {
      size:            sizeVal,
      kinetic:         unit.attributes.kinetic         ?? 0,
      rangeAttack:     unit.attributes.rangeAttack     ?? 0,
      splashAttack:    unit.attributes.splashAttack    ?? 0,
      antiAir:         unit.attributes.antiAir         ?? 0,
      armour:          unit.attributes.armour          ?? 0,
      defence:         unit.attributes.defence         ?? 0,
      repair:          unit.attributes.repair          ?? 0,
      engineer:        unit.attributes.engineer        ?? 0,
      wheeledMovement: unit.attributes.wheeledMovement ?? 0,
      limbMovement:    unit.attributes.limbMovement    ?? 0,
      flightMovement:  unit.attributes.flightMovement  ?? 0,
    };

    // ── Backdrop ─────────────────────────────────────────────────────────
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '3000',
      fontFamily: "'Segoe UI', sans-serif",
    });

    // ── Modal container ───────────────────────────────────────────────────
    const modal = document.createElement('div');
    Object.assign(modal.style, {
      background: '#1a1a2e',
      border: '1px solid #555',
      borderRadius: '8px',
      padding: '0',
      width: '1440px',
      maxWidth: '98vw',
      height: '95vh',
      maxHeight: '95vh',
      display: 'flex',
      flexDirection: 'column',
      color: '#eee',
      overflow: 'hidden',
    });

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '12px 16px',
      borderBottom: '1px solid #333',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexShrink: '0',
    });
    header.innerHTML = `
      <div>
        <span style="font-size:15px;font-weight:bold;">⚙ Refit: ${unit.label}</span>
        <span style="font-size:12px;color:#888;margin-left:12px;">Chassis locked · Budget: <strong id="rm-budget-display">${budget}</strong> pts</span>
      </div>
      <div id="rm-points-remaining" style="font-size:13px;font-weight:bold;"></div>
    `;
    modal.appendChild(header);

    // ── Body (viewport + controls side-by-side) ───────────────────────────
    const body = document.createElement('div');
    Object.assign(body.style, {
      display: 'flex',
      flex: '1',
      overflow: 'hidden',
      minHeight: '0',
    });

    // 3D viewport
    const viewportEl = document.createElement('div');
    Object.assign(viewportEl.style, {
      flex: '1',
      background: '#2a2a3e',
      position: 'relative',
      minWidth: '0',
    });
    const canvas3d = document.createElement('canvas');
    Object.assign(canvas3d.style, { display: 'block', width: '100%', height: '100%' });
    viewportEl.appendChild(canvas3d);
    body.appendChild(viewportEl);

    // Controls panel
    const controlsEl = document.createElement('div');
    Object.assign(controlsEl.style, {
      width: '600px',
      flexShrink: '0',
      overflowY: 'auto',
      padding: '12px',
      borderLeft: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });

    // Chassis display (locked — no buttons)
    const chassisLabel: Record<UnitChassisType, string> = { wheeled: '🛞 Wheeled', limbed: '🕷️ Limbed', flight: '🚁 Flight' };
    const chassisRow = document.createElement('div');
    chassisRow.innerHTML = `
      <div style="font-size:11px;color:#888;margin-bottom:4px;">Chassis (locked)</div>
      <div style="padding:6px 10px;background:#333;border-radius:4px;font-size:13px;color:#aaa;">
        ${chassisLabel[chassis]}
      </div>
    `;
    controlsEl.appendChild(chassisRow);

    // Size is normally fixed at creation. God Mode can change it without
    // consuming the ordinary refit equipment budget.
    const sizeRow = document.createElement('div');
    const sizeSummary = document.createElement('div');
    Object.assign(sizeSummary.style, {
      padding: '6px 10px',
      background: '#333',
      borderRadius: '4px',
      fontSize: '13px',
      color: options.allowSizeEdit ? '#eee' : '#aaa',
    });
    const updateSizeSummary = () => {
      sizeSummary.textContent = `Size ${sizeVal} · ${sizeVal * 10} HP · caps weapons/armour/EW/repair at ${sizeVal}`;
    };
    updateSizeSummary();

    if (options.allowSizeEdit) {
      sizeRow.innerHTML = '<div style="font-size:11px;color:#c9a84c;margin-bottom:4px;">Size (God Mode)</div>';
      const sizeSlider = document.createElement('input');
      sizeSlider.type = 'range';
      sizeSlider.min = '1';
      sizeSlider.max = '5';
      sizeSlider.value = String(sizeVal);
      Object.assign(sizeSlider.style, { width: '100%', accentColor: '#c9a84c' });
      sizeSlider.addEventListener('input', () => {
        sizeVal = parseInt(sizeSlider.value);
        current.size = sizeVal;
        updateSizeSummary();
        for (const attr of CAPPED_BY_SIZE) {
          const slider = sliderEls.get(attr);
          const value = valEls.get(attr);
          if (!slider || !value) continue;
          const cap = Math.min(5, sizeVal);
          slider.max = String(cap);
          if (current[attr] > cap) {
            current[attr] = cap;
            slider.value = String(cap);
            value.textContent = String(cap);
          }
        }
        updatePointsRemaining();
        rebuildUnit3d();
      });
      sizeRow.appendChild(sizeSlider);
    } else {
      sizeRow.innerHTML = '<div style="font-size:11px;color:#888;margin-bottom:4px;">Size (locked)</div>';
    }
    sizeRow.appendChild(sizeSummary);
    controlsEl.appendChild(sizeRow);

    // Sliders for each upgrade attribute
    const SLIDER_LABELS: Partial<Record<keyof UnitAttributes, string>> = {
      kinetic:      'Kinetic',
      rangeAttack:  'Range Atk',
      splashAttack: 'Splash',
      antiAir:      'Anti-Air',
      armour:       'Armour',
      defence:      'Defence',
      repair:       'Repair',
    };

    const SLIDER_DESCS: Partial<Record<keyof UnitAttributes, string>> = {
      kinetic:      'Direct fire attack power. Deals full damage to ground; only 33% vs drones. Drones deal 50% outgoing with kinetic.',
      rangeAttack:  'Extends attack reach. 0 = melee only (~1 hex). Each point adds ~0.5 hex of range. Falloff: −10% damage per hex beyond 1.',
      splashAttack: 'Area-of-effect attack hitting all enemies in the target hex. Each enemy takes 30% of the full formula damage — total output beats single-target kinetic when 4+ enemies are stacked. Drones hit by splash take 50% of that (vs 33% for direct fire), so splash is relatively better against drone clusters.',
      antiAir:      'Dedicated anti-drone weapon. Full formula damage against drones with NO drone penalty. Also triggers reaction fire when a drone flies over or attacks your hex.',
      armour:       'Passive damage reduction. Contributes directly to DefencePower (0–5), reducing all incoming attack damage.',
      defence:      'Electronic Warfare (EW) — a radius-based anti-drone screen. Your defence value is the coverage radius in hexes; it protects friendly units within range (max(0, value − distance), additive across overlapping screens). Only mitigates damage from DRONE attackers — useless against tanks/spiders.',
      repair:       'Repair capability — restores this many ×10 HP to a selected friendly unit per repair action.',
    };

    const sliderEls: Map<keyof UnitAttributes, HTMLInputElement> = new Map();
    const valEls: Map<keyof UnitAttributes, HTMLSpanElement> = new Map();

    for (const attr of UPGRADE_ATTRS) {
      // Drones (flight chassis) attack adjacent only — no rangeAttack slider.
      if (attr === 'rangeAttack' && chassis === 'flight') continue;
      const label = SLIDER_LABELS[attr] ?? attr;
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', flexDirection: 'column', gap: '2px' });

      const topRow = document.createElement('div');
      Object.assign(topRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      Object.assign(labelEl.style, { fontSize: '11px', color: '#aaa' });
      const valEl = document.createElement('span');
      valEl.textContent = String(current[attr]);
      Object.assign(valEl.style, { fontSize: '11px', color: '#7ec8e3', fontWeight: 'bold', minWidth: '14px', textAlign: 'right' });
      topRow.appendChild(labelEl);
      topRow.appendChild(valEl);
      row.appendChild(topRow);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(CAPPED_BY_SIZE.has(attr) ? Math.min(5, sizeVal) : 5);
      slider.value = String(current[attr]);
      Object.assign(slider.style, { width: '100%', accentColor: '#2a9d8f' });

      slider.addEventListener('input', () => {
        const newVal = parseInt(slider.value);
        const oldVal = current[attr];
        const delta = newVal - oldVal;
        const used = UPGRADE_ATTRS.reduce((s, k) => s + (k === attr ? newVal : current[k]), 0);
        if (used > budget) {
          // Clamp: can't exceed budget
          const maxAllowed = budget - (UPGRADE_ATTRS.reduce((s, k) => s + (k !== attr ? current[k] : 0), 0));
          slider.value = String(Math.max(0, maxAllowed));
          current[attr] = Math.max(0, maxAllowed);
        } else {
          current[attr] = newVal;
        }
        valEl.textContent = String(current[attr]);
        updatePointsRemaining();
        rebuildUnit3d();
      });

      row.appendChild(slider);
      controlsEl.appendChild(row);
      sliderEls.set(attr, slider);
      valEls.set(attr, valEl);

      const desc = SLIDER_DESCS[attr];
      if (desc) {
        const descEl = document.createElement('div');
        descEl.textContent = desc;
        Object.assign(descEl.style, {
          fontSize: '10px',
          color: '#666',
          lineHeight: '1.4',
          marginTop: '1px',
          paddingLeft: '2px',
        });
        row.appendChild(descEl);
      }
    }

    // ── How damage is calculated ──────────────────────────────────────────
    const dmgSection = document.createElement('div');
    Object.assign(dmgSection.style, {
      marginTop: '8px',
      borderTop: '1px solid #333',
      paddingTop: '8px',
    });

    const dmgHeader = document.createElement('div');
    dmgHeader.textContent = 'How damage works';
    Object.assign(dmgHeader.style, {
      fontSize: '11px',
      color: '#7ec8e3',
      fontWeight: 'bold',
      marginBottom: '6px',
    });
    dmgSection.appendChild(dmgHeader);

    const dmgBlocks: Array<{ heading?: string; text: string; example?: boolean }> = [
      {
        text: 'Damage happens in two stages. First, attack and defence compete in a tug-of-war to decide the base damage. Then, multipliers are applied on top.',
      },
      {
        heading: 'Stage 1 — the tug-of-war (base damage)',
        text: 'These attributes feed directly into the tug-of-war:',
      },
      {
        heading: '  Attack side',
        text: 'Kinetic, Splash, or Anti-Air — whichever weapon mode is used. The attack value sets both the damage ceiling (6 × attack, max 50) and your share of it. Doubling your attack raises the ceiling AND wins a bigger share.',
      },
      {
        heading: '  Flanking / facing (attack bonus)',
        text: 'Attacking from the side adds +1 to attack power, from the rear +2. This shifts the tug-of-war itself — a higher effective attack means a higher ceiling too.',
      },
      {
        heading: '  Defence side',
        text: 'Armour (always) and forest cover. EW is a separate radius-based anti-drone screen that only reduces damage from drone attackers.',
      },
      {
        heading: 'Example — even match',
        text: 'Attack 3 vs Defence 3 → ceiling is 18 (6 × attack), each side equal so half lands → ~9 damage.',
        example: true,
      },
      {
        heading: 'Example — attacker dominates',
        text: 'Attack 5 vs Defence 1 → ceiling is 50, attacker wins ~96% → ~48 damage.',
        example: true,
      },
      {
        heading: 'Example — defender dominates',
        text: 'Attack 1 vs Defence 5 → ceiling is 6, attacker wins ~4% → 1 damage.',
        example: true,
      },
      {
        heading: 'Stage 2 — multipliers applied after',
        text: 'These don\'t change the tug-of-war, they scale the result up or down:',
      },
      {
        heading: '  Elevation',
        text: 'Each level you fire down adds ×10% to final damage (max ×1.3 from a mountain). Firing uphill gives the same penalty. No effect on or from drones.',
      },
      {
        heading: '  Chassis & drone resistance',
        text: 'Spiders deal ×0.75 outgoing, drones ×0.50. Separately, drones take only ×0.33 from direct fire and ×0.50 from splash — but ×1.0 from anti-air, which bypasses both penalties.',
      },
    ];

    for (const block of dmgBlocks) {
      const el = document.createElement('div');
      Object.assign(el.style, { marginBottom: '6px' });

      if (block.heading) {
        const h = document.createElement('div');
        h.textContent = block.heading;
        const isSubHeading = block.heading!.startsWith('  ');
        Object.assign(h.style, {
          fontSize: '10px',
          color: block.example ? '#f7b731' : isSubHeading ? '#aaa' : '#7ec8e3',
          fontWeight: 'bold',
          marginBottom: '1px',
        });
        el.appendChild(h);
      }

      const p = document.createElement('div');
      p.textContent = block.text;
      Object.assign(p.style, {
        fontSize: '10px',
        color: '#888',
        lineHeight: '1.5',
      });
      el.appendChild(p);
      dmgSection.appendChild(el);
    }

    controlsEl.appendChild(dmgSection);

    body.appendChild(controlsEl);
    modal.appendChild(body);

    // ── Footer ────────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '10px 16px',
      borderTop: '1px solid #333',
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
      flexShrink: '0',
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, {
      padding: '6px 14px', background: '#333', border: '1px solid #555',
      color: '#ccc', borderRadius: '4px', cursor: 'pointer',
    });
    const confirmBtn = document.createElement('button');
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

    // ── Points remaining display ─────────────────────────────────────────
    const pointsRemainingEl = modal.querySelector('#rm-points-remaining') as HTMLElement;
    function updatePointsRemaining(): void {
      const used = UPGRADE_ATTRS.reduce((s, k) => s + current[k], 0);
      const remaining = budget - used;
      pointsRemainingEl.textContent = remaining === 0
        ? `${remaining} pts remaining`
        : remaining > 0
          ? `${remaining} pts remaining`
          : `${Math.abs(remaining)} pts over budget!`;
      pointsRemainingEl.style.color = remaining < 0 ? '#ff6b6b' : remaining === 0 ? '#7fdbca' : '#f7b731';
      confirmBtn.disabled = remaining < 0;
      confirmBtn.style.opacity = remaining < 0 ? '0.5' : '1';
      confirmBtn.style.cursor = remaining < 0 ? 'not-allowed' : 'pointer';
    }
    updatePointsRemaining();

    // ── Three.js setup ───────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2a3e);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(3, 2.5, 3);

    const orbitControls = new OrbitControls(camera, canvas3d);
    orbitControls.target.set(0, 0.4, 0);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.1;
    orbitControls.minDistance = 2;
    orbitControls.maxDistance = 12;
    orbitControls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
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

    let unitGroup: THREE.Group = new THREE.Group();
    scene.add(unitGroup);

    function rebuildUnit3d(): void {
      unitGroup.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      });
      scene.remove(unitGroup);

      unitGroup = buildUnitModel({
        chassis,
        movement: movValue,
        kinetic:      current.kinetic,
        rangeAttack:  current.rangeAttack,
        splashAttack: current.splashAttack,
        antiAir:      current.antiAir,
        armour:       current.armour,
        defence:      current.defence,
        repair:       current.repair,
      });

      const healthScale = Math.pow(0.9, 5 - (current.size || 1));
      unitGroup.scale.setScalar(healthScale);
      scene.add(unitGroup);
    }

    // Resize the Three.js renderer when the modal's viewport changes
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
      orbitControls.update();
      renderer.render(scene, camera);
    }

    initMaterials();
    rebuildUnit3d();
    animate();

    // ── Cleanup ───────────────────────────────────────────────────────────
    function cleanup(): void {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      renderer.dispose();
      document.body.removeChild(backdrop);
    }

    // ── Event wiring ─────────────────────────────────────────────────────
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

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
      // Build the new UnitAttributes — preserve the chassis movement, set
      // all upgrade attrs from slider state, omit zero values.
      const newAttrs: UnitAttributes = {};
      newAttrs[movKey] = movValue;
      // Size is locked — preserve it (not part of UPGRADE_ATTRS).
      if (sizeVal > 0) newAttrs.size = sizeVal;
      for (const attr of UPGRADE_ATTRS) {
        const v = current[attr];
        if (v > 0) (newAttrs as Record<string, number>)[attr] = v;
      }
      cleanup();
      resolve({ attributes: newAttrs });
    });
  });
}
