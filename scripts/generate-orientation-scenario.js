/**
 * generate-orientation-scenario.js
 *
 * Generates a test scenario for orientation bonus debugging:
 *   - 1 player unit at the centre
 *   - 6 hexes at distance 3 (one per sector), each filled with 5 enemy units
 *   - All enemies face AWAY from the centre of their hex (outward from the map centre)
 *
 * This lets you visually inspect the orientation bonus calculation when the player
 * attacks enemies that are facing away.
 *
 * Usage: node scripts/generate-orientation-scenario.js
 * Output: data/orientation-scenario.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '../data/world.json');
const outPath   = join(__dirname, '../data/orientation-scenario.json');

// ---------------------------------------------------------------------------
// Load world
// ---------------------------------------------------------------------------
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const tiles = world.tiles;

const tileByIndex = new Map();
for (const t of tiles) tileByIndex.set(t.idx, t);

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------
const PLAYER_ID = 'city_0';
const ENEMY_ID  = 'city_6';

// ---------------------------------------------------------------------------
// Terrain helpers
// ---------------------------------------------------------------------------
const LAND_TERRAINS = new Set(['grassland', 'plains', 'tundra', 'desert']);

function isLand(tileIdx) {
  const t = tileByIndex.get(tileIdx);
  return t && LAND_TERRAINS.has(t.terrain);
}

// ---------------------------------------------------------------------------
// BFS — find tiles at exact distance from a seed tile
// ---------------------------------------------------------------------------
function bfsDistances(seedIdx, maxDist) {
  const distMap = new Map();
  distMap.set(seedIdx, 0);
  const queue = [seedIdx];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const curDist = distMap.get(cur);
    if (curDist >= maxDist) continue;

    const t = tileByIndex.get(cur);
    if (!t) continue;
    for (const nb of t.n) {
      if (!distMap.has(nb) && isLand(nb)) {
        distMap.set(nb, curDist + 1);
        queue.push(nb);
      }
    }
  }

  return distMap;
}

// ---------------------------------------------------------------------------
// Find a good centre tile — land tile with lots of land neighbours at dist 3
// ---------------------------------------------------------------------------
function findCentreTile() {
  // Use the player's home city tile as a starting area, then BFS out to find
  // a tile with 6 land neighbours at distance exactly 3
  const playerCity = world.cities.find((c) => c.id === PLAYER_ID);
  const startTile = playerCity ? playerCity.tileIndex : 12;

  // BFS from startTile to find a seed with good surrounding land
  const candidates = [];
  const visited = new Set();
  const queue = [startTile];
  visited.add(startTile);

  while (queue.length > 0 && candidates.length < 20) {
    const cur = queue.shift();
    if (!isLand(cur)) {
      const t = tileByIndex.get(cur);
      if (t) for (const nb of t.n) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
      continue;
    }

    // Check if this tile has enough land tiles at distance 3
    const dists = bfsDistances(cur, 3);
    const ring3 = [...dists.entries()].filter(([, d]) => d === 3).map(([idx]) => idx);

    if (ring3.length >= 6) {
      candidates.push({ idx: cur, ring3Count: ring3.length });
    }

    const t = tileByIndex.get(cur);
    if (t) for (const nb of t.n) {
      if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
    }
  }

  // Pick the candidate with the most ring-3 tiles
  candidates.sort((a, b) => b.ring3Count - a.ring3Count);
  return candidates[0]?.idx ?? startTile;
}

const centreIdx = findCentreTile();
console.log(`Centre tile: ${centreIdx}`);

// ---------------------------------------------------------------------------
// Get 6 evenly-spaced ring-3 tiles
// ---------------------------------------------------------------------------
const distMap = bfsDistances(centreIdx, 3);
const ring3Tiles = [...distMap.entries()]
  .filter(([, d]) => d === 3)
  .map(([idx]) => idx);

console.log(`Ring-3 tiles available: ${ring3Tiles.length}`);

// Pick 6 tiles spread around the centre by sorting by angular position
// Use the tile 3D positions for angular sorting
const centrePos = tileByIndex.get(centreIdx).pos;

function getAngle(tileIdx) {
  const pos = tileByIndex.get(tileIdx).pos;
  // Project onto tangent plane at centrePos
  const dx = pos[0] - centrePos[0];
  const dy = pos[1] - centrePos[1];
  const dz = pos[2] - centrePos[2];
  // Simple 2D angle using two most varying dimensions
  // Use atan2 of the tangent-plane components
  // For tiles near the sphere, just use the offset as a proxy
  return Math.atan2(dx, dz);
}

// Sort ring-3 tiles by angle and pick 6 evenly spaced
ring3Tiles.sort((a, b) => getAngle(a) - getAngle(b));

const selectedTiles = [];
const step = ring3Tiles.length / 6;
for (let i = 0; i < 6; i++) {
  const idx = Math.floor(i * step);
  selectedTiles.push(ring3Tiles[idx]);
}

console.log(`Selected enemy tiles: ${selectedTiles.join(', ')}`);

// ---------------------------------------------------------------------------
// Determine "outward" facing for each selected tile
// ---------------------------------------------------------------------------
// The outward direction is the neighbour direction whose bearing (from the tile)
// is closest to the "away from centre" bearing. This uses the same tangent-plane
// projection as the combat system to ensure consistency.

function v3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function v3dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function v3len(v) { return Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); }
function v3cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

function tangentProject(origin, target) {
  const dir = v3sub(target, origin);
  const radialComponent = v3dot(dir, origin);
  const tangent = [
    dir[0] - radialComponent * origin[0],
    dir[1] - radialComponent * origin[1],
    dir[2] - radialComponent * origin[2],
  ];
  let up = [0, 1, 0];
  if (Math.abs(v3dot(origin, up)) > 0.99) up = [1, 0, 0];
  const eastRaw = v3cross(up, origin);
  const eastLen = v3len(eastRaw);
  if (eastLen < 1e-10) return [0, 0];
  const east = [eastRaw[0]/eastLen, eastRaw[1]/eastLen, eastRaw[2]/eastLen];
  const north = v3cross(origin, east);
  return [v3dot(tangent, east), v3dot(tangent, north)];
}

function getBearing(fromPos, toPos) {
  const [tx, ty] = tangentProject(fromPos, toPos);
  const len = Math.sqrt(tx*tx + ty*ty);
  if (len < 1e-12) return NaN;
  return (Math.atan2(tx, ty) + 2*Math.PI) % (2*Math.PI);
}

function getOutwardFacing(tileIdx) {
  const t = tileByIndex.get(tileIdx);
  if (!t) return 0;

  // "Away from centre" bearing = bearing from this tile AWAY from centre tile
  // This is the opposite of "toward centre", i.e. bearing from tile toward centre + 180°
  const bearingTowardCentre = getBearing(t.pos, centrePos);
  const bearingAway = (bearingTowardCentre + Math.PI) % (2 * Math.PI);

  // Find the neighbour direction whose bearing is closest to bearingAway
  let bestDir = 0;
  let bestAngleDiff = Infinity;

  for (let dir = 0; dir < t.n.length; dir++) {
    const nbPos = tileByIndex.get(t.n[dir])?.pos;
    if (!nbPos) continue;
    const nbBearing = getBearing(t.pos, nbPos);
    let angleDiff = Math.abs(nbBearing - bearingAway);
    if (angleDiff > Math.PI) angleDiff = 2*Math.PI - angleDiff;
    if (angleDiff < bestAngleDiff) {
      bestAngleDiff = angleDiff;
      bestDir = dir;
    }
  }

  return bestDir;
}

// ---------------------------------------------------------------------------
// Unit naming (same logic as generate-battle-save.js)
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
// Build units
// ---------------------------------------------------------------------------
const HP_PER_PT = 10;
const units = [];
let unitId = 0;

// Player unit at centre — strong ranged tank
const playerAttrs = {
  maxHealth: 4,
  kinetic: 4,
  rangeAttack: 4,
  armour: 3,
  wheeledMovement: 3,
};

// Player faces toward the first enemy sector tile
const playerFacing = (() => {
  const t = tileByIndex.get(centreIdx);
  const targetTile = selectedTiles[0];
  // Find which neighbour direction is closest to the target
  let bestDir = 0;
  let bestDist = Infinity;
  for (let dir = 0; dir < t.n.length; dir++) {
    // BFS distance from neighbour to target
    const nbDist = distMap.get(t.n[dir]) ?? 999;
    // We want the neighbour closest to target direction
    const nbPos = tileByIndex.get(t.n[dir])?.pos;
    const tgtPos = tileByIndex.get(targetTile)?.pos;
    if (nbPos && tgtPos) {
      const d = Math.hypot(nbPos[0] - tgtPos[0], nbPos[1] - tgtPos[1], nbPos[2] - tgtPos[2]);
      if (d < bestDist) { bestDist = d; bestDir = dir; }
    }
  }
  return bestDir;
})();

units.push({
  id: `unit_${unitId++}`,
  label: generateUnitName(playerAttrs),
  ownerId: PLAYER_ID,
  tileIndex: centreIdx,
  segment: 0,
  facing: playerFacing,
  attributes: playerAttrs,
  currentHealth: playerAttrs.maxHealth * HP_PER_PT,
});

console.log(`Player unit at tile ${centreIdx}, facing ${playerFacing}`);

// Enemy units — 5 per hex, each with a different facing (all rotations from outward)
// This gives a spread of facings "away from centre" for testing
const ENEMY_CONFIGS = [
  // Variety of enemy types to make it interesting
  { kinetic: 3, rangeAttack: 3, armour: 2, wheeledMovement: 2, maxHealth: 3 },
  { kinetic: 4, rangeAttack: 2, armour: 1, limbMovement: 3, maxHealth: 2 },
  { kinetic: 2, rangeAttack: 4, armour: 3, wheeledMovement: 2, maxHealth: 3 },
  { splashAttack: 3, rangeAttack: 3, armour: 1, wheeledMovement: 2, maxHealth: 3 },
  { kinetic: 3, rangeAttack: 3, defence: 2, limbMovement: 2, maxHealth: 3 },
];

for (const tileIdx of selectedTiles) {
  const outwardFacing = getOutwardFacing(tileIdx);
  console.log(`  Enemy hex ${tileIdx}: outward facing = ${outwardFacing}`);

  for (let seg = 0; seg < 5; seg++) {
    // Each unit faces a DIFFERENT direction — radiating outward from the hex centre.
    // Unit in segment N faces toward the edge of segment N (i.e. toward neighbour N).
    // This makes them all "pointing away from each other" as if dispersing.
    const tileSides = tileByIndex.get(tileIdx)?.s ?? 6;
    const facing = seg % tileSides;

    const attrs = { ...ENEMY_CONFIGS[seg] };

    units.push({
      id: `unit_${unitId++}`,
      label: generateUnitName(attrs),
      ownerId: ENEMY_ID,
      tileIndex: tileIdx,
      segment: seg,
      facing,
      attributes: attrs,
      currentHealth: (attrs.maxHealth ?? 3) * HP_PER_PT,
    });
  }
}

console.log(`\nTotal units: ${units.length} (1 player + ${units.length - 1} enemies)`);

// ---------------------------------------------------------------------------
// Build the save payload (compact format — no tiles, regenerated from seed)
// ---------------------------------------------------------------------------
const save = {
  format: 'compact',
  seed: world.seed,
  cities: world.cities.map((c) => ({
    ...c,
    isPlayerHome: c.id === PLAYER_ID,
  })),
  units,
  playerColor: '#00e5ff',
  /** Centre camera on the player's tile. */
  battleCentreTile: centreIdx,
};

writeFileSync(outPath, JSON.stringify(save, null, 2));

console.log(`\nSaved to ${outPath}`);
console.log('Load in-game via Load → Scenarios → "Orientation Test"');
