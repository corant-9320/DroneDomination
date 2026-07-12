# Requirements Document

## Introduction

The Oil Logistics System adds an economic layer to Drone Domination. Players extract raw
Oil from deposits scattered across the Goldberg-polyhedron world, refine it into a
Refined_Product, and move both raw Oil and Refined_Product through a physical network of
roads back toward their home city. Refined_Product is the resource consumed to construct
and upgrade every building and structure in the game, so the health of the logistics
network directly gates a player's ability to expand.

The chain has these buildable and movable elements:

- **Oil wells** — drilled by Engineer units on oil deposits; extract raw Oil into limited local storage.
- **Refineries** — city-like clusters of one or more contiguous hexes that consume raw Oil and produce Refined_Product; a hex joins a Refinery when a refinery building is placed on one of its segments, and productivity grows as the player adds more refinery buildings across the cluster.
- **Logistics routes** — physical roads laid along a contiguous path of tiles between wells, refineries, and the home city; upgradeable from roads into higher-capacity highways.
- **Transportation units** — computer-controlled vehicles that physically carry Oil and Refined_Product along roads; upgradeable and vulnerable to enemy attack.
- **Distribution hubs** — buffer and balance flow across routes so limited well storage is not wasted.

Roads are real terrain features. They can only be laid on traversable tiles: crossing a
forest requires an Engineer to clear the trees first, and crossing a valley or water
requires an Engineer to build a bridge. The steepness of the path a road follows
determines how long transportation units take to traverse it, so players must design the
road network carefully to minimise delivery time.

This document specifies world generation of deposits, construction rules, extraction and
storage, refining into Refined_Product, road construction and terrain preparation,
transport units, transport capacity, travel time, and flow optimisation. It reuses
existing game concepts: the `engineer` unit attribute, the per-segment `HexSegment` model,
the tank steepness gate used for ground movement, the full-segment building model, the
tile `resourceType` field, and the existing unit combat model.

## Glossary

