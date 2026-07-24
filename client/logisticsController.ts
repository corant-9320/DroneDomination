/**
 * logisticsController.ts — client-side Oil Logistics build/upgrade actions.
 *
 * Maps player build / upgrade / clear / bridge / purchase actions to the
 * logistics `Intent` variants (`shared/matchTypes.ts`) and dispatches each one
 * through the SAME authoritative session path every other player action uses —
 * `ctx.matchClient.submit(intent)` (see `client/playerActions.ts`). The server
 * validates against the authoritative tiles + `LogisticsState`, charges
 * Refined_Product, mutates, and returns the updated `logistics` snapshot, which
 * we adopt back onto `world.logistics` so the renderer/HUD stay in sync. No new
 * transport is invented here; this reuses the established match-intent API.
 *
 * Road laying uses `findPath` (`shared/pathfinding.ts`) to preview the tile path
 * between two endpoints before a `buildRoute` intent is submitted, mirroring how
 * `buildController.ts` reuses the shared placement engine so the client never
 * disagrees with the server. `client/` never imports `src/` or `server/` — only
 * shared modules and sibling client modules.
 *
 * Requirements: 2.1 (build well), 4.1 (build refinery / segment), 6.1 (build
 * route), 6.7 (route tier upgrade), 8.11 (transport purchase/upgrade cap),
 * 9.1 (clear forest), 10.1 (build bridge).
 */

import { findPath, type PathTile } from '../shared/pathfinding.js';
import { findSegmentPath, encodeSeg, type SegGraphTile } from '../shared/segmentGraph.js';
import { segmentCost } from '../shared/movementConstants.js';
import type { Intent, MatchIntentResponse } from '../shared/matchTypes.js';
import type { GameContext } from './gameContext.js';
import { dbg } from './debug.js';

/**
 * Submit a logistics intent through the authoritative match session, exactly as
 * the attack/repair/move handlers do. On success the returned `logistics`
 * snapshot is adopted onto `world.logistics` (the server is the source of
 * truth); rejections are logged with the server's reason. Returns the response
 * (or null on a transport error).
 */
async function dispatchLogistics(
  ctx: GameContext,
  intent: Intent,
): Promise<MatchIntentResponse | null> {
  const { matchClient, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Logistics action blocked — not player turn:', intent.kind);
    return null;
  }

  const resp = await matchClient.submit(intent);
  if (!resp || !resp.success) {
    if (resp?.error) dbg.input.log('Logistics intent rejected by server:', intent.kind, resp.error);
    return resp ?? null;
  }

  // Adopt the complete authoritative response, including completed bridge and
  // cleared-forest tile overlays after a task resolves on end turn.
  ctx.matchClient.reconcile(resp, ctx.world, ctx.turnManager);

  return resp;
}

// ─── Engineer tasks (well / bridge / clear) ───────────────────────────────────

/** Order an engineer to drill an Oil_Well on its current segment (Req 2.1). */
export function buildOilWell(ctx: GameContext, unitId: string): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildOilWell', unitId });
}

/** Queue a bridge task for a selected impassable tile. Unit-free actions need server God Mode. */
export function buildBridge(
  ctx: GameContext,
  tileIndex: number,
  unitId?: string,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildBridge', tileIndex, unitId });
}

/** Queue a forest-clearing task for a selected tile. Unit-free actions need server God Mode. */
export function clearForest(
  ctx: GameContext,
  tileIndex: number,
  unitId?: string,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'clearForest', tileIndex, unitId });
}

/**
 * Order an engineer to pave the road segment it is standing on. Completes as a
 * timed `road` EngineerTask, like bridge/forest work; pave segment by segment
 * along a path to connect two structures so a shuttle transport can run.
 */
export function buildRoadSegment(
  ctx: GameContext,
  unitId: string,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildRoadSegment', unitId });
}

/** Build a server-authoritative, development-only road overlay on one empty segment. */
export function buildStandaloneRoad(
  ctx: GameContext,
  tileIndex: number,
  segment: number,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'godModeBuildRoad', tileIndex, segment });
}

/** Development-only segment-based oil-building CRUD. */
export function godModeCreateOilBuilding(
  ctx: GameContext,
  structure: 'well' | 'refinery',
  tileIndex: number,
  segment: number,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'godModeCreateOilBuilding', structure, tileIndex, segment });
}

export function godModeEditOilBuilding(
  ctx: GameContext,
  intent: Extract<Intent, { kind: 'godModeEditOilBuilding' }>,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, intent);
}

export function godModeDeleteOilBuilding(
  ctx: GameContext,
  intent: Extract<Intent, { kind: 'godModeDeleteOilBuilding' }>,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, intent);
}

// ─── Refineries ────────────────────────────────────────────────────────────────

/** Found a Refinery on a chosen tile (Req 4.1). */
export function buildRefinery(ctx: GameContext, tileIndex: number): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildRefinery', tileIndex });
}

