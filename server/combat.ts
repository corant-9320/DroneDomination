/**
 * Combat resolution API handler.
 *
 * Accepts a world state + attack command, resolves the combat using
 * src/world/combat.ts, and returns a detailed step-by-step explanation
 * of every mechanic that contributed to the final result.
 *
 * Framework-agnostic — takes a plain object, returns one.
 */

import { Tile } from '../src/world/types.js';
import { Unit, HexSegment } from '../src/world/units.js';
import { graphDistance } from '../src/world/pathfinding.js';
import {
  getApproachDirection,
  classifyAttackArc,
  getFacingModifier,
  getAdjacentFriendlySupport,
  getBestNearbyDefense,
  getEffectiveDefense,
  isEncircled,
  calculateSplashDamage,
  resolveAttack,
  type AttackArc,
  type CombatResult,
} from '../src/world/combat.js';
import type {
  ExplanationStep,
  SplashExplanation,
  ExplainedCombat,
  CombatResponse,
} from '../shared/combatTypes.js';

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

/** Wire-format unit (matches CompactUnit + facing). */
interface WireUnit {
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  facing: number;
  attributes: {
    maxHealth?: number;
    attack?: number;
    armour?: number;
    defence?: number;
    splashAttack?: number;
    rangeAttack?: number;
    wheeledMovement?: number;
    limbMovement?: number;
    flightMovement?: number;
    repair?: number;
  };
  currentHealth: number;
}

/** Minimal tile data needed for combat resolution. */
interface WireTile {
  idx: number;
  s: 5 | 6;
  n: number[];
}