- **Logistics_System**: The overall game subsystem that governs oil deposit placement, construction of logistics structures, extraction, refining, transport, road building, terrain preparation, and storage.
- **World_Generator**: The world-generation subsystem that produces tiles, terrain, and resources for a new world.
- **HexTile**: A single tile of the world map. May be a hexagon (6 segments) or pentagon (5 segments).
- **HexSegment**: One of the 5 or 6 triangular segments of a HexTile, indexed 0–5. The unit of placement for units, buildings, wells, and refinery segments.
- **Segment_Steepness**: The precomputed steepness (in radians) of a HexSegment, as used by the ground-movement steepness gate.
- **Segment_Traversal**: The base-game movement rule that a unit may move from its current HexSegment onto a destination HexSegment only when the destination is empty (holds no unit and no building or Refinery_Segment) and is one of the three HexSegments adjacent to the unit's current HexSegment (its two intra-hex neighbours and the single cross-hex facing segment). Placement imposes no reachability guarantee; a walled-off segment is simply unreachable rather than illegal to create.
- **Tank_Steepness_Threshold**: The maximum Segment_Steepness a tank-class (wheeled) chassis may traverse, equal to the existing `MAX_STEEP_WHEELED` constant (0.44 radians, approximately 25 degrees).
- **Engineer_Unit**: A Unit whose `engineer` attribute value is at least 1.
- **Oil_Deposit**: A map resource located on a HexSegment of a land HexTile, recorded via the tile `resourceType` value `"oil"`. It is the only location where an Oil_Well may be drilled.
- **Oil_Well**: A structure occupying exactly one HexSegment that extracts raw Oil from a co-located Oil_Deposit into its own storage.
- **Refinery**: A structure that processes raw Oil into Refined_Product, composed of one or more Refinery_Segments spread across a Refinery_Cluster of one or more adjacent Refinery_Hexes. A Refinery comes into existence during gameplay (never at world generation) when its first Refinery_Segment is built, and grows as further Refinery_Segments are added. Distinct Refineries never merge, even when their hexes become adjacent.
- **Refinery_Segment**: A single refinery building placed on one HexSegment. Placing a Refinery_Segment on a segment makes that HexTile a Refinery_Hex belonging to a Refinery. The total number of Refinery_Segments across a Refinery's whole Refinery_Cluster determines its processing throughput.
- **Refinery_Hex**: A HexTile that contains at least one Refinery_Segment and therefore belongs to a Refinery. Being a Refinery_Hex is a derived property (true whenever the hex holds at least one Refinery_Segment), not a stored terrain type, and is never assigned at world generation.
- **Refinery_Cluster**: The connected set of adjacent Refinery_Hexes that make up a single Refinery.
- **Cluster_Boundary**: The rendered perimeter (for example a fence or wall) drawn around each individual City and Refinery so that adjacent-but-distinct clusters remain visually separable.
- **Refinery_Throughput_Rate**: The fixed quantity of raw Oil a single Refinery_Segment enables a Refinery to process per turn, equal to 20 raw Oil units per Refinery_Segment per turn.
- **Conversion_Ratio**: The fixed, uniform ratio of Refined_Product produced per unit of raw Oil consumed by any Refinery, equal to 0.5 (2 raw Oil units yield 1 Refined_Product unit).
- **Oil**: The raw transported resource extracted by Oil_Wells, measured in integer units. Raw Oil is the input to a Refinery and has no direct construction use.
- **Refined_Product**: The processed resource produced by a Refinery from raw Oil, measured in integer units. Refined_Product is the sole resource consumed to construct and upgrade buildings, structures, roads, and units.
- **Construction_Cost**: The quantity of Refined_Product the Logistics_System requires to construct or upgrade a given building, structure, road, highway, or unit. Concrete Construction_Cost values (in Refined_Product units) are: Oil_Well 50; Refinery (first Refinery_Segment) 150; each additional Refinery_Segment 100; Logistics_Route as a Road 40 per Route_Segment; Logistics_Route upgrade to the next capacity tier 60 per Route_Segment; Distribution_Hub 200; Bridge 80; Transportation_Unit 30; Transportation_Unit upgrade 45. Clearing a Forest_Tile has a Construction_Cost of 0 Refined_Product and costs only turns.
- **Logistics_Route**: A physical transport link laid along a contiguous path of adjacent, traversable HexTiles (its Route_Segments), connecting two endpoints that are each an Oil_Well, a Refinery, or the Home_City. Rendered as a Road or, once upgraded, a Highway.
- **Route_Segment**: A single HexTile along the contiguous path of a Logistics_Route.
- **Road**: The base physical form of a Logistics_Route, rendered as a road, with base Route_Capacity.
- **Highway**: The upgraded physical form of a Logistics_Route, rendered as a highway, with greater Route_Capacity than a Road.
- **Route_Capacity**: The maximum combined quantity of Oil and Refined_Product a Logistics_Route can transport per turn.
- **Route_Travel_Time**: The number of turns a Transportation_Unit takes to carry cargo from one endpoint of a Logistics_Route to the other, determined by the cumulative steepness of the route's Route_Segments.
- **Transportation_Unit**: A computer-controlled (AI-driven) vehicle that physically moves along a Logistics_Route carrying Oil or Refined_Product between the route's endpoints. Upgradeable and destroyable by enemy units.
- **Forest_Tile**: A HexTile whose terrain is classified as forest, on which trees must be cleared by an Engineer_Unit before a Road may cross it.
- **Impassable_Terrain**: A HexTile classified as water or valley, across which a Road may only be laid once a Bridge has been built.
- **Bridge**: A structure built by an Engineer_Unit across a HexTile of Impassable_Terrain that allows a Road to cross that HexTile.
- **Distribution_Hub**: A structure that connects two or more Logistics_Routes, buffers Oil and Refined_Product, and distributes flow across the connected routes.
- **Home_City**: The player's home city, as marked by the existing `isPlayerHome` city flag. The destination for delivered Oil and Refined_Product and the store of the player's Refined_Product.
- **Storage_Capacity**: The maximum quantity of Oil (or Refined_Product) a structure (Oil_Well or Distribution_Hub) can hold at once. An Oil_Well's Storage_Capacity is 100 raw Oil units; a Distribution_Hub's Storage_Capacity is 500 combined Oil and Refined_Product units.
- **Extraction_Rate**: The quantity of raw Oil an operational Oil_Well adds to its storage per turn, equal to 10 raw Oil units per turn.
- **Deposit_Spacing**: The minimum shortest-path tile distance required between any two Oil_Deposits, equal to 20 hex tiles.
- **Maximal_Deposit_Fill**: The World_Generator behaviour of greedily placing Oil_Deposits across all land HexTiles until no remaining land HexTile is at least the Deposit_Spacing of 20 hex tiles from every already-placed Oil_Deposit, at which point the world is saturated and no further Oil_Deposit can be placed. There is no fixed upper bound on the number of Oil_Deposits placed.
- **Home_City_Refined_Product_Maximum**: The maximum quantity of Refined_Product the Home_City can store, equal to 100000 Refined_Product units.
- **Hit_Points**: The integer amount of combat damage a destroyable structure (Oil_Well, Refinery, Distribution_Hub, Road, or Bridge) can absorb before it is destroyed, tracked and reduced by the existing unit combat model.
- **Structure_Owner**: The player that constructed a given structure (Oil_Well, Refinery, Distribution_Hub, Road, or Bridge) and to whom that structure belongs for the duration of the match unless the structure is destroyed.
- **Client**: The Drone Domination browser client that renders the game world and all game entities in 3D using Three.js.
- **Default_Test_World**: The world produced by the standard development and testing seed, which is also used as the default match world. Distinguished from a world generated from an arbitrary player-chosen seed.
- **Seeded_Logistics_Network**: The example, fully-formed logistics network that the Logistics_System initialises in place during Default_Test_World generation so that the logistics chain is demonstrably operational from the first turn.
- **Home_Faction**: The default player faction that owns the Home_City and, in the Default_Test_World, owns every structure and Transportation_Unit of the Seeded_Logistics_Network.
- **Transport_Tier**: The visual upgrade tier of a Transportation_Unit, drawn from an ordered set of at least three escalating tiers — Small_Van (smallest), Truck (intermediate), and Juggernaut (largest) — that determines the size and mass of the Transportation_Unit's rendered 3D model.
- **Small_Van**: The smallest Transport_Tier, rendered with the smallest Transportation_Unit 3D model.
- **Truck**: The intermediate Transport_Tier, rendered with a Transportation_Unit 3D model larger than the Small_Van model and smaller than the Juggernaut model.
- **Juggernaut**: The largest Transport_Tier, rendered with the largest Transportation_Unit 3D model.
- **Unit_Model_Standard**: The minimum 3D model quality and detail baseline for logistics entities, defined by the existing procedural unit models built with Three.js in the `unitModel*` module family. The baseline is measured by geometry detail, namely polygon count and structural fidelity, and excludes low-detail placeholder geometry.
- **Logistics_Entity**: Any entity introduced by the Logistics_System that the Client renders in 3D, namely an Oil_Well, a Refinery, a Refinery_Segment, a Distribution_Hub, a Road, a Highway, a Bridge, or a Transportation_Unit.

## Requirements

### Requirement 1: Oil Deposit Generation

**User Story:** As a player, I want oil deposits scattered predictably across the map, so that resource sites are worth exploring and contesting.

#### Acceptance Criteria

