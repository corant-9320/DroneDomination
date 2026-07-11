# Implementation Plan: Oil Logistics System

## Overview

This plan builds the Oil Logistics System bottom-up: pure constants and types first, then the
pure resolution engine in `src/world/logistics.ts` (each function landing with its property
tests), then deterministic world-gen (`src/world/logisticsGen.ts`), then the wire/serialization
layer, then the server intents and turn hook, and finally the client rendering/UI. Language is
**TypeScript** (per the design). Tests use **Vitest + fast-check** as specified in the design's
Testing Strategy — 26 correctness properties become property tests, and rejections, cost tables,
init constants, ownership recording, and combat/turn wiring become example/integration tests.

Conventions respected throughout: `.js` import extensions on all imports, named exports only,
`client/` never imports `src/` or `server/`, and no pinned game-balance formula values in tests
(specification constants from `logisticsConstants.ts` may be asserted exactly).

## Tasks

- [x] 1. Foundation: constants and shared types
  - [x] 1.1 Create `shared/logisticsConstants.ts`
    - Add all named numeric constants (EXTRACTION_RATE, WELL_STORAGE_CAPACITY, REFINERY_THROUGHPUT_RATE, CONVERSION_RATIO, HUB_STORAGE_CAPACITY, DEPOSIT_SPACING, HOME_CITY_REFINED_PRODUCT_MAX, ROUTE_CAPACITY_MIN/MAX/STEP, TRANSPORT_CARGO_MIN/MAX, MAX_TRANSPORTS_PER_ROUTE, ENGINEER_TASK_BASE) and the `CONSTRUCTION_COST` table
    - Add `DEFAULT_SEED` (the single known development/test seed that gates example-network seeding) and `TRANSPORT_TIER_THRESHOLDS` (`van`/`truck`/`juggernaut` inclusive lower bounds) plus the `TransportTier` union type
    - Named exports only; no default export
    - _Requirements: 1.2, 3.1, 3.2, 4.4, 4.5, 5.4, 5.8, 5.9, 6.4, 6.5, 6.7, 8.3, 8.11, 11.3, 13.1, 14.3_
  - [x] 1.2 Create `shared/logisticsTypes.ts`
    - Define `Amount`, `OilWell`, `Refinery`, `LogisticsRoute`, `Transport`, `DistributionHub`, `HomeStock`, `EngineerTask`, `LogisticsState`
    - Add `upgrades: number` (cumulative upgrade count, integer >= 0) and `tier: TransportTier` (derived, kept in sync via `transportTier`) to the `Transport` interface, importing `TransportTier` from `logisticsConstants.js`
    - Define `LogisticsRejectionReason`, `LogisticsValidation`, and `LogisticsEvent`
    - Use `.js` import extension for the `Tile`/`UnitAttributes` type imports; named exports only
    - _Requirements: 2.8, 3.2, 3.6, 4.2, 4.6, 5.5, 6.4, 7.3, 8.3, 8.4, 11.3, 12.1, 12.4, 14.5_
  - [x]* 1.3 Write unit test for the Construction_Cost golden table and constant values
    - Assert `CONSTRUCTION_COST` entries and specification constants exactly (these are spec constants, not balance-formula outputs)
    - _Requirements: 5.8, 5.9_

