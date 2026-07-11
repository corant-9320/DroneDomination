/**
 * generate-default-scenario.js
 *
 * Generates the heavily-populated DEFAULT scenario that loads when the game
 * starts (served at /default-scenario.json, fetched by client/worldData.ts).
 *
 * Goal: a scenario that is immediately useful for testing every system, with:
 *   - Two big cities (player capital + an enemy capital) carrying DOZENS of
 *     buildings spread across many owned hexes. Every building is placed
 *     through the SAME street-navigation rules the engine enforces
 *     (shared/buildings.ts), so the cities keep legal through-streets and no
 *     sealed courtyards.
 *   - A city DEFENCE situation: an enemy assault army staged next to the
 *     player capital, facing in, with a player garrison inside.
 *   - A city ATTACK situation: a player assault army staged next to the enemy
 *     capital, facing in, with an enemy garrison inside.
 *   - Several open-field battles: player vs enemy armies across a gap.
 *
 * The street-validation functions below are a faithful JS port of
 * shared/buildings.ts (the single source of truth). Keep them in sync if the
 * invariants there change.
 *
 * Usage:  node scripts/generate-default-scenario.js
 * Output: data/default-scenario.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '../data/world.json');
const outPath = join(__dirname, '../data/default-scenario.json');

// ---------------------------------------------------------------------------
// Load world
// ---------------------------------------------------------------------------
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const tiles = world.tiles;

const tileByIndex = new Map();
for (const t of tiles) tileByIndex.set(t.idx, t);

// ---------------------------------------------------------------------------
// Faction IDs (each city is its own faction; the player owns PLAYER_CITY_ID)
// ---------------------------------------------------------------------------
const PLAYER_CITY_ID = 'city_0';   // player capital + assault armies
const ENEMY_CITY_ID = 'city_6';    // enemy capital (player attacks it)
const ENEMY_ASSAULT_ID = 'city_3'; // enemy army that besieges the player capital
const ENEMY_FIELD_A = 'city_1';    // open-field enemy A
const ENEMY_FIELD_B = 'city_2';    // open-field enemy B

// ---------------------------------------------------------------------------
// Terrain helpers
// ---------------------------------------------------------------------------
const LAND_TERRAINS = new Set(['grassland', 'plains', 'tundra', 'desert']);

function isLand(tileIdx) {
  const t = tileByIndex.get(tileIdx);
  return !!t && LAND_TERRAINS.has(t.terrain);
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

/** Buildable tile: land and not a mountain (cities don't sit on peaks). */
function isBuildable(tileIdx) {
  return isLand(tileIdx) && getElevType(tileIdx) !== 'mountain';
}

function isTankFriendly(tileIdx) {
  const elev = getElevType(tileIdx);
  return (elev === 'flat' || elev === 'rolling') && !isForested(tileIdx);
}

function isSpiderFriendly(tileIdx) {
  const elev = getElevType(tileIdx);
  if (elev === 'mountain') return false;
  return elev === 'hills' || isForested(tileIdx);
}

function isDroneFriendly(tileIdx) {
  return isLand(tileIdx);
}

// ---------------------------------------------------------------------------
// Street-navigation validation — faithful port of shared/buildings.ts
// `groundPassable` at tile granularity means "not ocean" (per buildings.ts).
// ---------------------------------------------------------------------------
function groundPassable(tileIdx) {
  return getTerrain(tileIdx) !== 'ocean';
}

function segKey(tileIndex, segment) {
  return `${tileIndex}:${segment}`;
}

function intraHexNeighbours(sides, segment) {
  return [(segment + 1) % sides, (segment - 1 + sides) % sides];
}

function sidesOf(tileIdx) {
  return tileByIndex.get(tileIdx)?.s ?? 6;
}

function neighboursOf(tileIdx) {
  return tileByIndex.get(tileIdx)?.n ?? [];
}

function openSegments(tileIdx, buildingSet) {
  const open = [];
  const sides = sidesOf(tileIdx);
  for (let s = 0; s < sides; s++) {
    if (!buildingSet.has(segKey(tileIdx, s))) open.push(s);
  }
  return open;
}

