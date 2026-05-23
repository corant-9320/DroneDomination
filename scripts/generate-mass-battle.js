/**
 * Generate a mass-battle save file from the existing world.json.
 * Places 100 player units and 100 enemy units with random attributes,
 * separated by exactly 2 hexes.
 *
 * Each army occupies 20 tiles (5 units per tile, the max allowed).
 * The two armies are placed 2 tile-hops apart.
 *
 * Run: node scripts/generate-mass-battle.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = resolve(__dirname, '..', 'data', 'world.json');
const outPath = resolve(__dirname, '..', 'data', 'mass-battle.json');

const world = JSON.parse(readFileSync(worldPath, 'utf-8'));

// --- Seeded RNG (simple mulberry32) ---
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(7777);

function randInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// --- BFS helper: collect N non-ocean tiles from a start tile ---
function collectTiles(startIndex, count, excludeSet) {
  const collected = [];
  const visited = new Set(excludeSet);
  const queue = [startIndex];
  visited.add(startIndex);

  while (queue.length > 0 && collected.length < count) {
    const idx = queue.shift();
    const tile = world.tiles[idx];
    // Skip ocean tiles
    if (tile.terrain === 'ocean') {
      for (const n of tile.n) {
        if (!visited.has(n)) { visited.add(n); queue.push(n); }
      }
      continue;
    }
    collected.push(idx);
    for (const n of tile.n) {
      if (!visited.has(n)) { visited.add(n); queue.push(n); }
    }
  }
  return collected;
}

// --- Find the 2-hop boundary between armies ---
// Strategy: pick player tiles starting from tile 200 (inland),
// then find tiles 2 hops from player boundary for enemy.
const TILES_PER_SIDE = 20; // 20 tiles × 5 units = 100 units

const playerTiles = collectTiles(200, TILES_PER_SIDE, new Set());
const playerSet = new Set(playerTiles);

// Get tiles exactly 1 hop from player territory (the gap tiles)
const gap1 = new Set();
for (const ti of playerTiles) {
  for (const n of world.tiles[ti].n) {
    if (!playerSet.has(n)) gap1.add(n);
  }
}

// Get tiles exactly 2 hops from player territory
const gap2 = new Set();
for (const ti of gap1) {
  for (const n of world.tiles[ti].n) {
    if (!playerSet.has(n) && !gap1.has(n)) gap2.add(n);
  }
}

// Start enemy BFS from the gap2 frontier
const excludeForEnemy = new Set([...playerSet, ...gap1, ...gap2]);
// Pick a good starting point from gap2 neighbors
let enemyStart = null;
for (const ti of gap2) {
  for (const n of world.tiles[ti].n) {
    if (!excludeForEnemy.has(n) && world.tiles[n].terrain !== 'ocean') {
      enemyStart = n;
      break;
    }
  }
  if (enemyStart !== null) break;
}

if (enemyStart === null) {
  // Fallback: just start further along
  enemyStart = 400;
}

const enemyTiles = collectTiles(enemyStart, TILES_PER_SIDE, excludeForEnemy);

// --- Random unit generation ---
const MOVEMENT_TYPES = ['wheeledMovement', 'limbMovement', 'flightMovement'];
const LABELS_PLAYER = [
  'Assault Tank', 'Recon Drone', 'Heavy Walker', 'Sniper Bot', 'Shield Unit',
  'Artillery Mech', 'Repair Drone', 'Fast Raider', 'Gunship', 'Infantry Bot',
  'Siege Crawler', 'EW Jammer', 'Mortar Tank', 'Flame Walker', 'Scout Bike',
  'Rail Cannon', 'Medic Drone', 'Hover Tank', 'Rocket Pod', 'Stealth Unit',
];
const LABELS_ENEMY = [
  'Enemy Crusher', 'Enemy Stalker', 'Enemy Titan', 'Enemy Marksman', 'Enemy Barrier',
  'Enemy Howitzer', 'Enemy Mender', 'Enemy Interceptor', 'Enemy Bomber', 'Enemy Trooper',
  'Enemy Breaker', 'Enemy Disruptor', 'Enemy Lobber', 'Enemy Scorcher', 'Enemy Patrol',
  'Enemy Railgun', 'Enemy Healer', 'Enemy Skimmer', 'Enemy Barrage', 'Enemy Phantom',
];

function generateUnit(id, label, ownerId, tileIndex, segment) {
  // Pick exactly one movement type
  const moveType = pick(MOVEMENT_TYPES);
  const moveValue = randInt(1, 5);

  // Random other attributes
  const maxHealth = randInt(1, 5);
  const attrs = { maxHealth, [moveType]: moveValue };

  // Randomly add 2-4 additional attributes
  const otherAttrs = ['attack', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair'];
  const numExtra = randInt(2, 4);
  const shuffled = otherAttrs.sort(() => rng() - 0.5);
  for (let i = 0; i < numExtra; i++) {
    attrs[shuffled[i]] = randInt(1, 5);
  }

  return {
    id,
    label,
    ownerId,
    tileIndex,
    segment,
    facing: randInt(0, 5),
    attributes: attrs,
    currentHealth: maxHealth,
  };
}

// --- Place units ---
const units = [];
let playerIdx = 0;
for (const tileIndex of playerTiles) {
  for (let seg = 0; seg < 5; seg++) {
    const label = `${pick(LABELS_PLAYER)} #${playerIdx + 1}`;
    units.push(generateUnit(`mass_p${playerIdx}`, label, 'city_0', tileIndex, seg));
    playerIdx++;
  }
}

let enemyIdx = 0;
for (const tileIndex of enemyTiles) {
  for (let seg = 0; seg < 5; seg++) {
    const label = `${pick(LABELS_ENEMY)} #${enemyIdx + 1}`;
    units.push(generateUnit(`mass_e${enemyIdx}`, label, 'city_1', tileIndex, seg));
    enemyIdx++;
  }
}

// --- Write output ---
world.units = units;

// Mark city_0 as player home
const city0 = world.cities.find(c => c.id === 'city_0');
if (city0) city0.isPlayerHome = true;

writeFileSync(outPath, JSON.stringify(world));

console.log(`Mass battle save written to ${outPath}`);
console.log(`  Player units: ${playerIdx} across tiles [${playerTiles.join(', ')}]`);
console.log(`  Enemy units:  ${enemyIdx} across tiles [${enemyTiles.join(', ')}]`);
console.log(`  2-hex gap between armies`);
console.log(`  All units have random attributes with exactly one movement type`);
