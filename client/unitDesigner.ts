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
  attack: 0,
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
    attack: currentAttrs.attack,
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
  if (currentAttrs.attack) parts.push(`Att${currentAttrs.attack}`);
  if (currentAttrs.rangeAttack) parts.push(`Rng${currentAttrs.rangeAttack}`);
  if (currentAttrs.splashAttack) parts.push(`Spl${currentAttrs.splashAttack}`);
  if (currentAttrs.antiAir) parts.push(`AA${currentAttrs.antiAir}`);
  if (currentAttrs.armour) parts.push(`Arm${currentAttrs.armour}`);
  if (currentAttrs.defence) parts.push(`Def${currentAttrs.defence}`);
  if (currentAttrs.repair) parts.push(`Rep${currentAttrs.repair}`);
  document.getElementById('unit-name')!.textContent = `${chassisName[currentChassis]}: ${parts.join(' / ')}`;

  updateMovementHelp();
}

function updateMovementHelp(): void {
  const el = document.getElementById('movement-help-text');
  if (!el) return;

  const mp = currentAttrs.movement;

  const helpByType: Record<ChassisType, string> = {
    wheeled: buildWheeledHelp(mp),
    limbed: buildLimbedHelp(mp),
    flight: buildFlightHelp(mp),
  };

  el.innerHTML = helpByType[currentChassis];
}

function buildWheeledHelp(mp: number): string {
  const clearHexes = Math.floor((mp - 1) / 2);
  const canAttackAfterClear = (mp - 1 - clearHexes * 2) >= 1;

  return `
    <p>Tanks are fastest on open ground but slow through rough terrain.</p>
    <table class="cost-table">
      <tr><th>Terrain</th><th>Cost</th></tr>
      <tr><td>First hex (always)</td><td>1 MP</td></tr>
      <tr><td>Clear / Flat</td><td>2 MP</td></tr>
      <tr><td>Hill OR Forest</td><td>3 MP</td></tr>
      <tr><td>Hill AND Forest</td><td>4 MP</td></tr>
    </table>
    <p>With <b>${mp} MP</b> on clear ground: move ${1 + clearHexes} hex${clearHexes !== 0 ? 'es' : ''}${canAttackAfterClear ? ' + attack' : ', no attack'}.</p>
    <p class="impassable">⛔ Cannot enter Mountain or Ocean tiles.</p>
    <p class="note">Attacking costs 1 MP. Units can move then attack in one turn.</p>
  `;
}

function buildLimbedHelp(mp: number): string {
  const hexes = Math.floor((mp - 1) / 3);
  const canAttack = (mp - 1 - hexes * 3) >= 1;

  return `
    <p>Spiders ignore terrain difficulty — all non-first hexes cost the same.</p>
    <table class="cost-table">
      <tr><th>Terrain</th><th>Cost</th></tr>
      <tr><td>First hex (always)</td><td>1 MP</td></tr>
      <tr><td>Any traversable hex</td><td>3 MP</td></tr>
    </table>
    <p>With <b>${mp} MP</b>: move ${1 + hexes} hex${hexes !== 0 ? 'es' : ''}${canAttack ? ' + attack' : ', no attack'}.</p>
    <p class="impassable">⛔ Cannot enter Mountain or Ocean tiles.</p>
    <p class="note">Attacking costs 1 MP. Units can move then attack in one turn.</p>
  `;
}

function buildFlightHelp(mp: number): string {
  // First hex: 1 MP, subsequent hexes: 1 MP each
  const hexes = mp; // 1 + (mp - 1) * 1 = mp hexes total
  const canAttack = (mp - hexes) >= 1; // No leftover after moving max
  const hexesWithAttack = mp - 1; // Leave 1 MP for attack

  return `
    <p>Drones fly over all terrain at minimal cost — including mountains and oceans.</p>
    <table class="cost-table">
      <tr><th>Terrain</th><th>Cost</th></tr>
      <tr><td>First hex (always)</td><td>1 MP</td></tr>
      <tr><td>Any hex (including mountain/ocean)</td><td>1 MP</td></tr>
    </table>
    <p>With <b>${mp} MP</b>: move ${hexes} hexes, or ${hexesWithAttack} hex${hexesWithAttack !== 1 ? 'es' : ''} + attack.</p>
    <p class="note">Attacking costs 1 MP. Units can move then attack in one turn.</p>
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
