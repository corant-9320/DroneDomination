/**
 * DEBUG STATE — Machine-readable runtime snapshot of the running game.
 *
 * Purpose: let an automated agent (or a developer in the console) inspect what
 * the game *actually* believes is true at runtime — without screenshots.
 *
 * Two halves:
 *   1. installErrorCapture()  — records uncaught errors + promise rejections.
 *      Call this as early as possible (before anything else can throw).
 *   2. installDebugState(deps) — exposes window.__DD_STATE__ with a snapshot()
 *      function. Call once the main views are constructed.
 *
 * Consumed by scripts/debug-snapshot.mjs, which loads the page headless and
 * writes the snapshot + console log + errors + a screenshot to
 * artifacts/sessions/<timestamp>/ for an agent to read.
 *
 * Console usage:  window.__DD_STATE__.snapshot()
 */

import type { WorldData } from './worldData.js';
import type { LocalMapView } from './localMap.js';
import type { TurnManager } from './turnManager.js';
import { computeMovementRange } from './localMapMovement.js';
import { computeFacingAngle, angleToFacing } from './localMapGeometry.js';

interface CapturedError {
  message: string;
  stack?: string;
  source?: string;
  ts: number;
}

const capturedErrors: CapturedError[] = [];

/** Records uncaught errors and unhandled rejections into a readable buffer. */
export function installErrorCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e) => {
    capturedErrors.push({
      message: e.message,
      stack: (e.error as Error | undefined)?.stack,
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      ts: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | string | undefined;
    capturedErrors.push({
      message:
        typeof reason === 'string'
          ? `Unhandled rejection: ${reason}`
          : `Unhandled rejection: ${reason?.message ?? '(no message)'}`,
      stack: typeof reason === 'object' ? reason?.stack : undefined,
      ts: Date.now(),
    });
  });
}

export interface DebugStateDeps {
  world: WorldData;
  localMap: LocalMapView;
  turnManager: TurnManager;
}

/**
 * Exposes window.__DD_STATE__ = { snapshot(), errors }.
 *
 * snapshot() returns a plain, JSON-serialisable object describing the current
 * turn, selection, camera, and every unit's position / health / movement.
 */
