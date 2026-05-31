/**
 * generate-battle-save.js
 *
 * Generates a 30v30 battle save game with two factions facing each other
 * across a 2-hex gap, using random unit types.
 *
 * Usage: node scripts/generate-battle-save.js
 * Output: data/battle-30v30.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '../data/world.json');
const outPath = join(__dirname, '../data/battle-30v30.json');

// ---------------------------------------------------------------------------
// Load world
// ---------------------------------------------------------------------------
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const tiles = world.tiles;

// Build a fast lookup: tileIndex -> tile
const tileByIndex = new Map();
for (const t of tiles) tileByIndex.set(t.idx, t);

// ---------------------------------------------------------------------------
// Faction IDs — must be real city IDs so factionColor() resolves them
// ---------------------------------------------------------------------------
// city_0 is the player's home city (isPlayerHome = true)
// Pick a geographically distant city for the enemy
const PLAYER_CITY_ID = 'city_0';
const ENEMY_CITY_ID  = 'city_6'; // city_6 is on the opposite side of the globe

// ---------------------------------------------------------------------------
// Find a good land tile cluster
// ---------------------------------------------------------------------------
const LAND_TERRAINS = new Set(['grassland', 'plains', 'tundra', 'desert']);

function isLand(tileIdx) {
  const t = tileByIndex.get(tileIdx);
  return t && LAND_TERRAINS.has(t.terrain);
}

/**
 * BFS from a seed tile, collecting up to `limit` connected land tiles.
 * Returns tiles grouped by BFS distance layer.
 */
function bfsLayers(seedIdx, maxLayers, maxTilesPerLayer) {
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
    layers.push(next.slice(0, maxTilesPerLayer));
    frontier = next;
  }
  return layers;
}

/**
 * Find a land tile with at least `minNeighbours` land neighbours.
 */
function findGoodSeed(startIdx, endIdx) {
  for (let i = startIdx; i <= endIdx; i++) {
    const t = tileByIndex.get(i);
    if (!t || !isLand(t.idx)) continue;
    const landNeighbours = t.n.filter(isLand);
    if (landNeighbours.length >= 5) return t.idx;
  }
  return null;
}

// Find a good mid-latitude land cluster
let seedIdx = findGoodSeed(1200, 2000);
if (!seedIdx) seedIdx = findGoodSeed(0, tiles.length - 1);
console.log(`Seed tile: ${seedIdx}`);

const layers = bfsLayers(seedIdx, 14, 8);
console.log(`BFS layers: ${layers.map((l, i) => `[${i}]:${l.length}`).join(', ')}`);

if (layers.length < 8) {
  console.error(`Only got ${layers.length} BFS layers, need at least 8.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Select tiles for each side
// ---------------------------------------------------------------------------
// Layout (BFS distance from seed):
//   layers 0-2 → player front (6 tiles total)
//   layers 3-4 → gap (no units)
//   layers 5-7 → enemy front (6 tiles total)
//
// 6 tiles × 5 segments = 30 units per side

function tilesFromLayers(layerArr, count) {
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

const TILES_NEEDED = 6;

const playerTiles = tilesFromLayers([layers[0], layers[1], layers[2]], TILES_NEEDED);
const enemyTiles  = tilesFromLayers([layers[5], layers[6], layers[7]], TILES_NEEDED);

console.log('Player tiles:', playerTiles);
console.log('Enemy tiles:', enemyTiles);

if (playerTiles.length < TILES_NEEDED || enemyTiles.length < TILES_NEEDED) {
  console.error(`Not enough tiles: player=${playerTiles.length}, enemy=${enemyTiles.length}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Compute facing direction for each tile
// ---------------------------------------------------------------------------
// Facing = the segment index (0-5) whose outer edge points toward the enemy.
// Segment i faces neighbour[i] (the tile at t.n[i]).
// So: find which neighbour of this tile is "toward the enemy" by checking
// which neighbour has a higher BFS layer (for player tiles) or lower BFS
// layer (for enemy tiles).

// Build a BFS distance map from the seed
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

/**
 * For a tile, find the segment index (0-5) that faces "toward" the target
 * direction. "Toward" means: the neighbour at that segment has a BFS distance
 * closer to `targetDist` than the current tile's distance.
 *
 * For player tiles: targetDist = higher (toward enemy = away from seed)
 * For enemy tiles:  targetDist = lower  (toward player = toward seed)
 */
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
// Random unit type generator
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    return s / 0x100000000;
  };
}

const rand = rng(42);
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function randChoice(arr)   { return arr[Math.floor(rand() * arr.length)]; }

