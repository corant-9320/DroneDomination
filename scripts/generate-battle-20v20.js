/**
 * generate-battle-20v20.js
 *
 * Generates a 20v20 battle scenario with randomized unit attributes.
 *
 * Army composition (per side, 20 units total):
 *   - Each unit gets 27 points to randomly allocate across attributes
 *   - Movement types distributed: 8 Tanks, 6 Spiders, 6 Drones
 *   - Units spawn on terrain they are allowed on
 *
 * Formation: 5 hexes wide × 1 deep per side (5 tiles per army)
 * Gap: 2 BFS layers between the armies.
 *
 * Usage: node scripts/generate-battle-20v20.js
 * Output: data/battle-20v20.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '../data/world.json');
const outPath   = join(__dirname, '../data/battle-20v20.json');

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

/** Drones can spawn anywhere (they fly). */
function isDroneFriendly(tileIdx) {
  return isLand(tileIdx);
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
// Build battlefield with 5 hexes per row (1 row deep per army)
// Prefer terrain that accommodates all unit types
// ---------------------------------------------------------------------------
function tryBuildBattleField(seedIdx) {
  const layers = bfsLayers(seedIdx, 12);
  if (layers.length < 4) return null;

  // Layout:
  //   layers 0-1 → player front row (5 tiles from 2 layers)
  //   layers 2-3 → gap (no units, camera centres here)
  //   layers 4-5 → enemy front row  (5 tiles from 2 layers)

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

  const playerFront = pickTiles([layers[0], layers[1], layers[2]], 8);
  let gapTiles = [];
  let enemyFront = [];
  
  if (layers.length > 3) gapTiles = pickTiles([layers[3]], 2);
  if (layers.length > 4) {
    const gapExtra = pickTiles([layers[4]], 2);
    gapTiles = gapTiles.concat(gapExtra);
  }
  if (layers.length > 5) enemyFront = pickTiles([layers[5], layers[6], layers[7]], 8);

  if (playerFront.length < 5 || enemyFront.length < 5 || gapTiles.length < 1) {
    return null;
  }

  return { playerFront, gapTiles, enemyFront, layers };
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

const { playerFront, gapTiles, enemyFront } = battlefield;

// Camera centre tile = middle of the gap
const centreTile = gapTiles[Math.floor(gapTiles.length / 2)];

console.log('Player front:', playerFront);
console.log('Gap tiles:   ', gapTiles, '→ centre:', centreTile);
console.log('Enemy front: ', enemyFront);

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
// Unit naming
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
// Build a random unit with 27-point budget
// ---------------------------------------------------------------------------
const COMBAT_ATTRS = ['kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'antiAir'];

function makeRandomUnit(movAttr, pointBudget = 27) {
  const attrs = { [movAttr]: 0 };
  let remaining = pointBudget;

  // Ensure minimum movement (1-3) and health (1-2)
  const minMov = 1;
  const maxMov = 4;
  const movPts = Math.min(maxMov, Math.max(minMov, randInt(1, Math.min(maxMov, Math.floor(remaining * 0.25)))));
  attrs[movAttr] = movPts;
  remaining -= movPts;

  // Health: 1-4 points
  const hpPts = Math.min(4, Math.max(1, randInt(1, Math.min(4, Math.floor(remaining * 0.2)))));
  attrs.maxHealth = hpPts;
  remaining -= hpPts;

  // Armour for non-drones: 0-3 points (optional)
  if (movAttr !== 'flightMovement') {
    const armPts = Math.min(3, randInt(0, Math.floor(remaining * 0.15)));
    if (armPts > 0) {
      attrs.armour = armPts;
      remaining -= armPts;
    }
  }

  // Distribute remaining points across combat attributes
  const availableAttrs = [...COMBAT_ATTRS];
  // Drones can't have armour
  if (movAttr === 'flightMovement') {
    const armIdx = availableAttrs.indexOf('armour');
    if (armIdx >= 0) availableAttrs.splice(armIdx, 1);
  }

  // Distribute remaining points randomly across 2-4 attributes
  const numAttrs = Math.min(availableAttrs.length, randInt(2, 4));
  const chosen = [...availableAttrs].sort(() => rand() - 0.5).slice(0, numAttrs);

  while (remaining > 0) {
    // Keep cycling through attributes, even if some are maxed
    let found = false;
    for (const key of chosen) {
      if (remaining <= 0) break;
      const current = attrs[key] ?? 0;
      if (current < 5) {
        attrs[key] = current + 1;
        remaining--;
        found = true;
      }
    }
    
    // If all chosen attributes are maxed, pick a random available one
    if (!found && remaining > 0) {
      const allAvailable = availableAttrs.filter(k => (attrs[k] ?? 0) < 5);
      if (allAvailable.length > 0) {
        const key = randChoice(allAvailable);
        attrs[key] = (attrs[key] ?? 0) + 1;
        remaining--;
      } else {
        break; // All attributes maxed
      }
    }
  }

  // Ensure maxHealth is set
  if (!attrs.maxHealth) attrs.maxHealth = 1;

  return attrs;
}

// ---------------------------------------------------------------------------
// Unit class distribution: balance based on terrain distribution
// Tanks prefer flat/rolling, Spiders can use hills, Drones go anywhere
// For a balanced 20-unit army:
//   - 6 Tanks (less common than before, terrain limited)
//   - 7 Spiders (can use hills and forests better)
//   - 7 Drones (no terrain restriction)
// ---------------------------------------------------------------------------
const UNIT_CLASSES = [
  ...Array(6).fill('wheeledMovement'),  // 6 Tanks
  ...Array(7).fill('limbMovement'),     // 7 Spiders
  ...Array(7).fill('flightMovement'),   // 7 Drones
];

// ---------------------------------------------------------------------------
// Build army (20 units with randomized 27-point attributes)
// ---------------------------------------------------------------------------
function buildArmy() {
  const units = [];
  for (const movAttr of UNIT_CLASSES) {
    units.push({ movAttr, attrs: makeRandomUnit(movAttr, 27) });
  }
  return units;
}

// ---------------------------------------------------------------------------
// Terrain-aware tile categorization
// ---------------------------------------------------------------------------
function categorizeTiles(frontTiles) {
  const tankTiles   = [];
  const spiderTiles = [];
  const droneTiles  = [];

  for (const tileIdx of frontTiles) {
    if (isTankFriendly(tileIdx))   tankTiles.push(tileIdx);
    if (isSpiderFriendly(tileIdx)) spiderTiles.push(tileIdx);
    if (isDroneFriendly(tileIdx))  droneTiles.push(tileIdx);
  }

  return { tankTiles, spiderTiles, droneTiles };
}

// ---------------------------------------------------------------------------
// BFS — find nearest tile satisfying a predicate
// ---------------------------------------------------------------------------
function bfsFind(startIdx, predicate) {
  const visited = new Set([startIdx]);
  const queue = [startIdx];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (predicate(cur)) return cur;
    const t = tileByIndex.get(cur);
    if (!t) continue;
    for (const nb of t.n) {
      if (!visited.has(nb) && isLand(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Place units onto tiles, then fix terrain violations
// ---------------------------------------------------------------------------
const HP_PER_PT = 10;
const units = [];
let unitId = 0;

// Global occupancy map shared across both armies — prevents cross-army collisions
const globalOccupancy = new Map();

function getOrInitOcc(tileIdx) {
  if (!globalOccupancy.has(tileIdx)) globalOccupancy.set(tileIdx, 0);
  return globalOccupancy.get(tileIdx);
}

function placeArmy(armyUnits, frontTiles, ownerId, facingDir) {
  // Step 1: place each unit on the first front tile with space, ignoring terrain for now
  const placed = [];
  for (const unitDef of armyUnits) {
    let targetTile = null;
    for (const t of frontTiles) {
      if (getOrInitOcc(t) < 4) { targetTile = t; break; }
    }
    if (targetTile === null) {
      console.warn(`Overflow: no front tile space for unit ${unitId}`);
      continue;
    }
    const seg = getOrInitOcc(targetTile);
    globalOccupancy.set(targetTile, seg + 1);
    placed.push({ unitDef, tileIdx: targetTile, seg });
  }

  // Step 2: fix terrain violations — move unit to nearest valid tile via BFS
  for (const entry of placed) {
    const { unitDef } = entry;
    const movAttr = unitDef.movAttr;

    const isValid = (tileIdx) => {
      if (!isLand(tileIdx)) return false;
      if (movAttr === 'wheeledMovement') return isTankFriendly(tileIdx);
      if (movAttr === 'limbMovement')    return isSpiderFriendly(tileIdx);
      return true; // drones go anywhere on land
    };

    if (!isValid(entry.tileIdx)) {
      // Release the slot on the invalid tile
      globalOccupancy.set(entry.tileIdx, globalOccupancy.get(entry.tileIdx) - 1);

      // BFS out from the current tile until we find a valid one with space
      const newTile = bfsFind(entry.tileIdx, (t) => isValid(t) && getOrInitOcc(t) < 4);

      if (newTile === null) {
        console.warn(`No valid tile found for unit ${unitId} (${movAttr}), skipping`);
        entry.skip = true;
        continue;
      }

      const newSeg = getOrInitOcc(newTile);
      globalOccupancy.set(newTile, newSeg + 1);
      entry.tileIdx = newTile;
      entry.seg = newSeg;
      console.log(`  Moved ${movAttr} unit from invalid tile to ${newTile} (${getTerrain(newTile)}/${getElevType(newTile)})`);
    }
  }

  // Step 3: emit unit records
  for (const entry of placed) {
    if (entry.skip) continue;
    const attrs     = entry.unitDef.attrs;
    const maxHealth = attrs.maxHealth ?? 1;
    units.push({
      id:            `unit_${unitId++}`,
      label:         generateUnitName(attrs),
      ownerId,
      tileIndex:     entry.tileIdx,
      segment:       entry.seg,
      facing:        facingDir,
      attributes:    attrs,
      currentHealth: maxHealth * HP_PER_PT,
    });
  }
}

// Build armies
const playerArmy = buildArmy();
const enemyArmy  = buildArmy();

// Facing: player faces toward enemy (higher BFS dist), enemy faces toward player
const playerFacing = facingToward(playerFront[0], true);
const enemyFacing  = facingToward(enemyFront[0],  false);

console.log(`Player facing: ${playerFacing}, Enemy facing: ${enemyFacing}`);

placeArmy(playerArmy, playerFront, PLAYER_CITY_ID, playerFacing);
placeArmy(enemyArmy,  enemyFront,  ENEMY_CITY_ID,  enemyFacing);

console.log(`Generated ${units.length} units total (${units.length / 2} per side)`);

// ---------------------------------------------------------------------------
// Build the save payload (compact format)
// ---------------------------------------------------------------------------
const save = {
  format: 'compact',
  seed: world.seed,
  cities: world.cities.map((c) => ({
    ...c,
    isPlayerHome: c.id === PLAYER_CITY_ID,
  })),
  units,
  playerColor: '#00e5ff',
  battleCentreTile: centreTile,
};

writeFileSync(outPath, JSON.stringify(save, null, 2));

console.log(`\nSaved to ${outPath}`);
console.log(`  Player (${PLAYER_CITY_ID}): ${playerArmy.length} units`);
console.log(`    Front tiles: ${playerFront.join(', ')}`);
console.log(`  Enemy  (${ENEMY_CITY_ID}):  ${enemyArmy.length} units`);
console.log(`    Front tiles: ${enemyFront.join(', ')}`);
console.log(`  Camera centre tile: ${centreTile}`);

// Print terrain summary
console.log('\nTerrain summary:');
for (const t of [...playerFront, ...enemyFront]) {
  const tile = tileByIndex.get(t);
  const forested = tile?.f ? ' (forested)' : '';
  console.log(`  Tile ${t}: ${tile?.terrain} / ${tile?.elevType}${forested}`);
}
