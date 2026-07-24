/** Turret mounting point info shared by all chassis builders. */
export interface TurretInfo {
  turretY: number;
  turretZ: number;
  /** Z coordinate of the front face of the turret/body — barrel starts here */
  turretFrontZ: number;
}

/**
 * Model base type. The three movement chassis (wheeled/limbed/flight) belong to
 * mobile units; `building` is a static structure base used by buildingModel.ts.
 * Buildings reuse the same attribute add-on builders (gun, splash, anti-air,
 * armour, defence, repair) but never carry movement or engineering equipment.
 *
 * Lives here (not unitModel.ts) so the per-chassis builder modules
 * (unitModelWheeled/Limbed/Flight.ts) and unitModelAddons.ts can depend on it
 * without importing unitModel.ts itself, which would create a cycle since
 * unitModel.ts imports all of those modules.
 */
export type ChassisType = 'wheeled' | 'limbed' | 'flight' | 'building';

/**
 * The mobile unit chassis — every {@link ChassisType} except `'building'`.
 * Unit-only UIs (designer, refit) never operate on buildings, so they use this
 * narrower type for exhaustive per-chassis records.
 */
export type UnitChassisType = Exclude<ChassisType, 'building'>;

export interface UnitModelAttrs {
  kinetic: number;
  rangeAttack: number;
  splashAttack: number;
  antiAir: number;
  armour: number;
  defence: number;
  repair: number;
  movement: number;
  chassis: ChassisType;
}
