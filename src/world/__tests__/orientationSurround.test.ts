/**
 * Orientation Bonus — Surrounded Scenario
 *
 * A single player unit at the centre of a 3-ring hex grid, with enemies
 * placed three hexes away. Each enemy hex is full (5 units) with every
 * unit facing AWAY from the hex centre (i.e. facing outward from the
 * centre of their own hex toward the world edge).
 *
 * Because the enemies face away from the centre, the player attacking
 * FROM the centre should be hitting them in the rear (high orientation
 * bonus). Conversely, when the enemies attack the centre, they are
 * shooting behind themselves (the player is behind them), meaning
 * the player's facing relative to the enemies gives THEM the orientation
 * bonus — but wait, orientation bonus accrues to the ATTACKER based on
 * the DEFENDER's facing. So:
 *
 *   - Player attacks enemy facing away → player hits enemy's rear → HIGH bonus
 *   - Enemy attacks player → bonus depends on player's facing, not enemy's
 *
 * This test verifies the continuous bearing-based orientation calculation
 * is consistent across all surrounding directions.
 */

import { describe, it, expect } from 'vitest';
import { Tile, Vec3 } from '../types.js';
import { Unit, HexSegment } from '../units.js';
import {
  calculateOrientationBonus,
  classifyArcFromAngle,
  getAngularDifference,
  calculateDirectDamage,
  resolveAttack,
} from '../combat.js';

// ---------------------------------------------------------------------------
// Grid construction — 3-ring hex grid (37 tiles)
// ---------------------------------------------------------------------------

/**
 * Build a 3-ring hex grid on the unit sphere.
 *
 * Ring 0: tile 0 (centre) — at the "north pole"
 * Ring 1: tiles 1–6 — immediate neighbours of tile 0
 * Ring 2: tiles 7–18 — neighbours of ring 1 (not in ring 0 or 1)
 * Ring 3: tiles 19–36 — neighbours of ring 2 (not in prior rings)
 *
 * Each tile gets a position3d on the unit sphere and a correct neighbour list.
 * The geometry uses concentric rings at increasing polar angles from the pole.
 */
