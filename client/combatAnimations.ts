/**
 * Combat Animations — Canvas 2D particle effects for attacks.
 *
 * Three animation types:
 * 1. Missile: a glowing rocket with flame, smoke, wobble and a bright exhaust trail
 * 2. Explosion: layered flash, shockwave, fireball sprites, sparks and debris
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
  shape?: 'spark' | 'ember' | 'smoke' | 'debris';
  rotation?: number;
  spin?: number;
}

interface TrailPoint extends Vec2 {
  age: number;
  width: number;
}

interface MissileState {
  type: 'missile';
  from: Vec2;
  to: Vec2;
  color: string;
  progress: number; // 0–1
  trail: TrailPoint[];
  smoke: Particle[];
  wobbleSeed: number;
}

interface ExplosionSprite {
  angle: number;
  distance: number;
  size: number;
  color: string;
  rotation: number;
  spin: number;
  lifeOffset: number;
}

interface Shockwave {
  radius: number;
  width: number;
  alpha: number;
}

interface ExplosionState {
  type: 'explosion';
  centre: Vec2;
  particles: Particle[];
  sprites: ExplosionSprite[];
  shockwaves: Shockwave[];
  scale: number;
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

const MISSILE_DURATION = 520;        // ms
const EXPLOSION_DURATION = 680;      // ms
const SMOKE_DURATION = 800;          // ms
const EXPLOSION_PARTICLES = 34;
const EXPLOSION_SPRITES = 7;
const SMOKE_PARTICLES = 18;
const TRAIL_LENGTH = 14;
const MISSILE_SMOKE_LENGTH = 10;

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
        smoke: [],
        wobbleSeed: Math.random() * Math.PI * 2,
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
      const scale = Math.min(2.8, 0.6 + damage / 18);
      const particles = this.createExplosionParticles(centre, scale, color);
      const state: ExplosionState = {
        type: 'explosion',
        centre,
        particles,
        sprites: this.createExplosionSprites(scale, color),
        shockwaves: this.createShockwaves(scale),
        scale,
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
    m.progress = this.easeInOutCubic(t);

    const pos = this.getMissilePosition(m, m.progress);
    const tangent = this.normalise({ x: m.to.x - m.from.x, y: m.to.y - m.from.y });
    const exhaust = {
      x: pos.x - tangent.x * 12,
      y: pos.y - tangent.y * 12,
    };

    m.trail.push({ ...exhaust, age: 0, width: 5 + Math.random() * 2 });
    if (m.trail.length > TRAIL_LENGTH) {
      m.trail.shift();
    }
    m.trail.forEach((p, i) => {
      p.age = 1 - (i + 1) / m.trail.length;
    });

    if (m.progress > 0.08 && m.progress < 0.95) {
      m.smoke.push({
        x: exhaust.x + (Math.random() - 0.5) * 5,
        y: exhaust.y + (Math.random() - 0.5) * 5,
        vx: -tangent.x * (10 + Math.random() * 14) + (Math.random() - 0.5) * 10,
        vy: -tangent.y * (10 + Math.random() * 14) + (Math.random() - 0.5) * 10,
        life: 1,
        maxLife: 1,
        size: 3 + Math.random() * 4,
        color: '#777777',
        alpha: 0.35,
        shape: 'smoke',
      });
    }

    if (m.smoke.length > MISSILE_SMOKE_LENGTH) {
      m.smoke.splice(0, m.smoke.length - MISSILE_SMOKE_LENGTH);
    }

    for (const p of m.smoke) {
      p.life = Math.max(0, p.life - 0.08);
      p.alpha = p.life * 0.35;
      p.x += p.vx * 0.016;
      p.y += p.vy * 0.016;
      p.size += 0.45;
    }
  }

  private drawMissile(m: MissileState) {
    const pos = this.getMissilePosition(m, m.progress);
    const dir = this.normalise({ x: m.to.x - m.from.x, y: m.to.y - m.from.y });
    const angle = Math.atan2(dir.y, dir.x);
    const flameFlicker = 0.8 + Math.sin(m.progress * 60 + m.wobbleSeed) * 0.2;

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'lighter';

    // Exhaust smoke sits behind the bright trail.
    for (const p of m.smoke) {
      if (p.alpha <= 0) continue;
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = this.colorWithAlpha(p.color, p.alpha);
      this.ctx.fill();
    }

    // Draw a hot fading contrail.
    if (m.trail.length > 1) {
      for (let i = 1; i < m.trail.length; i++) {
        const start = m.trail[i - 1];
        const end = m.trail[i];
        const alpha = (i / m.trail.length) * 0.75;
        const width = end.width * (i / m.trail.length);

        this.ctx.beginPath();
        this.ctx.moveTo(start.x, start.y);
        this.ctx.lineTo(end.x, end.y);
        this.ctx.strokeStyle = this.colorWithAlpha('#ffdd66', alpha * 0.55);
        this.ctx.lineWidth = width + 4;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(start.x, start.y);
        this.ctx.lineTo(end.x, end.y);
        this.ctx.strokeStyle = this.colorWithAlpha(m.color, alpha);
        this.ctx.lineWidth = width;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();
      }
    }

    // Flame plume.
    this.ctx.translate(pos.x, pos.y);
    this.ctx.rotate(angle);
    const flame = this.ctx.createRadialGradient(-12, 0, 1, -12, 0, 16 * flameFlicker);
    flame.addColorStop(0, 'rgba(255,255,255,0.95)');
    flame.addColorStop(0.25, 'rgba(255,220,80,0.85)');
    flame.addColorStop(0.8, this.colorWithAlpha(m.color, 0.45));
    flame.addColorStop(1, 'rgba(255,120,0,0)');
    this.ctx.fillStyle = flame;
    this.ctx.beginPath();
    this.ctx.ellipse(-12, 0, 16 * flameFlicker, 6, 0, 0, Math.PI * 2);
    this.ctx.fill();

    // Rocket body with small fins and nose, so it reads as a missile rather than a dot.
    this.ctx.shadowColor = m.color;
    this.ctx.shadowBlur = 14;
    this.ctx.fillStyle = '#f7f7f7';
    this.ctx.beginPath();
    this.ctx.moveTo(12, 0);
    this.ctx.lineTo(2, -5);
    this.ctx.lineTo(-10, -4);
    this.ctx.lineTo(-13, 0);
    this.ctx.lineTo(-10, 4);
    this.ctx.lineTo(2, 5);
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle = this.colorWithAlpha(m.color, 0.85);
    this.ctx.beginPath();
    this.ctx.moveTo(-5, -4);
    this.ctx.lineTo(-13, -9);
    this.ctx.lineTo(-10, -2);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.beginPath();
    this.ctx.moveTo(-5, 4);
    this.ctx.lineTo(-13, 9);
    this.ctx.lineTo(-10, 2);
    this.ctx.closePath();
    this.ctx.fill();

    this.ctx.restore();
  }

  // ─── Explosion ──────────────────────────────────────────────────────

  private createExplosionParticles(centre: Vec2, scale: number, color: string): Particle[] {
    const particles: Particle[] = [];
    const count = Math.round(EXPLOSION_PARTICLES * scale);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.55;
      const isSpark = Math.random() > 0.32;
      const speed = (isSpark ? 55 + Math.random() * 80 : 24 + Math.random() * 42) * scale;
      const life = 0.55 + Math.random() * 0.45;
      particles.push({
        x: centre.x,
        y: centre.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        size: (isSpark ? 2 + Math.random() * 3 : 4 + Math.random() * 5) * scale,
        color: isSpark
          ? (Math.random() > 0.55 ? '#ffcc33' : '#ff6a00')
          : (Math.random() > 0.5 ? color : '#444444'),
        alpha: 1,
        shape: isSpark ? 'spark' : (Math.random() > 0.45 ? 'debris' : 'ember'),
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.25,
      });
    }
    return particles;
  }

  private createExplosionSprites(scale: number, color: string): ExplosionSprite[] {
    const sprites: ExplosionSprite[] = [];
    for (let i = 0; i < EXPLOSION_SPRITES; i++) {
      sprites.push({
        angle: Math.random() * Math.PI * 2,
        distance: (4 + Math.random() * 12) * scale,
        size: (12 + Math.random() * 15) * scale,
        color: i % 3 === 0 ? color : (i % 2 === 0 ? '#ff8a00' : '#ffd24a'),
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 1.4,
        lifeOffset: Math.random() * 0.18,
      });
    }
    return sprites;
  }

  private createShockwaves(scale: number): Shockwave[] {
    return [
      { radius: 18 * scale, width: 3 * scale, alpha: 0.75 },
      { radius: 10 * scale, width: 2 * scale, alpha: 0.45 },
    ];
  }

  private updateExplosion(e: ExplosionState, t: number) {
    e.progress = this.easeOutCubic(t);
    for (const p of e.particles) {
      const localT = e.progress;
      p.life = p.maxLife * (1 - t);
      p.alpha = Math.max(0, p.life / p.maxLife);
      p.x = e.centre.x + p.vx * localT * 0.75;
      p.y = e.centre.y + (p.vy * localT * 0.75) + 22 * localT * localT;
      p.rotation = (p.rotation ?? 0) + (p.spin ?? 0);
    }
  }

  private drawExplosion(e: ExplosionState) {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'lighter';

    // White-hot flash and fireball glow.
    const flashAlpha = Math.max(0, 1 - e.progress * 3.4);
    if (flashAlpha > 0) {
      const radius = (14 + 26 * e.progress) * e.scale;
      const glow = this.ctx.createRadialGradient(e.centre.x, e.centre.y, 0, e.centre.x, e.centre.y, radius);
      glow.addColorStop(0, this.colorWithAlpha('#ffffff', flashAlpha));
      glow.addColorStop(0.32, this.colorWithAlpha('#ffd24a', flashAlpha * 0.9));
      glow.addColorStop(1, 'rgba(255,80,0,0)');
      this.ctx.fillStyle = glow;
      this.ctx.beginPath();
      this.ctx.arc(e.centre.x, e.centre.y, radius, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Procedural explosion sprites: jagged fire puffs instead of just dots.
    for (const sprite of e.sprites) {
      const spriteT = Math.max(0, Math.min(1, (e.progress - sprite.lifeOffset) / (1 - sprite.lifeOffset)));
      const alpha = Math.max(0, 1 - spriteT * 1.25);
      if (alpha <= 0) continue;

      const x = e.centre.x + Math.cos(sprite.angle) * sprite.distance * (0.8 + spriteT);
      const y = e.centre.y + Math.sin(sprite.angle) * sprite.distance * (0.8 + spriteT);
      this.drawExplosionSprite(
        x,
        y,
        sprite.size * (0.6 + spriteT * 0.8),
        sprite.rotation + sprite.spin * spriteT,
        sprite.color,
        alpha,
      );
    }

    // Expanding shockwaves sell the impact.
    for (const wave of e.shockwaves) {
      const radius = wave.radius + e.progress * 36 * e.scale;
      const alpha = wave.alpha * Math.max(0, 1 - e.progress);
      this.ctx.beginPath();
      this.ctx.arc(e.centre.x, e.centre.y, radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = this.colorWithAlpha('#fff2a8', alpha);
      this.ctx.lineWidth = wave.width * Math.max(0.35, 1 - e.progress);
      this.ctx.stroke();
    }

    // Sparks, embers and debris.
    for (const p of e.particles) {
      if (p.alpha <= 0) continue;

      if (p.shape === 'spark') {
        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(Math.atan2(p.vy, p.vx));
        this.ctx.beginPath();
        this.ctx.moveTo(-p.size * 1.6, 0);
        this.ctx.lineTo(p.size * 1.8, 0);
        this.ctx.strokeStyle = this.colorWithAlpha(p.color, p.alpha * 0.9);
        this.ctx.lineWidth = Math.max(1, p.size * 0.55 * p.alpha);
        this.ctx.lineCap = 'round';
        this.ctx.stroke();
        this.ctx.restore();
      } else if (p.shape === 'debris') {
        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(p.rotation ?? 0);
        this.ctx.fillStyle = this.colorWithAlpha(p.color, p.alpha * 0.75);
        this.ctx.fillRect(-p.size * 0.45, -p.size * 0.3, p.size * 0.9, p.size * 0.6);
        this.ctx.restore();
      } else {
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, p.size * p.alpha, 0, Math.PI * 2);
        this.ctx.fillStyle = this.colorWithAlpha(p.color, p.alpha * 0.85);
        this.ctx.fill();
      }
    }

    this.ctx.restore();
  }

  private drawExplosionSprite(
    x: number,
    y: number,
    radius: number,
    rotation: number,
    color: string,
    alpha: number,
  ): void {
    const points = 9;
    const inner = radius * 0.45;

    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(rotation);
    this.ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? radius : inner + Math.sin(i * 1.7) * radius * 0.08;
      const a = (Math.PI * 2 * i) / (points * 2);
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) this.ctx.moveTo(px, py);
      else this.ctx.lineTo(px, py);
    }
    this.ctx.closePath();
    this.ctx.fillStyle = this.colorWithAlpha(color, alpha * 0.75);
    this.ctx.fill();

    this.ctx.beginPath();
    this.ctx.arc(0, 0, radius * 0.45, 0, Math.PI * 2);
    this.ctx.fillStyle = this.colorWithAlpha('#ffffff', alpha * 0.35);
    this.ctx.fill();
    this.ctx.restore();
  }

  // ─── Smoke ──────────────────────────────────────────────────────────

  private createSmokeParticles(centre: Vec2): Particle[] {
    const particles: Particle[] = [];
    for (let i = 0; i < SMOKE_PARTICLES; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 12 + Math.random() * 24;
      const life = 0.7 + Math.random() * 0.3;
      particles.push({
        x: centre.x + (Math.random() - 0.5) * 10,
        y: centre.y + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 18, // drift upward
        life,
        maxLife: life,
        size: 7 + Math.random() * 10,
        color: Math.random() > 0.55 ? '#555555' : '#777777',
        alpha: 0.72,
        shape: 'smoke',
      });
    }
    return particles;
  }

  private updateSmoke(s: SmokeState, t: number) {
    s.progress = t;
    for (const p of s.particles) {
      p.life = p.maxLife * (1 - t);
      p.alpha = Math.max(0, (p.life / p.maxLife) * 0.72);
      p.x = s.centre.x + p.vx * t;
      p.y = s.centre.y + p.vy * t;
      p.size += 0.35; // grow as smoke dissipates
    }
  }

  private drawSmoke(s: SmokeState) {
    this.ctx.save();
    for (const p of s.particles) {
      if (p.alpha <= 0) continue;
      const gradient = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      gradient.addColorStop(0, this.colorWithAlpha(p.color, p.alpha));
      gradient.addColorStop(1, this.colorWithAlpha(p.color, 0));
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getMissilePosition(m: MissileState, t: number): Vec2 {
    const base = this.lerpVec(m.from, m.to, t);
    const dir = this.normalise({ x: m.to.x - m.from.x, y: m.to.y - m.from.y });
    const normal = { x: -dir.y, y: dir.x };
    const distance = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
    const wobble = Math.sin(t * Math.PI * 5 + m.wobbleSeed) * Math.min(10, distance * 0.035) * Math.sin(t * Math.PI);
    return {
      x: base.x + normal.x * wobble,
      y: base.y + normal.y * wobble,
    };
  }

  private lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    };
  }

  private normalise(v: Vec2): Vec2 {
    const length = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / length, y: v.y / length };
  }

  private easeInOutCubic(t: number): number {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  private colorWithAlpha(hex: string, alpha: number): string {
    // Parse hex color and return rgba. Fall back to white if a non-hex colour slips through.
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
      return `rgba(255,255,255,${alpha})`;
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}
