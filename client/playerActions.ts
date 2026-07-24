/**
 * All player-initiated actions: attack, repair, refit, building refit, sleep.
 * Each handler checks isPlayerTurn(), emits a debug event, calls the server
 * (via combatPanel), and syncs the result back into world + renders.
 */

import { showRefitModal } from './refitModal.js';
import { showBuildingRefitModal } from './buildingRefitModal.js';
import {
  godModeCreateOilBuilding,
  godModeDeleteOilBuilding,
  godModeEditOilBuilding,
  createShuttleTransport as submitCreateShuttleTransport,
  stopShuttleTransport as submitStopShuttleTransport,
} from './logisticsController.js';
import {
  showShuttleDestinationModal,
  shuttleCandidateLabel,
  type ShuttleDestinationCandidate,
} from './shuttleTransportModal.js';
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
 * reaction fire). A one-tile path represents a pure intra-hex reposition.
 */
export async function handlePlayerMove(
  ctx: GameContext,
  unitId: string,
  path: number[],
  segment: number,
): Promise<void> {
  const { world, localMap, combatPanel, turnManager, matchClient, isPlayerTurn } = ctx;
  if (!isPlayerTurn()) return;
  if (path.length < 1) return;

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

function canUseGodModeEntityEditing(ctx: GameContext): boolean {
  return ctx.matchClient.capabilities?.entityEditing === true;
}

function refreshAfterGodModeEntityAction(ctx: GameContext): void {
  const { localMap, detailPanel } = ctx;
  localMap.computeMovementRange();
  localMap.render();
  detailPanel.showTile(
    localMap.selectedTile,
    localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined,
  );
}

/** Edit a unit through the development-only authoritative match intent. */
export async function handleGodModeEditUnit(ctx: GameContext, unitId: string): Promise<void> {
  const { world, matchClient, turnManager } = ctx;
  if (!canUseGodModeEntityEditing(ctx)) return;

  const unit = world.units.find((candidate) => candidate.id === unitId);
  if (!unit) return;
  const result = await showRefitModal(unit, {
    allowSizeEdit: true,
    allowUnrestrictedBudget: true,
  });
  if (!result) return;

  const response = await matchClient.submit({ kind: 'godModeEditUnit', unitId, attributes: result.attributes });
  if (!response?.success) {
    if (response?.error) dbg.input.log('God Mode unit edit rejected:', response.error);
    return;
  }

  matchClient.reconcile(response, world, turnManager);
  const updated = world.units.find((candidate) => candidate.id === unitId);
  if (updated) await rerenderUnitSprite(updated, world);
  refreshAfterGodModeEntityAction(ctx);
}

/** Delete a unit through the development-only authoritative match intent. */
export async function handleGodModeDeleteUnit(ctx: GameContext, unitId: string): Promise<void> {
  const { world, matchClient, turnManager, firstPerson } = ctx;
  if (!canUseGodModeEntityEditing(ctx)) return;

  const response = await matchClient.submit({ kind: 'godModeDeleteUnit', unitId });
  if (!response?.success) {
    if (response?.error) dbg.input.log('God Mode unit deletion rejected:', response.error);
    return;
  }

  matchClient.reconcile(response, world, turnManager);
  turnManager.selectedUnits.delete(unitId);
  turnManager.sleepingUnits.delete(unitId);
  turnManager.rotatedUnits.delete(unitId);
  if (firstPerson.isActive) firstPerson.close();
  refreshAfterGodModeEntityAction(ctx);
}

/** Edit a building through the development-only authoritative match intent. */
export async function handleGodModeEditBuilding(ctx: GameContext, buildingId: string): Promise<void> {
  const { world, matchClient, turnManager } = ctx;
  if (!canUseGodModeEntityEditing(ctx)) return;

  const building = world.buildings.find((candidate) => candidate.id === buildingId);
  if (!building) return;
  const label = `#${building.id.replace(/^building_/, '')}`;
  const result = await showBuildingRefitModal(
    { label, attributes: building.attributes },
    factionColor(world, building.ownerId),
  );
  if (!result) return;

  const response = await matchClient.submit({ kind: 'godModeEditBuilding', buildingId, attributes: result.attributes });
  if (!response?.success) {
    if (response?.error) dbg.input.log('God Mode building edit rejected:', response.error);
    return;
  }

  matchClient.reconcile(response, world, turnManager);
  const updated = world.buildings.find((candidate) => candidate.id === buildingId);
  if (updated) await rerenderBuildingSprite(updated, world);
  refreshAfterGodModeEntityAction(ctx);
}

/** Delete a building through the development-only authoritative match intent. */
export async function handleGodModeDeleteBuilding(ctx: GameContext, buildingId: string): Promise<void> {
  const { world, matchClient, turnManager } = ctx;
  if (!canUseGodModeEntityEditing(ctx)) return;

  const response = await matchClient.submit({ kind: 'godModeDeleteBuilding', buildingId });
  if (!response?.success) {
    if (response?.error) dbg.input.log('God Mode building deletion rejected:', response.error);
    return;
  }

  matchClient.reconcile(response, world, turnManager);
  if (turnManager.selectedBuilding?.id === buildingId) turnManager.clearBuilding();
  refreshAfterGodModeEntityAction(ctx);
}

export async function handleGodModeCreateOilBuilding(
  ctx: GameContext,
  structure: 'well' | 'refinery',
  tileIndex: number,
  segment: number,
): Promise<void> {
  if (!canUseGodModeEntityEditing(ctx)) return;
  const response = await godModeCreateOilBuilding(ctx, structure, tileIndex, segment);
  if (!response?.success) return;
  refreshAfterGodModeEntityAction(ctx);
}

function promptNonNegativeInteger(label: string, current: number, minimum = 0): number | null {
  const value = window.prompt(label, String(current));
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    window.alert(`Enter an integer of at least ${minimum}.`);
    return null;
  }
  return parsed;
}

