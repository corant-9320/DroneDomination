/**
 * Shuttle transports — point-to-point auto-patrol Transportation_Units.
 *
 * A shuttle is a `Transport` created directly between two player-owned oil
 * structures (well / refinery / storage hub) connected by ANY already-built
 * road — a real `LogisticsRoute` or a development `standaloneRoadSegments`
 * overlay, in any combination (see `findExistingRoadPath` in `routes.ts`).
 * Unlike an ordinary cargo-hauling transport (dispatched by the supply-driven
 * pipeline in `turn.ts`, loaded with Oil/Refined_Product, and delivered once
 * per `route.travelTime`), a shuttle carries no cargo at all. It simply walks
 * back and forth along its fixed `shuttlePath` (computed once at creation
 * time), advancing `SHUTTLE_SEGMENTS_PER_TURN` segments each turn and
 * reversing direction whenever it reaches either end, until the player
 * explicitly stops it (`shuttleStopped: true`).
 *
 * Every helper here is PURE: it never mutates its inputs and always returns
 * new values, matching the rest of this engine.
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

import { SHUTTLE_SEGMENTS_PER_TURN } from '../../../shared/logisticsConstants.js';
import type { Transport } from '../../../shared/logisticsTypes.js';

/**
 * Caller-supplied initialisation for a newly-created shuttle transport. The
 * pure engine fills every shuttle-specific field so the applier only needs to
 * supply identity, ownership, the resolved fixed path, and the backing-unit id.
 */
export interface ShuttleCreationInit {
  id: string;
  ownerId: string;
  /** The fixed, ordered segment-key path (`encodeSeg(tileIndex, segment)`)
   *  the shuttle will patrol, resolved once at creation time. Must have at
   *  least 2 nodes. */
  shuttlePath: number[];
  cargoCapacity: number;
  speed: number;
  defence: number;
  unitId: string;
}

/**
 * Create a new shuttle transport parked at the start of `shuttlePath`
 * (index 0, direction forward). Pure: builds a fresh object (copying
 * `shuttlePath` into a new array); mutates nothing.
 */
export function createShuttleTransport(init: ShuttleCreationInit): Transport {
  return {
    id: init.id,
    ownerId: init.ownerId,
    // Shuttles have no meaningful LogisticsRoute — `shuttlePath` is authoritative.
    // Kept as an empty string (not undefined) so `Transport.routeId: string` stays
    // required and every existing `routeId`-keyed lookup safely misses.
    routeId: '',
    cargoType: null,
    cargo: 0,
    cargoCapacity: init.cargoCapacity,
    speed: init.speed,
    defence: init.defence,
    upgrades: 0,
    tier: 'van',
    inTransit: false,
    turnsRemaining: 0,
    unitId: init.unitId,
    shuttleMode: true,
    shuttlePath: [...init.shuttlePath],
    shuttlePosition: 0,
    shuttleDirection: 1,
    shuttleStopped: false,
  };
}

/**
 * Advance one shuttle transport by up to `SHUTTLE_SEGMENTS_PER_TURN` segments
 * along its own `shuttlePath`, bouncing off either end so it patrols back and
 * forth indefinitely.
 *
 * Movement is resolved step-by-step (rather than a single clamped jump) so a
 * shuttle that reaches an end mid-turn reverses and continues consuming the
 * remainder of its per-turn budget in the new direction, exactly like a ball
 * bouncing between two walls. A path with fewer than 2 nodes has nowhere to
 * bounce between, so the shuttle stays put. A stopped shuttle
 * (`shuttleStopped`) never moves. Pure — returns a new transport, never
 * mutates the input.
 *
 * @param t The shuttle transport to advance (`shuttleMode` must be true).
 * @param segmentsPerTurn How many segment-steps to consume this turn (defaults
 *   to {@link SHUTTLE_SEGMENTS_PER_TURN}).
 * @returns A new `Transport` with `shuttlePosition`/`shuttleDirection` advanced.
 */
export function advanceShuttle(
  t: Transport,
  segmentsPerTurn: number = SHUTTLE_SEGMENTS_PER_TURN,
): Transport {
  if (t.shuttleStopped) return t;
  const pathLength = t.shuttlePath?.length ?? 0;
  if (pathLength < 2) return t;

  const lastIndex = pathLength - 1;
  let position = Math.max(0, Math.min(lastIndex, t.shuttlePosition ?? 0));
  let direction: 1 | -1 = t.shuttleDirection === -1 ? -1 : 1;
  let remaining = Math.max(0, Math.floor(segmentsPerTurn));

  while (remaining > 0) {
    const next = position + direction;
    if (next > lastIndex) {
      direction = -1;
      position = lastIndex;
    } else if (next < 0) {
      direction = 1;
      position = 0;
    } else {
      position = next;
    }
    remaining -= 1;
  }

  return { ...t, shuttlePosition: position, shuttleDirection: direction };
}

/** Mark a shuttle transport as explicitly stopped (no further automated movement). */
export function stopShuttle(t: Transport): Transport {
  return { ...t, shuttleStopped: true };
}