export function installDebugState(deps: DebugStateDeps): void {
  if (typeof window === 'undefined') return;

  const snapshot = () => {
    const { world, localMap, turnManager } = deps;

    const units = world.units.map((u) => ({
      id: u.id,
      label: u.label,
      ownerId: u.ownerId,
      tileIndex: u.tileIndex,
      segment: u.segment,
      facing: u.facing,
      currentHealth: u.currentHealth,
      maxHealth: u.attributes.maxHealth,
      mp: localMap.getRemainingMovement(u.id),
      acted: localMap.hasActed(u.id),
    }));

    const byFaction: Record<string, number> = {};
    for (const u of units) byFaction[u.ownerId] = (byFaction[u.ownerId] ?? 0) + 1;

    return {
      capturedAt: new Date().toISOString(),
      seed: world.seed,
      turn: {
        number: turnManager.turnNumber,
        activeFaction: turnManager.getActiveFaction(),
        isPlayerTurn: turnManager.isPlayerTurn(),
      },
      counts: {
        tiles: world.tileCount,
        cities: world.cities.length,
        units: units.length,
        unitsByFaction: byFaction,
      },
      selection: {
        selectedTile: localMap.selectedTile,
        selectedSegment: localMap.selectedSegment,
        selectedUnitIds: [...localMap.getSelectedUnits()],
        centreTile: localMap.centreTileIndex,
        scale: localMap.scale,
      },
      units,
      errors: capturedErrors,
    };
  };

  (window as unknown as Record<string, unknown>).__DD_STATE__ = {
    snapshot,
    /**
     * Diagnostic: for a given unit, report which of its 6 hex-neighbours are
     * reachable by the movement-range Dijkstra and at what MP cost, alongside
     * the unit's segment/facing. Used to debug directional movement bias.
     */
    moveRange(unitId: string) {
      const { world, localMap } = deps;
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return null;
      const mp = localMap.getRemainingMovement(unitId);
      const res = computeMovementRange(world, unit, mp);
      const startTile = world.tiles[unit.tileIndex];
      const neighbours = (startTile as unknown as { n: number[] }).n ?? [];
      const neighbourReach = neighbours.map((nTile, dir) => {
        const nt = world.tiles[nTile] as unknown as { terrain?: string; elevType?: string; f?: boolean };
        return {
          dir,
          tile: nTile,
          terrain: nt?.terrain,
          elevType: nt?.elevType,
          forested: nt?.f,
          reachable: res.moveRangeTiles.has(nTile),
          cost: res.moveRangeTiles.get(nTile) ?? null,
        };
      });
      return {
        unit: { id: unit.id, label: unit.label, tile: unit.tileIndex, segment: unit.segment, facing: unit.facing, mp },
        reachableTileCount: res.moveRangeTiles.size,
        neighbourReach,
      };
    },

    /**
     * Facing pipeline diagnostic.
     *
     * Given two tile indices, shows every step of the facing calculation:
     * the world-space angle, the raw facing index, and the name of the
     * direction — so you can verify the math without moving a unit.
     *
     * Usage:
     *   window.__DD_STATE__.facing(fromTile, toTile)
     *   window.__DD_STATE__.facing(fromTile, toTile, 'planFacing', 3)
     *
     * @param fromTile   Source tile index
     * @param toTile     Destination tile index
     * @param label      Optional label (e.g. 'plan.facing')
     * @param planFacing Optional plan.facing value to compare against
     */
    facing(fromTile: number, toTile: number, label?: string, planFacing?: number) {
      const { localMap } = deps;
      const flatTiles = localMap.flatTiles;
      const tiles = localMap.world.tiles;

      const DIRECTION_NAMES = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

      const angle = computeFacingAngle(fromTile, toTile, flatTiles, tiles);
      const facing = angleToFacing(angle);

      // Also show raw screen-vector facing using actual screen positions
      const fromScreenPos = localMap.getUnitScreenPos !== undefined
        ? null  // can't call without a unit id; use world-space only
        : null;

      const ft1 = flatTiles.find(f => f.tileIndex === fromTile);
      const ft2 = flatTiles.find(f => f.tileIndex === toTile);
      const screenAngleDeg = ft1 && ft2
        ? Math.atan2(ft2.cx - ft1.cx, -(ft2.cy - ft1.cy)) * 180 / Math.PI
        : null;

      const result = {
        from: fromTile,
        to: toTile,
        inFlatView: !!ft1 && !!ft2,
        angle_rad: angle,
        angle_deg: angle * 180 / Math.PI,
        screenAngle_northClockwise_deg: screenAngleDeg,
        facing,
        direction: DIRECTION_NAMES[facing],
        ...(label !== undefined && planFacing !== undefined ? {
          [label]: planFacing,
          [`${label}_direction`]: DIRECTION_NAMES[planFacing % 6],
          match: planFacing === facing,
        } : {}),
      };
      console.table([result]);
      return result;
    },

    /**
     * Test angleToFacing for a given angle in degrees.
     * Useful to verify the quantization math directly.
     *
     * Usage:
     *   window.__DD_STATE__.testAngle(0)    // right  → expect facing 1 (NE) or 2 (SE)?
     *   window.__DD_STATE__.testAngle(90)   // down   → expect facing 3 (S)
     *   window.__DD_STATE__.testAngle(-90)  // up     → expect facing 0 (N)
     */
    testAngle(degrees: number) {
      const DIRECTION_NAMES = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
      const angle = degrees * Math.PI / 180;
      const facing = angleToFacing(angle);
      const result = { input_deg: degrees, facing, direction: DIRECTION_NAMES[facing] };
      console.log('testAngle:', result);
      return result;
    },

    /**
     * Show the full facing pipeline for all 6 neighbours of a unit's tile.
     *
     * Usage:
     *   window.__DD_STATE__.facingNeighbours('unit_1')
     */
    facingNeighbours(unitId: string) {
      const { localMap } = deps;
      const unit = localMap.world.units.find(u => u.id === unitId);
      if (!unit) { console.warn('unit not found:', unitId); return null; }

      const DIRECTION_NAMES = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
      const tile = localMap.world.tiles[unit.tileIndex];
      const flatTiles = localMap.flatTiles;
      const tiles = localMap.world.tiles;

      const rows = (tile.n as number[]).map((neighbourTile, dir) => {
        const angle = computeFacingAngle(unit.tileIndex, neighbourTile, flatTiles, tiles);
        const facing = angleToFacing(angle);
        const ft1 = flatTiles.find(f => f.tileIndex === unit.tileIndex);
        const ft2 = flatTiles.find(f => f.tileIndex === neighbourTile);
        return {
          neighbourIndex: dir,
          neighbourTile,
          angle_deg: Math.round(angle * 180 / Math.PI),
          screenAngle_northCW_deg: ft1 && ft2
            ? Math.round(Math.atan2(ft2.cx - ft1.cx, -(ft2.cy - ft1.cy)) * 180 / Math.PI)
            : 'off-screen',
          facing,
          direction: DIRECTION_NAMES[facing],
          isCurrent: dir === unit.facing ? '← current' : '',
        };
      });
      console.log(`Unit ${unitId} at tile ${unit.tileIndex}, current facing: ${unit.facing} (${DIRECTION_NAMES[unit.facing]})`);
      console.table(rows);
      return rows;
    },

    get errors() {
      return capturedErrors;
    },
  };
}
