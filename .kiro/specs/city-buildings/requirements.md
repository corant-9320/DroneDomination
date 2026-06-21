# Requirements Document

## Introduction

This feature introduces **cities** to Drone Domination. A city is a contiguous,
faction-owned cluster of tiles on which the player constructs **buildings**.
Each building occupies a single triangular segment of a hex (a full-segment
occupant, like a unit). The defining constraint is **traversability**: a player
may never build in a way that walls off the city. Every city tile must retain a
through-street made of its open (unbuilt) segments, and the city's entire
open-segment network must remain reachable from the world outside the city.

### Scope for this session

In scope:
- Founding a city on the faction capital hex with one free building.
- Constructing buildings (one per turn), constrained to grow contiguously.
- The strict through-street invariant and the no-courtyard (external
  reachability) invariant, validated at build time.
- Buildings sharing the 6-segment-per-tile budget with units.

Explicitly deferred to a future session (referenced here only so the model
does not paint us into a corner):
- A dedicated `road` terrain type with its own movement cost. For now, open
  street segments keep the tile's **existing terrain and movement cost**.
- Building **types** with distinct stats. For now a building is a single generic
  occupant with no per-type attributes.
- Building **upgrades** (analogous to unit upgrades).

## Glossary

- **Segment** — one of the 6 triangular subdivisions of a hex (indices 0–5,
  clockwise from `neighbours[0]`). Segment N's **external face** is the hex edge
  shared with `neighbours[N]`.
- **Building** — a full-segment occupant identified by `(tileIndex, segment)`.
- **Open segment / street segment** — a segment of a city tile that holds no
  building. Units may occupy or pass through it; it retains the tile's terrain.
- **Through-street** — within a single tile, a connected run of open segments
  whose two ends have external faces opening onto ground-passable neighbours,
  allowing a ground unit to enter one face and leave another.
- **Ground-passable neighbour** — a neighbouring tile a ground chassis could
  enter under existing movement rules (i.e. not ocean / not otherwise
  impassable).
- **Open-segment network** — the graph of all open segments across the city,
  connected within a hex (segment N ↔ N±1) and across shared external faces
  between adjacent city tiles.