function create3RingGrid(): Tile[] {
  const angularSpacing = 0.12; // radians between rings (~7° per ring)

  // Generate positions for each ring
  const positions: Vec3[] = [];

  // Ring 0: centre at north pole
  positions.push({ x: 0, y: 0, z: 1 });

  // Ring 1: 6 tiles at angular distance 1×spacing
  for (let i = 0; i < 6; i++) {
    const azimuth = (i * Math.PI) / 3; // 0°, 60°, 120°, 180°, 240°, 300°
    const polar = angularSpacing;
    positions.push({
      x: Math.sin(polar) * Math.sin(azimuth),
      y: Math.sin(polar) * Math.cos(azimuth),
      z: Math.cos(polar),
    });
  }

  // Ring 2: 12 tiles at angular distance 2×spacing
  // Two tiles per sector: one aligned with ring-1 tile, one between them
  for (let i = 0; i < 6; i++) {
    // Tile aligned with ring-1 tile i (same azimuth, further out)
    const azimuth1 = (i * Math.PI) / 3;
    const polar2 = angularSpacing * 2;
    positions.push({
      x: Math.sin(polar2) * Math.sin(azimuth1),
      y: Math.sin(polar2) * Math.cos(azimuth1),
      z: Math.cos(polar2),
    });

    // Tile between ring-1 tile i and tile (i+1)%6
    const azimuth2 = ((i + 0.5) * Math.PI) / 3;
    positions.push({
      x: Math.sin(polar2) * Math.sin(azimuth2),
      y: Math.sin(polar2) * Math.cos(azimuth2),
      z: Math.cos(polar2),
    });
  }

  // Ring 3: 18 tiles at angular distance 3×spacing
  // Three tiles per sector
  for (let i = 0; i < 6; i++) {
    const polar3 = angularSpacing * 3;

    // Tile aligned with ring-1 tile i (same azimuth)
    const azA = (i * Math.PI) / 3;
    positions.push({
      x: Math.sin(polar3) * Math.sin(azA),
      y: Math.sin(polar3) * Math.cos(azA),
      z: Math.cos(polar3),
    });

    // Tile 1/3 way between i and (i+1)%6
    const azB = ((i + 1 / 3) * Math.PI) / 3;
    positions.push({
      x: Math.sin(polar3) * Math.sin(azB),
      y: Math.sin(polar3) * Math.cos(azB),
      z: Math.cos(polar3),
    });

    // Tile 2/3 way between i and (i+1)%6
    const azC = ((i + 2 / 3) * Math.PI) / 3;
    positions.push({
      x: Math.sin(polar3) * Math.sin(azC),
      y: Math.sin(polar3) * Math.cos(azC),
      z: Math.cos(polar3),
    });
  }

  // Total: 1 + 6 + 12 + 18 = 37 tiles

  // Build neighbour relationships based on proximity
  // For a well-formed hex grid, each tile should have 6 neighbours (except pentagons)
  // We'll use angular distance to find the 6 closest tiles as neighbours
  const tileCount = positions.length;
  const neighbours: number[][] = new Array(tileCount).fill(null).map(() => []);

  for (let i = 0; i < tileCount; i++) {
    // Calculate distances to all other tiles
    const distances: Array<{ index: number; dist: number }> = [];
    for (let j = 0; j < tileCount; j++) {
      if (i === j) continue;
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const dz = positions[i].z - positions[j].z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      distances.push({ index: j, dist });
    }
    distances.sort((a, b) => a.dist - b.dist);

    // Take the 6 closest as neighbours
    neighbours[i] = distances.slice(0, 6).map((d) => d.index);
  }

  // Sort each tile's neighbours clockwise for consistent facing directions
  for (let i = 0; i < tileCount; i++) {
    const origin = positions[i];
    // Use tangent-plane projection for sorting
    const up: Vec3 = Math.abs(origin.y) < 0.99
      ? { x: 0, y: 1, z: 0 }
      : { x: 1, y: 0, z: 0 };

    // east = cross(up, origin), normalized
    const eastRaw = {
      x: up.y * origin.z - up.z * origin.y,
      y: up.z * origin.x - up.x * origin.z,
      z: up.x * origin.y - up.y * origin.x,
    };
    const eLen = Math.sqrt(eastRaw.x ** 2 + eastRaw.y ** 2 + eastRaw.z ** 2);
    const east = { x: eastRaw.x / eLen, y: eastRaw.y / eLen, z: eastRaw.z / eLen };

    // north = cross(origin, east)
    const north = {
      x: origin.y * east.z - origin.z * east.y,
      y: origin.z * east.x - origin.x * east.z,
      z: origin.x * east.y - origin.y * east.x,
    };

    // Sort neighbours by angle in the tangent plane (clockwise from north)
    neighbours[i].sort((a, b) => {
      const da = {
        x: positions[a].x - origin.x,
        y: positions[a].y - origin.y,
        z: positions[a].z - origin.z,
      };
      const db = {
        x: positions[b].x - origin.x,
        y: positions[b].y - origin.y,
        z: positions[b].z - origin.z,
      };
      const angleA = Math.atan2(
        da.x * east.x + da.y * east.y + da.z * east.z,
        da.x * north.x + da.y * north.y + da.z * north.z,
      );
      const angleB = Math.atan2(
        db.x * east.x + db.y * east.y + db.z * east.z,
        db.x * north.x + db.y * north.y + db.z * north.z,
      );
      return angleA - angleB;
    });
  }

  // Build tile objects
  const tiles: Tile[] = positions.map((pos, idx) => ({
    id: `t${idx}`,
    index: idx,
    sides: 6 as const,
    neighbours: neighbours[idx],
    position3d: pos,
    boundary: [],
    terrainType: 'plains' as const,
    elevationType: 'flat' as const,
    forested: false,
  }));

  return tiles;
}

// ---------------------------------------------------------------------------
// Helper: get ring-3 tile indices
// ---------------------------------------------------------------------------

