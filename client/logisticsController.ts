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

  // Adopt the authoritative logistics state so the renderer/panel reflect the
  // outcome. Wire and authoritative shapes are identical, so this is a straight
  // assignment (no field remapping) — mirrors matchClient.reconcile for units.
  if (resp.logistics) ctx.world.logistics = resp.logistics;

  return resp;
}

// ─── Engineer tasks (well / bridge / clear) ───────────────────────────────────

/** Order an engineer to drill an Oil_Well on its current segment (Req 2.1). */
export function buildOilWell(ctx: GameContext, unitId: string): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildOilWell', unitId });
}

/** Order an engineer to build a bridge over its adjacent impassable tile (Req 10.1). */
export function buildBridge(
  ctx: GameContext,
  unitId: string,
  tileIndex: number,
): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'buildBridge', unitId, tileIndex });
}

/** Order an engineer to clear the forest on its current tile (Req 9.1). */
export function clearForest(ctx: GameContext, unitId: string): Promise<MatchIntentResponse | null> {
  return dispatchLogistics(ctx, { kind: 'clearForest', unitId });
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
 * Preview the tile path a road would follow between two endpoints, using the
 * shared `findPath` (great-circle A*). The cost function routes around tiles the
 * server would reject for a `buildRoute` (ocean without a completed bridge,
 * forest that has not been cleared), so the preview is a viable candidate path
 * the player can inspect before committing. Returns the inclusive tile-index
 * path, or null when no traversable path exists.
 */
export function previewRoutePath(
  ctx: GameContext,
  fromTile: number,
  toTile: number,
): number[] | null {
  const { world } = ctx;

  // findPath indexes `tiles[idx]`; build an index-aligned adapter exposing the
  // minimal PathTile shape (client tiles store neighbours as `n`). Carry `idx`
  // so the cost function can inspect the underlying tile's terrain/overlays.
  interface PreviewTile extends PathTile {
    idx: number;
  }
  const adapter: PreviewTile[] = world.tiles.map((t) => ({
    neighbours: t.n,
    pos: t.pos,
    idx: t.idx,
  }));

  const costFn = (pt: PathTile): number => {
    const tile = world.tiles[(pt as PreviewTile).idx];
    if (!tile) return Infinity;
    // Unbridged water is impassable for a road.
    if (tile.terrain === 'ocean' && tile.bridge !== true) return Infinity;
    // Uncleared forest blocks a road until an engineer clears it.
    if (tile.f === true && tile.clearedForest !== true) return Infinity;
    return 1;
  };

  return findPath(adapter, fromTile, toTile, costFn);
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
