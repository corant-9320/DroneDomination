/**
 * Shared unit attribute types.
 *
 * Authoritative definition of UnitAttributes, shared between:
 *   - src/world/units.ts  (server-side unit logic)
 *   - client/worldData.ts (client-side wire format)
 *   - server/combatApi.ts (combat API wire format)
 */

/**
 * The full set of attributes a unit *may* have.
 * All fields are optional — a unit only carries the attributes relevant to it.
 *
 * All values are integers within a fixed range:
 *   size:           1–5  (must be at least 1 if present)
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
  /**
   * Unit size / frame class (1–5). Chosen at creation and NOT refittable.
   * Sets max HP (size × HP_PER_POINT) and acts as a ceiling on the size of
   * weapons/armour/EW/repair that can be fitted. Costs 1 point per size.
   */
  size?: number;
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
  /**
   * Engineering capability (0–5). An engineer with ≥1 can build a bridge over an
   * adjacent river hex, making it passable to ground units. Non-combat.
   */
  engineer?: number;
}