1. WHEN a new world is generated, THE World_Generator SHALL place each Oil_Deposit on a HexTile classified as land (a HexTile whose terrain is not water).
2. WHEN a new world is generated, THE World_Generator SHALL perform Maximal_Deposit_Fill by greedily placing Oil_Deposits across land HexTiles such that every pair of placed Oil_Deposits is separated by a shortest-path tile distance of at least the Deposit_Spacing of 20 hex tiles and no additional Oil_Deposit can be placed on any remaining land HexTile without violating the Deposit_Spacing of 20 hex tiles.
3. WHEN a new world is generated, THE World_Generator SHALL record each placed Oil_Deposit on its HexTile using the `resourceType` value `"oil"`.
4. WHEN no remaining land HexTile is at least the Deposit_Spacing of 20 hex tiles from every already-placed Oil_Deposit, THE World_Generator SHALL stop placing further Oil_Deposits, retain all previously placed Oil_Deposits unchanged, and complete world generation.
5. WHEN a new world is generated from a given world seed, THE World_Generator SHALL produce an identical set of Oil_Deposit tile positions on every generation that uses the same seed.

### Requirement 2: Oil Well Construction by Engineers

**User Story:** As a player, I want to drill oil wells using engineer units, so that the strength of my engineers affects how fast I develop resource sites.

#### Acceptance Criteria

1. WHERE a Unit has an `engineer` attribute value in the range 1 to 5, THE Logistics_System SHALL allow that Unit to begin constructing an Oil_Well on the Unit's current HexSegment.
2. IF a player attempts to construct an Oil_Well using a Unit whose `engineer` attribute value is 0, THEN THE Logistics_System SHALL reject the construction, leave the HexSegment unchanged, and return an indication that the Unit lacks Engineer capability.
3. IF a player attempts to construct an Oil_Well on a HexSegment whose Segment_Steepness exceeds the Tank_Steepness_Threshold (MAX_STEEP_WHEELED = 0.44 radians), THEN THE Logistics_System SHALL reject the construction, leave the HexSegment unchanged, and return an indication that the terrain is too steep.
4. IF a player attempts to construct an Oil_Well on a HexSegment that does not contain an Oil_Deposit, THEN THE Logistics_System SHALL reject the construction, leave the HexSegment unchanged, and return an indication that no Oil_Deposit is present.
5. IF a player attempts to construct an Oil_Well on a HexSegment that is already occupied by an Oil_Well, a Refinery_Segment, or another building, THEN THE Logistics_System SHALL reject the construction, leave the HexSegment unchanged, and return an indication that the HexSegment is occupied.
6. WHEN construction of an Oil_Well begins, THE Logistics_System SHALL set the required construction duration to (6 minus the constructing Engineer_Unit `engineer` attribute value) turns, yielding a value in the inclusive range of 1 turn (engineer 5) to 5 turns (engineer 1).
7. WHILE an Oil_Well is under construction, THE Logistics_System SHALL decrease that Oil_Well's remaining construction duration by one at the start of each turn, clamped to a minimum of zero.
8. WHEN an Oil_Well's remaining construction duration reaches zero, THE Logistics_System SHALL create an operational Oil_Well occupying exactly one HexSegment.

### Requirement 3: Oil Well Extraction and Storage

**User Story:** As a player, I want wells to accumulate oil up to a storage limit, so that I am motivated to build transport before storage fills.

#### Acceptance Criteria

1. WHILE an Oil_Well is operational, THE Logistics_System SHALL, at the end of each turn, increase that Oil_Well's stored Oil by its Extraction_Rate of 10 raw Oil units, clamping the resulting stored Oil so that it never exceeds the Oil_Well's Storage_Capacity.
2. THE Oil_Well SHALL have a fixed Storage_Capacity of 100 raw Oil units that does not change during a match.
3. IF an Oil_Well's stored Oil reaches its Storage_Capacity, THEN THE Logistics_System SHALL hold that Oil_Well's stored Oil at the Storage_Capacity and SHALL accrue no additional Oil until Oil is removed from that Oil_Well.
4. WHEN Oil is removed from an Oil_Well for transport in a quantity greater than zero and less than or equal to that Oil_Well's stored Oil, THE Logistics_System SHALL decrease that Oil_Well's stored Oil by the removed quantity.
5. IF a request to remove Oil from an Oil_Well specifies a quantity greater than that Oil_Well's stored Oil, THEN THE Logistics_System SHALL reject the removal, leave that Oil_Well's stored Oil unchanged, and return an error indicating insufficient stored Oil.
6. THE Logistics_System SHALL represent each Oil_Well's stored Oil, Extraction_Rate, and Storage_Capacity as integer numbers of Oil units, where stored Oil is greater than or equal to zero and both Extraction_Rate and Storage_Capacity are greater than zero.

### Requirement 4: Refinery Construction, Refining, and Productivity

**User Story:** As a player, I want refineries that turn raw oil into a refined product and that I can grow segment by segment and hex by hex, so that I can invest to increase the output that fuels my construction.

#### Acceptance Criteria