export interface CombatRequest {
  /** The attack to resolve. */
  action: 'attack' | 'move' | 'preview';
  /** For 'attack'/'preview': attacker unit ID. */
  attackerId?: string;
  /** For 'attack'/'preview': target unit ID. */
  targetId?: string;
  /** For 'move': unit ID that is moving. */
  unitId?: string;
  /** For 'move': path as tile indices. */
  path?: number[];
  /** The faction (ownerId) whose turn it currently is. Only this faction may attack. */
  activeFaction: string;
  /** All units currently on the board. */
  units: WireUnit[];
  /** Tile adjacency data (only idx, sides, neighbours needed). */
  tiles: WireTile[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleCombat(req: CombatRequest): CombatResponse<WireUnit> {
  console.log('[DD][combat] handleCombat action=%s', req.action);

  // Rebuild minimal Tile[] for pathfinding/adjacency (we only need neighbours)
  const tiles = rebuildTiles(req.tiles);
  const units = rebuildUnits(req.units);

  if (req.action === 'attack') {
    return handleAttack(req, tiles, units);
  } else if (req.action === 'preview') {
    return handlePreview(req, tiles, units);
  } else if (req.action === 'move') {
    return handleMove(req, tiles, units);
  }

  return { success: false, error: 'Unknown action', combats: [], reactions: [], updatedUnits: [] };
}

// ---------------------------------------------------------------------------
// Attack handler
// ---------------------------------------------------------------------------

function handleAttack(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
  const { attackerId, targetId, activeFaction } = req;
  if (!attackerId || !targetId) {
    return { success: false, error: 'attackerId and targetId required', combats: [], reactions: [], updatedUnits: [] };
  }

  const attacker = units.find((u) => u.id === attackerId);
  const target = units.find((u) => u.id === targetId);
  if (!attacker || !target) {
    return { success: false, error: 'Attacker or target not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Turn-based enforcement: only the active faction may attack
  if (attacker.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn to attack', combats: [], reactions: [], updatedUnits: [] };
  }

  // Build explanation BEFORE resolving (so we capture "before" state)
  const explained = explainAttack(attacker, target, units, tiles);

  // Actually resolve the attack (mutates units)
  const result = resolveAttack(attackerId, targetId, units, tiles);

  // Update explanation with post-combat health
  explained.targetHealthAfter = target.currentHealth;
  explained.targetDestroyed = target.currentHealth <= 0;
  explained.destroyedUnitIds = result.destroyedUnitIds;

  // Build splash explanations
  explained.splash = explainSplash(attacker, target, result, units, tiles);

  return {
    success: true,
    combats: [explained],
    reactions: [],
    updatedUnits: units.map(toWireUnit),
  };
}

// ---------------------------------------------------------------------------
// Preview handler (explanation only, no state mutation)
// ---------------------------------------------------------------------------

function handlePreview(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
  const { attackerId, targetId } = req;
  if (!attackerId || !targetId) {
    return { success: false, error: 'attackerId and targetId required', combats: [], reactions: [], updatedUnits: [] };
  }

  const attacker = units.find((u) => u.id === attackerId);
  const target = units.find((u) => u.id === targetId);
  if (!attacker || !target) {
    return { success: false, error: 'Attacker or target not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Build explanation WITHOUT resolving (read-only)
  const explained = explainAttack(attacker, target, units, tiles);

  return {
    success: true,
    combats: [explained],
    reactions: [],
    updatedUnits: [], // no mutation for preview
  };
}

// ---------------------------------------------------------------------------
// Move handler (with reaction fire)
// ---------------------------------------------------------------------------

function handleMove(req: CombatRequest, tiles: Tile[], units: Unit[]): CombatResponse<WireUnit> {
  const { unitId, path, activeFaction } = req;
  if (!unitId || !path || path.length < 2) {
    return { success: false, error: 'unitId and path (2+ tiles) required', combats: [], reactions: [], updatedUnits: [] };
  }

  const mover = units.find((u) => u.id === unitId);
  if (!mover) {
    return { success: false, error: 'Moving unit not found', combats: [], reactions: [], updatedUnits: [] };
  }

  // Turn-based enforcement: only the active faction may move
  if (mover.ownerId !== activeFaction) {
    return { success: false, error: 'Not this faction\'s turn to move', combats: [], reactions: [], updatedUnits: [] };
  }

  // Walk the path — update position and facing.
  // No reaction fire in turn-based mode (units only act on their own turn).
  for (let i = 1; i < path.length; i++) {
    const prevHex = path[i - 1];
    const currentHex = path[i];

    mover.tileIndex = currentHex;
    const dir = tiles[prevHex].neighbours.indexOf(currentHex);
    if (dir !== -1) {
      mover.facing = dir as HexSegment;
    }
  }

  return {
    success: true,
    combats: [],
    reactions: [],
    updatedUnits: units.map(toWireUnit),
  };
}

// ---------------------------------------------------------------------------
// Explanation builder
// ---------------------------------------------------------------------------

function explainAttack(
  attacker: Unit,
  target: Unit,
  allUnits: Unit[],
  tiles: Tile[],
): ExplainedCombat {
  const steps: ExplanationStep[] = [];

  // Validation
  if (attacker.currentHealth <= 0) {
    return invalidExplanation(attacker, target, 'Attacker is destroyed');
  }
  if (target.currentHealth <= 0) {
    return invalidExplanation(attacker, target, 'Target is already destroyed');
  }
  if (attacker.ownerId === target.ownerId) {
    return invalidExplanation(attacker, target, 'Cannot attack a friendly unit');
  }

  // Step 1: Range
  const rangeAttack = attacker.attributes.rangeAttack ?? 0;
  const meleeAttack = attacker.attributes.attack ?? 0;
  const attackRange = Math.max(rangeAttack, meleeAttack > 0 ? 1 : 0);
  const dist = graphDistance(tiles, attacker.tileIndex, target.tileIndex);

  steps.push({
    title: '📏 Range Check',
    description: `Graph distance from ${attacker.label} to ${target.label} is ${dist} hex${dist !== 1 ? 'es' : ''}. Attacker range: ${attackRange} (rangeAttack=${rangeAttack}${meleeAttack > 0 ? ', melee=1' : ''}).`,
    formula: `distance(${dist}) ≤ range(${attackRange})`,
    result: dist <= attackRange ? `✓ In range` : `✗ Out of range`,
    tone: dist <= attackRange ? 'positive' : 'negative',
  });

  if (dist < 0 || dist > attackRange) {
    return {
      attackerId: attacker.id,
      attackerLabel: attacker.label,
      targetId: target.id,
      targetLabel: target.label,
      wasValid: false,
      reasonInvalid: 'Out of range',
      steps,
      directDamage: 0,
      targetHealthBefore: target.currentHealth,
      targetHealthAfter: target.currentHealth,
      targetDestroyed: false,
      splash: [],
      destroyedUnitIds: [],
    };
  }

  // Step 2: Attack angle
  const approachDir = getApproachDirection(tiles, target.tileIndex, attacker.tileIndex);
  const arc = classifyAttackArc(target.facing, approachDir);
  const facingMod = getFacingModifier(arc);

  steps.push({
    title: '🧭 Attack Angle',
    description: `${target.label} faces direction ${target.facing}. ${attacker.label} approaches from direction ${approachDir}. The attack hits the ${formatArcLong(arc)}.`,
    formula: `(approach ${approachDir} − facing ${target.facing}) mod 6 = ${((approachDir - target.facing) % 6 + 6) % 6}`,
    result: `${formatArcShort(arc)} → ${formatMod(facingMod)} damage`,
    tone: facingMod > 0 ? 'positive' : facingMod < 0 ? 'negative' : 'neutral',
  });

  // Step 3: Base damage
  const attackPower = attacker.attributes.attack ?? 0;
  const rawDamage = attackPower + facingMod;

  steps.push({
    title: '⚔ Raw Damage',
    description: `Attack power from ${attacker.label} plus the facing angle modifier.`,
    formula: `attackPower(${attackPower}) + facingMod(${formatMod(facingMod)}) = ${rawDamage}`,
    result: `${rawDamage} raw damage`,
    tone: rawDamage > 0 ? 'positive' : 'neutral',
  });

  // Step 4: Target armour
  const armour = target.attributes.armour ?? 0;

  steps.push({
    title: '🛡 Armour',
    description: `${target.label} has ${armour} armour, reducing incoming damage by that amount.`,
    formula: `armour = ${armour}`,
    result: `−${armour} from armour`,
    tone: armour > 0 ? 'negative' : 'neutral',
  });

  // Step 5: Defence breakdown
  const ownDef = target.attributes.defence ?? 0;
  const nearbyDef = getBestNearbyDefense(target, allUnits, tiles);
  const formation = getAdjacentFriendlySupport(target, allUnits, tiles);
  const encircled = isEncircled(target, allUnits, tiles);
  const effDef = getEffectiveDefense(target, allUnits, tiles);
  const defReduction = Math.floor(effDef / 2);

  let defDesc = `Own defence: ${ownDef}`;
  defDesc += ` + best nearby EW aura: ${nearbyDef}`;
  defDesc += ` + formation support: ${formation} (max 2)`;
  if (encircled) defDesc += ` − encirclement: 1`;
  defDesc += `. Clamped to max 7.`;

  steps.push({
    title: '📡 Electronic Defence',
    description: defDesc,
    formula: `effective = min(7, ${ownDef} + ${nearbyDef} + ${formation}${encircled ? ' − 1' : ''}) = ${effDef} → ⌊${effDef}/2⌋ = ${defReduction} reduction`,
    result: `−${defReduction} from EW defence`,
    tone: defReduction > 0 ? 'negative' : 'neutral',
  });

  // Formation detail sub-step
  if (formation > 0) {
    const adjacentFriends = allUnits.filter(
      (u) => u.id !== target.id && u.ownerId === target.ownerId && u.currentHealth > 0 &&
        (u.tileIndex === target.tileIndex || tiles[target.tileIndex].neighbours.includes(u.tileIndex))
    );
    const names = adjacentFriends.slice(0, 3).map((u) => u.label).join(', ');
    steps.push({
      title: '🤝 Formation Support',
      description: `${adjacentFriends.length} adjacent friendly unit${adjacentFriends.length !== 1 ? 's' : ''} (${names}${adjacentFriends.length > 3 ? '…' : ''}) provide +${formation} support (capped at +2).`,
      result: `+${formation} to effective defence`,
      tone: 'neutral',
    });
  }

  if (encircled) {
    steps.push({
      title: '🔄 Encircled',
      description: `Enemy units occupy 3+ adjacent directions around ${target.label}, reducing effective defence by 1.`,
      result: `−1 effective defence`,
      tone: 'critical',
    });
  }

  // Step 6: Final damage calculation
  const finalDamage = Math.max(0, Math.min(target.currentHealth, rawDamage - armour - defReduction));

  steps.push({
    title: '💥 Final Damage',
    description: `Raw damage minus all reductions, clamped to [0, target HP].`,
    formula: `max(0, min(${target.currentHealth}, ${rawDamage} − ${armour} − ${defReduction})) = ${finalDamage}`,
    result: finalDamage > 0 ? `${finalDamage} damage dealt` : `0 — attack fully absorbed`,
    tone: finalDamage > 0 ? 'critical' : 'negative',
  });

  // Step 7: Health outcome
  const healthAfter = Math.max(0, target.currentHealth - finalDamage);
  const destroyed = healthAfter <= 0;

  steps.push({
    title: destroyed ? '☠ Target Destroyed' : '❤ Health Update',
    description: `${target.label}: ${target.currentHealth} HP → ${healthAfter} HP.`,
    formula: `${target.currentHealth} − ${finalDamage} = ${healthAfter}`,
    result: destroyed ? `${target.label} is destroyed!` : `${healthAfter}/${target.attributes.maxHealth ?? 1} HP remaining`,
    tone: destroyed ? 'critical' : (finalDamage > 0 ? 'negative' : 'neutral'),
  });

  return {
    attackerId: attacker.id,
    attackerLabel: attacker.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: true,
    steps,
    directDamage: finalDamage,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: healthAfter, // will be overwritten with actual post-resolve value
    targetDestroyed: destroyed,
    splash: [],
    destroyedUnitIds: [],
  };
}

function explainSplash(
  attacker: Unit,
  primaryTarget: Unit,
  result: CombatResult,
  allUnits: Unit[],
  tiles: Tile[],
): SplashExplanation[] {
  const splashPower = attacker.attributes.splashAttack ?? 0;
  if (splashPower <= 0 || result.splashEvents.length === 0) return [];

  const explanations: SplashExplanation[] = [];

  for (const event of result.splashEvents) {
    const victim = allUnits.find((u) => u.id === event.victimId);
    if (!victim) continue;

    const victimArmour = victim.attributes.armour ?? 0;
    const armourRed = Math.floor(victimArmour / 2);
    const victimEffDef = getEffectiveDefense(victim, allUnits, tiles);
    const defRed = Math.floor(victimEffDef / 2);
    const healthBefore = victim.currentHealth + event.damage; // reconstruct pre-splash health

    const steps: ExplanationStep[] = [
      {
        title: '💥 Splash Source',
        description: `${attacker.label} has splash attack ${splashPower}. ${victim.label} is adjacent to primary target ${primaryTarget.label}.`,
        result: `Splash power: ${splashPower}`,
        tone: 'neutral',
      },
      {
        title: '🛡 Victim Armour',
        description: `${victim.label} armour ${victimArmour} → half reduction: ⌊${victimArmour}/2⌋ = ${armourRed}.`,
        formula: `−${armourRed}`,
        result: `−${armourRed} from armour`,
        tone: armourRed > 0 ? 'negative' : 'neutral',
      },
      {
        title: '📡 Victim EW Defence',
        description: `${victim.label} effective defence = ${victimEffDef} → reduction ⌊${victimEffDef}/2⌋ = ${defRed}.`,
        formula: `−${defRed}`,
        result: `−${defRed} from defence`,
        tone: defRed > 0 ? 'negative' : 'neutral',
      },
      {
        title: '💥 Splash Result',
        description: `Final splash: max(0, ${splashPower} − ${armourRed} − ${defRed}) = ${event.damage}.`,
        formula: `max(0, ${splashPower} − ${armourRed} − ${defRed}) = ${event.damage}`,
        result: event.victimDestroyed
          ? `${event.damage} damage — ${victim.label} destroyed!`
          : `${event.damage} damage to ${victim.label}`,
        tone: event.damage > 0 ? 'critical' : 'neutral',
      },
    ];

    explanations.push({
      victimId: victim.id,
      victimLabel: victim.label,
      steps,
      damage: event.damage,
      victimDestroyed: event.victimDestroyed,
      victimHealthBefore: healthBefore,
      victimHealthAfter: victim.currentHealth,
    });
  }

  return explanations;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalidExplanation(attacker: Unit, target: Unit, reason: string): ExplainedCombat {
  return {
    attackerId: attacker.id,
    attackerLabel: attacker.label,
    targetId: target.id,
    targetLabel: target.label,
    wasValid: false,
    reasonInvalid: reason,
    steps: [{
      title: '❌ Invalid Attack',
      description: reason,
      result: 'Attack cannot proceed',
      tone: 'negative',
    }],
    directDamage: 0,
    targetHealthBefore: target.currentHealth,
    targetHealthAfter: target.currentHealth,
    targetDestroyed: false,
    splash: [],
    destroyedUnitIds: [],
  };
}

function rebuildTiles(wireTiles: WireTile[]): Tile[] {
  // Build a sparse array indexed by tile idx
  const maxIdx = wireTiles.reduce((m, t) => Math.max(m, t.idx), 0);
  const tiles: Tile[] = new Array(maxIdx + 1);

  for (const wt of wireTiles) {
    tiles[wt.idx] = {
      id: `t${wt.idx}`,
      index: wt.idx,
      sides: wt.s,
      neighbours: wt.n,
      position3d: { x: 0, y: 0, z: 0 },
      boundary: [],
      terrainType: 'plains',
      elevation: 0,
    };
  }

  return tiles;
}

function rebuildUnits(wireUnits: WireUnit[]): Unit[] {
  return wireUnits.map((wu) => ({
    id: wu.id,
    label: wu.label,
    ownerId: wu.ownerId,
    tileIndex: wu.tileIndex,
    segment: wu.segment as HexSegment,
    facing: wu.facing as HexSegment,
    attributes: {
      maxHealth: wu.attributes.maxHealth,
      attack: wu.attributes.attack,
      armour: wu.attributes.armour,
      defence: wu.attributes.defence,
      splashAttack: wu.attributes.splashAttack,
      rangeAttack: wu.attributes.rangeAttack,
      wheeledMovement: wu.attributes.wheeledMovement,
      limbMovement: wu.attributes.limbMovement,
      flightMovement: wu.attributes.flightMovement,
      repair: wu.attributes.repair,
    },
    currentHealth: wu.currentHealth,
  }));
}

function toWireUnit(u: Unit): WireUnit {
  return {
    id: u.id,
    label: u.label,
    ownerId: u.ownerId,
    tileIndex: u.tileIndex,
    segment: u.segment,
    facing: u.facing,
    attributes: u.attributes,
    currentHealth: u.currentHealth,
  };
}

function formatArcLong(arc: AttackArc): string {
  switch (arc) {
    case 'front': return 'front armour (strongest protection)';
    case 'frontSide': return 'front-side (standard exposure)';
    case 'side': return 'side flank (vulnerable)';
    case 'rear': return 'rear (most vulnerable)';
    default: return 'unknown angle';
  }
}

function formatArcShort(arc: AttackArc): string {
  switch (arc) {
    case 'front': return '🛡 Front';
    case 'frontSide': return '↗ Front-Side';
    case 'side': return '→ Side';
    case 'rear': return '🎯 Rear';
    default: return '? Unknown';
  }
}

function formatMod(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
