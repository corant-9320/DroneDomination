# Archived Fixed-Issue Notes

[← Live Known Issues](../known-issues.md) · [Architecture Wiki](../README.md)

Historical resolutions moved out of the live issue page to keep task navigation focused. Code and tests define current behavior; use git history for exact diffs and rationale. `DECISIONS.md` only covers decisions recorded in that archive and does not contain every item below.

## Fixed 2026-07-24

- **`getLocalHexSpacing` property test was seed-flaky.** `src/world/__tests__/segmentGeometry.test.ts` > "returns the mean chord distance to neighbours" intermittently failed in the extended suite. Cause was float underflow, not coordinate equality: `arbBoundaryGrid` drew neighbouring tile centres independently, so fast-check could shrink two centres to within the subnormal range (or to exactly equal). `v3.distance` squares each component, and squaring e.g. `5e-323` underflows to `0`, making the mean chord distance exactly `0`. The pre-existing `fc.pre` guard compared coordinates with `!==`, which passes for unequal-but-underflowing values and so never caught it. Fixed by filtering `arbBoundaryGrid` to grids whose neighbouring centres are at least `MIN_TILE_SEPARATION` (1e-6) apart — a degenerate grid is not a hex tiling, and `segmentDistance` already falls back to graph distance when `avgSpacing < 1e-10`. The now-redundant `fc.pre` guard was removed. Production code was never at fault.

## Fixed 2026-07-15

- **Default logistics roads used hex centres and the committed world had no network.** `LogisticsRoute.segments` now stores encoded segment nodes, and local-map, globe, and first-person renderers draw through segment centroids. API and CLI default-world generation seed after units/buildings, producing an adjacent Home_City hub, a refinery five tile hops away, and two oil wells with separate roads into it.

## Fixed 2026-07-12

- **Segment-Based Movement & Unrestricted In-Cluster Building.** `shared/buildings.ts` permits building on any eligible city segment even when it seals off others. Movement uses occupancy-gated `shared/segmentGraph.ts` primitives across server, client, and AI; `src/world/movement.ts` accepts an optional occupancy predicate.
- **Seeded logistics network was client-render-only, not authoritative.** `CreateMatchRequest` accepts optional logistics state, `handleCreateMatch` adopts it (or creates empty state), and `client/matchClient.ts` passes `world.logistics`. Seeding remains in generation; match creation carries that state into the authoritative session.

## Resolved in current implementation (resolution date not recorded here)

- **Pure logistics placement could not see ordinary buildings.** This remains an intentional pure-engine boundary in `src/world/logistics/placement.ts`; canonical server appliers in `server/logistics/wells.ts`, `refineries.ts`, and `hubs.ts` now add authoritative building-collision checks before mutation. The live sync requirement documents the boundary.

## Fixed 2026-07-04

- **Oil-deposit markers did not reach the client.** `tile.resourceType` is carried by `shared/wireTypes.ts::WireTile`, emitted by `src/world/compact.ts`, preserved by tile regeneration, and rendered by `client/logisticsRenderer.ts`.

## Fixed 2026-07-03

- **Cliff skirt drawn on every edge.** `buildTerrainMesh` now gates walls with `isCliffEdge(a, b)`.
- **Units invisible on shore-adjacent segments.** Unit placement now applies the same `max(sampled, plateau)` clamp as buildings.

## Fixed 2026-06-17

- **Compact wire format hand-mirrored.** Compact wire types were unified in `shared/wireTypes.ts`; server and client import them. The runtime client model extends the wire tile with client-only overlay state.

## Fixed 2026-06-10

- **Movement cost modelled twice.** Movement uses a single segment-step model; rotation is a flat once-per-turn fee.
- **Server combat ignored elevation.** `server/combatApi.ts` now carries elevation through the wire format.