- [x] 2. Engineer tasks and placement validation (`src/world/logistics.ts`)
  - [x] 2.1 Implement engineer task lifecycle
    - `engineerTaskDuration(engineer)` = `ENGINEER_TASK_BASE - engineer`; `tickTask` decrements and clamps `turnsRemaining >= 0`; completion transitions (operational well on one segment, cleared non-forest tile, crossable bridged tile); interruption cancels and discards progress
    - _Requirements: 2.6, 2.7, 2.8, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 10.7_
  - [x]* 2.2 Write property test for engineer task duration
    - **Property 4: Engineer task duration is `6 − engineer`**
    - **Validates: Requirements 2.6, 9.3, 10.1**
  - [x]* 2.3 Write property test for task countdown and completion
    - **Property 5: Task countdown never goes negative**
    - **Validates: Requirements 2.7, 2.8, 9.4, 10.2, 10.3**
  - [x]* 2.4 Write property test for task interruption
    - **Property 25: Engineer task interruption discards progress**
    - **Validates: Requirements 9.5, 10.7**
  - [x] 2.5 Implement placement validators
    - `validateWellPlacement`, `validateRefineryPlacement`, `validateRefinerySegment` returning `LogisticsValidation` with the correct `LogisticsRejectionReason`; run before any mutation (reject-and-preserve); reuse `segSteep[]`/`MAX_STEEP_WHEELED` and ownership rules
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.8, 4.9, 4.10, 4.11, 4.12, 12.2, 12.3_
  - [x]* 2.6 Write property test for well placement gate
    - **Property 6: Well placement gate**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 12.2, 12.3**
  - [x]* 2.7 Write property test for refinery eligibility predicate
    - **Property 11: Refinery eligibility predicate**
    - **Validates: Requirements 4.1, 4.8, 4.9, 4.10, 4.11, 4.12**
  - [x]* 2.8 Write unit tests for rejection reason codes
    - Assert each validator returns the exact reason and leaves inputs unchanged
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 4.8, 4.9, 4.10, 11.2_

- [x] 3. Extraction, storage, and refining (`src/world/logistics.ts`)
  - [x] 3.1 Implement extraction and oil removal
    - `extract(well)` adds `EXTRACTION_RATE` clamped to `WELL_STORAGE_CAPACITY`; `removeOil(well, qty)` succeeds for `0 < qty <= storedOil` else rejects with insufficient-stock error, leaving stored oil unchanged
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [x]* 3.2 Write property test for extraction clamp
    - **Property 7: Extraction increases stored oil and clamps to capacity**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.6**
  - [x]* 3.3 Write property test for oil removal
    - **Property 8: Oil removal conserves and validates quantity**
    - **Validates: Requirements 3.4, 3.5**
  - [x] 3.4 Implement refinery throughput and refining
    - `refineryThroughput(n)` = `n * REFINERY_THROUGHPUT_RATE`; `refine(refinery)` consumes `min(throughput, heldOil)`, decrements held oil, and adds `floor(consumed * CONVERSION_RATIO)` to `refinedProductAvailable`; no-op when `heldOil = 0`
    - _Requirements: 4.4, 4.5, 4.6, 4.7_
  - [x]* 3.5 Write property test for refinery throughput linearity
    - **Property 9: Refinery throughput is linear in segment count**
    - **Validates: Requirements 4.4**
  - [x]* 3.6 Write property test for refining conservation
    - **Property 10: Refining consumes the correct oil and conserves mass at ratio 0.5**
    - **Validates: Requirements 4.5, 4.6, 4.7**

- [x] 4. Economy: construction charging and home accrual (`src/world/logistics.ts`)
  - [x] 4.1 Implement charge and accrual helpers
    - `canAfford(home, cost)`, `chargeConstruction(home, cost)` (debit exact, Refined_Product only), `accrueRefinedProduct(home, qty)` (clamp to `HOME_CITY_REFINED_PRODUCT_MAX`, discard overflow), `accrueOil(home, qty)`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.9_
  - [x]* 4.2 Write property test for construction charging
    - **Property 12: Construction charges Refined_Product exactly, or rejects**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.6, 5.8**
  - [x]* 4.3 Write property test for home stock bounds
    - **Property 13: Home stock stays within `[0, 100000]` and discards overflow**
    - **Validates: Requirements 5.4, 5.5, 5.7, 6.9**

