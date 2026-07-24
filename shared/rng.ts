/**
 * Seeded PRNG — mulberry32.
 *
 * A fast, high-quality 32-bit PRNG suitable for deterministic world generation
 * and deterministic client-side scatter (forest placement, etc.). The same seed
 * always produces the same sequence.
 *
 * Lives in `shared/` because all three areas need it: `src/` and `server/` for
 * world generation, and `client/` for view-local deterministic scatter. The
 * client bundle is forbidden from importing `src/` (see `tsconfig.client.json`),
 * so `shared/` is the only place a single implementation can serve everyone.
 * `src/world/rng.ts` re-exports this so existing world-gen imports keep working.
 *
 * Usage:
 *   const rng = mulberry32(seed);
 *   const value = rng(); // returns a float in [0, 1)
 */

/** Simple seeded PRNG (mulberry32) — returns a function that yields floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
