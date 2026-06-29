/**
 * Building component identifiers (building-damage feature).
 *
 * The seven equipment attributes a building may carry. A building is never
 * destroyed; attacks strip points from these components. A component with
 * value 0 is "absent" and cannot be targeted. Shared between the authoritative
 * combat code (src/world/combat.ts) and the client UI (which must not import
 * from src/).
 */

export type BuildingComponent =
  | 'kinetic'
  | 'rangeAttack'
  | 'splashAttack'
  | 'antiAir'
  | 'armour'
  | 'defence'
  | 'repair';

export const BUILDING_COMPONENTS: readonly BuildingComponent[] = [
  'kinetic',
  'rangeAttack',
  'splashAttack',
  'antiAir',
  'armour',
  'defence',
  'repair',
] as const;