- [x] 5. Routes: travel time, capacity, and path validation (`src/world/logistics.ts`)
  - [x] 5.1 Implement route travel-time
    - `routeTravelTime(segmentSteepness)` = `max(1, ceil(Σ(1 + s_i / MAX_STEEP_WHEELED)))`; add the per-segment steepness helper (mean of entry/exit faces; single face at endpoints)
    - _Requirements: 7.1, 7.2, 7.3, 7.6_
  - [x]* 5.2 Write property test for travel-time formula and monotonicity
    - **Property 17: Route travel time is a ceiling formula, `>= 1`, and monotone in steepness**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.6**
  - [x] 5.3 Implement route creation, path validation, and capacity upgrade
    - `validateRoutePath(ctx, path, endpoints)` (contiguity via `findPath`, reject uncleared forest / unbridged impassable / invalid or identical endpoints); route creation assigns `capacity = ROUTE_CAPACITY_MIN`, tier `road`, computed `travelTime`; `upgradeRouteCapacity(cap)` = `min(ROUTE_CAPACITY_MAX, cap + ROUTE_CAPACITY_STEP)` sets tier `highway`, rejects at max
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 9.2, 10.4, 10.5_
  - [x]* 5.4 Write property test for route creation, capacity bounds, and upgrade
    - **Property 14: Route creation, capacity bounds, and upgrade steps**
    - **Validates: Requirements 6.1, 6.4, 6.5, 6.7, 6.8**
  - [x]* 5.5 Write property test for untraversable paths and invalid endpoints
    - **Property 15: Untraversable paths and invalid endpoints are rejected**
    - **Validates: Requirements 6.2, 6.3, 9.2, 10.4, 10.5**

- [x] 6. Transports: capacity, load/deliver, upgrade, assignment (`src/world/logistics.ts`)
  - [x] 6.1 Implement transport helpers
    - `clampTransport(cargo, capacity)` (per-turn route-capacity limit, retain excess at source); `loadTransport(t, supply)` (accept only up to `cargoCapacity`); `deliver(dest, cargo)` (clamp to destination capacity, retain remainder on transport); transport upgrade (strictly improve one of cargo/speed/defence, leave route capacity untouched); route assignment cap of `MAX_TRANSPORTS_PER_ROUTE`; undelivered-at-source retention within storage capacity
    - Implement `transportTier(upgrades)`: a total, monotonic pure function mapping the cumulative upgrade count to `'van' | 'truck' | 'juggernaut'` via `TRANSPORT_TIER_THRESHOLDS`; on every transport upgrade (increment of `upgrades`) recompute and keep `Transport.tier` in sync
    - _Requirements: 6.6, 8.1, 8.2, 8.3, 8.4, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 14.3, 14.5_
  - [x]* 6.2 Write property test for per-turn route-capacity limit
    - **Property 16: Per-turn transport never exceeds route capacity; excess is retained**
    - **Validates: Requirements 6.6, 8.1**
  - [x]* 6.3 Write property test for cargo bounds and delivery clamp
    - **Property 18: Cargo capacity is bounded and loads/deliveries clamp with conservation**
    - **Validates: Requirements 8.2, 8.3, 8.9, 8.10**
  - [x]* 6.4 Write property test for transport upgrade
    - **Property 19: Transport upgrade strictly improves one stat and leaves route capacity untouched**
    - **Validates: Requirements 8.4**
  - [x]* 6.5 Write property test for per-route transport cap
    - **Property 21: Transports per route are capped at 3**
    - **Validates: Requirements 8.11, 8.12, 8.13**
  - [x]* 6.6 Write property test for undelivered-cargo retention
    - **Property 22: Undelivered cargo is retained at the source within storage capacity**
    - **Validates: Requirements 8.7, 8.8**
  - [x]* 6.7 Write property test for transport tier mapping (engine side)
    - **Property 29 (engine part): `transportTier(upgrades)` is total and monotonic — for any `upgrades >= 0` it returns exactly one tier and an upgrade never lowers the tier**
    - **Validates: Requirements 14.3, 14.5**

