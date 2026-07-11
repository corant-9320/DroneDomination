# Memory Graph

**Purpose:** Tell every session that a persistent project knowledge graph exists and how to use it.
**Scope:** All sessions.
**Audience:** Any agent working on this repo.

## What it is

A structured knowledge graph of Drone Domination concepts is maintained via the `memory` MCP server, configured in `DroneDomination\.kiro\settings\mcp.json`.

It is an orientation and continuity tool. It helps agents quickly understand important game concepts, relationships, assumptions, and prior design decisions without rediscovering everything from scratch.

It contains entities and relations covering:

* World model: `GoldbergPolyhedron`, `HexTile`, `HexSegment`, `TerrainType`
* Game entities: `Unit`, `City`, `Building`, and their attributes
* Combat system: `DamageFormula`, `ChassisType`, `FacingAndOrientation`, `RangeAndDistance`, `DefencePower`, `ElectronicWarfare`, `ElevationAdvantage`, and weapon modes
* Game systems: `MovementSystem`, `RepairSystem`, `WorldGeneration`, `AISystem`, etc.
* Architecture: `ModuleLayout`, `SharedModules`, `CompactWireFormat`, `ServerAPI`
* Client modules: `GlobeView`, `LocalMapView`, `FirstPersonView`, `TurnManager`, etc.

## What it is not

The memory graph is not the source of truth for current implementation details.

The source of truth remains:

1. The code
2. The tests
3. The authoritative project documents, such as `ARCHITECTURE.md` and `COMBAT_RULES.md`

Use memory to orient yourself, find relevant concepts, and understand relationships. Before changing behaviour, verify the relevant code and canonical docs.

## When to query it

### At session start

Before grepping widely or re-reading large documents, search the graph for concepts relevant to the task. This gives a fast map of the domain and points you towards the right files, docs, and related concepts.

### When you hit an unfamiliar term

Search for the term by name to get its observations and relations before opening multiple files.

### Before changing a major system

Search the graph for the relevant system and neighbouring concepts so you understand likely side effects.

### After making a significant change

Add or update observations so the next session inherits accurate project state.

## How to use it

Query by concept name or keyword:

```ts
mcp_memory_search_nodes("combat")
mcp_memory_open_nodes(["DamageFormula", "DefencePower"])
mcp_memory_read_graph()
```

Prefer targeted search and open calls. `mcp_memory_read_graph()` is expensive and should only be used when targeted search is insufficient.

Add knowledge after changes:

```ts
mcp_memory_add_observations({
  entityName: "DamageFormula",
  contents: ["Changed SPLASH_SCALE from 0.3 to 0.4 on 2026-06-18 because splash weapons were underperforming against grouped units."]
})
```

Create new entities when a new durable concept is introduced:

```ts
mcp_memory_create_entities([{
  name: "NewSystem",
  entityType: "GameSystem",
  observations: ["..."]
}])
```

## Rules

1. **Use memory for orientation, not authority.**
   Query the graph early to understand the relevant concepts and relationships. Before editing behaviour, verify against the code, tests, and canonical docs.

2. **Prefer targeted queries.**
   Search by concept name, system name, or keyword. Avoid reading the full graph unless there is no more focused way to find the relevant context.

3. **Keep the graph current for structural changes.**
   Update the graph when a concept changes structurally, including:

   * new entity
   * deleted entity
   * renamed entity
   * changed relationship
   * formula rewrite
   * new system
   * removed system
   * changed responsibility boundary

4. **Record non-obvious downstream effects.**
   Update observations when a value-only change has consequences that are not obvious from the code diff alone.

   Examples:

   * a constant bump makes another cap unreachable
   * a threshold change causes a different branch of a formula to dominate
   * a terrain modifier changes the relative value of a unit class
   * a range change alters which tactics are viable

5. **Skip obvious value-only changes.**
   Do not update the graph for simple tuning changes where the effect is exactly what the diff says.

   The code and git history are authoritative for current numeric values.

6. **Do not duplicate steering.**
   The graph holds what the game contains and how concepts relate. Steering files hold rules for agents. Do not copy agent instructions into graph observations.

7. **Do not store noisy implementation detail.**
   Avoid adding every function, file, constant, or temporary implementation detail. The graph should contain durable concepts and relationships, not a second copy of the codebase.

8. **Use clear observation wording.**
   Good observations explain why the fact matters, not just that it exists.

   Prefer:

   ```text
   ElevationAdvantage affects both hit chance and damage, so changes to terrain height generation can indirectly alter combat balance.
   ```

   Avoid:

   ```text
   ElevationAdvantage exists.
   ```
