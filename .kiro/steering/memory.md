# Memory Graph

**Purpose:** Tell every session that a persistent knowledge graph exists and how to use it.  
**Scope:** All sessions.  
**Audience:** Any agent working on this repo.

## What is it

A structured knowledge graph of Drone Domination's concepts is maintained via the
`memory` MCP server (configured in `.kiro/settings/mcp.json`). It contains entities
and relations covering:

- World model (GoldbergPolyhedron, HexTile, HexSegment, TerrainType)
- Game entities (Unit, City, Building) and their attributes
- Combat system (DamageFormula, ChassisType, FacingAndOrientation, RangeAndDistance,
  DefencePower, ElectronicWarfare, ElevationAdvantage, all three weapon modes)
- Game systems (MovementSystem, RepairSystem, WorldGeneration, AISystem, etc.)
- Architecture (ModuleLayout, SharedModules, CompactWireFormat, ServerAPI)
- Client modules (GlobeView, LocalMapView, FirstPersonView, TurnManager, etc.)

## When to query it

**At session start** — before reading docs or grepping code, search the graph for
the concepts relevant to the task. This is faster than re-reading ARCHITECTURE.md
or COMBAT_RULES.md from scratch.

**When you hit an unfamiliar term** — search for it by name to get its observations
and relations without opening files.

**After making a significant change** — add or update observations so the next
session inherits accurate state.

## How to use it

Query by concept name or keyword:

```
mcp_memory_search_nodes("combat")       # finds all combat-related entities
mcp_memory_open_nodes(["DamageFormula", "DefencePower"])  # load specific nodes
mcp_memory_read_graph()                 # full graph (expensive — prefer search)
```

Add knowledge after changes:

```
mcp_memory_add_observations({
  entityName: "DamageFormula",
  contents: ["Changed SPLASH_SCALE from 0.3 to 0.4 on 2026-06-18"]
})
```

Create new entities when a new concept is introduced:

```
mcp_memory_create_entities([{
  name: "NewSystem",
  entityType: "GameSystem",
  observations: ["..."]
}])
```

## Rules

1. **Query before reading files.** If the graph has it, use it. Only open the
   authoritative doc (`COMBAT_RULES.md`, `ARCHITECTURE.md`) when you need more
   detail than the graph provides.

2. **Keep it current.** If you change a formula, constant, or mechanic, update the
   relevant graph entity in the same turn. The graph is only useful if it stays in
   sync with the code.

3. **Don't duplicate steering.** The graph holds *what the game contains*. Steering
   holds *rules for agents*. Don't copy agent instructions into graph observations.
