# World Generation, Hex Segments & Pathfinding

[← Architecture Wiki](README.md) · Covers `src/world/**`

## World Generation Pipeline

1. `generateGeodesicSphere(24)` — subdivided icosahedron → vertices + triangles
2. `computeDual(mesh)` — triangle centroids become tiles, shared edges become adjacency
3. Result: 5762 tiles (12 pentagons + 5750 hexagons) — formula: 10×T²+2 where T=24
4. `generateTerrain(positions, seed)` — noise-based terrain + elevation
5. `placeCities(tiles, seed)` — 12 cities on non-ocean tiles, spaced apart (avoiding polar caps)
6. `selectEnemyCities(world, player, count, targetSpacing)` — picks enemies closest to target graph distance
7. `spawnInitialUnits(tiles, cities)` — 6 units per city (3 splash + 3 ranged, placed in alternating neighbour tiles)

## Hex Segments

Each tile is divided into 6 triangular segments (0–5, clockwise from neighbour[0]).
Each segment holds at most 1 unit. Max 5 units per tile — one segment must remain
unoccupied, keeping hex and pentagon capacity equal.

## Pathfinding

Pure helpers, available in both `shared/pathfinding.ts` and `src/world/pathfinding.ts`:

- `graphDistance(tiles, from, to)` — BFS, returns hop count or -1
- `tilesWithinRadius(tiles, centre, radius)` — BFS flood fill → Map<index, distance>
- `findPath(tiles, from, to, costFn?)` — A* with great-circle heuristic

## Constants

`CITY_COUNT = 12` (`src/world/generate.ts`), `MIN_SPACING = 20`, `MAX_SPACING = 45`,
`FREQUENCY = 24`.

## See Also

- [data-flow-and-api.md](data-flow-and-api.md) — how generated worlds reach the client
- [modules.md](modules.md) — where each `src/world/` file lives
- [COMBAT_RULES.md](../../COMBAT_RULES.md) — combat constants and formulas
