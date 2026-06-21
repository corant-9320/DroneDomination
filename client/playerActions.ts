/**
 * All player-initiated actions: attack, repair, refit, building refit, sleep.
 * Each handler checks isPlayerTurn(), emits a debug event, calls the server
 * (via combatPanel), and syncs the result back into world + renders.
 */

import { showRefitModal } from './refitModal.js';
import { showBuildingRefitModal } from './buildingRefitModal.js';
import { rerenderUnitSprite } from './unitRenderer.js';
import { rerenderBuildingSprite } from './buildingRenderer.js';
import { factionColor } from './colors.js';
import { dbg } from './debug.js';
import { emitDebugEvent } from './gameDebug.js';
import type { GameContext } from './gameContext.js';

export async function handlePlayerAttack(
  ctx: GameContext,
  attackerId: string,
  targetId: string,
): Promise<void> {
  const { world, localMap, firstPerson, combatPanel, detailPanel, turnManager, switchRpTab, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Attack blocked — not player turn');
    return;
  }
  dbg.input.log('Attack initiated:', attackerId, '→', targetId);
  emitDebugEvent('attack', { attackerId, targetId }, turnManager.turnNumber);

  const attacker = world.units.find((u) => u.id === attackerId);
  const updatedUnits = await combatPanel.resolveAttack(attackerId, targetId);
  if (!updatedUnits) return;

  switchRpTab('history');

  const { units, combat } = updatedUnits;

  const oldTarget = world.units.find((u) => u.id === targetId);
  const newTarget = units.find((u) => u.id === targetId);
  const damage = oldTarget && newTarget
    ? oldTarget.currentHealth - newTarget.currentHealth
    : oldTarget ? oldTarget.currentHealth : 10;
  const targetDestroyed = newTarget ? newTarget.currentHealth <= 0 : true;
  const attackerColor = attacker ? factionColor(world, attacker.ownerId) : '#ffffff';

  const splashVictims = combat.splash
    .filter((s) => s.victimId !== targetId)
    .map((s) => ({
      unitId: s.victimId,
      damage: s.damage,
      destroyed: s.victimDestroyed,
    }));

  const attackAnims: Array<Promise<void>> = [
    localMap.playAttackAnimation(attackerId, targetId, attackerColor, damage, targetDestroyed, splashVictims),
  ];
  if (firstPerson.isActive) {
    attackAnims.push(firstPerson.playAttackAnimation(attackerId, targetId, attackerColor, damage, targetDestroyed, splashVictims));
  }
  await Promise.all(attackAnims);

  world.units = units;
  localMap.render();
  if (firstPerson.isActive) firstPerson.refresh();

  // Keep detail panel in sync after the attack
  detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
}

export async function handlePlayerRepair(
  ctx: GameContext,
  repairerId: string,
  targetId: string,
): Promise<void> {
  const { world, localMap, firstPerson, combatPanel, turnManager, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Repair blocked — not player turn');
    return;
  }
  dbg.input.log('Repair initiated:', repairerId, '→', targetId);
  emitDebugEvent('repair', { repairerId, targetId }, turnManager.turnNumber);

  const updatedUnits = await combatPanel.resolveRepair(repairerId, targetId);
  if (!updatedUnits) return;

  world.units = updatedUnits;
  localMap.render();
  if (firstPerson.isActive) firstPerson.refresh();
}

export function handlePlayerSleep(ctx: GameContext, unitId: string): void {
  const { turnManager } = ctx;
  dbg.input.log('Unit put to sleep:', unitId);
  emitDebugEvent('sleep', { unitId }, turnManager.turnNumber);
  turnManager.sleepUnit(unitId);
}

export async function handlePlayerRefit(ctx: GameContext, unitId: string): Promise<void> {
  const { world, localMap, firstPerson, detailPanel, turnManager, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Refit blocked — not player turn');
    return;
  }
  const unit = world.units.find((u) => u.id === unitId);
  if (!unit) return;

  dbg.input.log('Refit initiated for:', unit.label);
  emitDebugEvent('refit', { unitId, label: unit.label }, turnManager.turnNumber);

  const result = await showRefitModal(unit);
  if (!result) {
    dbg.input.log('Refit cancelled');
    return;
  }

  unit.attributes = result.attributes;

  const newMaxHp = (result.attributes.maxHealth ?? 1) * 10;
  unit.currentHealth = newMaxHp;

  turnManager.movementPoints.set(unitId, 0);

  await rerenderUnitSprite(unit, world);

  dbg.input.log('Refit complete:', unit.label, '| new HP:', newMaxHp, '| MP zeroed');
  localMap.computeMovementRange();
  localMap.render();
  detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
  if (firstPerson.isActive) firstPerson.refresh();
}

export async function handlePlayerBuildingRefit(ctx: GameContext, buildingId: string): Promise<void> {
  const { world, localMap, detailPanel, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Building refit blocked — not player turn');
    return;
  }
  const building = world.buildings.find((b) => b.id === buildingId);
  if (!building) return;

  const label = `#${building.id.replace(/^building_/, '')}`;
  const fc = factionColor(world, building.ownerId);
  const result = await showBuildingRefitModal({ label, attributes: building.attributes }, fc);
  if (!result) {
    dbg.input.log('Building refit cancelled');
    return;
  }

  building.attributes = result.attributes;
  await rerenderBuildingSprite(building, world);

  dbg.input.log('Building refit complete:', buildingId);
  localMap.render();
  detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
}
