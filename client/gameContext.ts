/**
 * Shared runtime context threaded through all controller modules.
 * Constructed once in main.ts and passed to each setup function.
 * No logic lives here — only the wire.
 */

import type { WorldData } from './worldData.js';
import type { GlobeView } from './globe.js';
import type { LocalMapView } from './localMap.js';
import type { CombatPanel } from './combatPanel.js';
import type { DetailPanel } from './detailPanel.js';
import type { FirstPersonView } from './firstPersonView.js';
import type { AiPlaybackController } from './aiPlayback.js';
import type { TurnManager } from './turnManager.js';
import type { MatchClient } from './matchClient.js';

export interface GameContext {
  world: WorldData;
  globe: GlobeView;
  localMap: LocalMapView;
  combatPanel: CombatPanel;
  detailPanel: DetailPanel;
  firstPerson: FirstPersonView;
  aiPlayback: AiPlaybackController;
  turnManager: TurnManager;
  /** Authoritative server match session (server-authority Phase 3). */
  matchClient: MatchClient;
  /** Switch the right-curtain tab (main = selection info, history = combat log). */
  switchRpTab: (tab: 'main' | 'history') => void;
  /** True when the player's faction is the active one. */
  isPlayerTurn: () => boolean;
  /** Refresh the turn-number indicator in the HUD. */
  updateTurnIndicator: () => void;
}
