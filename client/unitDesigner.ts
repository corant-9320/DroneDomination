/**
 * Unit Designer — interactive 3D preview using the shared unitModel builder.
 * Loaded by test-units.html via Vite dev server.
 *
 * Single source of truth: all geometry comes from buildUnitModel() in unitModel.ts.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildUnitModel, initMaterials } from './unitModel.js';
import type { ChassisType, UnitModelAttrs } from './unitModel.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentChassis: ChassisType = 'wheeled';
let currentAttrs = {
  kinetic: 0,
  rangeAttack: 0,
  splashAttack: 0,
  antiAir: 0,
  armour: 0,
  defence: 0,
  repair: 0,
  movement: 3,
  health: 1,
};

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById('render-canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a3e);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(3, 2.5, 3);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.minDistance = 2;
controls.maxDistance = 12;
controls.update();

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(3, 5, 2);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0x8888ff, 0.3);
fillLight.position.set(-2, 1, -3);
scene.add(fillLight);

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(6, 6),
  new THREE.MeshStandardMaterial({ color: 0x2a2a3e, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
scene.add(ground);

// Grid helper
const gridHelper = new THREE.GridHelper(4, 8, 0x444466, 0x333355);
gridHelper.position.y = 0.001;
scene.add(gridHelper);

// ---------------------------------------------------------------------------
// Unit group (rebuilt on each change)
// ---------------------------------------------------------------------------

let unitGroup: THREE.Group = new THREE.Group();
scene.add(unitGroup);

function rebuildUnit(): void {
  // Dispose old geometry
  unitGroup.traverse((obj) => {
    if ((obj as THREE.Mesh).geometry) {
      (obj as THREE.Mesh).geometry.dispose();
    }
  });
  scene.remove(unitGroup);

  const attrs: UnitModelAttrs = {
    chassis: currentChassis,
    movement: currentAttrs.movement,
    kinetic: currentAttrs.kinetic,
    rangeAttack: currentAttrs.rangeAttack,
    splashAttack: currentAttrs.splashAttack,
    antiAir: currentAttrs.antiAir,
    armour: currentAttrs.armour,
    defence: currentAttrs.defence,
    repair: currentAttrs.repair,
  };

  unitGroup = buildUnitModel(attrs);
  scene.add(unitGroup);
  updateUI();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function updateUI(): void {
  const total = Object.values(currentAttrs).reduce((s, v) => s + v, 0);
  document.getElementById('points-total')!.textContent = String(total);

  const chassisName: Record<ChassisType, string> = { wheeled: 'Tank', limbed: 'Spider', flight: 'Drone' };
  const parts: string[] = [];
  parts.push(`Mov${currentAttrs.movement}`);
  parts.push(`HP${currentAttrs.health * 10}`);
  if (currentAttrs.kinetic) parts.push(`Kin${currentAttrs.kinetic}`);
  if (currentAttrs.rangeAttack) parts.push(`Rng${currentAttrs.rangeAttack}`);
  if (currentAttrs.splashAttack) parts.push(`Spl${currentAttrs.splashAttack}`);
  if (currentAttrs.antiAir) parts.push(`AA${currentAttrs.antiAir}`);
  if (currentAttrs.armour) parts.push(`Arm${currentAttrs.armour}`);
  if (currentAttrs.defence) parts.push(`Def${currentAttrs.defence}`);
  if (currentAttrs.repair) parts.push(`Rep${currentAttrs.repair}`);
  document.getElementById('unit-name')!.textContent = `${chassisName[currentChassis]}: ${parts.join(' / ')}`;

  updateMovementComparison();
  updateChassisTraits();
}

function updateMovementComparison(): void {
  const el = document.getElementById('movement-comparison-content');
  if (!el) return;

  const mp = currentAttrs.movement;
  const colIndex: Record<ChassisType, number> = { wheeled: 0, limbed: 1, flight: 2 };
  const active = colIndex[currentChassis];

  // Compute "max hexes + can attack?" for each chassis at current MP
  // Tank: first hex=1, subsequent=2 (clear). hexes = 1 + floor((mp-1)/2), attack if remainder>=1
  const tankClearHexes = 1 + Math.floor((mp - 1) / 2);
  const tankCanAttack = (mp - 1 - Math.floor((mp - 1) / 2) * 2) >= 1;
  // Spider: first hex=1, subsequent=3. hexes = 1 + floor((mp-1)/3), attack if remainder>=1
  const spiderHexes = 1 + Math.floor((mp - 1) / 3);
  const spiderCanAttack = (mp - 1 - Math.floor((mp - 1) / 3) * 3) >= 1;
  // Drone: every hex=1. hexes = mp, or (mp-1) + attack
  const droneHexes = mp;
  const droneHexesWithAttack = mp - 1;

  type Cell = { text: string; cls?: string };
  type Row = { label: string; cells: [Cell, Cell, Cell] };

  const rows: Row[] = [
    {
      label: 'First hex',
      cells: [{ text: '1 MP' }, { text: '1 MP' }, { text: '1 MP' }],
    },
    {
      label: 'Clear / flat',
      cells: [{ text: '2 MP' }, { text: '3 MP', cls: 'warn' }, { text: '1 MP', cls: 'good' }],
    },
    {
      label: 'Hill or forest',
      cells: [{ text: '3 MP', cls: 'warn' }, { text: '3 MP', cls: 'warn' }, { text: '1 MP', cls: 'good' }],
    },
    {
      label: 'Hill + forest',
      cells: [{ text: '4 MP', cls: 'bad' }, { text: '3 MP', cls: 'warn' }, { text: '1 MP', cls: 'good' }],
    },
    {
      label: 'Mountain/ocean',
      cells: [
        { text: 'blocked', cls: 'bad' },
        { text: 'blocked', cls: 'bad' },
        { text: 'passable', cls: 'good' },
      ],
    },
    {
      label: `With ${mp} MP (clear)`,
      cells: [
        { text: `${tankClearHexes}hex${tankClearHexes !== 1 ? 'es' : ''}${tankCanAttack ? '+atk' : ''}`, cls: tankCanAttack ? 'good' : 'warn' },
        { text: `${spiderHexes}hex${spiderHexes !== 1 ? 'es' : ''}${spiderCanAttack ? '+atk' : ''}`, cls: spiderCanAttack ? 'good' : 'warn' },
        { text: `${droneHexes}hex${droneHexes !== 1 ? 'es' : ''} or ${droneHexesWithAttack}+atk`, cls: 'good' },
      ],
    },
  ];

  const headerRow = `
    <tr>
      <th></th>
      <th${active === 0 ? ' style="color:#fff"' : ''}>🛞 Tank</th>
      <th${active === 1 ? ' style="color:#fff"' : ''}>🕷️ Spider</th>
      <th${active === 2 ? ' style="color:#fff"' : ''}>🚁 Drone</th>
    </tr>`;

  const bodyRows = rows.map(row => {
    const cells = row.cells.map((cell, i) => {
      const isActive = i === active;
      const cls = cell.cls ? ` class="${cell.cls}"` : '';
      return `<td${isActive ? ` style="font-weight:bold;color:${cell.cls === 'good' ? '#7fdbca' : cell.cls === 'bad' ? '#ff6b6b' : cell.cls === 'warn' ? '#f7b731' : '#fff'}"` : cls}>${cell.text}</td>`;
    }).join('');
    return `<tr><td>${row.label}</td>${cells}</tr>`;
  }).join('');

  el.innerHTML = `
    <table>
      <thead>${headerRow}</thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <p class="section-note">Last row updates with the Movement slider. Attacking costs 1 MP.</p>
  `;
}

function updateChassisTraits(): void {
  const el = document.getElementById('chassis-traits-content');
  if (!el) return;

  // Row data: [label, tank value/class, spider value/class, drone value/class]
  type Cell = { text: string; cls?: string };
  type Row = { label: string; cells: [Cell, Cell, Cell] };

  const rows: Row[] = [
    {
      label: 'Attack modifier',
      cells: [
        { text: '1.00×', cls: 'good' },
        { text: '0.75×', cls: 'warn' },
        { text: '0.50×', cls: 'bad' },
      ],
    },
    {
      label: 'Hit by Direct Fire',
      cells: [
        { text: '1.00×' },
        { text: '1.00×' },
        { text: '0.33×', cls: 'good' },
      ],
    },
    {
      label: 'Hit by Splash Fire',
      cells: [
        { text: '1.00×' },
        { text: '1.00×' },
        { text: '0.50×', cls: 'good' },
      ],
    },
    {
      label: 'Hit by Anti-Air',
      cells: [
        { text: 'immune', cls: 'good' },
        { text: 'immune', cls: 'good' },
        { text: '1.00×', cls: 'bad' },
      ],
    },
    {
      label: 'AA Reaction Fire',
      cells: [
        { text: 'never', cls: 'good' },
        { text: 'never', cls: 'good' },
        { text: 'triggers', cls: 'bad' },
      ],
    },
    {
      label: 'Terrain defence',
      cells: [
        { text: 'full' },
        { text: 'full' },
        { text: 'none', cls: 'bad' },
      ],
    },
    {
      label: 'Mountain / Ocean',
      cells: [
        { text: 'blocked', cls: 'bad' },
        { text: 'blocked', cls: 'bad' },
        { text: 'passable', cls: 'good' },
      ],
    },
  ];

  const colIndex: Record<ChassisType, number> = { wheeled: 0, limbed: 1, flight: 2 };
  const active = colIndex[currentChassis];

  const headerRow = `
    <tr>
      <th></th>
      <th${active === 0 ? ' style="color:#fff"' : ''}>🛞 Tank</th>
      <th${active === 1 ? ' style="color:#fff"' : ''}>🕷️ Spider</th>
      <th${active === 2 ? ' style="color:#fff"' : ''}>🚁 Drone</th>
    </tr>`;

  const bodyRows = rows.map(row => {
    const highlightedCells = row.cells.map((cell, i) => {
      const isActive = i === active;
      const cls = cell.cls ? ` class="${cell.cls}"` : '';
      return `<td${isActive ? ` style="font-weight:bold;color:${cell.cls === 'good' ? '#7fdbca' : cell.cls === 'bad' ? '#ff6b6b' : cell.cls === 'warn' ? '#f7b731' : '#fff'}"` : cls}>${cell.text}</td>`;
    }).join('');
    return `<tr><td>${row.label}</td>${highlightedCells}</tr>`;
  }).join('');

  el.innerHTML = `
    <table>
      <thead>${headerRow}</thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <p class="section-note">Bold column = currently selected chassis. Modifiers apply to all weapon modes.</p>
  `;
}

// Chassis buttons
const chassisBtns = document.querySelectorAll<HTMLElement>('.chassis-btn');
chassisBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    chassisBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChassis = btn.dataset.chassis as ChassisType;
    enforceChassisConstraints();
    rebuildUnit();
  });
});

/** Enforce attribute constraints based on chassis type. */
function enforceChassisConstraints(): void {
  const armourSlider = document.querySelector<HTMLInputElement>('input[data-attr="armour"]');
  if (!armourSlider) return;

  // Armour is now allowed for all chassis types (including drones)
  armourSlider.disabled = false;
  armourSlider.title = '';
}

// Attribute sliders
const sliders = document.querySelectorAll<HTMLInputElement>('input[data-attr]');
sliders.forEach(slider => {
  slider.addEventListener('input', () => {
    const attr = slider.dataset.attr as keyof typeof currentAttrs;
    const val = parseInt(slider.value);
    currentAttrs[attr] = val;
    (slider.nextElementSibling as HTMLElement).textContent = String(val);



    rebuildUnit();
  });
});

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

function onResize(): void {
  const container = document.getElementById('viewport')!;
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

initMaterials();
rebuildUnit();
animate();