/** Per-tile through-street (Requirement 4). */
function hasThroughStreet(tileIdx, buildingSet) {
  const open = openSegments(tileIdx, buildingSet);
  if (open.length === 0) return false;
  const openSet = new Set(open);
  const seen = new Set();
  const sides = sidesOf(tileIdx);
  const nbrs = neighboursOf(tileIdx);

  for (const start of open) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    let passableFaces = 0;
    while (stack.length) {
      const seg = stack.pop();
      const nbIdx = nbrs[seg];
      if (nbIdx !== undefined && groundPassable(nbIdx)) passableFaces++;
      for (const adj of intraHexNeighbours(sides, seg)) {
        if (openSet.has(adj) && !seen.has(adj)) {
          seen.add(adj);
          stack.push(adj);
        }
      }
    }
    if (passableFaces >= 2) return true;
  }
  return false;
}

/** Whole-city external reachability (Requirement 5). */
function findOrphanedPockets(cityHexes, buildingSet) {
  const cityHexSet = new Set(cityHexes);
  const seen = new Set();
  const orphanedHexes = new Set();

  for (const hexIndex of cityHexes) {
    if (!tileByIndex.has(hexIndex)) continue;
    for (const seg of openSegments(hexIndex, buildingSet)) {
      const startKey = segKey(hexIndex, seg);
      if (seen.has(startKey)) continue;

      const component = [];
      const stack = [{ tileIndex: hexIndex, segment: seg }];
      seen.add(startKey);
      let hasExit = false;

      while (stack.length) {
        const node = stack.pop();
        component.push(segKey(node.tileIndex, node.segment));
        const sidesA = sidesOf(node.tileIndex);
        const nbrsA = neighboursOf(node.tileIndex);

        for (const adj of intraHexNeighbours(sidesA, node.segment)) {
          const k = segKey(node.tileIndex, adj);
          if (!buildingSet.has(k) && !seen.has(k)) {
            seen.add(k);
            stack.push({ tileIndex: node.tileIndex, segment: adj });
          }
        }

        const nbIdx = nbrsA[node.segment];
        if (nbIdx === undefined || !tileByIndex.has(nbIdx)) continue;

        if (cityHexSet.has(nbIdx)) {
          const facing = neighboursOf(nbIdx).indexOf(node.tileIndex);
          if (facing >= 0) {
            const k = segKey(nbIdx, facing);
            if (!buildingSet.has(k) && !seen.has(k)) {
              seen.add(k);
              stack.push({ tileIndex: nbIdx, segment: facing });
            }
          }
        } else if (groundPassable(nbIdx)) {
          hasExit = true;
        }
      }

      if (!hasExit) {
        for (const key of component) orphanedHexes.add(Number(key.split(':')[0]));
      }
    }
  }
  return [...orphanedHexes];
}

/** Per-segment steepness in radians (from wire field `ss`). Falls back to 0. */
function segmentSteepness(tileIdx, segment) {
  const t = tileByIndex.get(tileIdx);
  if (!t || !t.ss) return 0;
  return t.ss[segment] ?? 0;
}

const MAX_BUILD_STEEPNESS = 0.44; // must match shared/buildings.ts

/**
 * Pure placement validation (faithful port). `state` carries the live building
 * set, unit set, the faction's building tiles, and its owned city hexes.
 */
