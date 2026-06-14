/**
 * AI Playback Controller — video-style controls for enemy turn execution.
 *
 * Buttons (left to right):
 *  ⏪  Fast Rewind   — return to the beginning of the enemy round
 *  ⏮  Step Rewind   — return to the previous enemy move
 *  ▶/⏸ Play         — auto-play enemy moves with a 3-second gap (toggle)
 *  ⏭  Step Forward  — show next enemy move (recorded replay or live)
 *  ⏩  Skip to End   — instantly resolve all remaining enemy moves to their
 *                     final outcome (no per-step delay, animations skipped)
 *
 * The controller records unit-state snapshots after each AI action so the
 * player can rewind through already-executed moves without recomputing them.
 * Forward navigation either replays a recorded snapshot or triggers the next
 * live AI computation (by resolving the waitForNext promise).
 */

import type { WorldData, UnitData } from './worldData.js';

export type PlaybackMode = 'paused' | 'play';

export class AiPlaybackController {
  private mode: PlaybackMode = 'paused';
  private active: boolean = false;
  private el: HTMLElement;

  /** Promise resolve for the currently pending waitForNext() call. */
  private pendingResolve: (() => void) | null = null;
  /** Auto-play timer handle. */
  private timer: number | null = null;

  // Timing
  private readonly PLAY_DELAY = 3000;

  /**
   * Skip-to-end mode. When true, waitForNext() resolves immediately so the AI
   * loop runs to completion as fast as the async combat calls allow, and the
   * visual callbacks (animations, intermediate renders) are bypassed. Set by
   * the ⏩ button; reset at the start/end of each round.
   */
  private skipping: boolean = false;

  // Recording & navigation
  /** Snapshots of world.units at each step. Index 0 is the state before any AI action. */
  private snapshots: UnitData[][] = [];
  /** Current viewing position in the snapshots array. */
  private cursor: number = 0;
  /** Reference to the world object for snapshotting and restoring state. */
  private world: WorldData | null = null;
  /** Callback to re-render the map after restoring a snapshot. */
  private renderCallback: (() => void) | null = null;
  /** True once all AI actions for this round have been computed. */
  private computationDone: boolean = false;
  /** Resolve for waitUntilDone() — called when the user reaches the final snapshot. */
  private doneResolve: (() => void) | null = null;

