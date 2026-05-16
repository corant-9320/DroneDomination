# World Module Steering

## Applies to: `src/world/**`

## When to load: editing world generation, tile logic, pathfinding, cities, units, or validation

## Geometry invariants

- Goldberg G(24,0) polyhedron: 5762 tiles total (12 pentagons + 5750 hexagons)
- Formula: `10 × T² + 2` where T = 24 (FREQUENCY constant in `src/world/generate.ts`)
- Tiles have exactly 5 or 6 neighbours; pentagons are at original icosahedron vertices
- Tile positions and boundaries are on the unit sphere

## Generation pipeline (order matters)

1. `generateGeodesicSphere(24)` → subdivided icosahedron mesh
2. `computeDual(mesh)` → DualTile[] (tiles as faces of dual polyhedron)
3. `generateTerrain(positions, seed)` → terrain type + elevation per tile
4. `placeCities(tiles, seed)` → 12 cities on non-ocean, non-pentagon tiles (not adjacent to pentagons, avoiding polar caps)

## Key constants

- `FREQUENCY = 24` — `src/world/generate.ts`
- `CITY_COUNT = 12` — `src/world/cities.ts`
- `NEIGHBOUR_DISTANCE = 20` — `src/world/cities.ts`
- `MAX_UNITS_PER_TILE = 5` — `src/world/units.ts`

## Unit rules

- No fixed unit types — defined entirely by `UnitAttributes`
- Must have ≥1 movement point (wheeled, limb, or flight)
- All attribute values are integers in defined ranges (see `ATTRIBUTE_RANGES`)
- Each tile has 6 triangular segments (0–5) for hexes, 5 for pentagons
- Max 5 units per tile (one hex segment must stay free, unifying hex/pentagon capacity)
- Max 1 unit per segment

## Validation

- `validateWorld(world)` checks tile counts, adjacency symmetry, terrain validity, city placement
- Always validate generated worlds before saving or returning via API

## Tests

- Located in `src/world/__tests__/`
- Run with `npm run test`
- Cover: pathfinding, terrain, units, vec3

## When editing this module

- Do not change tile count or geometry formula without updating ARCHITECTURE.md
- Maintain adjacency symmetry (if A neighbours B, B must neighbour A)
- Keep `src/world/index.ts` barrel exports updated when adding/removing modules
- Run `npm run test` after changes
