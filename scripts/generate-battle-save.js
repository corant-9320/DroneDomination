/**
 * generate-battle-save.js
 *
 * Generates a structured battle scenario with two armies facing each other.
 *
 * Army composition (per side, 36 units total):
 *   - 10 chassis types × 1 EW specialist (defence)
 *   - 10 chassis types × 1 Repair specialist (repair)
 *   - 16 remaining units with 480 points randomly distributed
 *
 * Chassis types (10 per side):
 *   - 4 Tanks  (wheeledMovement) — placed on flat/rolling terrain
 *   - 3 Spiders (limbMovement)   — placed on hills/mountains/forests
 *   - 3 Drones  (flightMovement) — placed at the outer edge of each army
 *
 * Formation: 4 hexes wide × 2 deep (8 tiles per army).
 * Gap: 2 BFS layers between the armies.
 * Camera centres on the gap tile.
 *
 * Usage: node scripts/generate-battle-save.js
 * Output: data/battle-30v30.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '../data/world.json');
const outPath   = join(__dirname, '../data/battle-30v30.json');

// ---------------------------------------------------------------------------
// Load world
// ---------------------------------------------------------------------------
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const tiles = world.tiles;

const tileByIndex = new Map();
for (const t of tiles) tileByIndex.set(t.idx, t);

// ---------------------------------------------------------------------------
// Faction IDs
// ---------------------------------------------------------------------------
const PLAYER_CITY_ID = 'city_0';
const ENEMY_CITY_ID  = 'city_6';

// ---------------------------------------------------------------------------
// Terrain helpers
// ---------------------------------------------------------------------------
const LAND_TERRAINS = new Set(['grassland', 'plains', 'tundra', 'desert']);

function isLand(tileIdx) {
  const t = tileByIndex.get(tileIdx);
  return t && LAND_TERRAINS.has(t.terrain);
}

function getTerrain(tileIdx) {
  return tileByIndex.get(tileIdx)?.terrain ?? 'ocean';
}

function getElevType(tileIdx) {
  return tileByIndex.get(tileIdx)?.elevType ?? 'flat';
}

function isForested(tileIdx) {
  return tileByIndex.get(tileIdx)?.f === true;
}

/** True if a tile is good for tanks (flat or rolling, not forested). */
function isTankFriendly(tileIdx) {
  const elev = getElevType(tileIdx);
  return (elev === 'flat' || elev === 'rolling') && !isForested(tileIdx);
}

/** True if a tile is good for spiders (hills, mountains, or forested). */
function isSpiderFriendly(tileIdx) {
  const elev = getElevType(tileIdx);
  return elev === 'hills' || elev === 'mountain' || isForested(tileIdx);
}

