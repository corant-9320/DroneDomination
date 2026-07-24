---
inclusion: fileMatch
fileMatchPattern: "{src/generateCli.ts,src/validate.ts,src/world/compact.ts,src/world/generate.ts,src/world/geodesic.ts,src/world/movement.ts,src/world/tilePathfinding.ts,src/world/rng.ts,src/world/segmentGeometry.ts,src/world/segmentSteepness.ts,src/world/spawn.ts,src/world/types.ts,src/world/validate.ts,src/world/vec3.ts,shared/movementConstants.ts,shared/pathfinding.ts,shared/rng.ts,shared/segmentGraph.ts}"
---

# Architecture — World Generation, Movement & Pathfinding detail

Loads only for world generation, world geometry/serialization, movement, and
pathfinding files. It intentionally does not load for `src/world/combat/**` or
`src/world/logistics/**` edits. For pathfinding, edit canonical algorithms in
`shared/pathfinding.ts`; `src/world/tilePathfinding.ts` is the `Tile`-typed entry
point owning type adaptation to those algorithms — add new algorithms to
`shared/pathfinding.ts`, not there. `mulberry32` is canonical in `shared/rng.ts`;
`src/world/rng.ts` re-exports it as the world-gen entry point.

#[[file:../../docs/architecture/world-generation.md]]
