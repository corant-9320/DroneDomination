/** Turret mounting point info shared by all chassis builders. */
export interface TurretInfo {
  turretY: number;
  turretZ: number;
  /** Z coordinate of the front face of the turret/body — barrel starts here */
  turretFrontZ: number;
}