1. WHEN a player builds a Refinery_Segment on an eligible HexSegment whose HexTile is neither already a Refinery_Hex nor adjacent to any Refinery_Hex, THE Logistics_System SHALL create a new Refinery whose Refinery_Cluster is that single HexTile, place exactly one Refinery_Segment on the target HexSegment, and mark that HexTile as a Refinery_Hex.
2. WHEN a player builds a Refinery_Segment on an eligible HexSegment whose HexTile is already a Refinery_Hex, THE Logistics_System SHALL add that Refinery_Segment to the Refinery that owns the HexTile.
3. WHEN a player builds a Refinery_Segment on an eligible HexSegment whose HexTile is not yet a Refinery_Hex but is adjacent to exactly one existing Refinery, THE Logistics_System SHALL add that Refinery_Segment to that adjacent Refinery and mark the HexTile as a Refinery_Hex of that Refinery.
4. WHEN a player builds a Refinery_Segment on an eligible HexSegment whose HexTile is not yet a Refinery_Hex and is adjacent to two or more distinct existing Refineries, THE Logistics_System SHALL add the Refinery_Segment to the single Refinery whose nearest Refinery_Segment is closest to the target HexSegment by segment-to-segment distance, mark the HexTile as a Refinery_Hex of only that Refinery, and SHALL NOT merge the adjacent Refineries.
5. WHERE two or more Refineries tie as closest under criterion 4, THE Logistics_System SHALL join the new Refinery_Segment to exactly one of the tied Refineries chosen by a deterministic rule (the Refinery with the lowest identifier), so that generation and replay remain deterministic.
6. THE Logistics_System SHALL keep distinct Refineries distinct for the duration of the match, such that two Refineries whose Refinery_Hexes become adjacent SHALL remain separate Refineries with independent throughput, held raw Oil, available Refined_Product, Hit_Points, and Structure_Owner.
7. WHILE a HexTile is a Refinery_Hex, THE Logistics_System SHALL permit only Refinery_Segments to be added to its HexSegments, SHALL reject any attempt to build an Oil_Well or any non-refinery building on that HexTile, and SHALL continue to allow units to occupy and move through its open (unbuilt) HexSegments.
8. THE Logistics_System SHALL allow at most one Refinery_Segment per HexSegment, up to a maximum of one Refinery_Segment for every HexSegment of each Refinery_Hex (5 or 6 per hex).
9. THE Logistics_System SHALL set each Refinery's processing throughput equal to the total number of Refinery_Segments across all HexTiles of its Refinery_Cluster multiplied by the Refinery_Throughput_Rate of 20 raw Oil units per Refinery_Segment per turn, such that a Refinery containing N Refinery_Segments processes exactly N times 20 raw Oil per turn.
10. WHILE a Refinery holds raw Oil and has available throughput in a turn, THE Logistics_System SHALL, once per turn, consume a quantity of raw Oil equal to the lesser of the Refinery's remaining throughput for that turn and the raw Oil available to that Refinery, and produce Refined_Product equal to the consumed raw Oil multiplied by the Conversion_Ratio of 0.5 (2 raw Oil units yield 1 Refined_Product unit), rounding any fractional Refined_Product down to the nearest whole unit.
11. WHEN a Refinery produces Refined_Product, THE Logistics_System SHALL decrease that Refinery's held raw Oil by the quantity consumed and SHALL make the produced Refined_Product available for transport from that Refinery.
12. IF a Refinery has no raw Oil available at the start of a turn, THEN THE Logistics_System SHALL produce zero Refined_Product at that Refinery for that turn and SHALL leave the Refinery's held raw Oil unchanged.
13. THE Logistics_System SHALL treat a HexSegment as eligible for a Refinery_Segment only WHEN its HexTile is land that is owned by the requesting player or unowned, the target HexSegment's Segment_Steepness is at or below the Tank_Steepness_Threshold (MAX_STEEP_WHEELED = 0.44 radians), the target HexSegment is not occupied by a unit, an Oil_Well, another building, or an existing Refinery_Segment, and the HexTile is not a City hex.
14. THE Logistics_System SHALL impose no through-street or external-reachability requirement on Refinery_Segment placement: a player MAY add a Refinery_Segment on any HexSegment eligible under criterion 13 even when doing so isolates one or more open HexSegments of the Refinery_Cluster, and the Logistics_System SHALL accept the resulting placement. A HexSegment left unreachable under Segment_Traversal is the player's responsibility.
15. IF a player attempts to build a Refinery_Segment on a HexSegment that is ineligible under criterion 13, THEN THE Logistics_System SHALL reject the construction, leave all HexSegments unchanged, and return an indication of the specific reason (terrain too steep, segment occupied, tile owned by another player, or tile is a City hex).
16. IF a player attempts to build a Refinery_Segment on a HexTile classified as water or as a Forest_Tile whose trees have not been cleared, THEN THE Logistics_System SHALL reject the construction, leave the HexTile unchanged, and return an indication that the terrain cannot host a Refinery_Segment.
17. IF a player attempts to build a Refinery_Segment on a Refinery_Hex in which every HexSegment is already occupied by a Refinery_Segment, THEN THE Logistics_System SHALL reject the construction, leave all HexSegments unchanged, and return an indication that the Refinery_Hex is at maximum segment capacity.

### Requirement 5: Refined Product as the Construction and Upgrade Resource

**User Story:** As a player, I want refined product to be the resource that pays for all my construction and upgrades, so that securing the oil supply chain is what lets me expand.

#### Acceptance Criteria

1. THE Logistics_System SHALL require Refined_Product as the sole resource consumed to construct or upgrade any building, structure, Road, Highway, Refinery_Segment, Distribution_Hub, Bridge, or unit.
2. WHERE a player requests to construct or upgrade an item whose Construction_Cost is greater than zero and less than or equal to the Refined_Product stored at the Home_City, THE Logistics_System SHALL deduct the item's Construction_Cost from the Home_City's stored Refined_Product and begin the construction or upgrade within the same turn.
3. IF a player requests to construct or upgrade an item whose Construction_Cost exceeds the Refined_Product stored at the Home_City, THEN THE Logistics_System SHALL reject the request, leave the Home_City's stored Refined_Product unchanged, and return an indication that Refined_Product is insufficient.
4. WHEN a positive integer quantity of Refined_Product arrives at the Home_City along a Logistics_Route, THE Logistics_System SHALL add the arriving quantity to the Home_City's stored Refined_Product, not exceeding the Home_City_Refined_Product_Maximum of 100000 Refined_Product units.
5. THE Logistics_System SHALL represent the Home_City's stored Refined_Product as an integer quantity in the inclusive range of 0 to the Home_City_Refined_Product_Maximum of 100000 Refined_Product units.
6. THE Logistics_System SHALL represent each item's Construction_Cost as an integer number of Refined_Product units greater than or equal to one.
7. IF Refined_Product arriving at the Home_City would raise the stored Refined_Product above the Home_City_Refined_Product_Maximum of 100000 Refined_Product units, THEN THE Logistics_System SHALL clamp the stored Refined_Product to that maximum and SHALL NOT retain the excess.
8. WHEN a player constructs or upgrades an item, THE Logistics_System SHALL charge the following Construction_Cost in Refined_Product units: Oil_Well 50; Refinery first Refinery_Segment 150; each additional Refinery_Segment 100; Logistics_Route built as a Road 40 per Route_Segment; Logistics_Route upgrade to the next capacity tier 60 per Route_Segment; Distribution_Hub 200; Bridge 80; Transportation_Unit 30; Transportation_Unit upgrade 45.
9. WHEN a player clears a Forest_Tile, THE Logistics_System SHALL charge a Construction_Cost of 0 Refined_Product and SHALL consume only the required number of clearing turns.

