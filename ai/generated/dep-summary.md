# Dependency Graph Summary

Generated: 2026-07-11
Modules: 147

Use `ai/generated/dep-graph.json` for full machine-readable graph.

## src/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| world/types.ts | 3 | 23 |
| world/units.ts | 3 | 14 |
| world/combat.ts | 9 | 8 |
| world/pathfinding.ts | 2 | 7 |
| world/generate.ts | 9 | 6 |
| world/vec3.ts | 1 | 5 |
| world/repair.ts | 2 | 4 |
| world/buildings.ts | 2 | 4 |
| world/logistics.ts | 6 | 4 |
| world/validate.ts | 4 | 4 |
| world/compact.ts | 4 | 4 |
| world/segmentGeometry.ts | 4 | 3 |
| world/rng.ts | 0 | 3 |
| world/spawn.ts | 2 | 3 |
| world/combatFacing.ts | 3 | 2 |
| world/combatFormula.ts | 1 | 2 |
| world/movement.ts | 5 | 2 |
| world/turnState.ts | 2 | 2 |
| world/geodesic.ts | 2 | 2 |
| world/logisticsGen.ts | 4 | 2 |
| world/logisticsSeed.ts | 5 | 2 |
| world/segmentSteepness.ts | 3 | 1 |
| generateCli.ts | 9 | 0 |
| validate.ts | 6 | 0 |
| world/index.ts | 21 | 0 |

### Key hubs in src/

- **src/world/types.ts** — depended on by 23 modules
- **src/world/units.ts** — depended on by 14 modules
- **src/world/combat.ts** — depended on by 8 modules
  - src/world/movement.ts
  - src/world/repair.ts
  - src/world/logistics.ts
  - src/world/index.ts
  - server/aiTurnApi.ts
  - server/combatApi.ts
  - server/combatExplainer.ts
  - server/matchApi.ts
- **src/world/pathfinding.ts** — depended on by 7 modules
  - src/world/segmentGeometry.ts
  - src/world/generate.ts
  - src/world/logisticsGen.ts
  - src/world/logisticsSeed.ts
  - src/world/validate.ts
  - src/world/index.ts
  - server/generateApi.ts
- **src/world/generate.ts** — depended on by 6 modules
  - src/world/validate.ts
  - src/generateCli.ts
  - src/world/index.ts
  - server/generateApi.ts
  - server/matchApi.ts
  - server/regenerate.ts

## server/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| combatExplainer.ts | 5 | 3 |
| combatApi.ts | 9 | 2 |
| logisticsApi.ts | 6 | 1 |
| sessionStore.ts | 1 | 1 |
| aiTurnApi.ts | 10 | 0 |
| devPlugin.ts | 1 | 0 |
| generateApi.ts | 7 | 0 |
| matchApi.ts | 14 | 0 |
| regenerate.ts | 3 | 0 |

### Key hubs in server/

- **server/combatExplainer.ts** — depended on by 3 modules
  - server/aiTurnApi.ts
  - server/combatApi.ts
  - server/matchApi.ts
- **server/combatApi.ts** — depended on by 2 modules
  - server/aiTurnApi.ts
  - server/matchApi.ts
- **server/logisticsApi.ts** — depended on by 1 modules
  - server/matchApi.ts
- **server/sessionStore.ts** — depended on by 1 modules
  - server/matchApi.ts

## shared/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| movementConstants.ts | 1 | 25 |
| unitTypes.ts | 0 | 11 |
| combatTypes.ts | 1 | 11 |
| logisticsConstants.ts | 0 | 10 |
| logisticsTypes.ts | 2 | 9 |
| rangeCheck.ts | 0 | 7 |
| buildingComponents.ts | 0 | 6 |
| wireTypes.ts | 2 | 5 |
| matchTypes.ts | 4 | 5 |
| pathfinding.ts | 0 | 4 |
| buildings.ts | 0 | 2 |
| unitNaming.ts | 1 | 2 |