- **City-owned hex** — a hex belonging to a city (carries the city's owner).
- **Capital hex** — the founding hex of a city (the faction's capital). It is
  exempt from the per-tile through-street invariant and may hold buildings on
  all six segments.

## Requirements

### Requirement 1: City founding

**User Story:** As a player, I want my faction to begin with a city on my
capital hex so that I have a starting point from which to build.

#### Acceptance Criteria

1. WHEN a new world is generated THEN the system SHALL create one city per
   faction located on that faction's capital hex.
2. WHEN a city is founded THEN the system SHALL place one free building on a
   segment of the capital hex without consuming the faction's per-turn
   construction action.
3. WHEN a city is founded THEN the system SHALL mark the capital hex as
   city-owned by the founding faction.
4. WHERE a building is placed at founding THE system SHALL choose a segment that
   leaves the capital hex with a valid through-street (Requirement 4). The
   capital hex itself is exempt from the through-street invariant (Requirement
   4.5), so any open segment is acceptable.
5. THE system SHALL record each city with a stable id, an owning faction, and
   the set of hexes it owns.

### Requirement 2: Per-turn construction

**User Story:** As a player, I want to construct buildings over time so that my
city grows turn by turn.

#### Acceptance Criteria

1. WHEN it is a faction's turn THEN the system SHALL allow that faction to
   construct at most one building that turn.
2. WHEN a building construction is committed THEN the system SHALL place the
   building immediately (no multi-turn build timer) and consume that turn's
   single construction action.
3. IF a faction has already constructed a building this turn THEN the system
   SHALL reject any further construction until the next turn.
4. THE system SHALL track the per-turn construction allowance per **faction**,
   so that a faction may construct at most one building per turn across all of
   its cities.
5. WHEN a building is constructed THEN the system SHALL assign it a stable id and
   record its `(tileIndex, segment)` and owning faction.

### Requirement 3: Contiguous growth and placement legality

**User Story:** As a player, I want buildings to extend my existing city so that
the city stays a single connected cluster.

#### Acceptance Criteria

1. WHEN a player selects a target segment for a new building THEN the system
   SHALL accept it ONLY IF its hex is adjacent to (or is) a hex that already
   holds a building owned by the same faction.
2. IF the target segment already holds a unit THEN the system SHALL reject the
   placement.
3. IF the target segment already holds a building THEN the system SHALL reject
   the placement.
4. WHEN a building is placed on a hex not previously city-owned THEN the system
   SHALL mark that hex as city-owned by the faction.
5. THE system SHALL keep buildings within the 6-segment budget shared with
   units, such that the total of buildings plus units on a tile never exceeds
   the tile's segment capacity.
6. WHILE units occupy open street segments THE system SHALL continue to permit
   them to move through and rest on those segments under existing movement
   rules.

### Requirement 4: Strict through-street invariant (per tile)

**User Story:** As a player, I want every city tile to remain passable so that
units can move through my city rather than around it.

#### Acceptance Criteria

1. WHEN a building placement is evaluated THEN the system SHALL verify that the
   affected hex still has a through-street after the placement.
2. THE system SHALL define a valid through-street as a connected run of open
   segments within the hex whose two end segments each have a clear external
   face opening onto a ground-passable neighbour.
3. IF a placement would leave any city hex without a valid through-street THEN
   the system SHALL reject the placement.
4. WHERE a hex's external face borders an impassable neighbour (e.g. ocean) THE
   system SHALL NOT count that face as a valid street opening.
5. WHERE the affected hex is a city's **capital hex** THE system SHALL exempt it
   from the through-street invariant (criteria 4.1–4.3), permitting buildings on
   all six of its segments. The surrounding city hexes remain fully subject to
   the through-street invariant, so the city's traversability is carried by the
   hexes around the capital rather than through the capital itself.

### Requirement 5: No-courtyard / external reachability invariant (whole city)

**User Story:** As a player, I want the streets of my city to connect to the
outside world so that the city can never trap units in a sealed pocket.

#### Acceptance Criteria

1. WHEN a building placement is evaluated THEN the system SHALL verify that the
   city's open-segment network remains connected to at least one hex outside the
   city via a ground-passable external face.
2. IF a placement would create an open-segment pocket with no path to the
   external map THEN the system SHALL reject the placement, EVEN IF every
   individual tile still satisfies the per-tile through-street rule
   (Requirement 4).
3. THE system SHALL treat the open-segment network as a graph connected within a
   hex (segment N ↔ N±1) and across shared external faces between adjacent hexes.

### Requirement 6: Build-time validation and feedback

**User Story:** As a player, I want clear feedback when a building can't be
placed so that I understand why and can choose a legal spot.

#### Acceptance Criteria

1. WHEN a placement is rejected THEN the system SHALL report a specific reason
   (segment occupied, not adjacent to the city, breaks a through-street, or
   orphans the street network).
2. THE system SHALL expose a pure validation function that, given a world and a
   proposed placement, returns whether it is legal and—if not—the offending
   hexes/segments.
3. THE system SHALL reuse that same validation in world-integrity checking
   (`npm run validate`) so that no generated or loaded world contains a city
   that violates Requirements 4 or 5.

### Requirement 7: Persistence and wire format

**User Story:** As a player, I want my city and buildings to survive save/load
and the client/server round-trip so that my progress is not lost.

#### Acceptance Criteria

1. THE system SHALL include buildings and city ownership in the authoritative
   world model and its compact wire format.
2. WHEN a world is saved and reloaded THEN the system SHALL restore all cities,
   their owned hexes, and all buildings with their segment positions.
3. THE client representation SHALL mirror the building/ownership data needed to
   render and validate placement without importing server-only modules.

## Open Questions

All initial open questions are resolved:

- **O1 — Per-turn cap granularity.** RESOLVED: the cap is **per faction** (one
  building per turn across all of a faction's cities). See R2.1 / R2.4.
- **O2 — Building selection at founding.** RESOLVED: no preference — any segment
  that preserves a valid through-street is acceptable. See R1.4.
- **O3 — Capital hex source.** RESOLVED: the capital hex is identifiable from
  world-gen (faction home city) and is reused as the city anchor.