- [x] 7. Distribution hubs (`src/world/logistics.ts`)
  - [x] 7.1 Implement hub distribution and initialization
    - Hub created with `buffer = 0`; `distributeHub(hub, outgoingCaps)` computes `available = buffer + inflow`, distributes `min(available, ΣcapOut)` with no route over its capacity, buffers excess up to `HUB_STORAGE_CAPACITY`, leaves the rest upstream
    - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [x]* 7.2 Write property test for hub bounds, distribution, and conservation
    - **Property 23: Distribution hub bounds, distribution, and conservation**
    - **Validates: Requirements 11.3, 11.4, 11.5, 11.6, 11.7**
  - [x]* 7.3 Write unit test for hub initialization
    - Assert a newly placed hub starts with zero buffer
    - _Requirements: 11.1_

- [x] 8. Combat integration for structures (`src/world/logistics.ts`)
  - [x] 8.1 Implement `HpStructure` and `attackStructure`
    - Add `HpStructure` shape; `attackStructure(struct, damage)` reuses the existing `computeDamage`/`applyDamage` pipeline from `src/world/combat.ts` (imported with `.js`); destroyed when `hitPoints <= 0`; destroyed well/refinery/hub drops stored Oil/Refined_Product; road/bridge destruction marks routes inoperable
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 12.8_
  - [x]* 8.2 Write property test for structure HP and destruction losses
    - **Property 24: Structures have positive HP; combat reduces HP and destroys at zero, dropping stored resources**
    - **Validates: Requirements 12.4, 12.5, 12.6, 12.7, 12.8**
  - [x]* 8.3 Write integration test for combat through the real `CombatContext`
    - Attack a structure and a transport via `CombatContext`/`computeDamage`; assert HP monotonicity and destruction threshold only (no pinned damage numbers)
    - _Requirements: 8.5, 12.5_

- [x] 9. Per-turn orchestration (`src/world/logistics.ts`)
  - [x] 9.1 Implement `resolveLogisticsTurn`
    - Run the 7 ordered stages (tick tasks → refine → dispatch transports → advance in-transit & deliver at `turnsRemaining = 0` if intact → hub distribute → home accrual → extract); honour `operable = false` before dispatch; drop cargo of destroyed transports; return `{ logistics, events }` as a pure function
    - _Requirements: 3.1, 4.5, 5.4, 6.6, 6.9, 7.4, 7.5, 8.1, 8.6, 8.9, 11.4, 12.8_
  - [x]* 9.2 Write property test for delivery timing and destruction losses
    - **Property 20: Delivery timing and destruction losses**
    - **Validates: Requirements 7.4, 7.5, 8.5, 8.6**
  - [x]* 9.3 Write property test for whole-pipeline conservation
    - **Property 26: Pipeline conserves Oil and Refined_Product except at explicit loss points**
    - **Validates: Requirements 3.1, 4.5, 5.7, 6.6, 8.8, 11.7, 12.7**

