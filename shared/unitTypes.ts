/**
 * Shared unit attribute types.
 *
 * Authoritative definition of UnitAttributes, shared between:
 *   - src/world/units.ts  (server-side unit logic)
 *   - client/worldData.ts (client-side wire format)
 *   - server/combat.ts    (combat API wire format)
 */

/**
 * The full set of attributes a unit *may* have.
 * All fields are optional — a unit only carries the attributes relevant to it.
 *
 * All values are integers within a fixed range:
 *   maxHealth:      1–5  (must be at least 1 if present)
 *   kinetic:        0–5
 *   armour:         0–5
 *   defence:        0–5
 *   splashAttack:   0–5
 *   rangeAttack:    0–5
 *   wheeledMovement:0–5
 *   limbMovement:   0–5
 *   flightMovement: 0–5
 *   repair:         0–5
 *   antiAir:        0–5
 *
 * A unit MUST have at least 1 point in one movement category
 * (wheeledMovement, limbMovement, or flightMovement).
 */
export interface UnitAttributes {
  /** Maximum hit points (1–5). */
  maxHealth?: number;
  /** Kinetic attack power — single heavy shell fired through a barrel (0–5). Determines gun length in icon. */
  kinetic?: number;
  /** Damage reduction from incoming attacks (0–5). */
  armour?: number;
  /** Electronic Warfare (EW) value. Contributes to same-hex allies' DefencePower (0–5). */
  defence?: number;
  /** Base splash damage dealt in adjacent combat (0–5). */
  splashAttack?: number;
  /** Base damage dealt at range (0–5). */
  rangeAttack?: number;
  /** Movement points for wheeled/vehicle traversal (0–5). */
  wheeledMovement?: number;
  /** Movement points for organic/legged traversal (0–5). */
  limbMovement?: number;
  /** Movement points for aerial traversal (0–5). */
  flightMovement?: number;
  /** Repair capability — points of health restored per action (0–5). */
  repair?: number;
  /** Anti-air attack power — can only target drones (0–5). */
  antiAir?: number;
}