const MOVEMENT_TYPES = ['wheeledMovement', 'limbMovement', 'flightMovement'];
const COMBAT_ATTRS   = ['attack', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair'];

function randomAttributes() {
  const movType = randChoice(MOVEMENT_TYPES);
  const movVal  = randInt(1, 4);
  const attrs   = { maxHealth: randInt(1, 4), [movType]: movVal };

  const shuffled = [...COMBAT_ATTRS].sort(() => rand() - 0.5);
  const count = randInt(2, 4);
  for (let i = 0; i < count; i++) {
    const key = shuffled[i];
    if (movType === 'flightMovement' && key === 'armour') continue;
    attrs[key] = randInt(1, 4);
  }
  return attrs;
}

// Unit name generator (mirrors TypeScript logic)
const SPEED_NAMES = { 1: 'Loitering', 2: 'Plodder', 3: 'Walker', 4: 'Runner', 5: 'Sprinter' };
const TYPE_NAMES  = { wheeledMovement: 'Tank', flightMovement: 'Drone', limbMovement: 'Spider' };
const ATTR_NAMES  = {
  attack:       { 1: 'Harasser', 2: 'Raider', 3: 'Striker', 4: 'Breaker', 5: 'Executioner' },
  armour:       { 1: 'Flyweight', 2: 'Bantamweight', 3: 'Welterweight', 4: 'Middleweight', 5: 'Heavyweight' },
  defence:      { 1: 'Listener', 2: 'Scrambler', 3: 'Jammer', 4: 'Disruptor', 5: 'Nullifier' },
  splashAttack: { 1: 'Popper', 2: 'Blaster', 3: 'Bombardier', 4: 'Demolisher', 5: 'Devastator' },
  rangeAttack:  { 1: 'Melee', 2: 'Short', 3: 'Medium', 4: 'Long', 5: 'Distance' },
  repair:       { 1: 'Tinkerer', 2: 'Mechanic', 3: 'Engineer', 4: 'Restorer', 5: 'Fabricator' },
};
const NAMING_ATTRS = ['attack', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair'];
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
  const att = attrs.attack ?? 0;
  const rng = attrs.rangeAttack ?? 0;
  const spl = attrs.splashAttack ?? 0;
  const arm = attrs.armour ?? 0;
  const ew  = attrs.defence ?? 0;
  const rep = attrs.repair ?? 0;

  return `${parts.join(' ')} (Mov ${mov}, Att ${att}, Rng ${rng}, Spl ${spl}, Arm ${arm}, EW ${ew}, Rep ${rep})`;
}

// ---------------------------------------------------------------------------
// Place units
// ---------------------------------------------------------------------------
const SEGMENTS  = [0, 1, 2, 3, 4]; // 5 segments per tile (segment 5 stays free)
const HP_PER_PT = 10;

const units = [];
let unitId = 0;

function placeUnits(tileIndices, ownerId, count, facing) {
  let placed = 0;
  let tileIdx = 0;
  let segIdx  = 0;

  while (placed < count) {
    if (tileIdx >= tileIndices.length) {
      console.warn(`Ran out of tiles for ${ownerId} (placed ${placed}/${count})`);
      break;
    }

    const tileIndex = tileIndices[tileIdx];
    const segment   = SEGMENTS[segIdx];
    const attrs     = randomAttributes();
    const maxHealth = attrs.maxHealth ?? 1;

    units.push({
      id: `unit_${unitId++}`,
      label: generateUnitName(attrs),
      ownerId,
      tileIndex,
      segment,
      facing,
      attributes: attrs,
      currentHealth: maxHealth * HP_PER_PT,
    });

    placed++;
    segIdx++;
    if (segIdx >= SEGMENTS.length) {
      segIdx = 0;
      tileIdx++;
    }
  }
}

// Player (blue) faces NE = segment/facing 1
// Enemy  (red)  faces SW = segment/facing 4
// segmentAngle: 0=N, 1=NE, 2=SE, 3=S, 4=SW, 5=NW (each step +60° clockwise)
placeUnits(playerTiles, PLAYER_CITY_ID, 30, 1);
placeUnits(enemyTiles,  ENEMY_CITY_ID,  30, 4);

console.log(`Generated ${units.length} units total`);

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
  playerColor: '#00e5ff', // cyan — default player color from FACTION_PALETTE
};

writeFileSync(outPath, JSON.stringify(save, null, 2));

console.log(`\nSaved to ${outPath}`);
console.log(`  Player (${PLAYER_CITY_ID}): 30 units on tiles ${playerTiles.join(', ')}`);
console.log(`  Enemy  (${ENEMY_CITY_ID}):  30 units on tiles ${enemyTiles.join(', ')}`);
console.log(`  Gap tiles (layers 3-4): ${tilesFromLayers([layers[3], layers[4]], 12).join(', ')}`);