- [x] 10. Checkpoint - engine complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Deterministic world-gen for oil deposits
  - [x] 11.1 Implement `placeOilDeposits` in `src/world/logisticsGen.ts`
    - Dedicated PRNG sub-sequence `mulberry32(seed ^ 0x0117_0000)`; land-only candidates; Fisher–Yates shuffle; greedy `DEPOSIT_SPACING` spacing via `graphDistance`/`tilesWithinRadius` exclusion; greedy fill until the world is saturated (no remaining land tile `>= DEPOSIT_SPACING` from all placed deposits); set `resourceType = 'oil'`; return sorted indices
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [x]* 11.2 Write property test for deposit placement
    - **Property 1: Deposits are on land and adequately spaced**
    - **Validates: Requirements 1.1, 1.2, 1.3**
  - [x]* 11.3 Write property test for maximal deposit packing
    - **Property 2: Deposit placement is a valid maximal packing**
    - **Validates: Requirements 1.2, 1.4**
  - [x]* 11.4 Write property test for deposit determinism
    - **Property 3: Deposit generation is deterministic in the seed**
    - **Validates: Requirements 1.5**
  - [x] 11.5 Wire deposit generation into world generation and the barrel
    - Call `placeOilDeposits(tiles, seed)` in `src/world/generate.ts` after terrain/river passes and before city placement; re-export `logistics`/`logisticsGen` from `src/world/index.ts`
    - _Requirements: 1.1, 1.3, 1.5_
  - [x] 11.6 Implement and wire the seeded default logistics network
    - Implement `seedDefaultLogisticsNetwork(state, tiles, homeFactionId)` in `src/world/logisticsSeed.ts`, building the example network (>=1 operational well, refinery with >=2 segments, road, highway, hub connecting >=2 routes, one transport per tier) exclusively through the pure engine construction/upgrade helpers (`validate*`, refinery-segment add, route creation, `upgradeRouteCapacity`, hub connection, transport purchase, `transportTier`) so it never bypasses a clamp or bound; pick anchor tiles deterministically (nearest `resourceType==='oil'` tiles to Home_City by `graphDistance`, lowest index tie-break); mutate only `state`
    - Invoke it from `src/world/generate.ts` **iff** `seed === DEFAULT_SEED` (after `placeOilDeposits` and city placement); re-export `logisticsSeed` from `src/world/index.ts`
    - Wire `DEFAULT_SEED` into default world generation: `src/generateCli.ts` (postbuild generator) and `server/generateApi.ts` use `DEFAULT_SEED` for the default match world; arbitrary player seeds flow through unchanged
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10_
  - [x]* 11.7 Write property test for seeded-network determinism and legality
    - **Property 27: Seeded default network is deterministic and invariant-legal (deep-equal across invocations; satisfies every field-level invariant, all entities `ownerId === homeFactionId`)**
    - **Validates: Requirements 13.1, 13.8, 13.9**
  - [x]* 11.8 Write property test for arbitrary-seed non-alteration
    - **Property 28: For any seed != `DEFAULT_SEED`, the generated `LogisticsState` carries only standard deposit placement (empty wells/refineries/routes/hubs/transports) and is otherwise identical to a baseline generation omitting the seeding step**
    - **Validates: Requirements 13.10**
  - [x]* 11.9 Write example test for the seeded-network composition
    - Generate the `DEFAULT_SEED` world once and assert its composition: >=1 operational well on an `'oil'` tile, a refinery with `segments.length >= 2`, a route with `tier === 'road'` and a route with `tier === 'highway'`, a hub connecting >=2 routes, one transport per tier — all home-owned and chained to the `isPlayerHome` Home_City
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [x] 12. Wire format and serialization
  - [x] 12.1 Extend `World` and wire payloads with logistics
    - Add `logistics?` container to `src/world/types.ts`; extend `CompactSave`/`WireWorld` in `shared/wireTypes.ts` with the logistics payload (mirroring the `bridges: number[]` overlay pattern)
    - _Requirements: 5.5, 6.4, 9.4, 10.3, 12.1_
  - [x] 12.2 (De)serialize logistics in `src/world/compact.ts`
    - Add logistics (de)serialization to `toCompactWorld` and the expand path; straight field copy since wire and authoritative shapes match
    - _Requirements: 5.5, 6.4, 12.1_
  - [x]* 12.3 Write round-trip serialization test
    - Serialize then expand a populated `LogisticsState`; assert structural equality
    - _Requirements: 5.5, 6.4, 12.1_