### Requirement 6: Logistics Routes as Physical Roads

**User Story:** As a player, I want routes to be real roads laid across the terrain and upgradeable into highways, so that I can plan, route, and scale my supply network across the map.

#### Acceptance Criteria

1. WHEN a player requests to build a Logistics_Route between two distinct player-owned endpoints that are each an Oil_Well, a Refinery, or the Home_City, and a contiguous path of adjacent traversable HexTiles exists between those endpoints, THE Logistics_System SHALL create the Logistics_Route as a Road following that path of Route_Segments.
2. IF a player requests to build a Logistics_Route whose two endpoints are the same structure, or where either endpoint is not a player-owned Oil_Well, Refinery, or Home_City, THEN THE Logistics_System SHALL reject the build request, SHALL NOT create the Logistics_Route, and SHALL return an indication that the endpoints are invalid.
3. IF a player requests to build a Logistics_Route whose path would cross a Forest_Tile whose trees have not been cleared, or a HexTile of Impassable_Terrain that has no Bridge, THEN THE Logistics_System SHALL reject the build request, SHALL NOT create the Logistics_Route, and SHALL return an indication that the path is not traversable.
4. WHEN a Logistics_Route is created as a Road, THE Logistics_System SHALL assign it a Route_Capacity of 100 combined Oil and Refined_Product units per turn.
5. THE Logistics_System SHALL constrain every Logistics_Route's Route_Capacity to the inclusive range of 100 to 1000 combined Oil and Refined_Product units per turn.
6. WHEN cargo is transported along a Logistics_Route during a turn, THE Logistics_System SHALL limit the total transported quantity for that turn to that Logistics_Route's current Route_Capacity, and SHALL retain any excess at the source structure.
7. WHERE a player upgrades a Logistics_Route whose Route_Capacity is below 1000 units per turn, THE Logistics_System SHALL increase that Logistics_Route's Route_Capacity by 100 units per turn, not exceeding 1000, and SHALL render the upgraded Logistics_Route as a Highway.
8. IF a player upgrades a Logistics_Route whose Route_Capacity is already 1000 units per turn, THEN THE Logistics_System SHALL reject the upgrade, SHALL leave the Route_Capacity unchanged, and SHALL return an indication that the maximum capacity has been reached.
9. WHEN Oil arrives at the Home_City along a Logistics_Route, THE Logistics_System SHALL add the arriving quantity to the Home_City's stored Oil.

### Requirement 7: Route Travel Time Based on Steepness

**User Story:** As a player, I want steeper roads to take longer to traverse, so that I am rewarded for designing efficient, low-gradient road networks.

#### Acceptance Criteria

1. WHEN a Logistics_Route is created or its path changes, THE Logistics_System SHALL compute that Logistics_Route's Route_Travel_Time as a function of the cumulative Segment_Steepness across the route's Route_Segments that is strictly increasing, such that any increase in cumulative Segment_Steepness produces a Route_Travel_Time that is greater than or equal to the previous value and never smaller.
2. WHEN comparing two Logistics_Routes that have the same number of Route_Segments, THE Logistics_System SHALL assign the greater Route_Travel_Time to the Logistics_Route with the greater cumulative Segment_Steepness, and equal Route_Travel_Time when their cumulative Segment_Steepness values are equal.
3. WHEN computing any Logistics_Route's Route_Travel_Time, THE Logistics_System SHALL represent the result as a whole number of turns that is greater than or equal to one, rounding any fractional computed value up to the next whole turn.
4. WHEN a Transportation_Unit departs one endpoint of a Logistics_Route carrying cargo and remains intact for the full traversal, THE Logistics_System SHALL deliver that cargo to the other endpoint exactly on the turn that is a number of turns equal to that Logistics_Route's Route_Travel_Time after departure.
5. IF a Transportation_Unit carrying cargo is destroyed after departing one endpoint of a Logistics_Route and before the Route_Travel_Time elapses, THEN THE Logistics_System SHALL NOT deliver that cargo to either endpoint.
6. WHEN computing a Logistics_Route's Route_Travel_Time, THE Logistics_System SHALL calculate it as the ceiling of the sum, over every Route_Segment of that Logistics_Route, of (1 + that Route_Segment's Segment_Steepness divided by the Tank_Steepness_Threshold of 0.44 radians), and SHALL clamp the result to a minimum of 1 turn, yielding a base of 1 turn per flat Route_Segment and up to approximately 2 turns per maximally-steep Route_Segment.

### Requirement 8: Transportation Units

**User Story:** As a player, I want computer-controlled transport vehicles to physically carry oil along my roads and be defensible, so that protecting my supply lines becomes part of the game.

#### Acceptance Criteria

