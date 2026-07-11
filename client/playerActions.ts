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
  const { world, localMap, firstPerson, combatPanel, detailPanel, turnManager, matchClient, switchRpTab, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Attack blocked — not player turn');
    return;
  }
  dbg.input.log('Attack initiated:', attackerId, '→', targetId);
  emitDebugEvent('attack', { attackerId, targetId }, turnManager.turnNumber);

  const attacker = world.units.find((u) => u.id === attackerId);

  // Authoritative resolution via the match session.
  const resp = await matchClient.submit({ kind: 'attack', attackerId, targetId });
  if (!resp || !resp.success) {
    if (resp?.error) dbg.input.log('Attack rejected by server:', resp.error);
    return;
  }

  switchRpTab('history');

  const combat = resp.combats?.[0];
  if (combat) {
    const damage = combat.directDamage;
    const targetDestroyed = combat.targetDestroyed;
    const attackerColor = attacker ? factionColor(world, attacker.ownerId) : '#ffffff';
    const splashVictims = combat.splash
      .filter((s) => s.victimId !== targetId)
      .map((s) => ({ unitId: s.victimId, damage: s.damage, destroyed: s.victimDestroyed }));

    const attackAnims: Array<Promise<void>> = [
      localMap.playAttackAnimation(attackerId, targetId, attackerColor, damage, targetDestroyed, splashVictims),
    ];
    if (firstPerson.isActive) {
      attackAnims.push(firstPerson.playAttackAnimation(attackerId, targetId, attackerColor, damage, targetDestroyed, splashVictims));
    }
    await Promise.all(attackAnims);
  }

  // Adopt authoritative state, then rebuild any damaged building models.
  const buildingDamage = combat?.buildingDamage ?? [];
  matchClient.reconcile(resp, world, turnManager);
  combatPanel.recordHistory(resp.combats ?? [], resp.reactions ?? []);
  for (const ev of buildingDamage) {
    const b = world.buildings.find((bb) => bb.id === ev.buildingId);
    if (b) await rerenderBuildingSprite(b, world);
  }

  localMap.computeMovementRange();
  localMap.render();
  if (firstPerson.isActive) firstPerson.refresh();
  detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
}

export async function handlePlayerBuildingAttack(
  ctx: GameContext,
  attackerId: string,
  buildingId: string,
  mode: 'splash' | 'direct',
  component?: string,
): Promise<void> {
  const { world, localMap, firstPerson, combatPanel, detailPanel, turnManager, matchClient, switchRpTab, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Building attack blocked — not player turn');
    return;
  }
  dbg.input.log('Building attack initiated:', attackerId, '→', buildingId, mode, component ?? '');
  emitDebugEvent('attack', { attackerId, targetId: buildingId }, turnManager.turnNumber);

  const resp = await matchClient.submit({
    kind: 'attackBuilding',
    attackerId,
    buildingId,
    weaponMode: mode,
    component: component as import('../shared/buildingComponents.js').BuildingComponent | undefined,
  });
  if (!resp || !resp.success) {
    if (resp?.error) dbg.input.log('Building attack rejected by server:', resp.error);
    return;
  }

  switchRpTab('history');

  const combat = resp.combats?.[0];
  const attacker = world.units.find((u) => u.id === attackerId);
  const attackerColor = attacker ? factionColor(world, attacker.ownerId) : '#ffffff';
  const splashVictims = (combat?.splash ?? []).map((s) => ({
    unitId: s.victimId,
    damage: s.damage,
    destroyed: s.victimDestroyed,
  }));
  const buildingAnims: Array<Promise<void>> = [
    localMap.playBuildingAttackAnimation(attackerId, buildingId, attackerColor, splashVictims),
  ];
  if (firstPerson.isActive) {
    buildingAnims.push(firstPerson.playBuildingAttackAnimation(attackerId, buildingId, attackerColor, splashVictims));
  }
  await Promise.all(buildingAnims);

  const buildingDamage = combat?.buildingDamage ?? [];
  matchClient.reconcile(resp, world, turnManager);
  combatPanel.recordHistory(resp.combats ?? [], []);
  for (const ev of buildingDamage) {
    const b = world.buildings.find((bb) => bb.id === ev.buildingId);
    if (b) await rerenderBuildingSprite(b, world);
  }

  localMap.computeMovementRange();
  localMap.render();
  if (firstPerson.isActive) firstPerson.refresh();
  detailPanel.showTile(localMap.selectedTile, localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined);
}

export async function handlePlayerRepair(
  ctx: GameContext,
  repairerId: string,
  targetId: string,
): Promise<void> {
  const { world, localMap, firstPerson, combatPanel, turnManager, matchClient, isPlayerTurn } = ctx;

  if (!isPlayerTurn()) {
    dbg.input.log('Repair blocked — not player turn');
    return;
  }
  dbg.input.log('Repair initiated:', repairerId, '→', targetId);
  emitDebugEvent('repair', { repairerId, targetId }, turnManager.turnNumber);

  const resp = await matchClient.submit({ kind: 'repair', repairerId, targetId });
  if (!resp || !resp.success) {
    if (resp?.error) dbg.input.log('Repair rejected by server:', resp.error);
    return;
  }

  matchClient.reconcile(resp, world, turnManager);
  if (resp.repair) combatPanel.recordRepairHistory(resp.repair);

  localMap.computeMovementRange();
  localMap.render();
  if (firstPerson.isActive) firstPerson.refresh();
}

/**
 * Submit a committed player move to the authoritative session and adopt the
 * result. The local optimistic move + glide have already run in mapInput; this
 * syncs the server's authoritative position / MP (and surfaces any drone
 * reaction fire). Skips pure intra-hex repositions (no tile-index path).
 */
export async function handlePlayerMove(
  ctx: GameContext,
  unitId: string,
  path: number[],
  segment: number,
): Promise<void> {
  const { world, localMap, combatPanel, turnManager, matchClient, isPlayerTurn } = ctx;
  if (!isPlayerTurn()) return;
  if (path.length < 2) return; // intra-hex reposition — not modelled server-side yet

  const resp = await matchClient.submit({ kind: 'move', unitId, path, segment });
  if (!resp || !resp.success) {
    if (resp?.error) dbg.input.log('Move rejected by server:', resp.error);
    return;
  }

  matchClient.reconcile(resp, world, turnManager);
  if (resp.reactions && resp.reactions.length > 0) {
    combatPanel.recordHistory([], resp.reactions);
  }
  localMap.computeMovementRange();
  localMap.render();
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

  const newMaxHp = (result.attributes.size ?? 1) * 10;
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
