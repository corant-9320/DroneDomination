import type { BuildingComponent } from '../../../shared/buildingComponents.js';
import type { ChassisType } from '../combatFormula.js';
import type { AttackArc } from '../combatFacing.js';
import type { Building, Tile } from '../types.js';
import type { Unit } from '../units.js';

/** Shared world state read by combat calculations and mutated by resolvers. */
export interface CombatContext {
  units: Unit[];
  tiles: Tile[];
  buildings: Building[];
}

export type RandomFn = () => number;
export type WeaponMode = 'direct' | 'splash' | 'antiAir';

export interface WeaponOption {
  mode: WeaponMode;
  score: number;
  damages: Array<{ unitId: string; damage: number }>;
}

export interface SplashEvent {
  victimId: string;
  damage: number;
  victimDestroyed: boolean;
}

export interface BuildingDamageEvent {
  buildingId: string;
  component: BuildingComponent;
  newValue: number;
  destroyed: boolean;
}

export interface CombatResult {
  attackerId: string;
  targetId: string;
  wasValid: boolean;
  reasonInvalid?: string;
  attackArc: AttackArc;
  facingModifier: number;
  targetArmour: number;
  targetEffectiveDefense: number;
  directDamage: number;

  /** Anti-air damage dealt to the target (only if antiAir mode was chosen). */
  antiAirDamage: number;
  splashEvents: SplashEvent[];
  destroyedUnitIds: string[];
  reactionEvents: CombatResult[];
  chosenWeaponMode?: WeaponMode;
  buildingDamage: BuildingDamageEvent[];
}

/** Presentation-agnostic, non-mutating attack evaluation. */
export interface CombatPreview {
  attackerId: string;
  attackerLabel: string;
  targetId: string;
  targetLabel: string;
  wasValid: boolean;
  reasonInvalid?: string;
  distance: number;
  baseRangeThreshold: number;
  elevationRangeMultiplier: number;
  effectiveRangeThreshold: number;
  inRange: boolean;
  angleDiffDeg: number;
  arc: AttackArc;
  orientationArmourPenalty: number;
  orientationLabel: string;
  defArmour: number;
  defEW: number;
  defEWRaw: number;
  defEWMultiplier: number;
  defTerrain: number;
  defTotal: number;
  effectiveDefence: number;
  chassisType: ChassisType;
  chassisLabel: 'Tank' | 'Spider' | 'Drone';
  chassisModifier: number;
  weaponOptions: WeaponOption[];
  chosenMode: WeaponMode | 'none';
  baseWeapon: number;
  rangeEfficiency: number;
  attackTotal: number;
  primaryTargetDamage: number;
  totalDamage: number;
  targetIsDrone: boolean;
  droneEvasion: number;
  targetHealthBefore: number;
  targetHealthAfter: number;
  targetDestroyed: boolean;
  targetMaxHp: number;
  splashVictims: Array<{
    unitId: string;
    unitLabel: string;
    damage: number;
    healthBefore: number;
    healthAfter: number;
    destroyed: boolean;
    maxHp: number;
  }>;
}