1. WHEN a Logistics_Route's source endpoint holds transportable Oil or Refined_Product and an operational Transportation_Unit with available cargo capacity is assigned to that Logistics_Route, THE Logistics_System SHALL dispatch that Transportation_Unit along the Logistics_Route within the same game turn, without requiring a manual movement order from the player.
2. THE Logistics_System SHALL move each Transportation_Unit only along the Route_Segments of the Logistics_Route to which it is assigned.
3. THE Logistics_System SHALL limit the cargo carried by a single Transportation_Unit to that Transportation_Unit's fixed cargo capacity, expressed as an integer number of combined Oil and Refined_Product units in the inclusive range of 1 to 1000, and SHALL reject any load that would exceed that capacity.
4. WHERE a player upgrades a Transportation_Unit, THE Logistics_System SHALL increase at least one of that Transportation_Unit's cargo capacity, movement speed, or defensive strength by a strictly positive amount, and SHALL leave the Logistics_Route's Route_Capacity unchanged.
5. WHEN an enemy Unit attacks a Transportation_Unit, THE Logistics_System SHALL resolve the attack using the existing unit combat model.
6. WHEN a Transportation_Unit is destroyed while carrying cargo, THE Logistics_System SHALL, in the same turn the destruction is resolved, remove that Transportation_Unit and its carried cargo from play, and SHALL NOT deliver that cargo to any endpoint.
7. WHILE a Logistics_Route has no operational Transportation_Unit available to carry cargo, THE Logistics_System SHALL retain the undelivered Oil and Refined_Product at the source structure up to that structure's Storage_Capacity.
8. IF undelivered cargo at a source structure would exceed that structure's Storage_Capacity, THEN THE Logistics_System SHALL hold the stored quantity at the Storage_Capacity and SHALL NOT accrue the excess.
9. WHEN a Transportation_Unit carrying cargo arrives intact at its destination endpoint, THE Logistics_System SHALL add the carried cargo to that endpoint's stored Oil or Refined_Product, up to that endpoint's Storage_Capacity.
10. IF cargo delivered to a destination endpoint would exceed that endpoint's Storage_Capacity, THEN THE Logistics_System SHALL clamp the stored quantity to the Storage_Capacity and SHALL retain the undelivered remainder on the Transportation_Unit.
11. WHERE a player purchases a Transportation_Unit for a Construction_Cost of 30 Refined_Product and the target Logistics_Route has fewer than 3 assigned Transportation_Units, THE Logistics_System SHALL create the Transportation_Unit and assign it to that Logistics_Route.
12. IF a player attempts to assign a Transportation_Unit to a Logistics_Route that already has 3 assigned Transportation_Units, THEN THE Logistics_System SHALL reject the assignment, SHALL NOT create the Transportation_Unit, and SHALL return an indication that the Logistics_Route has reached its maximum of 3 Transportation_Units.
13. WHILE a Transportation_Unit is assigned to a Logistics_Route, THE Logistics_System SHALL dispatch and route that Transportation_Unit automatically under computer (AI) control, without requiring a manual movement order from the player.

### Requirement 9: Engineer Forest Clearing

**User Story:** As a player, I want engineers to clear forests before roads can cross them, so that terrain shapes where my supply lines can go.

#### Acceptance Criteria

