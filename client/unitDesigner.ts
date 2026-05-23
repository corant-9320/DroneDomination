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
  armour: 0,
  defence: 0,
  repair: 0,
  movement: 3,
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
  if (currentAttrs.attack) parts.push(`Att${currentAttrs.attack}`);
  if (currentAttrs.rangeAttack) parts.push(`Rng${currentAttrs.rangeAttack}`);
  if (currentAttrs.splashAttack) parts.push(`Spl${currentAttrs.splashAttack}`);
  if (currentAttrs.armour) parts.push(`Arm${currentAttrs.armour}`);
  if (currentAttrs.defence) parts.push(`Def${currentAttrs.defence}`);
  if (currentAttrs.repair) parts.push(`Rep${currentAttrs.repair}`);
  document.getElementById('unit-name')!.textContent = `${chassisName[currentChassis]}: ${parts.join(' / ')}`;
}

// Chassis buttons
const chassisBtns = document.querySelectorAll<HTMLElement>('.chassis-btn');
chassisBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    chassisBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChassis = btn.dataset.chassis as ChassisType;
    rebuildUnit();
  });
});

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