/** Edit stored resources and HP while preserving the structure's segment footprint. */
export async function handleGodModeEditOilBuilding(
  ctx: GameContext,
  structure: 'well' | 'refinery',
  structureId: string,
): Promise<void> {
  const { world } = ctx;
  if (!canUseGodModeEntityEditing(ctx)) return;

  if (structure === 'well') {
    const well = world.logistics?.wells.find((candidate) => candidate.id === structureId);
    if (!well) return;
    const hitPoints = promptNonNegativeInteger('Oil well hit points', well.hitPoints, 1);
    if (hitPoints === null) return;
    const storedOil = promptNonNegativeInteger('Oil well stored oil', well.storedOil);
    if (storedOil === null) return;
    const response = await godModeEditOilBuilding(ctx, {
      kind: 'godModeEditOilBuilding', structure, structureId, hitPoints, storedOil,
    });
    if (!response?.success) return;
    refreshAfterGodModeEntityAction(ctx);
    return;
  }

  const refinery = world.logistics?.refineries.find((candidate) => candidate.id === structureId);
  if (!refinery) return;
  const hitPoints = promptNonNegativeInteger('Refinery hit points', refinery.hitPoints, 1);
  if (hitPoints === null) return;
  const heldOil = promptNonNegativeInteger('Refinery held oil', refinery.heldOil);
  if (heldOil === null) return;
  const refinedProductAvailable = promptNonNegativeInteger(
    'Refinery refined product available', refinery.refinedProductAvailable,
  );
  if (refinedProductAvailable === null) return;
  const response = await godModeEditOilBuilding(ctx, {
    kind: 'godModeEditOilBuilding', structure, structureId, hitPoints, heldOil, refinedProductAvailable,
  });
  if (!response?.success) return;
  refreshAfterGodModeEntityAction(ctx);
}

export async function handleGodModeDeleteOilBuilding(
  ctx: GameContext,
  structure: 'well' | 'refinery',
  structureId: string,
  segment: number,
): Promise<void> {
  if (!canUseGodModeEntityEditing(ctx)) return;
  const response = structure === 'well'
    ? await godModeDeleteOilBuilding(ctx, { kind: 'godModeDeleteOilBuilding', structure, structureId })
    : await godModeDeleteOilBuilding(ctx, { kind: 'godModeDeleteOilBuilding', structure, structureId, segment });
  if (!response?.success) return;
  refreshAfterGodModeEntityAction(ctx);
}

// ─── Shuttle transports (RMB "Create Transport" / "Stop Transport") ─────────

function refreshAfterLogisticsAction(ctx: GameContext): void {
  const { localMap, detailPanel } = ctx;
  localMap.render();
  detailPanel.showTile(
    localMap.selectedTile,
    localMap.selectedSegment >= 0 ? localMap.selectedSegment : undefined,
  );
}

/**
 * RMB "Create Transport" on an owned oil hex (well / refinery / storage hub):
 * prompt for a destination among the player's other owned oil structures,
 * then submit the authoritative intent. The server rejects the request when
 * no road connects the two structures.
 */
export async function handleCreateShuttleTransport(
  ctx: GameContext,
  fromStructureId: string,
): Promise<void> {
  const { world, turnManager, isPlayerTurn } = ctx;
  if (!isPlayerTurn()) {
    dbg.input.log('Create Transport blocked — not player turn');
    return;
  }
  const playerFaction = turnManager.getPlayerFaction();
  const logistics = world.logistics;
  if (!logistics) return;

  const candidates: ShuttleDestinationCandidate[] = [
    ...logistics.wells
      .filter((w) => w.ownerId === playerFaction && w.id !== fromStructureId)
      .map((w) => ({ structureId: w.id, tileIndex: w.tileIndex, kind: 'well' as const })),
    ...logistics.refineries
      .filter((r) => r.ownerId === playerFaction && r.id !== fromStructureId)
      .map((r) => ({ structureId: r.id, tileIndex: r.tileIndex, kind: 'refinery' as const })),
    ...logistics.hubs
      .filter((h) => h.ownerId === playerFaction && h.id !== fromStructureId)
      .map((h) => ({ structureId: h.id, tileIndex: h.tileIndex, kind: 'hub' as const })),
  ]
    .sort((a, b) => a.tileIndex - b.tileIndex)
    .map((c) => ({ structureId: c.structureId, label: shuttleCandidateLabel(c.kind, c.tileIndex) }));

  const toStructureId = await showShuttleDestinationModal(candidates);
  if (!toStructureId) {
    dbg.input.log('Create Transport cancelled');
    return;
  }

  const response = await submitCreateShuttleTransport(ctx, fromStructureId, toStructureId);
  if (!response?.success) {
    if (response?.error) window.alert(response.error);
    return;
  }
  refreshAfterLogisticsAction(ctx);
}

/** RMB "Stop Transport" on the hex a shuttle currently occupies. */
export async function handleStopShuttleTransport(ctx: GameContext, transportId: string): Promise<void> {
  const { isPlayerTurn } = ctx;
  if (!isPlayerTurn()) {
    dbg.input.log('Stop Transport blocked — not player turn');
    return;
  }
  const response = await submitStopShuttleTransport(ctx, transportId);
  if (!response?.success) {
    if (response?.error) dbg.input.log('Stop Transport rejected:', response.error);
    return;
  }
  refreshAfterLogisticsAction(ctx);
}