1. WHERE a Unit has an `engineer` attribute value in the range 1 to 5 and occupies a Forest_Tile, THE Logistics_System SHALL allow that Unit to begin clearing the trees on that Forest_Tile.
2. IF a player attempts to build a Road across a Forest_Tile whose trees have not been cleared, THEN THE Logistics_System SHALL reject the Road construction on that HexTile, leave that HexTile unchanged, and return an indication that the forest must be cleared first.
3. WHEN a Unit begins clearing a Forest_Tile, THE Logistics_System SHALL complete the clearing after a number of turns equal to (6 minus that Unit's `engineer` attribute value), yielding 5 turns at engineer level 1 through 1 turn at engineer level 5.
4. WHEN a Unit completes the required number of clearing turns on a Forest_Tile, THE Logistics_System SHALL reclassify that HexTile as a traversable non-forest HexTile on which a Road may be built.
5. IF a Unit that is clearing a Forest_Tile leaves that Forest_Tile before the required number of clearing turns has elapsed, THEN THE Logistics_System SHALL cancel the clearing, leave that HexTile classified as a Forest_Tile, discard any accumulated clearing progress, and return an indication that clearing was interrupted.
6. IF a player attempts to clear trees using a Unit whose `engineer` attribute value is 0, THEN THE Logistics_System SHALL reject the clearing, leave the Forest_Tile unchanged, and return an indication that the Unit lacks Engineer capability.

### Requirement 10: Engineer Bridge Building

**User Story:** As a player, I want engineers to build bridges over valleys and water, so that I can route roads across terrain that is otherwise impassable.

#### Acceptance Criteria

1. WHERE a Unit has an `engineer` attribute value in the range 1 to 5 and is adjacent to a HexTile of Impassable_Terrain, THE Logistics_System SHALL allow that Unit to begin building a Bridge across that HexTile with a required build duration of (6 minus the Unit's `engineer` attribute value) turns.
2. WHILE a Unit is building a Bridge across a HexTile of Impassable_Terrain, THE Logistics_System SHALL keep that HexTile marked as not yet crossable by a Road until the required build duration has fully elapsed.
3. WHEN a Unit has spent the full required build duration building a Bridge across a HexTile of Impassable_Terrain, THE Logistics_System SHALL mark that Bridge as completed and mark that HexTile as crossable by a Road.
4. WHERE a HexTile of Impassable_Terrain has a completed Bridge, THE Logistics_System SHALL allow a Road to be laid across that HexTile as a Route_Segment.
5. IF a player attempts to build a Road across a HexTile of Impassable_Terrain that has no completed Bridge, THEN THE Logistics_System SHALL reject the Road construction on that HexTile, leave that HexTile unchanged, and return an indication that a Bridge is required.
6. IF a player attempts to build a Bridge using a Unit whose `engineer` attribute value is 0, THEN THE Logistics_System SHALL reject the Bridge construction, leave the HexTile unchanged, and return an indication that the Unit lacks Engineer capability.
7. IF a Unit is destroyed or is no longer adjacent to the HexTile before the required build duration has elapsed, THEN THE Logistics_System SHALL cancel that Bridge construction and leave that HexTile of Impassable_Terrain without a completed Bridge.

### Requirement 11: Distribution Hubs

**User Story:** As a player, I want distribution hubs that buffer and balance flow, so that limited well storage is not wasted when routes are congested.

#### Acceptance Criteria

1. WHEN a Distribution_Hub is placed at a valid location, THE Logistics_System SHALL create the Distribution_Hub with an initial buffered quantity of zero.
2. IF a player attempts to place a Distribution_Hub at an invalid location, THEN THE Logistics_System SHALL reject the placement, SHALL NOT create the Distribution_Hub, and SHALL return an indication that the placement is invalid.
3. THE Distribution_Hub SHALL provide buffer storage bounded by a fixed Storage_Capacity of 500 combined Oil and Refined_Product units, where the buffered quantity is always in the inclusive range of 0 to 500 combined units.
4. WHEN a turn begins, THE Logistics_System SHALL add the Distribution_Hub's buffered quantity from the previous turn to the quantity available for distribution in the current turn.
5. WHERE a Distribution_Hub connects two or more outgoing Logistics_Routes, THE Logistics_System SHALL distribute a total quantity equal to the minimum of the available quantity and the sum of the connected outgoing Route_Capacities, such that no Logistics_Route carries more than its Route_Capacity in a turn.
6. IF the available quantity at a Distribution_Hub in a turn exceeds the combined outgoing Route_Capacity, THEN THE Logistics_System SHALL hold the excess in the Distribution_Hub's buffer storage up to the Storage_Capacity.
7. IF the excess at a Distribution_Hub exceeds the available buffer storage, THEN THE Logistics_System SHALL leave the unbuffered quantity at its upstream source and SHALL NOT discard it.

### Requirement 12: Structure Ownership, Combat, and Destruction

**User Story:** As a player, I want the structures I build to belong to me and to be destroyable in combat, so that contesting an opponent's supply chain is a viable strategy.

#### Acceptance Criteria

1. WHEN a player constructs an Oil_Well, Refinery, Distribution_Hub, Road, or Bridge, THE Logistics_System SHALL record that player as the Structure_Owner of that structure for the duration of the match unless the structure is destroyed.
2. WHERE a HexTile is owned by the requesting player or is unowned land, THE Logistics_System SHALL allow that player to construct a structure on that HexTile subject to the other construction rules.
3. IF a player attempts to construct a structure on a HexTile owned by another player, THEN THE Logistics_System SHALL reject the construction, leave the HexTile unchanged, and return an indication that the HexTile is owned by another player.
4. THE Logistics_System SHALL assign each Oil_Well, Refinery, Distribution_Hub, Road, and Bridge a positive integer quantity of Hit_Points and SHALL allow enemy Units to attack that structure using the existing unit combat model.
5. WHEN an enemy Unit attacks an Oil_Well, Refinery, Distribution_Hub, Road, or Bridge, THE Logistics_System SHALL reduce that structure's Hit_Points using the existing unit combat model.
6. WHEN a structure's Hit_Points reach zero, THE Logistics_System SHALL destroy that structure and remove it from play.
7. WHEN an Oil_Well, Refinery, or Distribution_Hub is destroyed, THE Logistics_System SHALL remove that structure's stored Oil and stored Refined_Product from play, delivering none of it to any endpoint.
8. WHEN a Road or Bridge that is a Route_Segment of a Logistics_Route is destroyed, THE Logistics_System SHALL mark every Logistics_Route that uses that Route_Segment as inoperable and SHALL prevent cargo from being transported along that Logistics_Route until the Route_Segment is repaired or the Logistics_Route is rerouted along an intact path.

### Requirement 13: Pre-Seeded Example Logistics Network in the Default Test World

**User Story:** As a developer or player, I want a complete example logistics network already in place when the default test world loads, so that I can see the logistics system working immediately without building it from scratch.

#### Acceptance Criteria

1. WHEN the Default_Test_World is generated, THE Logistics_System SHALL initialise a Seeded_Logistics_Network that is fully operational at the start of the first turn.
2. WHEN the Default_Test_World is generated, THE Logistics_System SHALL include in the Seeded_Logistics_Network at least one operational Oil_Well placed on an Oil_Deposit.
3. WHEN the Default_Test_World is generated, THE Logistics_System SHALL include in the Seeded_Logistics_Network at least one Refinery that contains two or more Refinery_Segments.
4. WHEN the Default_Test_World is generated, THE Logistics_System SHALL include in the Seeded_Logistics_Network at least one Logistics_Route rendered as a Road.
5. WHEN the Default_Test_World is generated, THE Logistics_System SHALL include in the Seeded_Logistics_Network at least one Logistics_Route rendered as a Highway.
6. WHEN the Default_Test_World is generated, THE Logistics_System SHALL include in the Seeded_Logistics_Network at least one Distribution_Hub that connects two or more Logistics_Routes.
7. WHEN the Default_Test_World is generated, THE Logistics_System SHALL include in the Seeded_Logistics_Network at least one Transportation_Unit of each Transport_Tier, with every such Transportation_Unit assigned to a Logistics_Route.
8. WHEN the Default_Test_World is generated, THE Logistics_System SHALL assign every structure and Transportation_Unit of the Seeded_Logistics_Network to the Home_Faction and SHALL connect the Seeded_Logistics_Network through to the Home_City.
9. WHEN the Default_Test_World is generated two or more times from the default seed, THE Logistics_System SHALL produce an identical Seeded_Logistics_Network on every generation.
10. WHERE a world is generated from an arbitrary player-chosen seed other than the default seed, THE Logistics_System SHALL restrict that world's seeded logistics content to the standard Oil_Deposit placement and SHALL leave all other aspects of that world's generation unchanged.

### Requirement 14: High-Quality Tiered 3D Models with Visual Upgrade Differentiation

**User Story:** As a player, I want each logistics entity rendered as a detailed 3D model whose appearance reflects its type and upgrade level, so that I can recognise what I am looking at and how upgraded it is at a glance.

#### Acceptance Criteria

1. THE Client SHALL render each Logistics_Entity as a procedural 3D model built with Three.js.
2. THE Client SHALL render each Logistics_Entity 3D model with geometry detail, measured by polygon count and structural fidelity, that meets or exceeds the Unit_Model_Standard.
3. THE Client SHALL render a distinct 3D model for each Transport_Tier, comprising at least three tiers: a Small_Van model, a Truck model, and a Juggernaut model.
4. THE Client SHALL render the Small_Van, Truck, and Juggernaut models with strictly increasing size and mass, such that the Truck model is larger than the Small_Van model and the Juggernaut model is larger than the Truck model.
5. WHEN a Transportation_Unit's Transport_Tier changes through upgrade, THE Client SHALL render that Transportation_Unit using the 3D model assigned to its current Transport_Tier.
6. THE Client SHALL render a Highway with a 3D model that is visually distinct from a Road, presenting the Highway as wider or multi-lane.
7. THE Client SHALL render a Cluster_Boundary around each individual City and each individual Refinery, such that two adjacent but distinct clusters (City–City, Refinery–Refinery, or City–Refinery) display separate boundaries and remain visually distinguishable as separate entities.

## Open Questions

1. **Refinery combat granularity across a multi-hex cluster.** Requirement 12 currently assigns Hit_Points and destruction to "a Refinery" as a single structure, which was written when a Refinery was one hex. With multi-hex clusters, it is unresolved whether an attack targets and destroys an individual Refinery_Segment, a whole Refinery_Hex, or the entire Refinery_Cluster at once, and what happens to the cluster's held Oil / available Refined_Product on partial destruction. Requirement 12 is unchanged pending this decision.

## Resolved Questions

Previously open questions that the current requirements now answer:

- **Building placement inside Cities and Refineries (sealing / through-street).** Resolved: the mandatory per-hex through-street invariant and the whole-cluster external-reachability invariant are deprecated for both Cities and Refineries (Requirement 4.14). A player may build on any eligible segment, even one that isolates other segments. Movement instead relies on Segment_Traversal — a unit may step only onto an empty segment that is one of the three adjacent to its current segment — so an unreachable placement is simply the player's mistake, not an illegal build. This requires base-game changes to `shared/buildings.ts` placement validation, the movement/pathfinding modules, and the shared world-integrity check (see Design).
- **End use of Oil (was Open Question 1, original set).** Resolved: Refineries consume raw Oil to produce Refined_Product (Requirement 4), and Refined_Product is the sole resource consumed to construct and upgrade all buildings, structures, roads, and units (Requirement 5).
- **Route geometry (was Open Question 5, original set).** Resolved: Logistics_Routes are physical roads laid along a contiguous path of adjacent traversable HexTiles (Requirement 6), cannot cross uncleared forests or unbridged impassable terrain (Requirements 6, 9, 10), and their traversal time depends on the steepness of the path (Requirement 7).
- **Refinery input/output (was Open Question 6, original set).** Resolved: A Refinery consumes raw Oil and produces a distinct Refined_Product (Requirement 4.5–4.7), rather than merely increasing throughput of the same resource.
- **Extraction, capacity, and conversion values.** Resolved: Oil_Well Extraction_Rate is 10 raw Oil per turn (Requirement 3.1); Oil_Well Storage_Capacity is 100 raw Oil (Requirement 3.2); Refinery_Throughput_Rate is 20 raw Oil per Refinery_Segment per turn (Requirement 4.4); the Conversion_Ratio is 0.5, i.e. 2 raw Oil yield 1 Refined_Product (Requirement 4.5); Distribution_Hub Storage_Capacity is 500 combined units (Requirement 11.3); Oil_Deposits are placed by Maximal_Deposit_Fill with no fixed count, greedily filling all land until no remaining land HexTile is at least the Deposit_Spacing of 20 hex tiles from every placed deposit (Requirement 1.2, 1.4); the Home_City_Refined_Product_Maximum is 100000 (Requirement 5.4–5.7); and the full Construction_Cost table is fixed (Glossary and Requirement 5.8–5.9). Route_Capacity remains the previously specified 100–1000 per-turn model (Requirement 6.4–6.7).
- **Refinery eligibility.** Resolved: A Refinery may be built on any player-owned land HexTile whose every HexSegment is at or below the Tank_Steepness_Threshold and unoccupied; refineries may not be built on water or on Forest_Tiles that have not been cleared (Requirement 4.11–4.12).
- **Ownership and contesting.** Resolved: Structures belong to the player that built them and may only be built on owned or unowned land (Requirement 12.1–12.3); Oil_Wells, Refineries, Distribution_Hubs, Roads, and Bridges have Hit_Points and are destroyable via the existing combat model (Requirement 12.4–12.6); a destroyed Oil_Well, Refinery, or Distribution_Hub loses its stored Oil and Refined_Product (Requirement 12.7); and destroying a Road or Bridge renders any Logistics_Route using that Route_Segment inoperable until repaired or rerouted (Requirement 12.8).
- **Transportation_Unit production and limits.** Resolved: Transportation_Units are purchased with Refined_Product at a Construction_Cost of 30, assigned to a specific Logistics_Route, capped at 3 per Logistics_Route, and dispatched automatically under AI control (Requirement 8.11–8.13); Transportation_Unit upgrades cost 45 (Glossary and Requirement 5.8).
- **Route travel-time function shape.** Resolved: Route_Travel_Time equals the ceiling of the sum over Route_Segments of (1 + Segment_Steepness / Tank_Steepness_Threshold), clamped to a minimum of 1 turn (Requirement 7.6), giving a base of 1 turn per flat Route_Segment and up to approximately 2 turns per maximally-steep Route_Segment.