### Key hubs in shared/

- **shared/movementConstants.ts** — depended on by 25 modules
- **shared/unitTypes.ts** — depended on by 11 modules
- **shared/combatTypes.ts** — depended on by 11 modules
- **shared/logisticsConstants.ts** — depended on by 10 modules
- **shared/logisticsTypes.ts** — depended on by 9 modules

## client/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| worldData.ts | 4 | 41 |
| debug.ts | 0 | 17 |
| colors.ts | 1 | 17 |
| unitModelHelpers.ts | 1 | 12 |
| unitModel.ts | 7 | 11 |
| localMapProjection.ts | 2 | 11 |
| turnManager.ts | 3 | 9 |
| facing.ts | 0 | 6 |
| buildingRenderer.ts | 5 | 5 |
| buildingModel.ts | 9 | 5 |
| localMap.ts | 13 | 5 |
| gameContext.ts | 9 | 5 |
| buildController.ts | 2 | 4 |
| unitModelTypes.ts | 0 | 4 |
| combatPanel.ts | 6 | 4 |
| htmlUtils.ts | 0 | 4 |
| localMapGeometry.ts | 3 | 4 |
| ewOverlay.ts | 3 | 4 |
| localMapMovement.ts | 3 | 4 |
| terrainContext.ts | 5 | 4 |
| terrainTextures.ts | 13 | 4 |
| unitRenderer.ts | 5 | 4 |
| gameDebug.ts | 4 | 4 |
| aiPlayback.ts | 1 | 3 |
| cityPlan.ts | 3 | 3 |
| mapInput.ts | 10 | 3 |
| movementRange.ts | 3 | 3 |
| localMapUnits.ts | 7 | 3 |
| globe.ts | 5 | 3 |
| aiTurn.ts | 11 | 2 |
| unitModelAddons.ts | 4 | 2 |
| combatBreakdownView.ts | 4 | 2 |
| cityContextMenus.ts | 0 | 2 |
| movementRoute.ts | 5 | 2 |
| unitContextMenu.ts | 3 | 2 |
| detailPanel.ts | 10 | 2 |
| firstPersonTerrain.ts | 17 | 2 |
| firstPersonView.ts | 18 | 2 |
| matchClient.ts | 4 | 2 |
| saveLoad.ts | 2 | 2 |
| turnController.ts | 5 | 2 |
| unitModelFlight.ts | 4 | 1 |
| unitModelLimbed.ts | 4 | 1 |
| unitModelWheeled.ts | 4 | 1 |
| buildingAttackMenu.ts | 2 | 1 |
| buildingRefitModal.ts | 5 | 1 |
| cityDesignModal.ts | 5 | 1 |
| movementDraw.ts | 4 | 1 |
| combatAnimations.ts | 0 | 1 |
| debugState.ts | 5 | 1 |
| localMapTerrain.ts | 8 | 1 |
| terrainFeatures.ts | 2 | 1 |
| terrainRelief.ts | 5 | 1 |
| terrainColor.ts | 0 | 1 |
| terrainWater.ts | 3 | 1 |
| unitIcons.ts | 2 | 1 |
| unitNames.ts | 2 | 1 |
| keyboardShortcuts.ts | 9 | 1 |
| logisticsModel.ts | 5 | 1 |
| logisticsModelBridge.ts | 2 | 1 |
| logisticsModelHub.ts | 2 | 1 |
| logisticsModelRefinery.ts | 2 | 1 |
| logisticsModelWell.ts | 2 | 1 |
| logisticsModelRoad.ts | 3 | 1 |
| logisticsModelTransport.ts | 3 | 1 |
| newWorldModal.ts | 2 | 1 |
| panelWiring.ts | 3 | 1 |
| playerActions.ts | 9 | 1 |
| refitModal.ts | 5 | 1 |
| logisticsController.ts | 4 | 0 |
| logisticsPanel.ts | 3 | 0 |
| logisticsRenderer.ts | 6 | 0 |
| main.ts | 24 | 0 |
| mapProjection.ts | 1 | 0 |
| unitDesigner.ts | 4 | 0 |
| vite-env.d.ts | 1 | 0 |

