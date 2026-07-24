/**
 * First-person combat effects — the 3D echo of the 2D map's attack animations
 * (`combatAnimations.ts`): a glowing missile arcs to the target, then an
 * explosion blooms. Timings live in `firstPersonConstants.ts` and are kept in
 * lockstep with the 2D map so both views feel identical.
 *
 * Extracted verbatim from `firstPersonView.ts`. Each builder takes the scene and
 * the view's active-effect list explicitly and pushes a ticked effect onto it;
 * the view's render loop calls {@link updateEffects} once per frame.
 */

import * as THREE from 'three';
import {
  HEX_WORLD_RADIUS,
  MAX_PITCH,
  MISSILE_DURATION,
  MISSILE_TRAIL_POINTS,
  EXPLOSION_DURATION,
} from './firstPersonConstants.js';

/** A combat effect (missile / explosion) ticked each render frame.
 *  `update` returns false once finished, signalling the loop to dispose it. */
export interface ActiveEffect {
  update(nowMs: number): boolean;
  dispose(): void;
}

/** Smooth ease used by the missile arc (mirrors combatAnimations.ts). */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Animate a glowing missile arcing from `from` to `to` with a fading contrail.
 * Resolves when it reaches the target.
 */
export function playMissile3D(
  scene: THREE.Scene | null,
  effects: ActiveEffect[],
  from: THREE.Vector3,
  to: THREE.Vector3,
  color: THREE.Color,
): Promise<void> {
  if (!scene) return Promise.resolve();

  // Lob height scales with distance so short shots stay flat, long shots arc.
  const dist = from.distanceTo(to);
  const arc = Math.min(HEX_WORLD_RADIUS * 1.5, dist * 0.18);

  const headGeo = new THREE.SphereGeometry(HEX_WORLD_RADIUS * 0.06, 10, 10);
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const head = new THREE.Mesh(headGeo, headMat);
  scene.add(head);

  // Glow shell around the head for a hot, bloomy look (additive).
  const glowGeo = new THREE.SphereGeometry(HEX_WORLD_RADIUS * 0.12, 10, 10);
  const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  scene.add(glow);

  // Contrail as an additive line we rebuild from recent positions each frame.
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MISSILE_TRAIL_POINTS * 3), 3));
  const trailMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
  const trail = new THREE.Line(trailGeo, trailMat);
  trail.frustumCulled = false;
  scene.add(trail);

  const tmp = new THREE.Vector3();
  const posAt = (t: number, out: THREE.Vector3): THREE.Vector3 => {
    out.lerpVectors(from, to, t);
    out.y += Math.sin(Math.PI * t) * arc; // parabolic lob
    return out;
  };

  const start = performance.now();
  const recent: THREE.Vector3[] = [];

  return new Promise<void>((resolve) => {
    const effect: ActiveEffect = {
      update: (now: number): boolean => {
        const raw = Math.min(1, (now - start) / MISSILE_DURATION);
        const t = easeInOutCubic(raw);
        const p = posAt(t, tmp);
        head.position.copy(p);
        glow.position.copy(p);

        recent.push(p.clone());
        if (recent.length > MISSILE_TRAIL_POINTS) recent.shift();
        const arr = trailGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < MISSILE_TRAIL_POINTS; i++) {
          const src = recent[Math.min(i, recent.length - 1)] ?? p;
          arr[i * 3] = src.x; arr[i * 3 + 1] = src.y; arr[i * 3 + 2] = src.z;
        }
        trailGeo.attributes.position.needsUpdate = true;
        trailGeo.setDrawRange(0, recent.length);

        if (raw >= 1) { resolve(); return false; }
        return true;
      },
      dispose: () => {
        scene.remove(head, glow, trail);
        headGeo.dispose(); headMat.dispose();
        glowGeo.dispose(); glowMat.dispose();
        trailGeo.dispose(); trailMat.dispose();
      },
    };
    effects.push(effect);
  });
}

/**
 * Bloom an explosion at `centre`: a white-hot flash that expands and fades,
 * wrapped in a faction-tinted fireball. Size scales with damage to match the
 * 2D map. Resolves when it finishes.
 */
export function playExplosion3D(
  scene: THREE.Scene | null,
  effects: ActiveEffect[],
  centre: THREE.Vector3,
  damage: number,
  color: THREE.Color,
): Promise<void> {
  if (!scene) return Promise.resolve();

  const scale = Math.min(2.8, 0.6 + damage / 18);
  const maxR = HEX_WORLD_RADIUS * 0.5 * scale;

  const coreGeo = new THREE.SphereGeometry(1, 16, 16);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.copy(centre);
  scene.add(core);

  const fireGeo = new THREE.SphereGeometry(1, 16, 16);
  const fireMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
  const fire = new THREE.Mesh(fireGeo, fireMat);
  fire.position.copy(centre);
  scene.add(fire);

  const start = performance.now();
  return new Promise<void>((resolve) => {
    const effect: ActiveEffect = {
      update: (now: number): boolean => {
        const t = Math.min(1, (now - start) / EXPLOSION_DURATION);
        const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

        // White core flashes fast then vanishes.
        const coreR = maxR * (0.35 + ease * 0.55);
        core.scale.setScalar(coreR);
        coreMat.opacity = Math.max(0, 1 - t * 3.2);

        // Fireball expands fully and fades over the whole duration.
        fire.scale.setScalar(maxR * (0.5 + ease));
        fireMat.opacity = Math.max(0, 0.8 * (1 - ease));

        if (t >= 1) { resolve(); return false; }
        return true;
      },
      dispose: () => {
        scene.remove(core, fire);
        coreGeo.dispose(); coreMat.dispose();
        fireGeo.dispose(); fireMat.dispose();
      },
    };
    effects.push(effect);
  });
}

/** Advance all active combat effects in place, disposing any that have finished. */
export function updateEffects(effects: ActiveEffect[]): void {
  const now = performance.now();
  for (let i = effects.length - 1; i >= 0; i--) {
    if (!effects[i].update(now)) {
      effects[i].dispose();
      effects.splice(i, 1);
    }
  }
}

/** Dispose every in-flight effect (view close) and empty the list. */
export function disposeEffects(effects: ActiveEffect[]): void {
  for (const fx of effects) {
    try { fx.dispose(); } catch { /* best-effort */ }
  }
  effects.length = 0;
}

/**
 * Yaw/pitch that aims a camera at `target` from `eye` (does not move the eye).
 * Returns null for a degenerate (zero-length) aim so the caller keeps its
 * current orientation. Pitch is clamped to the view's pole limit.
 */
export function aimAt(eye: THREE.Vector3, target: THREE.Vector3): { yaw: number; pitch: number } | null {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return null;
  return {
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.asin(dy / len))),
    yaw: Math.atan2(dx, -dz),
  };
}
