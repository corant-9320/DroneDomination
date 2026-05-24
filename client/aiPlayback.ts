/**
 * AI Playback Controller — video-style controls for enemy turn execution.
 *
 * Modes:
 *  - 'play'    — actions play with a timed delay so the player can follow
 *  - 'paused'  — waits for the player to click ⏩ (Fast Forward / Next)
 *  - 'fastForward' — skips the current delay and advances to the next action
 *
 * The controller renders a small toolbar into the combat panel area
 * and exposes a `waitForNext()` promise that AI turn logic awaits
 * between each action.
 */

export type PlaybackMode = 'play' | 'paused' | 'fastForward';

export class AiPlaybackController {
  private mode: PlaybackMode = 'play';
  private active: boolean = false;
  private el: HTMLElement;
  private resolve: (() => void) | null = null;
  private timer: number | null = null;
  /** Delay (ms) between actions in 'play' mode. */
  private playDelay: number = 1500;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'ai-playback-bar';
    this.el.style.display = 'none';
    container.appendChild(this.el);
    this.renderBar();
  }

  /** Show the playback bar and reset state — call at the start of the AI turn. */
  begin(): void {
    this.active = true;
    this.mode = 'play';
    this.el.style.display = '';
    this.renderBar();
  }

  /** Hide the bar — call when all AI turns are done. */
  end(): void {
    this.active = false;
    this.el.style.display = 'none';
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  /** Whether the controller is actively managing an AI turn. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Await this between each AI action. Resolves based on the current mode:
   *  - play: after `playDelay` ms
   *  - paused: when the player clicks ⏩
   *  - fastForward: immediately (then resets to play mode for next action)
   */
  waitForNext(): Promise<void> {
    if (!this.active) return Promise.resolve();

    if (this.mode === 'fastForward') {
      // Immediately advance, then revert to play for next action
      this.mode = 'play';
      this.renderBar();
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.resolve = resolve;

      if (this.mode === 'play') {
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.resolve = null;
          resolve();
        }, this.playDelay);
      }
      // If paused, just wait — resolve is called by button click
    });
  }

  // ─── Internal ──────────────────────────────────────────────

  private setMode(mode: PlaybackMode): void {
    this.mode = mode;
    this.renderBar();

    // If switching to fastForward or play while waiting, resolve now
    if (mode === 'fastForward' && this.resolve) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const r = this.resolve;
      this.resolve = null;
      r();
    }
    if (mode === 'play' && this.resolve && this.timer === null) {
      // Was paused, now playing — start a delay
      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (this.resolve) {
          const r = this.resolve;
          this.resolve = null;
          r();
        }
      }, this.playDelay);
    }
  }

  private renderBar(): void {
    const isPlaying = this.mode === 'play';
    const isPaused = this.mode === 'paused';

    this.el.innerHTML = `
      <div class="ai-pb-label">⚙ Enemy Turn</div>
      <div class="ai-pb-buttons">
        <button class="ai-pb-btn" id="ai-pb-play" title="${isPlaying ? 'Pause' : 'Play'}">${isPlaying ? '⏸' : '▶'}</button>
        <button class="ai-pb-btn" id="ai-pb-ff" title="Next action (Fast Forward)">⏩</button>
      </div>
    `;

    const playBtn = this.el.querySelector('#ai-pb-play') as HTMLButtonElement;
    const ffBtn = this.el.querySelector('#ai-pb-ff') as HTMLButtonElement;

    playBtn.addEventListener('click', () => {
      if (this.mode === 'play') {
        // Pause
        if (this.timer !== null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.mode = 'paused';
        this.renderBar();
      } else {
        // Resume playing
        this.setMode('play');
      }
    });

    ffBtn.addEventListener('click', () => {
      this.setMode('fastForward');
    });
  }
}