### Key hubs in client/

- **client/worldData.ts** — depended on by 41 modules
- **client/debug.ts** — depended on by 17 modules
- **client/colors.ts** — depended on by 17 modules
- **client/unitModelHelpers.ts** — depended on by 12 modules
- **client/unitModel.ts** — depended on by 11 modules

## Cross-area dependencies

Shows imports that cross area boundaries (client→shared, server→src, etc.)

### client → shared (40 edges)

- **shared/buildingComponents.ts** ← client/buildingAttackMenu.ts, client/mapInput.ts, client/playerActions.ts
- **shared/buildings.ts** ← client/buildController.ts
- **shared/combatTypes.ts** ← 5 modules
- **shared/logisticsConstants.ts** ← client/logisticsModelTransport.ts, client/logisticsPanel.ts
- **shared/logisticsTypes.ts** ← client/worldData.ts
- **shared/matchTypes.ts** ← client/matchClient.ts, client/logisticsController.ts
- **shared/movementConstants.ts** ← 15 modules
- **shared/pathfinding.ts** ← client/aiTurn.ts, client/logisticsController.ts
- **shared/rangeCheck.ts** ← 4 modules
- **shared/unitNaming.ts** ← client/unitNames.ts
- **shared/unitTypes.ts** ← client/buildingRefitModal.ts, client/detailPanel.ts, client/refitModal.ts
- **shared/wireTypes.ts** ← client/worldData.ts

### server → shared (19 edges)

- **shared/combatTypes.ts** ← 5 modules
- **shared/logisticsConstants.ts** ← server/generateApi.ts, server/logisticsApi.ts
- **shared/logisticsTypes.ts** ← server/logisticsApi.ts, server/matchApi.ts
- **shared/matchTypes.ts** ← server/logisticsApi.ts, server/matchApi.ts, server/sessionStore.ts
- **shared/movementConstants.ts** ← 4 modules
- **shared/pathfinding.ts** ← server/aiTurnApi.ts
- **shared/rangeCheck.ts** ← server/aiTurnApi.ts
- **shared/unitTypes.ts** ← server/combatApi.ts

### server → src (28 edges)

- **src/world/buildings.ts** ← server/generateApi.ts
- **src/world/combat.ts** ← 4 modules
- **src/world/compact.ts** ← server/regenerate.ts, server/regenerate.ts
- **src/world/generate.ts** ← server/generateApi.ts, server/matchApi.ts, server/regenerate.ts
- **src/world/logistics.ts** ← server/logisticsApi.ts, server/matchApi.ts
- **src/world/pathfinding.ts** ← server/generateApi.ts
- **src/world/repair.ts** ← server/combatApi.ts, server/combatExplainer.ts, server/matchApi.ts
- **src/world/spawn.ts** ← server/generateApi.ts
- **src/world/types.ts** ← 6 modules
- **src/world/units.ts** ← 4 modules
- **src/world/validate.ts** ← server/generateApi.ts

### src → shared (27 edges)

- **shared/buildingComponents.ts** ← src/world/combat.ts, src/world/combat.ts
- **shared/buildings.ts** ← src/world/buildings.ts
- **shared/logisticsConstants.ts** ← 5 modules
- **shared/logisticsTypes.ts** ← 4 modules
- **shared/movementConstants.ts** ← 6 modules
- **shared/pathfinding.ts** ← src/world/pathfinding.ts
- **shared/rangeCheck.ts** ← src/world/combat.ts, src/world/combatFormula.ts
- **shared/unitNaming.ts** ← src/world/units.ts
- **shared/unitTypes.ts** ← src/world/types.ts, src/world/units.ts, src/world/logistics.ts
- **shared/wireTypes.ts** ← src/world/compact.ts, src/validate.ts

