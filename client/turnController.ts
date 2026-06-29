/**
 * Turn lifecycle: advanceTurn, confirmEndTurn, faction cycling, AI orchestration.
 */

import { fetchAiTurn, replayAiTurn } from './aiTurn.js';
import { dbg } from './debug.js';
import { emitDebugEvent } from './gameDebug.js';
import { getMaxMovement } from '../shared/movementConstants.js';
import type { GameContext } from './gameContext.js';

/**
 * Show a confirmation modal if the player has units with MP remaining (not sleeping).
 * Returns true if the player confirms or there are no unmoved units.
 */
export function confirmEndTurn(ctx: GameContext): Promise<boolean> {
  const { turnManager, localMap, globe } = ctx;
  const unmovedUnits = turnManager.getUnmovedAwakeUnits();
  if (unmovedUnits.length === 0) return Promise.resolve(true);

  // Pause the globe's rAF loop so Playwright's element stability check passes.
  // Without this, continuous renders prevent the actionability check from
  // ever seeing the button as "stable" and clicks time out in headless tests.
  globe.pauseRender();

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.3)',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      zIndex: '2000',
    });

    const dialog = document.createElement('div');
    Object.assign(dialog.style, {
      background: '#1e1e1e',
      border: '1px solid #444',
      borderRadius: '8px 8px 0 0',
      padding: '16px 24px 20px',
      minWidth: '320px',
      maxWidth: '500px',
      height: '320px',
      display: 'flex',
      flexDirection: 'column',
      color: '#eee',
      fontFamily: "'Segoe UI', sans-serif",
      marginBottom: '0',
    });

    const unitListHtml = unmovedUnits.map((u, i) => {
      const name = u.label || u.id;
      const mp = turnManager.getMovementPoints(u.id);
      const maxMp = getMaxMovement(u.attributes);
      return `<div class="confirm-unit-row" data-idx="${i}" style="padding:4px 8px;cursor:pointer;border-radius:3px;font-size:12px;color:#ccc;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#eee;">${name}</span>
        <span style="color:#7ec8e3;font-size:11px;">${mp}/${maxMp} MP</span>
      </div>`;
    }).join('');

    dialog.innerHTML = `
      <h3 style="margin:0 0 10px;font-size:15px;color:#f0c040;">Are you sure?</h3>
      <p style="margin:0 0 8px;font-size:13px;color:#aaa;">
        ${unmovedUnits.length} unit${unmovedUnits.length > 1 ? 's' : ''} still ha${unmovedUnits.length > 1 ? 've' : 's'} movement remaining:
      </p>
      <div id="confirm-unit-list" style="flex:1;overflow-y:auto;margin-bottom:14px;border:1px solid #333;border-radius:4px;padding:4px 0;min-height:0;">
        ${unitListHtml}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="confirm-cancel" style="padding:6px 14px;background:#333;border:1px solid #555;color:#ccc;border-radius:4px;cursor:pointer;">Cancel</button>
        <button id="confirm-end" style="padding:6px 14px;background:#c0392b;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">End Turn</button>
      </div>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    // Wire up unit row clicks — navigate to that unit's location
    const rows = dialog.querySelectorAll('.confirm-unit-row');
    rows.forEach((row) => {
      row.addEventListener('mouseenter', () => { (row as HTMLElement).style.background = '#333'; });
      row.addEventListener('mouseleave', () => { (row as HTMLElement).style.background = ''; });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt((row as HTMLElement).dataset.idx!);
        const unit = unmovedUnits[idx];
        if (unit) {
          localMap.focusUnit(unit.id);
          ctx.detailPanel.showTile(unit.tileIndex, unit.segment);
        }
      });
    });

    function cleanup() {
      document.body.removeChild(backdrop);
      globe.resumeRender();
    }

    dialog.querySelector('#confirm-cancel')!.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });
    dialog.querySelector('#confirm-end')!.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { cleanup(); resolve(false); }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cleanup(); window.removeEventListener('keydown', onKey); resolve(false); }
      if (e.key === 'Enter')  { cleanup(); window.removeEventListener('keydown', onKey); resolve(true); }
    };
    window.addEventListener('keydown', onKey);
  });
}

/**
 * End the player's turn, let all AI factions take their moves,
 * then return control to the player with fresh movement points.
 */
export async function advanceTurn(ctx: GameContext): Promise<void> {
  const {
    world, localMap, globe: _globe, combatPanel, detailPanel,
    firstPerson, aiPlayback, turnManager, switchRpTab: _switchRpTab,
    isPlayerTurn, updateTurnIndicator,
  } = ctx;

  if (!isPlayerTurn()) return;

  const confirmed = await confirmEndTurn(ctx);
  if (!confirmed) return;

  dbg.input.log('Player ending turn — processing AI factions');
  emitDebugEvent('turn-end', { turn: turnManager.turnNumber }, turnManager.turnNumber);

  const renderMap = () => {
    if (aiPlayback.isSkipping()) return;
    localMap.render();
  };
  aiPlayback.begin(world, renderMap);

  const aiCallbacks = {
    highlightCombat(attackerId: string, targetId: string) {
      localMap.setHighlightCombat(attackerId, targetId);
    },
    clearHighlight() {
      localMap.setHighlightCombat(null, null);
    },
    highlightMove(unitId: string, fromTile: number, fromSeg: number) {
      localMap.setHighlightMove(unitId, fromTile, fromSeg);
    },
    markActed(unitId: string) {
      localMap.markAiActed(unitId);
    },
    selectActingUnit(unitId: string) {
      // Clear any lingering move arrow when focus shifts to the next acting unit.
      localMap.setHighlightMove(null, null);
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return;
      detailPanel.showTile(unit.tileIndex, unit.segment);
      combatPanel.showSelectedUnit(unit);
    },
    showCombatPreview(attackerId: string, targetId: string) {
      const attacker = world.units.find((u) => u.id === attackerId) ?? null;
      const target   = world.units.find((u) => u.id === targetId)   ?? null;
      detailPanel.showEnemy(target);
      combatPanel.showPreview(attacker, target);
    },
    renderMap,
    async playAttackAnimation(
      attackerId: string,
      targetId: string,
      factionColorHex: string,
      damage: number,
      targetDestroyed: boolean,
      splashVictims: Array<{ unitId: string; damage: number; destroyed: boolean }> = [],
    ) {
      if (aiPlayback.isSkipping()) return;
      const anims: Array<Promise<void>> = [
        localMap.playAttackAnimation(attackerId, targetId, factionColorHex, damage, targetDestroyed, splashVictims),
      ];
      if (firstPerson.isActive) {
        anims.push(firstPerson.playAttackAnimation(attackerId, targetId, factionColorHex, damage, targetDestroyed, splashVictims));
      }
      await Promise.all(anims);
    },
  };

  const factions = turnManager.getFactions();
  const playerFaction = turnManager.getPlayerFaction();

  for (let i = 1; i < factions.length; i++) {
    turnManager.activeFactionIndex = (turnManager.activeFactionIndex + 1) % factions.length;
    const faction = turnManager.getActiveFaction();
    if (faction === playerFaction) break;

    dbg.input.log('AI faction turn:', faction);
    emitDebugEvent('ai-turn-start', { faction }, turnManager.turnNumber);
    // Server-authoritative: resolve the whole faction turn in one request, then
    // replay the returned event log through the playback bar.
    const aiResult = await fetchAiTurn(world, faction);
    if (!aiResult.success) {
      dbg.input.error('AI turn resolution failed:', aiResult.error);
    } else {
      await replayAiTurn(world, aiResult.events, combatPanel, aiPlayback, aiCallbacks);
    }
  }

  aiPlayback.markComplete();
  await aiPlayback.waitUntilDone();
  aiPlayback.end();

  turnManager.activeFactionIndex = factions.indexOf(playerFaction);
  turnManager.turnNumber++;
  combatPanel.setActiveFaction(turnManager.getActiveFaction());
  combatPanel.setTurnNumber(turnManager.turnNumber);
  localMap.setActiveFaction(turnManager.getActiveFaction());
  updateTurnIndicator();
  localMap.endTurn();
  localMap.render();
  emitDebugEvent('ai-turn-end', { newTurn: turnManager.turnNumber }, turnManager.turnNumber);
  dbg.input.log('All AI turns complete — player turn begins, turn:', turnManager.turnNumber);
}