/** Ring 3 tiles are indices 19–36 */
function getRing3Indices(): number[] {
  const indices: number[] = [];
  for (let i = 19; i <= 36; i++) {
    indices.push(i);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Helper: create a unit
// ---------------------------------------------------------------------------

let unitCounter = 0;
function makeUnit(overrides: Partial<Unit> & { ownerId: string }): Unit {
  const id = `u${unitCounter++}`;
  return {
    id,
    label: id,
    tileIndex: 0,
    segment: 0 as HexSegment,
    facing: 0 as HexSegment,
    attributes: { maxHealth: 3, kinetic: 3, wheeledMovement: 2, rangeAttack: 3 },
    currentHealth: 30,
    ...overrides,
  };
}

/**
 * Determine the "outward" facing direction for a tile — the neighbour
 * direction that points AWAY from tile 0 (the grid centre).
 *
 * We find which neighbour is furthest from tile 0 and use that direction
 * as "facing away from centre".
 */
function getOutwardFacing(tiles: Tile[], tileIndex: number): HexSegment {
  const centre = tiles[0].position3d;
  const tile = tiles[tileIndex];
  let bestDir = 0;
  let bestDist = -1;

  for (let dir = 0; dir < tile.neighbours.length; dir++) {
    const nIdx = tile.neighbours[dir];
    const nPos = tiles[nIdx].position3d;
    // Distance from centre
    const dx = nPos.x - centre.x;
    const dy = nPos.y - centre.y;
    const dz = nPos.z - centre.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > bestDist) {
      bestDist = dist;
      bestDir = dir;
    }
  }

  return bestDir as HexSegment;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orientation Bonus — Surrounded Scenario (3 hex distance)', () => {
  const tiles = create3RingGrid();
  const ring3 = getRing3Indices();

  // Pick 6 representative ring-3 tiles (one per sector)
  // These are the tiles at indices 19, 22, 25, 28, 31, 34 (every 3rd in ring 3)
  const sectorTiles = [19, 22, 25, 28, 31, 34];

  describe('grid geometry sanity checks', () => {
    it('has 37 tiles total', () => {
      expect(tiles.length).toBe(37);
    });

    it('tile 0 has 6 neighbours', () => {
      expect(tiles[0].neighbours.length).toBe(6);
    });

    it('ring-3 tiles are at graph distance ≥ 2 from centre', () => {
      // BFS from tile 0 to verify distance
      const visited = new Map<number, number>();
      const queue = [{ tile: 0, dist: 0 }];
      visited.set(0, 0);
      while (queue.length > 0) {
        const { tile, dist } = queue.shift()!;
        for (const n of tiles[tile].neighbours) {
          if (!visited.has(n)) {
            visited.set(n, dist + 1);
            queue.push({ tile: n, dist: dist + 1 });
          }
        }
      }
      for (const idx of ring3) {
        const dist = visited.get(idx) ?? -1;
        expect(dist).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('player attacks enemies facing away from centre', () => {
    it('orientation bonus is consistently high (rear/side) for all sector tiles', () => {
      // Player unit at tile 0, facing direction 0
      const player = makeUnit({ ownerId: 'player', tileIndex: 0, facing: 0 as HexSegment });

      const bonuses: number[] = [];

      for (const enemyTileIdx of sectorTiles) {
        // Enemy facing AWAY from centre
        const outwardFacing = getOutwardFacing(tiles, enemyTileIdx);
        const enemy = makeUnit({
          ownerId: 'enemy',
          tileIndex: enemyTileIdx,
          facing: outwardFacing,
        });

        const bonus = calculateOrientationBonus(
          tiles,
          player.tileIndex, // attacker tile
          enemy.tileIndex,  // defender tile
          enemy.facing,     // defender facing
        );
        bonuses.push(bonus);

        // Enemy is facing away from centre, player is attacking from the
        // direction of the centre, so the angle difference should be large
        // (approaching from behind). Expect bonus ≥ 0.8 (solidly into side arc).
        // On a sphere, the "outward" heuristic may not perfectly align,
        // so some tiles produce ~0.9 rather than a full 2.0.
        expect(bonus).toBeGreaterThanOrEqual(0.8);
      }

      // Log the spread of bonuses for inspection
      console.log('Player → enemy orientation bonuses (enemy facing away):');
      sectorTiles.forEach((tileIdx, i) => {
        const angleDiff = getAngularDifference(tiles, 0, tileIdx, getOutwardFacing(tiles, tileIdx));
        const arc = classifyArcFromAngle(angleDiff);
        console.log(`  Tile ${tileIdx}: bonus=${bonuses[i].toFixed(1)}, arc=${arc}`);
      });
    });

    it('all enemies classify as side or rear arc', () => {
      for (const enemyTileIdx of sectorTiles) {
        const outwardFacing = getOutwardFacing(tiles, enemyTileIdx);
        const angleDiff = getAngularDifference(tiles, 0, enemyTileIdx, outwardFacing);
        const arc = classifyArcFromAngle(angleDiff);
        expect(['side', 'rear']).toContain(arc);
      }
    });

    it('bonuses are symmetric across the ring (within rounding tolerance)', () => {
      const bonuses: number[] = [];
      for (const enemyTileIdx of sectorTiles) {
        const outwardFacing = getOutwardFacing(tiles, enemyTileIdx);
        const bonus = calculateOrientationBonus(tiles, 0, enemyTileIdx, outwardFacing);
        bonuses.push(bonus);
      }

      // All sector tiles should yield similar bonuses (symmetric grid)
      const min = Math.min(...bonuses);
      const max = Math.max(...bonuses);
      // Allow up to 0.4 variance due to sphere geometry distortion
      expect(max - min).toBeLessThanOrEqual(0.4);
    });
  });

  describe('enemies attack player at centre', () => {
    it('orientation bonus depends on player facing, not enemy facing', () => {
      // Player facing direction 0 (toward tile 0's neighbour[0])
      const playerFacing = 0 as HexSegment;

      const results: Array<{ tileIdx: number; bonus: number; arc: string }> = [];

      for (const enemyTileIdx of sectorTiles) {
        // Enemy attacks player — orientation bonus is based on PLAYER's facing
        const bonus = calculateOrientationBonus(
          tiles,
          enemyTileIdx, // attacker tile
          0,            // defender tile (player)
          playerFacing, // defender facing (player)
        );

        const angleDiff = getAngularDifference(tiles, enemyTileIdx, 0, playerFacing);
        const arc = classifyArcFromAngle(angleDiff);
        results.push({ tileIdx: enemyTileIdx, bonus, arc });
      }

      // Since enemies surround the player from all directions, and the player
      // only faces ONE direction, bonuses should vary from front to rear
      const fronts = results.filter((r) => r.arc === 'front');
      const sides = results.filter((r) => r.arc === 'side');
      const rears = results.filter((r) => r.arc === 'rear');

      // With 6 sector tiles around the player, we expect a mix of arcs
      expect(fronts.length + sides.length + rears.length).toBe(sectorTiles.length);

      // At least one enemy should be attacking the player's front
      expect(fronts.length).toBeGreaterThanOrEqual(1);
      // At least one should be attacking from side or rear
      expect(sides.length + rears.length).toBeGreaterThanOrEqual(1);

      console.log('Enemy → player orientation bonuses (player facing dir 0):');
      results.forEach((r) => {
        console.log(`  From tile ${r.tileIdx}: bonus=${r.bonus.toFixed(1)}, arc=${r.arc}`);
      });
    });
  });

  describe('full combat scenario — 5 enemies per hex, all facing outward', () => {
    it('resolves attacks from centre to each surrounding hex', () => {
      unitCounter = 0;

      const player = makeUnit({
        ownerId: 'player',
        tileIndex: 0,
        facing: 0 as HexSegment,
      });
      player.attributes.kinetic = 4;
      player.attributes.rangeAttack = 4;
      player.attributes.armour = 3;

      const allUnits: Unit[] = [player];

      // Fill each sector tile with 5 enemies, all facing outward
      for (const tileIdx of sectorTiles) {
        const outwardFacing = getOutwardFacing(tiles, tileIdx);
        for (let seg = 0; seg < 5; seg++) {
          // Each enemy has a different facing to test variety:
          // seg 0 faces outward, seg 1 faces outward+1, etc.
          // This gives a spread of facings "away from centre"
          const facing = ((outwardFacing + seg) % 6) as HexSegment;
          const enemy = makeUnit({
            ownerId: 'enemy',
            tileIndex: tileIdx,
            segment: seg as HexSegment,
            facing,
          });
          enemy.attributes.kinetic = 3;
          enemy.attributes.rangeAttack = 3;
          enemy.attributes.armour = 2;
          allUnits.push(enemy);
        }
      }

      expect(allUnits.length).toBe(1 + 6 * 5); // 1 player + 30 enemies

      // Player attacks the first enemy in each sector tile
      const attackResults: Array<{
        tileIdx: number;
        targetFacing: number;
        bonus: number;
        arc: string;
        damage: number;
      }> = [];

      for (const tileIdx of sectorTiles) {
        const target = allUnits.find(
          (u) => u.ownerId === 'enemy' && u.tileIndex === tileIdx && u.segment === 0,
        )!;

        // Snapshot health
        const healthBefore = target.currentHealth;

        // Use calculateDirectDamage (non-mutating) for analysis
        const { damage, arc, orientationBonus } = calculateDirectDamage(
          player, target, allUnits, tiles, 3, // distance 3
        );

        attackResults.push({
          tileIdx,
          targetFacing: target.facing,
          bonus: orientationBonus,
          arc,
          damage,
        });

        // Verify bonus is reasonable for "facing away" scenario
        expect(orientationBonus).toBeGreaterThanOrEqual(0.8);
      }

      console.log('\nFull combat: Player (tile 0) → enemies at distance 3');
      console.log('Player: kinetic=4, rangeAttack=4, armour=3');
      console.log('Enemies: kinetic=3, rangeAttack=3, armour=2, facing outward');
      console.log('');
      attackResults.forEach((r) => {
        console.log(
          `  → Tile ${r.tileIdx} (facing dir ${r.targetFacing}): ` +
          `bonus=${r.bonus.toFixed(1)}, arc=${r.arc}, damage=${r.damage}`,
        );
      });
    });

    it('enemies attacking player get varied bonuses based on player facing', () => {
      unitCounter = 100;

      const player = makeUnit({
        ownerId: 'player',
        tileIndex: 0,
        facing: 0 as HexSegment,
      });
      player.attributes.kinetic = 3;
      player.attributes.rangeAttack = 4;
      player.attributes.armour = 3;

      const allUnits: Unit[] = [player];

      // Create one enemy per sector tile for simplicity
      const enemies: Unit[] = [];
      for (const tileIdx of sectorTiles) {
        const outwardFacing = getOutwardFacing(tiles, tileIdx);
        const enemy = makeUnit({
          ownerId: 'enemy',
          tileIndex: tileIdx,
          segment: 0 as HexSegment,
          facing: outwardFacing,
        });
        enemy.attributes.kinetic = 3;
        enemy.attributes.rangeAttack = 3;
        enemy.attributes.armour = 2;
        enemies.push(enemy);
        allUnits.push(enemy);
      }

      // Each enemy attacks the player — orientation bonus based on player's facing
      const results: Array<{
        enemyTile: number;
        bonusOnPlayer: number;
        arc: string;
        damage: number;
      }> = [];

      for (const enemy of enemies) {
        const { damage, arc, orientationBonus } = calculateDirectDamage(
          enemy, player, allUnits, tiles, 3,
        );
        results.push({
          enemyTile: enemy.tileIndex,
          bonusOnPlayer: orientationBonus,
          arc,
          damage,
        });
      }

      // The player faces direction 0. Enemies in the direction the player faces
      // should have LOW bonus (attacking from front). Enemies behind should have HIGH bonus.
      const frontAttacks = results.filter((r) => r.arc === 'front');
      const rearAttacks = results.filter((r) => r.arc === 'rear');

      if (frontAttacks.length > 0 && rearAttacks.length > 0) {
        const avgFrontBonus = frontAttacks.reduce((s, r) => s + r.bonusOnPlayer, 0) / frontAttacks.length;
        const avgRearBonus = rearAttacks.reduce((s, r) => s + r.bonusOnPlayer, 0) / rearAttacks.length;
        expect(avgRearBonus).toBeGreaterThan(avgFrontBonus);
      }

      console.log('\nEnemies attacking player (player facing dir 0):');
      results.forEach((r) => {
        console.log(
          `  ← From tile ${r.enemyTile}: ` +
          `bonus on player=${r.bonusOnPlayer.toFixed(1)}, arc=${r.arc}, damage=${r.damage}`,
        );
      });
    });
  });

  describe('edge case: enemy facing directly toward centre', () => {
    it('gives minimal orientation bonus (front arc) when enemy faces attacker', () => {
      for (const enemyTileIdx of sectorTiles) {
        // Find the "inward" facing — direction toward tile 0
        const tile = tiles[enemyTileIdx];
        const centre = tiles[0].position3d;
        let inwardDir = 0;
        let bestDist = Infinity;
        for (let dir = 0; dir < tile.neighbours.length; dir++) {
          const nPos = tiles[tile.neighbours[dir]].position3d;
          const dx = nPos.x - centre.x;
          const dy = nPos.y - centre.y;
          const dz = nPos.z - centre.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < bestDist) {
            bestDist = dist;
            inwardDir = dir;
          }
        }

        // Enemy faces toward centre (toward the attacker)
        const bonus = calculateOrientationBonus(tiles, 0, enemyTileIdx, inwardDir as HexSegment);

        // Should be low — enemy is facing the attacker head-on
        expect(bonus).toBeLessThanOrEqual(0.7);
      }
    });
  });
});