function validatePlacement(state, tileIdx, segment, founding) {
  if (!tileByIndex.has(tileIdx)) return false;
  const sides = sidesOf(tileIdx);
  if (segment < 0 || segment >= sides) return false;
  if (!groundPassable(tileIdx)) return false;
  if (segmentSteepness(tileIdx, segment) > MAX_BUILD_STEEPNESS) return false;

  const key = segKey(tileIdx, segment);
  if (state.unitSet.has(key)) return false;
  if (state.buildingSet.has(key)) return false;

  // Capacity: buildings + units must never exceed the tile's segment count.
  let occupied = 0;
  for (let s = 0; s < sides; s++) {
    const k = segKey(tileIdx, s);
    if (state.buildingSet.has(k) || state.unitSet.has(k)) occupied++;
  }
  if (occupied >= sides) return false;

  // Contiguous growth: adjacent to an existing faction building.
  if (!founding) {
    const adjacent =
      state.factionBuildingTiles.has(tileIdx) ||
      neighboursOf(tileIdx).some((n) => state.factionBuildingTiles.has(n));
    if (!adjacent) return false;
  }

  // Simulate.
  const after = new Set(state.buildingSet);
  after.add(key);

  if (!hasThroughStreet(tileIdx, after)) return false;

  const cityHexes = state.cityHexes.includes(tileIdx)
    ? state.cityHexes
    : [...state.cityHexes, tileIdx];
  if (findOrphanedPockets(cityHexes, after).length > 0) return false;

  return true;
}

// ---------------------------------------------------------------------------
// BFS helpers
// ---------------------------------------------------------------------------

