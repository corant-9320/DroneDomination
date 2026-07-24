# World Generation, Hex Segments & Pathfinding

[← Architecture Wiki](README.md) · Applies to world generation, geometry/serialization, movement/segments, and pathfinding

## World Generation Pipeline

1. `generateGeodesicSphere(24)` — subdivided icosahedron → vertices + triangles
2. `computeDual(mesh)` — triangle centroids become tiles, shared edges become adjacency
3. Result: 5762 tiles (12 pentagons + 5750 hexagons) — formula: 10×T²+2 where T=24
4. `generateTerrain(positions, seed)` — noise-based terrain + elevation
5. `placeCities(tiles, seed)` — 12 cities on non-ocean tiles, spaced apart (avoiding polar caps)
6. `selectEnemyCities(world, player, count, targetSpacing)` — picks enemies closest to target graph distance
7. `spawnInitialUnits(tiles, cities)` — 6 units per city (3 splash + 3 ranged, placed in alternating neighbour tiles)

## Hex Segments

Each tile is divided into triangular segments indexed by neighbour face: six
segments (0–5) on a hexagon and five (0–4) on a pentagon. Each segment holds at
most one occupant (unit or building). No segment is reserved as a mandatory
street; a tile may be filled to its actual side count, and any open segment
sealed behind occupants is intentionally unreachable.

## Pathfinding

Canonical pure algorithms live in `shared/pathfinding.ts`.
`src/world/tilePathfinding.ts` is the `Tile`-typed entry point: it owns the type
adaptation that wraps the server's `Tile[]` as `PathTile[]` (index-preserving) and
exposes the same three functions over server tiles. Add new algorithms to
`shared/pathfinding.ts`, never to the entry point:

- `graphDistance(tiles, from, to)` — BFS, returns hop count or -1
- `tilesWithinRadius(tiles, centre, radius)` — BFS flood fill → Map<index, distance>
- `findPath(tiles, from, to, costFn?)` — A* with great-circle heuristic

Segment-graph movement (occupancy-gated):

- `shared/segmentGraph.ts` — `segmentNeighbours()`, `findSegmentPath()`,
  `segmentReachability()`, `realizeTilePathOverSegments()`, `farthestAffordablePrefix()`

Movement is a uniform segment-step model: a unit may step from its current segment
onto an adjacent segment (2 intra-hex + 1 cross-hex) only when the destination
segment is empty and `segmentCost` is finite (Segment-Based Movement spec, B1–B3).

## Constants

`CITY_COUNT = 12` (`src/world/generate.ts`), `MIN_SPACING = 20`, `MAX_SPACING = 45`,
`FREQUENCY = 24`.

## Determinism

All world generation seeds from `mulberry32`, canonical in `shared/rng.ts` (so the
client can share the PRNG without importing `src/`). `src/world/rng.ts` re-exports
it as the world-gen entry point every `src/world/**` caller already imports.

## See Also

- [data-flow-and-api.md](data-flow-and-api.md) — how generated worlds reach the client
- [modules.md](modules.md) — where each `src/world/` file lives
- [COMBAT_RULES.md](../../COMBAT_RULES.md) — combat constants and formulas
