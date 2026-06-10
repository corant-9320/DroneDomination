/**
 * Combat Animations — Canvas 2D particle effects for attacks.
 *
 * Three animation types:
 * 1. Missile: a coloured streak flying from attacker to target
 * 2. Explosion: radial burst at impact point, scaled by damage dealt
 * 3. Smoke puff: grey dissipating cloud when a unit is destroyed
 *
 * The system hooks into the local map's render() cycle. When animations are
 * active, it requests animation frames that trigger a full map re-render,
 * which ends by calling drawFrame() to overlay particles on top.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vec2 { x: number; y: number }

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;     // 0–1, starts at 1, decreases
  maxLife: number;
  size: number;
  color: string;
  alpha: number;
}

interface MissileState {
  type: 'missile';
  from: Vec2;
  to: Vec2;
  color: string;
  progress: number; // 0–1
  trail: Vec2[];
}

interface ExplosionState {
  type: 'explosion';
  centre: Vec2;
  particles: Particle[];
  progress: number;
  duration: number;
}

interface SmokeState {
  type: 'smoke';
  centre: Vec2;
  particles: Particle[];
  progress: number;
  duration: number;
}

type AnimationState = MissileState | ExplosionState | SmokeState;

interface QueuedAnimation {
  state: AnimationState;
  startTime: number;
  duration: number;
  resolve: () => void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MISSILE_DURATION = 400;        // ms
const EXPLOSION_DURATION = 500;      // ms
const SMOKE_DURATION = 700;          // ms
const EXPLOSION_PARTICLES = 24;
const SMOKE_PARTICLES = 16;
const TRAIL_LENGTH = 8;

// ---------------------------------------------------------------------------
// Animation Engine
// ---------------------------------------------------------------------------

export class CombatAnimator {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private queue: QueuedAnimation[] = [];
  private running: boolean = false;
  /** Callback to trigger a full map re-render (which will call drawFrame at the end). */
  private renderCallback: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /** Set the callback that triggers a full map re-render. */
  setRenderCallback(cb: () => void): void {
    this.renderCallback = cb;
  }

  /** True if any animations are currently playing. */
  get isAnimating(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Draw the current animation frame overlay.
   * Called at the end of localMap.render() so particles appear on top of the map.
   */
  drawFrame(): void {
    if (this.queue.length === 0) return;

    const now = performance.now();
    const dpr = window.devicePixelRatio || 1;

    this.ctx.save();
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const anim of this.queue) {
      const elapsed = now - anim.startTime;
      const t = Math.min(1, elapsed / anim.duration);

      switch (anim.state.type) {
        case 'missile':
          this.updateMissile(anim.state, t);
          this.drawMissile(anim.state);
          break;
        case 'explosion':
          this.updateExplosion(anim.state, t);
          this.drawExplosion(anim.state);
          break;
        case 'smoke':
          this.updateSmoke(anim.state, t);
          this.drawSmoke(anim.state);
          break;
      }
    }

    this.ctx.restore();
  }

  /**
   * Play a missile animation from attacker to target position.
   * Resolves when the missile arrives.
   */
  playMissile(from: Vec2, to: Vec2, factionColor: string): Promise<void> {
    return new Promise((resolve) => {
      const state: MissileState = {
        type: 'missile',
        from,
        to,
        color: factionColor,
        progress: 0,
        trail: [],
      };
      this.enqueue(state, MISSILE_DURATION, resolve);
    });
  }

  /**
   * Play an explosion at the given position.
   * Size scales with damage (1–100+ HP).
   */
  playExplosion(centre: Vec2, damage: number, color: string): Promise<void> {
    return new Promise((resolve) => {
      const scale = Math.min(2.5, 0.5 + damage / 20);
      const particles = this.createExplosionParticles(centre, scale, color);
      const state: ExplosionState = {
        type: 'explosion',
        centre,
        particles,
        progress: 0,
        duration: EXPLOSION_DURATION,
      };
      this.enqueue(state, EXPLOSION_DURATION, resolve);
    });
  }

  /**
   * Play a smoke puff when a unit is destroyed.
   */
  playSmoke(centre: Vec2): Promise<void> {
    return new Promise((resolve) => {
      const particles = this.createSmokeParticles(centre);
      const state: SmokeState = {
        type: 'smoke',
        centre,
        particles,
        progress: 0,
        duration: SMOKE_DURATION,
      };
      this.enqueue(state, SMOKE_DURATION, resolve);
    });
  }

  /**
   * Full attack sequence: missile → explosion (+ smoke if destroyed).
   * This is the main entry point for combat visual feedback.
   */
  async playAttack(
    from: Vec2,
    to: Vec2,
    factionColor: string,
    damage: number,
    targetDestroyed: boolean,
  ): Promise<void> {
    await this.playMissile(from, to, factionColor);
    await this.playExplosion(to, damage, factionColor);
    if (targetDestroyed) {
      await this.playSmoke(to);
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private enqueue(state: AnimationState, duration: number, resolve: () => void) {
    const entry: QueuedAnimation = {
      state,
      startTime: performance.now(),
      duration,
      resolve,
    };
    this.queue.push(entry);
    if (!this.running) {
      this.running = true;
      this.tick();
    }
  }

  private tick = () => {
    if (this.queue.length === 0) {
      this.running = false;
      return;
    }

    const now = performance.now();

    // Check for completed animations
    const completed: QueuedAnimation[] = [];
    for (const anim of this.queue) {
      const elapsed = now - anim.startTime;
      if (elapsed >= anim.duration) {
        completed.push(anim);
      }
    }

    // Remove completed and resolve
    for (const done of completed) {
      const idx = this.queue.indexOf(done);
      if (idx >= 0) this.queue.splice(idx, 1);
      done.resolve();
    }

    // Trigger a full map re-render (which will call drawFrame at the end)
    if (this.renderCallback) {
      this.renderCallback();
    }

    if (this.queue.length > 0) {
      requestAnimationFrame(this.tick);
    } else {
      this.running = false;
      // Final render to clear any leftover particles
      if (this.renderCallback) {
        this.renderCallback();
      }
    }
  };

  // ─── Missile ────────────────────────────────────────────────────────

  private updateMissile(m: MissileState, t: number) {
    m.progress = t;
    // Add current position to trail
    const pos = this.lerpVec(m.from, m.to, t);
    m.trail.push(pos);
    if (m.trail.length > TRAIL_LENGTH) {
      m.trail.shift();
    }
  }

  private drawMissile(m: MissileState) {
    const pos = this.lerpVec(m.from, m.to, m.progress);

    // Draw trail (fading streak)
    if (m.trail.length > 1) {
      this.ctx.save();
      for (let i = 1; i < m.trail.length; i++) {
        const alpha = (i / m.trail.length) * 0.6;
        const width = (i / m.trail.length) * 3;
        this.ctx.beginPath();
        this.ctx.moveTo(m.trail[i - 1].x, m.trail[i - 1].y);
        this.ctx.lineTo(m.trail[i].x, m.trail[i].y);
        this.ctx.strokeStyle = this.colorWithAlpha(m.color, alpha);
        this.ctx.lineWidth = width;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    // Draw missile head (bright dot with glow)
    this.ctx.save();
    this.ctx.shadowColor = m.color;
    this.ctx.shadowBlur = 12;
    this.ctx.beginPath();
    this.ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fill();
    this.ctx.beginPath();
    this.ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
    this.ctx.fillStyle = this.colorWithAlpha(m.color, 0.7);
    this.ctx.fill();
    this.ctx.restore();
  }

  // ─── Explosion ──────────────────────────────────────────────────────

  private createExplosionParticles(centre: Vec2, scale: number, color: string): Particle[] {
    const particles: Particle[] = [];
    const count = Math.round(EXPLOSION_PARTICLES * scale);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = (30 + Math.random() * 40) * scale;
      const life = 0.6 + Math.random() * 0.4;
      particles.push({
        x: centre.x,
        y: centre.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        size: (3 + Math.random() * 4) * scale,
        color: Math.random() > 0.4 ? color : (Math.random() > 0.5 ? '#ff8800' : '#ffcc00'),
        alpha: 1,
      });
    }
    return particles;
  }

  private updateExplosion(e: ExplosionState, t: number) {
    e.progress = t;
    for (const p of e.particles) {
      p.life = p.maxLife * (1 - t);
      p.alpha = Math.max(0, p.life / p.maxLife);
      p.x = e.centre.x + p.vx * t;
      p.y = e.centre.y + p.vy * t;
    }
  }

  private drawExplosion(e: ExplosionState) {
    this.ctx.save();
    for (const p of e.particles) {
      if (p.alpha <= 0) continue;
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size * p.alpha, 0, Math.PI * 2);
      this.ctx.fillStyle = this.colorWithAlpha(p.color, p.alpha * 0.9);
      this.ctx.fill();
    }

    // Central flash (bright core that fades quickly)
    const flashAlpha = Math.max(0, 1 - e.progress * 3);
    if (flashAlpha > 0) {
      this.ctx.beginPath();
      this.ctx.arc(e.centre.x, e.centre.y, 8 * (1 - e.progress), 0, Math.PI * 2);
      this.ctx.fillStyle = this.colorWithAlpha('#ffffff', flashAlpha);
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  // ─── Smoke ──────────────────────────────────────────────────────────

  private createSmokeParticles(centre: Vec2): Particle[] {
    const particles: Particle[] = [];
    for (let i = 0; i < SMOKE_PARTICLES; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 10 + Math.random() * 20;
      const life = 0.7 + Math.random() * 0.3;
      particles.push({
        x: centre.x + (Math.random() - 0.5) * 8,
        y: centre.y + (Math.random() - 0.5) * 8,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 15, // drift upward
        life,
        maxLife: life,
        size: 6 + Math.random() * 8,
        color: '#666666',
        alpha: 0.7,
      });
    }
    return particles;
  }

  private updateSmoke(s: SmokeState, t: number) {
    s.progress = t;
    for (const p of s.particles) {
      p.life = p.maxLife * (1 - t);
      p.alpha = Math.max(0, (p.life / p.maxLife) * 0.7);
      p.x = s.centre.x + p.vx * t;
      p.y = s.centre.y + p.vy * t;
      p.size += 0.3; // grow as smoke dissipates
    }
  }

  private drawSmoke(s: SmokeState) {
    this.ctx.save();
    for (const p of s.particles) {
      if (p.alpha <= 0) continue;
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = this.colorWithAlpha(p.color, p.alpha);
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    };
  }

  private colorWithAlpha(hex: string, alpha: number): string {
    // Parse hex color and return rgba
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}
