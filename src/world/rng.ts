/**
 * Seeded PRNG — mulberry32.
 *
 * A fast, high-quality 32-bit PRNG suitable for deterministic world
 * generation. The same seed always produces the same sequence.
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
