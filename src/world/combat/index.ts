export {
  DEFENCE_SCALE,
  MAX_DAMAGE,
  MIN_DAMAGE,
  SPLASH_SCALE,
  RANGE_FALLOFF_PER_SEGMENT_UNIT as RANGE_FALLOFF_PER_HEX,
  DAMAGE_PER_ATTACK_POWER,
  SEGMENT_RANGE_PER_POINT,
  SEGMENT_RANGE_BASE,
  TANK_ATTACK_MODIFIER,
  SPIDER_ATTACK_MODIFIER,
  DRONE_ATTACK_MODIFIER,
  DRONE_DIRECT_FIRE_DAMAGE_MULTIPLIER,
  DRONE_SPLASH_FIRE_DAMAGE_MULTIPLIER,
  DRONE_ANTI_AIR_DAMAGE_MULTIPLIER,
  calculateRangeEfficiency,
  clamp,
  applyDamage,
  calculateFormulaDamage,
  modifiedAttackPower,
  effectiveDefenceWithOrientation,
  computeDamage,
  type ChassisType,
  type DamageInput,
  type DamageBreakdown,
} from '../combatFormula.js';

export {
  type TargetOrientation,
  type AttackArc,
  getOrientationBonus,
  getDirectionBetweenAdjacentHexes,
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  getCrossfireBonus,
  calculateOrientationBonus,
  calculateOrientationArmourPenalty,
  MAX_ORIENTATION_ARMOUR_PENALTY,
  classifyArcFromAngle,
  getAngularDifference,
  getBearingBetweenTiles,
  getFacingAngle,
} from '../combatFacing.js';


export type {
  CombatContext,
  RandomFn,
  WeaponMode,
  WeaponOption,
  SplashEvent,
  BuildingDamageEvent,
  CombatResult,
  CombatPreview,
} from './types.js';

export {
  isDrone,
  getChassisType,
  getChassisAttackModifier,
  applyDroneIncomingDamageModifier,
  getSegmentRangeThreshold,
} from './context.js';

export {
  MAX_EW_RADIUS,
  getEWProtection,
  getTerrainDefense,
  getDefencePower,
  calculateDirectDamage,
  calculateSplashDamage,
} from './defence.js';

export {
  type BuildingComponent,
  BUILDING_COMPONENTS,
  getEligibleBuildingComponents,
  applyBuildingComponentDamage,
  resolveBuildingDirectFire,
  resolveBuildingSplashInHex,
  resolveSplashHex,
} from './buildingDamage.js';

export {
  evaluateWeaponOptions,
  chooseWeaponOption,
} from './weaponOptions.js';

export { previewAttack } from './preview.js';
export { resolveAttack } from './resolution.js';
export {
  calculateAntiAirReactionDamage,
  resolveAntiAirReactionFireForTile,
  resolveReactionFire,
} from './reaction.js';
export { resolveSimultaneousAttacks } from './simultaneous.js';

export { moveUnit, pivotUnit } from '../movement.js';
export {
  getSegmentCentroid3D,
  getLocalHexSpacing,
  segmentDistance,
  effectiveCombatDistance,
  segmentMovementDistance,
} from '../segmentGeometry.js';