/** BFS layers of land tiles outward from a seed, up to maxLayers deep. */
function bfsLandLayers(seedIdx, maxLayers) {
  const visited = new Set([seedIdx]);
  let frontier = [seedIdx];
  const layers = [[seedIdx]];
  for (let d = 1; d < maxLayers; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of neighboursOf(cur)) {
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

/** BFS distance map (graph hops) from a seed over all tiles. */
function bfsDistances(seedIdx) {
  const dist = new Map([[seedIdx, 0]]);
  const queue = [seedIdx];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(cur);
    for (const nb of neighboursOf(cur)) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

/** Pick the segment of `tileIdx` whose neighbour points toward (or away from)
 *  a reference tile, using a precomputed distance map. */
function facingToward(tileIdx, distMap, wantCloser) {
  const myDist = distMap.get(tileIdx) ?? 0;
  const nbrs = neighboursOf(tileIdx);
  let bestSeg = 0;
  let bestDelta = -Infinity;
  for (let seg = 0; seg < nbrs.length; seg++) {
    const nbDist = distMap.get(nbrs[seg]) ?? myDist;
    const delta = wantCloser ? (myDist - nbDist) : (nbDist - myDist);
    if (delta > bestDelta) {
      bestDelta = delta;
      bestSeg = seg;
    }
  }
  return bestSeg;
}

/** Find a land seed with at least `minLand` land neighbours, scanning a range. */
function findGoodSeed(startIdx, endIdx) {
  for (let i = startIdx; i <= endIdx; i++) {
    if (!isLand(i)) continue;
    const landNb = neighboursOf(i).filter(isLand);
    if (landNb.length >= 5) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// RNG (seeded for a reproducible default scenario)
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = makeRng(0xD20E); // fixed → deterministic scenario
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function randChoice(arr) { return arr[Math.floor(rand() * arr.length)]; }

// ---------------------------------------------------------------------------
// Unit attributes + naming (ported from generate-battle-20v20.js)
// ---------------------------------------------------------------------------
const SPEED_NAMES = { 1: 'Loitering', 2: 'Plodder', 3: 'Walker', 4: 'Runner', 5: 'Sprinter' };
const TYPE_NAMES = { wheeledMovement: 'Tank', flightMovement: 'Drone', limbMovement: 'Spider' };
const ATTR_NAMES = {
  kinetic:      { 1: 'Harasser',  2: 'Raider',       3: 'Striker',      4: 'Breaker',     5: 'Executioner' },
  armour:       { 1: 'Flyweight', 2: 'Bantamweight', 3: 'Welterweight', 4: 'Middleweight', 5: 'Heavyweight' },
  defence:      { 1: 'Listener',  2: 'Scrambler',    3: 'Jammer',       4: 'Disruptor',   5: 'Nullifier' },
  splashAttack: { 1: 'Popper',    2: 'Blaster',      3: 'Bombardier',   4: 'Demolisher',  5: 'Devastator' },
  rangeAttack:  { 1: 'Melee',     2: 'Short',        3: 'Medium',       4: 'Long',        5: 'Distance' },
  repair:       { 1: 'Tinkerer',  2: 'Mechanic',     3: 'Engineer',     4: 'Restorer',    5: 'Fabricator' },
  antiAir:      { 1: 'Spotter',   2: 'Tracker',      3: 'Interceptor',  4: 'Skyhunter',   5: 'Annihilator' },
  engineer:     { 1: 'Sapper',    2: 'Pontoneer',    3: 'Bridger',      4: 'Pioneer',     5: 'Combat Engineer' },
};
const NAMING_ATTRS = ['kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'repair', 'antiAir', 'engineer'];
const MOV_ATTRS = ['wheeledMovement', 'limbMovement', 'flightMovement'];

function generateUnitName(attrs) {
  const movKey = MOV_ATTRS.find((k) => (attrs[k] ?? 0) >= 1) ?? 'wheeledMovement';
  const speed = attrs[movKey] ?? 1;
  const speedWord = SPEED_NAMES[Math.min(Math.max(speed, 1), 5)];
  const typeWord = TYPE_NAMES[movKey];

  const ranked = NAMING_ATTRS
    .map((key) => ({ key, value: attrs[key] ?? 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const parts = [];
  if (ranked[0]) parts.push(ATTR_NAMES[ranked[0].key][Math.min(Math.max(ranked[0].value, 1), 5)]);
  if (ranked[1]) parts.push(ATTR_NAMES[ranked[1].key][Math.min(Math.max(ranked[1].value, 1), 5)]);
  parts.push(speedWord, typeWord);

  const mov = attrs[movKey] ?? 0;
  return `${parts.join(' ')} (Mov ${mov}, Kin ${attrs.kinetic ?? 0}, Rng ${attrs.rangeAttack ?? 0}, ` +
    `Spl ${attrs.splashAttack ?? 0}, AA ${attrs.antiAir ?? 0}, Arm ${attrs.armour ?? 0}, ` +
    `EW ${attrs.defence ?? 0}, Rep ${attrs.repair ?? 0}, Eng ${attrs.engineer ?? 0})`;
}

const COMBAT_ATTRS = ['kinetic', 'armour', 'defence', 'splashAttack', 'rangeAttack', 'antiAir'];
const SIZE_CAPPED = new Set(['kinetic', 'splashAttack', 'antiAir', 'armour', 'defence', 'repair']);

function makeRandomUnit(movAttr, pointBudget = 27) {
  const attrs = { [movAttr]: 0 };
  let remaining = pointBudget;

  const movPts = Math.min(4, Math.max(1, randInt(1, Math.min(4, Math.floor(remaining * 0.25)))));
  attrs[movAttr] = movPts;
  remaining -= movPts;

  const hpPts = Math.min(4, Math.max(1, randInt(1, Math.min(4, Math.floor(remaining * 0.2)))));
  attrs.size = hpPts;
  remaining -= hpPts;

  if (movAttr !== 'flightMovement') {
    const armPts = Math.min(3, attrs.size, randInt(0, Math.floor(remaining * 0.15)));
    if (armPts > 0) { attrs.armour = armPts; remaining -= armPts; }
  }

  const capOf = (key) => (SIZE_CAPPED.has(key) ? attrs.size : 5);

  const availableAttrs = [...COMBAT_ATTRS];
  if (movAttr === 'flightMovement') {
    for (const drop of ['armour', 'rangeAttack']) {
      const i = availableAttrs.indexOf(drop);
      if (i >= 0) availableAttrs.splice(i, 1);
    }
  }

  const numAttrs = Math.min(availableAttrs.length, randInt(2, 4));
  const chosen = [...availableAttrs].sort(() => rand() - 0.5).slice(0, numAttrs);

  while (remaining > 0) {
    let found = false;
    for (const key of chosen) {
      if (remaining <= 0) break;
      const current = attrs[key] ?? 0;
      if (current < capOf(key)) { attrs[key] = current + 1; remaining--; found = true; }
    }
    if (!found && remaining > 0) {
      const allAvailable = availableAttrs.filter((k) => (attrs[k] ?? 0) < capOf(k));
      if (allAvailable.length > 0) {
        const key = randChoice(allAvailable);
        attrs[key] = (attrs[key] ?? 0) + 1;
        remaining--;
      } else break;
    }
  }
  if (!attrs.size) attrs.size = 1;
  return attrs;
}

const HP_PER_PT = 10;

/** A balanced 20-unit army composition: 6 Tanks, 7 Spiders, 7 Drones. */
function buildArmyComposition() {
  return [
    ...Array(6).fill('wheeledMovement'),
    ...Array(7).fill('limbMovement'),
    ...Array(7).fill('flightMovement'),
  ];
}

// ---------------------------------------------------------------------------
// Global live state
// ---------------------------------------------------------------------------
const allBuildings = [];
const allUnits = [];
const buildingSet = new Set();          // segKey of every building
const unitSet = new Set();              // segKey of every unit
const factionBuildingTiles = new Map(); // factionId → Set<tileIdx>
let buildingId = 0;
let unitId = 0;

function factionTiles(factionId) {
  if (!factionBuildingTiles.has(factionId)) factionBuildingTiles.set(factionId, new Set());
  return factionBuildingTiles.get(factionId);
}

function occupiedCount(tileIdx) {
  const sides = sidesOf(tileIdx);
  let n = 0;
  for (let s = 0; s < sides; s++) {
    const k = segKey(tileIdx, s);
    if (buildingSet.has(k) || unitSet.has(k)) n++;
  }
  return n;
}

function firstFreeSegment(tileIdx) {
  const sides = sidesOf(tileIdx);
  for (let s = 0; s < sides; s++) {
    const k = segKey(tileIdx, s);
    if (!buildingSet.has(k) && !unitSet.has(k)) return s;
  }
  return -1;
}

function addBuilding(factionId, tileIdx, segment, attrs) {
  allBuildings.push({ id: `building_${buildingId++}`, ownerId: factionId, tileIndex: tileIdx, segment, attributes: attrs });
  buildingSet.add(segKey(tileIdx, segment));
  factionTiles(factionId).add(tileIdx);
}

function addUnit(factionId, tileIdx, segment, attrs, facing) {
  const size = attrs.size ?? 1;
  allUnits.push({
    id: `unit_${unitId++}`,
    label: generateUnitName(attrs),
    ownerId: factionId,
    tileIndex: tileIdx,
    segment,
    facing,
    attributes: attrs,
    currentHealth: size * HP_PER_PT,
  });
  unitSet.add(segKey(tileIdx, segment));
}

// ---------------------------------------------------------------------------
// City population — dozens of buildings, all street-rule legal
// ---------------------------------------------------------------------------
const BUILDING_LOADOUTS = [
  { kinetic: 3, rangeAttack: 2 },  // gun turret
  { defence: 4 },                  // EW / jamming dish
  { repair: 3 },                   // repair bay
  { antiAir: 4 },                  // AA battery
  { armour: 3, kinetic: 1 },       // bunker
  { splashAttack: 3, kinetic: 1 }, // artillery emplacement
  { rangeAttack: 4, kinetic: 1 },  // long-range battery
  { defence: 2, repair: 2 },       // command post
];

/**
 * Populate a city: own a contiguous footprint of buildable hexes around the
 * capital and greedily fill segments with buildings, validating every single
 * placement through the street-navigation rules. Returns the owned hexes.
 */
function populateCity(factionId, capIdx, radius, maxBuildings) {
  const layers = bfsLandLayers(capIdx, radius + 1);
  const ownedHexes = [];
  for (const layer of layers) {
    for (const idx of layer) {
      // Exclude tiles hosting a seeded well/refinery — those are map-only and
      // must not become part of the city footprint (the "not in the city" rule).
      if (isBuildable(idx) && !logisticsStructureTiles.has(idx)) ownedHexes.push(idx);
    }
  }
  if (!ownedHexes.includes(capIdx)) ownedHexes.unshift(capIdx);

  const state = { buildingSet, unitSet, factionBuildingTiles: factionTiles(factionId), cityHexes: ownedHexes };

  // Founding building on the capital (free, skips contiguity).
  let founded = false;
  for (let s = 0; s < sidesOf(capIdx); s++) {
    if (validatePlacement(state, capIdx, s, true)) {
      addBuilding(factionId, capIdx, s, BUILDING_LOADOUTS[0]);
      founded = true;
      break;
    }
  }
  if (!founded) {
    console.warn(`  ${factionId}: could not found capital building on ${capIdx}`);
    return ownedHexes;
  }

  let count = 1;
  let loadoutIdx = 1;
  let changed = true;
  // Greedy multi-pass fixpoint: keep adding legal buildings until none fit or cap.
  while (changed && count < maxBuildings) {
    changed = false;
    for (const hex of ownedHexes) {
      const sides = sidesOf(hex);
      for (let s = 0; s < sides && count < maxBuildings; s++) {
        if (buildingSet.has(segKey(hex, s)) || unitSet.has(segKey(hex, s))) continue;
        if (validatePlacement(state, hex, s, false)) {
          addBuilding(factionId, hex, s, BUILDING_LOADOUTS[loadoutIdx % BUILDING_LOADOUTS.length]);
          loadoutIdx++;
          count++;
          changed = true;
        }
      }
    }
  }

  console.log(`  City ${factionId} @${capIdx}: ${count} buildings across ${ownedHexes.length} hexes`);
  return ownedHexes;
}

/** Place a few garrison units on open segments inside the city footprint. */
function garrisonCity(factionId, ownedHexes, capIdx, count) {
  const capDist = bfsDistances(capIdx);
  let placed = 0;
  for (const hex of ownedHexes) {
    if (placed >= count) break;
    const seg = firstFreeSegment(hex);
    if (seg < 0) continue;
    const attrs = makeRandomUnit(randChoice(['wheeledMovement', 'limbMovement', 'flightMovement']), 27);
    // Garrison faces outward (toward attackers approaching from outside).
    addUnit(factionId, hex, seg, attrs, facingToward(hex, capDist, false));
    placed++;
  }
  console.log(`  Garrison ${factionId}: ${placed} units`);
}

// ---------------------------------------------------------------------------
// Army staging
// ---------------------------------------------------------------------------

/** Spawn an army onto a set of front tiles, fixing terrain violations by BFS. */
function spawnArmy(factionId, frontTiles, facingSeg, budget = 27) {
  const comp = buildArmyComposition();
  let placed = 0;
  for (const movAttr of comp) {
    const attrs = makeRandomUnit(movAttr, budget);
    const valid = (idx) => {
      if (!isLand(idx)) return false;
      if (movAttr === 'wheeledMovement') return isTankFriendly(idx);
      if (movAttr === 'limbMovement') return isSpiderFriendly(idx);
      return isDroneFriendly(idx);
    };
    // Prefer a terrain-valid front tile with a free segment.
    let target = frontTiles.find((t) => valid(t) && occupiedCount(t) < sidesOf(t));
    if (target === undefined) {
      // BFS outward from the first front tile to find any valid tile with space.
      const start = frontTiles[0];
      const visited = new Set([start]);
      const queue = [start];
      let head = 0;
      while (head < queue.length && target === undefined) {
        const cur = queue[head++];
        if (valid(cur) && occupiedCount(cur) < sidesOf(cur)) { target = cur; break; }
        for (const nb of neighboursOf(cur)) {
          if (!visited.has(nb) && isLand(nb)) { visited.add(nb); queue.push(nb); }
        }
      }
    }
    if (target === undefined) continue;
    const seg = firstFreeSegment(target);
    if (seg < 0) continue;
    addUnit(factionId, target, seg, attrs, facingSeg(target));
    placed++;
  }
  return placed;
}

/** Collect a staging cluster of land tiles just outside a city footprint. */
function stagingCluster(capIdx, ownedSet, ringDist, count) {
  const layers = bfsLandLayers(capIdx, ringDist + 2);
  const out = [];
  for (let d = ringDist; d < layers.length && out.length < count; d++) {
    for (const idx of layers[d]) {
      if (!ownedSet.has(idx) && isLand(idx)) out.push(idx);
      if (out.length >= count) break;
    }
  }
  return out;
}

/** Build two opposing fronts separated by a gap, for an open-field battle. */
function buildBattleField(seedIdx) {
  const layers = bfsLandLayers(seedIdx, 9);
  if (layers.length < 6) return null;
  const pick = (layerArr, n) => {
    const seen = new Set();
    const res = [];
    for (const layer of layerArr) {
      for (const idx of layer) {
        if (!seen.has(idx)) { seen.add(idx); res.push(idx); if (res.length >= n) return res; }
      }
    }
    return res;
  };
  const playerFront = pick([layers[0], layers[1], layers[2]], 8);
  const gap = pick([layers[3]], 2);
  const enemyFront = pick([layers[5], layers[6], layers[7] ?? []], 8);
  if (playerFront.length < 5 || enemyFront.length < 5 || gap.length < 1) return null;
  return { playerFront, enemyFront, centre: gap[Math.floor(gap.length / 2)] };
}

// ---------------------------------------------------------------------------
// Orchestration — build all regions
// ---------------------------------------------------------------------------
const cityCenter = new Map();
for (const c of world.cities) cityCenter.set(c.id, c.tileIndex);

const ownedByFaction = new Map(); // factionId → ownedHexes[]

// ---------------------------------------------------------------------------
// Reserve seeded-logistics segments before populating city buildings.
//
// The seeded network (carried in world.logistics) is placed by generateWorld
// BEFORE this script runs. Its in-city Distribution_Hub sits on a segment of the
// player-capital tile; the well/refinery sit on open-map tiles. Buildings and
// garrison/army units must never share a segment with these structures (the
// "a hub can't share a segment with an existing building" rule). Adding each
// occupied segment to `buildingSet` makes every placement check (validatePlacement,
// through-street, orphaned-pocket, firstFreeSegment) treat it as blocked, so the
// founding building and every later building/unit avoid it.
// ---------------------------------------------------------------------------
// Tiles hosting a seeded Oil_Well or Refinery. These are map-only structures that
// must NOT sit inside a city, so populateCity excludes them from a city footprint
// (Distribution_Hubs are intentionally allowed in the city and are NOT excluded).
const logisticsStructureTiles = new Set();
function reserveLogisticsSegments() {
  const L = world.logistics;
  if (!L) return 0;
  let reserved = 0;
  const reserve = (tileIdx, segment) => {
    if (tileIdx === undefined || segment === undefined) return;
    if (!tileByIndex.has(tileIdx)) return;
    const k = segKey(tileIdx, segment);
    if (!buildingSet.has(k)) { buildingSet.add(k); reserved++; }
  };
  for (const w of L.wells ?? []) { reserve(w.tileIndex, w.segment); logisticsStructureTiles.add(w.tileIndex); }
  for (const r of L.refineries ?? []) {
    for (const s of r.segments ?? []) reserve(r.tileIndex, s);
    logisticsStructureTiles.add(r.tileIndex);
  }
  for (const h of L.hubs ?? []) reserve(h.tileIndex, h.segment); // hubs may sit in the city
  return reserved;
}
const reservedSegs = reserveLogisticsSegments();
console.log(
  `Reserved ${reservedSegs} seeded-logistics segment(s) from building placement; ` +
    `${logisticsStructureTiles.size} well/refinery tile(s) excluded from city footprints.`,
);

// ── Region A: Player capital + DEFENCE (enemy besieges it) ─────────────────
console.log('\nRegion A — player capital defence:');
const playerCapIdx = cityCenter.get(PLAYER_CITY_ID);
const playerOwned = populateCity(PLAYER_CITY_ID, playerCapIdx, 2, 55);
ownedByFaction.set(PLAYER_CITY_ID, playerOwned);
garrisonCity(PLAYER_CITY_ID, playerOwned, playerCapIdx, 6);

{
  const ownedSet = new Set(playerOwned);
  const staging = stagingCluster(playerCapIdx, ownedSet, 3, 8);
  if (staging.length >= 5) {
    const capDist = bfsDistances(playerCapIdx);
    const facing = (tile) => facingToward(tile, capDist, true); // face toward capital
    const n = spawnArmy(ENEMY_ASSAULT_ID, staging, facing);
    console.log(`  Enemy assault army (${ENEMY_ASSAULT_ID}): ${n} units besieging`);
  } else {
    console.warn('  Could not stage enemy assault army (no room).');
  }
}

// ── Region B: Enemy capital + ATTACK (player besieges it) ──────────────────
console.log('\nRegion B — enemy capital attack:');
const enemyCapIdx = cityCenter.get(ENEMY_CITY_ID);
const enemyOwned = populateCity(ENEMY_CITY_ID, enemyCapIdx, 2, 55);
ownedByFaction.set(ENEMY_CITY_ID, enemyOwned);
garrisonCity(ENEMY_CITY_ID, enemyOwned, enemyCapIdx, 6);

{
  const ownedSet = new Set(enemyOwned);
  const staging = stagingCluster(enemyCapIdx, ownedSet, 3, 8);
  if (staging.length >= 5) {
    const capDist = bfsDistances(enemyCapIdx);
    const facing = (tile) => facingToward(tile, capDist, true); // face toward enemy capital
    const n = spawnArmy(PLAYER_CITY_ID, staging, facing);
    console.log(`  Player assault army (${PLAYER_CITY_ID}): ${n} units attacking`);
  } else {
    console.warn('  Could not stage player assault army (no room).');
  }
}

// ── Regions C & D: open-field battles ──────────────────────────────────────
function openFieldBattle(label, seedScanStart, seedScanEnd, enemyFaction) {
  console.log(`\nRegion ${label} — open-field battle:`);
  let seed = findGoodSeed(seedScanStart, seedScanEnd);
  let field = seed !== null ? buildBattleField(seed) : null;
  for (let s = (seed ?? seedScanStart) + 50; field === null && s < seedScanEnd; s += 50) {
    if (isLand(s)) field = buildBattleField(s);
  }
  if (!field) { console.warn(`  Region ${label}: no suitable battlefield found.`); return null; }

  const distFromPlayer = bfsDistances(field.playerFront[0]);
  const pFacing = (tile) => facingToward(tile, distFromPlayer, false); // face toward enemy (away)
  const eFacing = (tile) => facingToward(tile, distFromPlayer, true);  // face toward player
  const np = spawnArmy(PLAYER_CITY_ID, field.playerFront, pFacing);
  const ne = spawnArmy(enemyFaction, field.enemyFront, eFacing);
  console.log(`  Player ${np} vs ${enemyFaction} ${ne}, centre tile ${field.centre}`);
  return field.centre;
}

openFieldBattle('C', 9000, 12000, ENEMY_FIELD_A);
openFieldBattle('D', 38000, 45000, ENEMY_FIELD_B);

// ---------------------------------------------------------------------------
// Build the save payload (compact format)
// ---------------------------------------------------------------------------
const save = {
  format: 'compact',
  seed: world.seed,
  cities: world.cities.map((c) => {
    const owned = ownedByFaction.get(c.id);
    const isHome = c.id === PLAYER_CITY_ID;
    return {
      ...c,
      isPlayerHome: isHome,
      ownerId: c.id,
      ...(owned ? { ownedHexes: owned } : { ownedHexes: [c.tileIndex] }),
    };
  }),
  units: allUnits,
  buildings: allBuildings,
  playerColor: '#00e5ff',
  battleCentreTile: playerCapIdx, // open on the player capital + its siege
  // Carry the seeded example logistics network from world.json (Oil Logistics
  // System — Req 13). world.json is generated with DEFAULT_SEED and this save
  // keeps the same seed + city_0 as the player home, so the network's tile /
  // home-city anchors stay valid when the client regenerates tiles from the seed.
  ...(world.logistics ? { logistics: world.logistics } : {}),
};

writeFileSync(outPath, JSON.stringify(save, null, 2));

console.log(`\nSaved to ${outPath}`);
console.log(`  Total: ${allBuildings.length} buildings, ${allUnits.length} units`);
console.log(`  Player home: ${PLAYER_CITY_ID} @ tile ${playerCapIdx}`);