- [x] 13. Server intents and turn hook
  - [x] 13.1 Extend `Intent` union and `MatchState`
    - Add the logistics intent variants and `MatchState.logistics: LogisticsState` in `shared/matchTypes.ts`
    - _Requirements: 2.1, 4.1, 4.3, 6.1, 6.7, 8.11, 8.4, 9.1, 10.1, 11.1_
  - [x] 13.2 Implement intent appliers in `server/logisticsApi.ts`
    - One applier per intent: validate against authoritative tiles + `LogisticsState`, charge Refined_Product, mutate, return a reason string on rejection (reuse engine validators)
    - _Requirements: 2.1, 2.2, 4.1, 4.8, 4.9, 5.2, 5.3, 6.1, 6.2, 6.3, 6.8, 8.11, 8.12, 9.1, 10.1, 10.6, 11.2, 12.1, 12.3_
  - [x] 13.3 Wire routing and turn hook in `server/matchApi.ts`
    - Route new intent kinds to `logisticsApi` appliers in `handleMatchIntent`; invoke `resolveLogisticsTurn` inside `advanceTurn` before rotating the faction; persist and forward `events`; honour `expectedVersion`
    - _Requirements: 3.1, 4.5, 5.4, 6.9, 7.4, 8.1, 9.1, 11.4_
  - [x]* 13.4 Write integration test for the endTurn pipeline
    - Drive an `endTurn` intent through `handleMatchIntent` and assert the returned `logistics` reflects one full pipeline pass
    - _Requirements: 3.1, 4.5, 5.4, 6.9_
  - [x]* 13.5 Write unit tests for intent rejections and ownership recording
    - Assert appliers reject with the correct reason and leave state unchanged; assert `ownerId` is recorded on constructed structures
    - _Requirements: 5.3, 6.2, 8.12, 11.2, 12.1, 12.3_

- [x] 14. Checkpoint - server complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Client rendering and UI
  - [x] 15.1 Mirror logistics wire types and overlays in `client/worldData.ts`
    - Add mirror aliases for the logistics payload and runtime overlays (`bridge`, cleared-forest) extending tiles; must NOT import from `src/` or `server/` (import shared types only)
    - _Requirements: 6.4, 9.4, 10.3, 12.1_
  - [x] 15.2 Implement `client/logisticsRenderer.ts`
    - Draw deposits, and instantiate/position the procedural model Groups from the `client/logisticsModel*` builders (tasks 15.6–15.8) for wells, refinery segments, hubs, bridges, roads vs highways, and moving transports with cargo/ETA readouts on globe and local map — consume the model builders instead of sprites; no special-case branch for the seeded default network
    - _Requirements: 1.3, 6.7, 8.1, 14.1, 14.6_
  - [x] 15.3 Implement `client/logisticsController.ts`
    - Map build/upgrade/clear/bridge/purchase actions to the new intents; road-laying `findPath` previews; reuse `buildController.ts` placement affordances
    - _Requirements: 2.1, 4.1, 6.1, 6.7, 8.11, 9.1, 10.1_
  - [x] 15.4 Implement `client/logisticsPanel.ts`
    - HUD readouts: well/hub storage, route capacity/tier/travel-time, Home_City Refined_Product and Oil stock
    - _Requirements: 3.2, 5.5, 6.4, 6.9, 7.3, 11.3_
  - [x]* 15.5 Write example tests for the client mirror/expand path
    - Assert the client expands a logistics payload into `WorldData` overlays correctly (no `src/`/`server/` imports)
    - _Requirements: 6.4, 12.1_
  - [x] 15.6 Implement the procedural model family orchestrator and static-entity builders
    - Implement `client/logisticsModel.ts` (orchestrator mirroring `unitModel.ts::buildUnitModel`) plus per-entity builders `logisticsModelWell.ts`, `logisticsModelRefinery.ts`, `logisticsModelHub.ts`, and `logisticsModelBridge.ts` — each returns a detailed multi-part `THREE.Group` meeting or exceeding the `unitModel*` standard, reusing `client/unitModelHelpers.ts` (`BoltOnMaterials`, `createTintedMaterials`) for faction tinting
    - _Requirements: 14.1, 14.2_
  - [x] 15.7 Implement `client/logisticsModelTransport.ts`
    - `buildTransportModel(tier, factionHex)` produces three visually distinct, escalating models — Small_Van, Truck, Juggernaut — differing in chassis length/width, axle & wheel count, cab size, and cargo-body volume; the `tier` argument is the transport's `tier` field so a tier-changing upgrade swaps the rendered model
    - _Requirements: 14.3, 14.4, 14.5_
  - [x] 15.8 Implement `client/logisticsModelRoad.ts`
    - `buildRoadMesh()` / `buildHighwayMesh()` extending the existing road rendering in `client/firstPersonTerrain.ts`; a Highway renders wider and multi-lane (broader ribbon with a centre-line/lane-divider strip) so it is immediately distinguishable from a single-lane Road
    - _Requirements: 14.6_
  - [x]* 15.9 Write property test for transport tier→model mapping (client side)
    - **Property 29 (client part): for each `tier` in {van, truck, juggernaut}, `buildTransportModel(tier)` returns a non-empty `THREE.Group` (>=1 mesh descendant) and the three tiers' Groups are pairwise distinct**
    - **Validates: Requirements 14.1, 14.3, 14.5**
  - [x]* 15.10 Write property test for strictly-increasing transport model size
    - **Property 30: for any faction tint, `THREE.Box3` size of `buildTransportModel('van')` < `buildTransportModel('truck')` < `buildTransportModel('juggernaut')`**
    - **Validates: Requirements 14.4**
  - [x]* 15.11 Write example/snapshot test for model fidelity and road distinction
    - Assert each logistics model's triangle count meets a baseline relative to a reference `unitModel*` model (fidelity), and that a Highway mesh is structurally distinct from (wider/more lanes than) a Road mesh
    - _Requirements: 14.2, 14.6_