  constructor(container: HTMLElement, insertBefore?: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'ai-playback-bar';
    this.el.style.display = 'none';
    if (insertBefore) {
      container.insertBefore(this.el, insertBefore);
    } else {
      container.appendChild(this.el);
    }
    this.renderBar();
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * Show the playback bar and start recording — call at the start of the AI round.
   * @param world    Reference to the live world object (units will be snapshotted/restored).
   * @param renderCb Callback to re-render the map after a snapshot restore.
   */
  begin(world: WorldData, renderCb: () => void): void {
    this.active = true;
    this.mode = 'paused';
    this.skipping = false;
    this.world = world;
    this.renderCallback = renderCb;
    this.computationDone = false;
    this.doneResolve = null;

    // Snapshot the initial state (before any AI moves)
    this.snapshots = [structuredClone(world.units)];
    this.cursor = 0;

    this.el.style.display = '';
    this.renderBar();
  }

  /**
   * Record the current world.units as a new snapshot.
   * Call this after each AI action resolves (move or attack).
   */
  recordSnapshot(): void {
    if (!this.world) return;
    this.snapshots.push(structuredClone(this.world.units));
    this.cursor = this.snapshots.length - 1;
    this.renderBar();

    // If auto-playing, schedule the next advance
    if (!this.skipping && this.mode === 'play') {
      this.scheduleAutoAdvance();
    }
  }

  /**
   * Signal that all AI actions for this round have been computed.
   * If the cursor is already at the final snapshot, resolves immediately.
   * Otherwise the bar stays visible until the user catches up.
   */
  markComplete(): void {
    this.computationDone = true;
    this.renderBar();

    // If already at the end, auto-finish
    if (this.cursor === this.snapshots.length - 1) {
      this.finishPlayback();
    }
  }

  /**
   * Returns a promise that resolves once the player has viewed all AI moves
   * (cursor reaches the final snapshot after computation is done).
   */
  waitUntilDone(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.computationDone && this.cursor === this.snapshots.length - 1) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });
  }

  /** Hide the bar and clean up — call after waitUntilDone resolves. */
  end(): void {
    this.active = false;
    this.skipping = false;
    this.el.style.display = 'none';
    this.clearTimer();

    // If AI turn is still waiting (e.g. forced end), unblock it
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }

    this.snapshots = [];
    this.world = null;
    this.renderCallback = null;
  }

  /** Whether the controller is actively managing an AI turn. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Whether the round is being skipped to its end. The AI turn callbacks use
   * this to bypass attack animations and intermediate map renders so the
   * final outcome appears immediately.
   */
  isSkipping(): boolean {
    return this.skipping;
  }

  /**
   * Await this between each AI action.
   * Resolves when the controller decides the next live action should execute
   * (via Step Forward, Play timer, or Fast Forward timer).
   */
  waitForNext(): Promise<void> {
    if (!this.active) return Promise.resolve();

    // Skip-to-end: never block, let the AI loop drain to completion.
    if (this.skipping) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
      this.renderBar();

      // If in auto-play and at the live edge, schedule the timer
      if (this.mode === 'play') {
        this.scheduleAutoAdvance();
      }
    });
  }

  // ─── Navigation Actions ────────────────────────────────────

  /** ⏪ Fast Rewind — jump to the start of the enemy round. */
  private rewindAll(): void {
    if (this.cursor === 0) return;
    this.stopAutoPlay();
    this.cursor = 0;
    this.restoreSnapshot();
  }

  /** ⏮ Step Rewind — go back one move. */
  private rewindStep(): void {
    if (this.cursor <= 0) return;
    this.stopAutoPlay();
    this.cursor--;
    this.restoreSnapshot();
  }

  /** ▶/⏸ Play toggle — auto-play at 3s intervals. */
  private togglePlay(): void {
    if (this.mode === 'play') {
      this.stopAutoPlay();
    } else {
      this.mode = 'play';
      this.renderBar();
      this.scheduleAutoAdvance();
    }
  }

  /** ⏭ Step Forward — advance one move (replay or live). */
  private stepForward(): void {
    this.stopAutoPlay();
    this.advanceOne();
  }

  /** ⏩ Skip to End — instantly resolve all remaining moves to the final outcome. */
  private skipToEnd(): void {
    if (this.skipping) return;
    this.skipping = true;
    this.mode = 'paused';
    this.clearTimer();
    this.renderBar();

    // If the AI loop is currently parked on waitForNext(), release it now.
    // From here on every waitForNext() resolves immediately, so the loop
    // drains to completion on its own; markComplete() then finishes playback.
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r();
    }
  }

  // ─── Internal Logic ────────────────────────────────────────

  /** Advance the cursor by one step. Either replays a recorded snapshot or triggers live computation. */
  private advanceOne(): void {
    // Case 1: There are recorded snapshots ahead — replay
    if (this.cursor < this.snapshots.length - 1) {
      this.cursor++;
      this.restoreSnapshot();

      // Check if we reached the end after computation is done
      if (this.computationDone && this.cursor === this.snapshots.length - 1) {
        this.stopAutoPlay();
        this.finishPlayback();
      }
      return;
    }

    // Case 2: At the live edge with a pending computation — trigger it
    if (this.pendingResolve && !this.computationDone) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r();
      // recordSnapshot() will be called after the action completes
      return;
    }

    // Case 3: At the end and computation is done — nothing to do
    if (this.computationDone) {
      this.stopAutoPlay();
      this.finishPlayback();
    }
  }

  /** Restore world.units from the snapshot at `cursor` and re-render. */
  private restoreSnapshot(): void {
    if (!this.world || this.cursor >= this.snapshots.length) return;
    this.world.units = structuredClone(this.snapshots[this.cursor]);
    if (this.renderCallback) this.renderCallback();
    this.renderBar();
  }

  /** Schedule the next auto-advance based on the current mode. */
  private scheduleAutoAdvance(): void {
    this.clearTimer();

    if (this.mode === 'paused') return;
    if (!this.canAdvance()) {
      this.stopAutoPlay();
      return;
    }

    const delay = this.PLAY_DELAY;

    // If we can replay (cursor behind live edge), use the timer directly
    // If at the live edge, the timer triggers a live computation
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.advanceOne();
    }, delay);
  }

  /** Whether forward navigation is possible. */
  private canAdvance(): boolean {
    // Can replay a recorded snapshot
    if (this.cursor < this.snapshots.length - 1) return true;
    // Can trigger a live computation
    if (!this.computationDone && this.pendingResolve) return true;
    // Can trigger a live computation (pending hasn't arrived yet but will)
    if (!this.computationDone) return true;
    return false;
  }

  /** Stop any auto-play mode and clear timer. */
  private stopAutoPlay(): void {
    this.mode = 'paused';
    this.clearTimer();
    this.renderBar();
  }

  /** Clear the auto-play timer. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Called when the user has reached the final snapshot and computation is done. */
  private finishPlayback(): void {
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────

  private renderBar(): void {
    const canRewind = this.cursor > 0;
    const canForward = this.canAdvance();
    const isPlaying = this.mode === 'play';

    this.el.innerHTML = `
      <div class="ai-pb-label">⚙ Enemy Turn</div>
      <div class="ai-pb-buttons">
        <button class="ai-pb-btn" id="ai-pb-rewind-all" title="Fast Rewind (start of round)" ${canRewind ? '' : 'disabled'}>⏪</button>
        <button class="ai-pb-btn" id="ai-pb-rewind-step" title="Step Rewind (previous move)" ${canRewind ? '' : 'disabled'}>⏮</button>
        <button class="ai-pb-btn${isPlaying ? ' ai-pb-active' : ''}" id="ai-pb-play" title="${isPlaying ? 'Pause' : 'Play (3s interval)'}" ${!isPlaying && !canForward ? 'disabled' : ''}>${isPlaying ? '⏸' : '▶'}</button>
        <button class="ai-pb-btn" id="ai-pb-step-fwd" title="Step Forward (next move)" ${canForward ? '' : 'disabled'}>⏭</button>
        <button class="ai-pb-btn" id="ai-pb-skip" title="Skip to End (resolve all moves instantly)" ${this.skipping || !canForward ? 'disabled' : ''}>⏩</button>
      </div>
      <div class="ai-pb-counter">${this.cursor}/${this.snapshots.length - 1}</div>
    `;

    this.bindButtons();
  }

  private bindButtons(): void {
    const rewindAllBtn = this.el.querySelector('#ai-pb-rewind-all') as HTMLButtonElement | null;
    const rewindStepBtn = this.el.querySelector('#ai-pb-rewind-step') as HTMLButtonElement | null;
    const playBtn = this.el.querySelector('#ai-pb-play') as HTMLButtonElement | null;
    const stepFwdBtn = this.el.querySelector('#ai-pb-step-fwd') as HTMLButtonElement | null;
    const skipBtn = this.el.querySelector('#ai-pb-skip') as HTMLButtonElement | null;

    rewindAllBtn?.addEventListener('click', () => this.rewindAll());
    rewindStepBtn?.addEventListener('click', () => this.rewindStep());
    playBtn?.addEventListener('click', () => this.togglePlay());
    stepFwdBtn?.addEventListener('click', () => this.stepForward());
    skipBtn?.addEventListener('click', () => this.skipToEnd());
  }
}