/** Extend an existing refinery onto an additional segment of its hex (Req 4.1). */
export function addRefinerySegment(
  ctx: GameContext,
  refineryId: string,
  segment: number,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'addRefinerySegment', refineryId, segment });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Preview the tile path a road would follow between two endpoints. Returns the
 * inclusive tile-index path (still tile-level for the client preview overlay),
 * or null when no traversable path exists.
 *
 * The server converts this tile-index path to a segment-level path when it
 * applies the `buildRoute` intent. The preview is segment-aware for blocking
 * (won't route through fully-sealed tiles), but shows tile-level for the
 * overlay since the 2D map renders roads as tile-to-tile lines.
 */
export function previewRoutePath(
  ctx: GameContext,
  fromTile: number,
  toTile: number,
): number[] | null {
  const { world } = ctx;

  // Adapter for segmentGraph: client tiles use n/s but SegGraphTile needs sides/neighbours
  interface ClientSegTile extends SegGraphTile { idx: number; terrain: string; f?: boolean; bridge?: boolean }
  const segTiles: ClientSegTile[] = world.tiles.map((t) => ({
    sides: t.s,
    neighbours: t.n,
    idx: t.idx,
    terrain: t.terrain,
    f: t.f && !t.clearedForest,
    bridge: t.bridge,
  }));

  // Build occupancy for buildings (drones can cross over, but road must avoid)
  const buildingOccupied = new Set<number>();
  for (const b of world.buildings) buildingOccupied.add(encodeSeg(b.tileIndex, b.segment));

  const costFn = (t: ClientSegTile, segment: number): number => {
    if (t.terrain === 'ocean' && !t.bridge) return Infinity;
    if (t.f === true) return Infinity; // uncleared forest
    // Occupied building segments are not impassable for the road itself at the
    // segment level — roads run through tiles, not through specific occupied
    // segments of those tiles. The server validates at segment level on commit.
    // Use ground-movement cost as the heuristic.
    return 0.25; // flat cost for preview (avoids heavy segSteep lookups client-side)
  };

  // Find a segment path from any segment of fromTile to any segment of toTile.
  // Since the client preview just needs a tile-level route for display, we find
  // the cheapest path starting from segment 0 of each tile.
  const result = findSegmentPath(segTiles, { tileIndex: fromTile, segment: 0 }, { tileIndex: toTile, segment: 0 }, costFn, (_t, _s) => false);
  if (!result) return null;

  // Deduplicate to unique tile indices for the overlay.
  const tilePath: number[] = [];
  for (const node of result.path) {
    if (tilePath.length === 0 || tilePath[tilePath.length - 1] !== node.tileIndex) {
      tilePath.push(node.tileIndex);
    }
  }
  return tilePath.length >= 2 ? tilePath : null;

  void findPath; // kept for potential fallback usage
}

/**
 * Build a Route between two structures along a contiguous tile path. Callers
 * typically obtain `path` from {@link previewRoutePath} (Req 6.1). The server
 * re-validates contiguity and traversability authoritatively.
 */
export function buildRoute(
  ctx: GameContext,
  fromStructureId: string,
  toStructureId: string,
  path: number[],
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildRoute', fromStructureId, toStructureId, path });
}

/** Upgrade a Route's capacity one step (road → highway tier) (Req 6.7). */
export function upgradeRoute(ctx: GameContext, routeId: string): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'upgradeRoute', routeId });
}

// ─── Distribution hubs ─────────────────────────────────────────────────────────

/** Place a Distribution_Hub on a segment, connecting the given routes (Req 6.1/11). */
export function buildDistributionHub(
  ctx: GameContext,
  tileIndex: number,
  segment: number,
  routeIds: string[],
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildDistributionHub', tileIndex, segment, routeIds });
}

// ─── Transports ─────────────────────────────────────────────────────────────────

/** Purchase a Transport assigned to a route (capped per route server-side) (Req 8.11). */
export function purchaseTransport(ctx: GameContext, routeId: string): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'purchaseTransport', routeId });
}

/** Upgrade one Transport stat (cargo / speed / defence) (Req 8.11). */
export function upgradeTransport(
  ctx: GameContext,
  transportId: string,
  stat: 'cargo' | 'speed' | 'defence',
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'upgradeTransport', transportId, stat });
}

// ─── Shuttle transports (point-to-point auto-patrol) ────────────────────────

/**
 * Create a point-to-point shuttle transport between two owned oil structures
 * (well / refinery / storage hub) along their EXISTING connecting road. The
 * server rejects this when no road connects the two structures yet.
 */
export function createShuttleTransport(
  ctx: GameContext,
  fromStructureId: string,
  toStructureId: string,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'createShuttleTransport', fromStructureId, toStructureId });
}

/** Permanently stop a shuttle transport's automated back-and-forth movement. */
export function stopShuttleTransport(
  ctx: GameContext,
  transportId: string,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'stopShuttleTransport', transportId });
}