- [x] 16. Documentation sync and final verification
  - [x] 16.1 Record cross-file sync requirements
    - Add the logistics wire-format sync requirements (`shared/logisticsTypes.ts` ↔ `src/world/compact.ts` ↔ `client/worldData.ts` ↔ `shared/wireTypes.ts`; `Intent` ↔ `matchApi.ts`/`logisticsApi.ts`) to `docs/architecture/known-issues.md`
    - _Requirements: 12.1_
  - [x] 16.2 Run full verification and cross-file sync checks
    - `npm test` (unit + property suites green), `npm run build` (tsc clean; world regenerates via postbuild with deposits), `npm run validate` (`data/world.json` integrity), `npm run deps:graph` (no new client→`src/`/`server/` violations); fix any failures
    - _Requirements: 1.3, 5.5, 6.4, 12.1_

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Property tests each run a minimum of 100 fast-check iterations and are tagged `// Feature: oil-logistics-system, Property {n}: ...` per the design's Testing Strategy.
- No pinned game-balance formula values in tests — specification constants from `shared/logisticsConstants.ts` may be asserted exactly; combat magnitudes are asserted only via monotonicity/thresholds.
- All imports use the `.js` extension; named exports only; `client/` never imports `src/` or `server/`.
- The pure engine (`src/world/logistics.ts`) is built incrementally in Epics 2–9; each implementation sub-task lands with its property tests before moving on, catching errors early.
- Each property sub-task references exactly one design property and the requirements clause it validates.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "11.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "11.2", "11.3", "11.4"] },
    { "id": 3, "tasks": ["2.6", "2.7", "2.8", "3.1", "11.5"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4"] },
    { "id": 5, "tasks": ["3.5", "3.6", "4.1"] },
    { "id": 6, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 7, "tasks": ["5.2", "5.3"] },
    { "id": 8, "tasks": ["5.4", "5.5", "6.1"] },
    { "id": 9, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "7.1"] },
    { "id": 10, "tasks": ["7.2", "7.3", "8.1"] },
    { "id": 11, "tasks": ["8.2", "8.3", "9.1"] },
    { "id": 12, "tasks": ["9.2", "9.3", "12.1", "11.6"] },
    { "id": 13, "tasks": ["12.2", "13.1", "11.7", "11.8", "11.9"] },
    { "id": 14, "tasks": ["12.3", "13.2"] },
    { "id": 15, "tasks": ["13.3"] },
    { "id": 16, "tasks": ["13.4", "13.5"] },
    { "id": 17, "tasks": ["15.1", "15.6", "15.7", "15.8"] },
    { "id": 18, "tasks": ["15.2", "15.3", "15.4", "15.9", "15.10", "15.11"] },
    { "id": 19, "tasks": ["15.5", "16.1"] },
    { "id": 20, "tasks": ["16.2"] }
  ]
}
```
