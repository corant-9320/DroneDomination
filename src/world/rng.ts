/**
 * Seeded PRNG — mulberry32 (compatibility re-export).
 *
 * The implementation now lives in `shared/rng.ts` so the client bundle can use
 * the same PRNG without importing `src/` (forbidden by `tsconfig.client.json`).
 * This module stays as the world-generation entry point every `src/world/**`
 * caller already imports.
 *
 * Usage:
 *   const rng = mulberry32(seed);
 *   const value = rng(); // returns a float in [0, 1)
 */

export { mulberry32 } from '../../shared/rng.js';