// ---------------------------------------------------------------------------
// BFS helpers
// ---------------------------------------------------------------------------
function bfsLayers(seedIdx, maxLayers) {
  const visited = new Set([seedIdx]);
  let frontier = [seedIdx];
  const layers = [[seedIdx]];

  for (let d = 1; d < maxLayers; d++) {
    const next = [];
    for (const cur of frontier) {
      const t = tileByIndex.get(cur);
      if (!t) continue;
      for (const nb of t.n) {
        if (!visited.has(nb) && isLand(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    if (next.length === 0) break;
    layers.push(next);
    frontier = next;
  }
  return layers;
}

function findGoodSeed(startIdx, endIdx) {
  for (let i = startIdx; i <= endIdx; i++) {
    const t = tileByIndex.get(i);
    if (!t || !isLand(t.idx)) continue;
    const landNeighbours = t.n.filter(isLand);
    if (landNeighbours.length >= 5) return t.idx;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Find a land cluster with enough variety for terrain-based placement
// ---------------------------------------------------------------------------
// We need 8 tiles per army (4 wide × 2 deep) with a mix of terrain types.
// Try multiple seeds until we find one with enough tiles.

function tryBuildBattleField(seedIdx) {
  const layers = bfsLayers(seedIdx, 16);
  if (layers.length < 8) return null;

  // Layout:
  //   layers 0-1 → player front row (4 tiles)
  //   layers 2-3 → player back row  (4 tiles)
  //   layers 4-5 → gap (no units, camera centres here)
  //   layers 6-7 → enemy front row  (4 tiles)
  //   layers 8-9 → enemy back row   (4 tiles)

  function pickTiles(layerArr, count) {
    const seen = new Set();
    const result = [];
    for (const layer of layerArr) {
      for (const idx of layer) {
        if (!seen.has(idx)) {
          seen.add(idx);
          result.push(idx);
          if (result.length >= count) return result;
        }
      }
    }
    return result;
  }

  const playerFront = pickTiles([layers[0], layers[1]], 4);
  const playerBack  = pickTiles([layers[2], layers[3]], 4);
  const gapTiles    = pickTiles([layers[4], layers[5]], 4);
  const enemyFront  = pickTiles([layers[6], layers[7]], 4);
  const enemyBack   = pickTiles([layers[8], layers[9]], 4);

  if (playerFront.length < 4 || playerBack.length < 4 ||
      enemyFront.length < 4  || enemyBack.length < 4) {
    return null;
  }

  return { playerFront, playerBack, gapTiles, enemyFront, enemyBack, layers };
}

let seedIdx = findGoodSeed(1200, 2000);
if (!seedIdx) seedIdx = findGoodSeed(0, tiles.length - 1);
console.log(`Seed tile: ${seedIdx}`);

let battlefield = tryBuildBattleField(seedIdx);
if (!battlefield) {
  // Try a few more seeds
  for (let s = seedIdx + 100; s < tiles.length && !battlefield; s += 100) {
    if (isLand(s)) battlefield = tryBuildBattleField(s);
  }
}
if (!battlefield) {
  console.error('Could not find a suitable battlefield cluster.');
  process.exit(1);
}

const { playerFront, playerBack, gapTiles, enemyFront, enemyBack, layers } = battlefield;

// Camera centre tile = middle of the gap
const centreTile = gapTiles[Math.floor(gapTiles.length / 2)];

console.log('Player front:', playerFront);
console.log('Player back: ', playerBack);
console.log('Gap tiles:   ', gapTiles, '→ centre:', centreTile);
console.log('Enemy front: ', enemyFront);
console.log('Enemy back:  ', enemyBack);

// ---------------------------------------------------------------------------
// BFS distance map (for facing direction)
// ---------------------------------------------------------------------------
const bfsDistMap = new Map();
{
  const visited = new Set([seedIdx]);
  const queue = [[seedIdx, 0]];
  let head = 0;
  while (head < queue.length) {
    const [cur, dist] = queue[head++];
    bfsDistMap.set(cur, dist);
    const t = tileByIndex.get(cur);
    if (!t) continue;
    for (const nb of t.n) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([nb, dist + 1]);
      }
    }
  }
}

function facingToward(tileIdx, wantHigher) {
  const t = tileByIndex.get(tileIdx);
  if (!t) return 0;
  const myDist = bfsDistMap.get(tileIdx) ?? 0;
  let bestSeg = 0;
  let bestDelta = -Infinity;
  for (let seg = 0; seg < t.n.length; seg++) {
    const nbIdx = t.n[seg];
    const nbDist = bfsDistMap.get(nbIdx) ?? myDist;
    const delta = wantHigher ? (nbDist - myDist) : (myDist - nbDist);
    if (delta > bestDelta) {
      bestDelta = delta;
      bestSeg = seg;
    }
  }
  return bestSeg;
}

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const rand = rng(42);
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function randChoice(arr)   { return arr[Math.floor(rand() * arr.length)]; }

// ---------------------------------------------------------------------------
// Unit naming (mirrors TypeScript logic in src/world/units.ts)
// ---------------------------------------------------------------------------
const SPEED_NAMES = { 1: 'Loitering', 2: 'Plodder', 3: 'Walker', 4: 'Runner', 5: 'Sprinter' };
const TYPE_NAMES  = { wheeledMovement: 'Tank', flightMovement: 'Drone', limbMovement: 'Spider' };
const ATTR_NAMES  = {
  kinetic:      { 1: 'Harasser',     2: 'Raider',       3: 'Striker',     4: 'Breaker',    5: 'Executioner' },
  armour:       { 1: 'Flyweight',    2: 'Bantamweight',  3: 'Welterweight',4: 'Middleweight',5: 'Heavyweight' },
  defence:      { 1: 'Listener',     2: 'Scrambler',     3: 'Jammer',      4: 'Disruptor',  5: 'Nullifier' },
  splashAttack: { 1: 'Popper',       2: 'Blaster',       3: 'Bombardier',  4: 'Demolisher', 5: 'Devastator' },
  rangeAttack:  { 1: 'Melee',        2: 'Short',         3: 'Medium',      4: 'Long',       5: 'Distance' },
  repair:       { 1: 'Tinkerer',     2: 'Mechanic',      3: 'Engineer',    4: 'Restorer',   5: 'Fabricator' },
  antiAir:      { 1: 'Spotter',      2: 'Tracker',       3: 'Interceptor', 4: 'Skyhunter',  5: 'Annihilator' },
};
const NAMING_ATTRS = ['kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair', 'antiAir'];
const MOV_ATTRS    = ['wheeledMovement', 'limbMovement', 'flightMovement'];

function generateUnitName(attrs) {
  const movKey    = MOV_ATTRS.find((k) => (attrs[k] ?? 0) >= 1) ?? 'wheeledMovement';
  const speed     = attrs[movKey] ?? 1;
  const speedWord = SPEED_NAMES[Math.min(Math.max(speed, 1), 5)];
  const typeWord  = TYPE_NAMES[movKey];

  const ranked = NAMING_ATTRS
    .map((key) => ({ key, value: attrs[key] ?? 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const parts = [];
  if (ranked[0]) parts.push(ATTR_NAMES[ranked[0].key][Math.min(Math.max(ranked[0].value, 1), 5)]);
  if (ranked[1]) parts.push(ATTR_NAMES[ranked[1].key][Math.min(Math.max(ranked[1].value, 1), 5)]);
  parts.push(speedWord, typeWord);

  const mov = attrs[movKey] ?? 0;
  const att = attrs.kinetic ?? 0;
  const rng = attrs.rangeAttack ?? 0;
  const spl = attrs.splashAttack ?? 0;
  const aa  = attrs.antiAir ?? 0;
  const arm = attrs.armour ?? 0;
  const ew  = attrs.defence ?? 0;
  const rep = attrs.repair ?? 0;

  return `${parts.join(' ')} (Mov ${mov}, Kin ${att}, Rng ${rng}, Spl ${spl}, AA ${aa}, Arm ${arm}, EW ${ew}, Rep ${rep})`;
}

// ---------------------------------------------------------------------------
// Army composition builder
// ---------------------------------------------------------------------------
// 10 chassis: 4 Tanks, 3 Spiders, 3 Drones
// Per chassis: 1 EW specialist + 1 Repair specialist = 20 fixed units
// Remaining 16 units: 480 points randomly distributed
//
// Point budget per random unit: 480 / 16 = 30 points average
// Each attribute point costs 1 point. maxHealth costs 1 point per point.
// Movement costs 1 point per point.
// We distribute 480 points across 16 units, each unit gets a random share.

const CHASSIS_TYPES = [
  ...Array(4).fill('wheeledMovement'),  // 4 Tanks
  ...Array(3).fill('limbMovement'),     // 3 Spiders
  ...Array(3).fill('flightMovement'),   // 3 Drones
];

const COMBAT_ATTRS = ['kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'antiAir'];
// Note: 'repair' and 'defence' are reserved for specialists; random units can still get them
// but they won't be the primary focus.

/**
 * Build a fixed EW specialist for a given chassis.
 * High defence (EW), moderate health, some movement.
 */
function makeEWSpecialist(movAttr) {
  const movVal = randInt(2, 4);
  const ewVal  = randInt(3, 5);
  const hpVal  = randInt(2, 4);
  const attrs  = {
    maxHealth: hpVal,
    [movAttr]: movVal,
    defence: ewVal,
  };
  // Drones can't have armour
  if (movAttr !== 'flightMovement') {
    attrs.armour = randInt(1, 2);
  }
  return attrs;
}

/**
 * Build a fixed Repair specialist for a given chassis.
 * High repair, moderate health, some movement.
 */
function makeRepairSpecialist(movAttr) {
  const movVal    = randInt(2, 4);
  const repairVal = randInt(3, 5);
  const hpVal     = randInt(2, 4);
  const attrs     = {
    maxHealth: hpVal,
    [movAttr]: movVal,
    repair: repairVal,
  };
  if (movAttr !== 'flightMovement') {
    attrs.armour = randInt(1, 2);
  }
  return attrs;
}

/**
 * Distribute `totalPoints` across `count` units, each getting a random share.
 * Returns an array of point budgets.
 */
function distributePoints(totalPoints, count) {
  // Use a "broken stick" approach: generate count-1 random cut points
  const cuts = [];
  for (let i = 0; i < count - 1; i++) {
    cuts.push(Math.floor(rand() * (totalPoints - count * 2)) + 1);
  }
  cuts.sort((a, b) => a - b);

  const budgets = [];
  let prev = 0;
  for (const cut of cuts) {
    budgets.push(Math.max(2, cut - prev));
    prev = cut;
  }
  budgets.push(Math.max(2, totalPoints - prev));

  // Clamp each budget to a reasonable range [5, 50]
  return budgets.map((b) => Math.min(50, Math.max(5, b)));
}

/**
 * Build a random unit from a point budget.
 * Allocates points across attributes randomly.
 */
function makeRandomUnit(movAttr, pointBudget) {
  const attrs = { [movAttr]: 0 };

  // Spend points: first ensure minimum movement (1 pt) and health (1 pt)
  let remaining = pointBudget;

  // Movement: 1–4 points
  const movPts = Math.min(4, Math.max(1, randInt(1, Math.min(4, Math.floor(remaining * 0.3)))));
  attrs[movAttr] = movPts;
  remaining -= movPts;

  // Health: 1–4 points
  const hpPts = Math.min(4, Math.max(1, randInt(1, Math.min(4, Math.floor(remaining * 0.25)))));
  attrs.maxHealth = hpPts;
  remaining -= hpPts;

  // Distribute remaining points across combat attributes
  const availableAttrs = [...COMBAT_ATTRS];
  // Drones can't have armour
  if (movAttr === 'flightMovement') {
    const armIdx = availableAttrs.indexOf('armour');
    if (armIdx >= 0) availableAttrs.splice(armIdx, 1);
  }

  // Shuffle and pick 2–4 attributes to invest in
  const shuffled = [...availableAttrs].sort(() => rand() - 0.5);
  const numAttrs = Math.min(shuffled.length, randInt(2, 4));
  const chosen   = shuffled.slice(0, numAttrs);

  while (remaining > 0 && chosen.length > 0) {
    const key = randChoice(chosen);
    const current = attrs[key] ?? 0;
    if (current < 4) {
      attrs[key] = current + 1;
      remaining--;
    } else {
      // This attr is maxed, remove it from choices
      chosen.splice(chosen.indexOf(key), 1);
    }
  }

  // Ensure maxHealth is set
  if (!attrs.maxHealth) attrs.maxHealth = 1;

  return attrs;
}

// ---------------------------------------------------------------------------
// Build the full army (36 units)
// ---------------------------------------------------------------------------
function buildArmy() {
  const units = [];

  // 10 EW specialists (one per chassis)
  for (const movAttr of CHASSIS_TYPES) {
    units.push({ type: 'ew', movAttr, attrs: makeEWSpecialist(movAttr) });
  }

  // 10 Repair specialists (one per chassis)
  for (const movAttr of CHASSIS_TYPES) {
    units.push({ type: 'repair', movAttr, attrs: makeRepairSpecialist(movAttr) });
  }

  // 16 random units with 480 points total
  const budgets = distributePoints(480, 16);
  // Assign chassis types to random units: cycle through CHASSIS_TYPES
  for (let i = 0; i < 16; i++) {
    const movAttr = CHASSIS_TYPES[i % CHASSIS_TYPES.length];
    units.push({ type: 'random', movAttr, attrs: makeRandomUnit(movAttr, budgets[i]) });
  }

  return units;
}

// ---------------------------------------------------------------------------
// Tile assignment with terrain preference
// ---------------------------------------------------------------------------
// Formation: 8 tiles (4 wide × 2 deep)
// Front row = closer to enemy, back row = further from enemy
// Drones go to the outer edge (first/last tiles in each row)
// Tanks prefer flat/rolling, Spiders prefer hills/mountains/forests

/**
 * Sort tiles into terrain categories.
 * Returns { tankTiles, spiderTiles, droneTiles, anyTiles }
 * where droneTiles = outer edge tiles (first and last in each row).
 */
function categorizeTiles(frontTiles, backTiles) {
  // Outer edge = first and last of each row
  const outerEdge = new Set([
    frontTiles[0], frontTiles[frontTiles.length - 1],
    backTiles[0],  backTiles[backTiles.length - 1],
  ]);

  const tankTiles   = [];
  const spiderTiles = [];
  const droneTiles  = [...outerEdge];
  const anyTiles    = [];

  for (const tileIdx of [...frontTiles, ...backTiles]) {
    if (outerEdge.has(tileIdx)) continue; // reserved for drones
    if (isTankFriendly(tileIdx)) {
      tankTiles.push(tileIdx);
    } else if (isSpiderFriendly(tileIdx)) {
      spiderTiles.push(tileIdx);
    } else {
      anyTiles.push(tileIdx);
    }
  }

  return { tankTiles, spiderTiles, droneTiles, anyTiles };
}

// ---------------------------------------------------------------------------
// Place units onto tiles
// ---------------------------------------------------------------------------
// Each tile can hold up to 5 units (segments 0–4).
// We fill tiles sequentially, 5 units per tile.

const HP_PER_PT = 10;
const units = [];
let unitId = 0;

function placeArmy(armyUnits, frontTiles, backTiles, ownerId, facingDir) {
  const { tankTiles, spiderTiles, droneTiles, anyTiles } = categorizeTiles(frontTiles, backTiles);

  // Build a tile queue for each chassis type
  // Tanks → tankTiles first, then anyTiles, then spiderTiles
  // Spiders → spiderTiles first, then anyTiles, then tankTiles
  // Drones → droneTiles first, then anyTiles, then anywhere
  const allTiles = [...frontTiles, ...backTiles];

  function buildQueue(preferred, fallback1, fallback2) {
    const seen = new Set();
    const q = [];
    for (const t of [...preferred, ...fallback1, ...fallback2, ...allTiles]) {
      if (!seen.has(t)) { seen.add(t); q.push(t); }
    }
    return q;
  }

  const tankQueue   = buildQueue(tankTiles,   anyTiles, spiderTiles);
  const spiderQueue = buildQueue(spiderTiles, anyTiles, tankTiles);
  const droneQueue  = buildQueue(droneTiles,  anyTiles, tankTiles);

  // Track how many units are on each tile (max 5 per tile)
  const tileOccupancy = new Map();
  for (const t of allTiles) tileOccupancy.set(t, 0);

  function getNextTile(queue) {
    for (const t of queue) {
      const occ = tileOccupancy.get(t) ?? 0;
      if (occ < 5) return t;
    }
    // Fallback: any tile with space
    for (const t of allTiles) {
      const occ = tileOccupancy.get(t) ?? 0;
      if (occ < 5) return t;
    }
    return null;
  }

  for (const unitDef of armyUnits) {
    let queue;
    if (unitDef.movAttr === 'wheeledMovement') queue = tankQueue;
    else if (unitDef.movAttr === 'limbMovement') queue = spiderQueue;
    else queue = droneQueue;

    const tileIdx = getNextTile(queue);
    if (tileIdx === null) {
      console.warn(`No tile available for unit ${unitId}`);
      continue;
    }

    const occ     = tileOccupancy.get(tileIdx);
    const segment = occ; // segments 0–4
    tileOccupancy.set(tileIdx, occ + 1);

    const attrs     = unitDef.attrs;
    const maxHealth = attrs.maxHealth ?? 1;

    units.push({
      id: `unit_${unitId++}`,
      label: generateUnitName(attrs),
      ownerId,
      tileIndex: tileIdx,
      segment,
      facing: facingDir,
      attributes: attrs,
      currentHealth: maxHealth * HP_PER_PT,
    });
  }
}

// Build armies
const playerArmy = buildArmy();
const enemyArmy  = buildArmy();

// Facing: player faces toward enemy (higher BFS dist), enemy faces toward player (lower BFS dist)
const playerFacing = facingToward(playerFront[0], true);
const enemyFacing  = facingToward(enemyFront[0],  false);

console.log(`Player facing: ${playerFacing}, Enemy facing: ${enemyFacing}`);

placeArmy(playerArmy, playerFront, playerBack, PLAYER_CITY_ID, playerFacing);
placeArmy(enemyArmy,  enemyFront,  enemyBack,  ENEMY_CITY_ID,  enemyFacing);

console.log(`Generated ${units.length} units total (${units.length / 2} per side)`);

// ---------------------------------------------------------------------------
// Build the save payload
// ---------------------------------------------------------------------------
const save = {
  seed: world.seed,
  tileCount: world.tileCount,
  pentagonCount: world.pentagonCount,
  hexCount: world.hexCount,
  pentagonIndices: world.pentagonIndices,
  cities: world.cities.map((c) => ({
    ...c,
    isPlayerHome: c.id === PLAYER_CITY_ID,
  })),
  tiles: world.tiles,
  units,
  playerColor: '#00e5ff',
  /** Tile index to centre the camera on at startup (gap between armies). */
  battleCentreTile: centreTile,
};

writeFileSync(outPath, JSON.stringify(save, null, 2));

console.log(`\nSaved to ${outPath}`);
console.log(`  Player (${PLAYER_CITY_ID}): ${playerArmy.length} units`);
console.log(`    Front tiles: ${playerFront.join(', ')}`);
console.log(`    Back tiles:  ${playerBack.join(', ')}`);
console.log(`  Enemy  (${ENEMY_CITY_ID}):  ${enemyArmy.length} units`);
console.log(`    Front tiles: ${enemyFront.join(', ')}`);
console.log(`    Back tiles:  ${enemyBack.join(', ')}`);
console.log(`  Camera centre tile: ${centreTile}`);

// Print terrain summary
const allArmyTiles = [...playerFront, ...playerBack, ...enemyFront, ...enemyBack];
console.log('\nTerrain summary:');
for (const t of allArmyTiles) {
  const tile = tileByIndex.get(t);
  const forested = tile?.f ? ' (forested)' : '';
  console.log(`  Tile ${t}: ${tile?.terrain} / ${tile?.elevType}${forested}`);
}
