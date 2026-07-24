# Dependency Graph Summary

Modules: 199

Use `ai/generated/dep-graph.json` for full machine-readable graph.

## src/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| world/types.ts | 3 | 34 |
| world/units.ts | 3 | 22 |
| world/combatFormula.ts | 1 | 13 |
| world/combatFacing.ts | 3 | 10 |
| world/combat/types.ts | 5 | 10 |
| world/combat.ts | 1 | 7 |
| world/combat/context.ts | 3 | 7 |
| world/segmentGeometry.ts | 4 | 6 |
| world/tilePathfinding.ts | 2 | 6 |
| world/combat/defence.ts | 7 | 6 |
| world/generate.ts | 8 | 6 |
| world/vec3.ts | 1 | 5 |
| world/logistics/placement.ts | 2 | 5 |
| world/repair.ts | 2 | 4 |
| world/logistics/routes.ts | 4 | 4 |
| world/validate.ts | 3 | 4 |
| world/logistics/tasks.ts | 2 | 4 |
| world/combat/weaponOptions.ts | 5 | 3 |
| world/logistics/production.ts | 2 | 3 |
| world/buildings.ts | 2 | 3 |
| world/rng.ts | 1 | 3 |
| world/logisticsSeed.ts | 1 | 3 |
| world/spawn.ts | 2 | 3 |
| world/logistics/hubs.ts | 2 | 3 |
| world/logistics/shuttle.ts | 2 | 3 |
| world/logistics/transport.ts | 3 | 3 |
| world/compact.ts | 4 | 3 |
| world/movement.ts | 6 | 2 |
| world/turnState.ts | 2 | 2 |
| world/combat/buildingDamage.ts | 11 | 2 |
| world/combat/results.ts | 1 | 2 |
| world/combat/resolution.ts | 11 | 2 |
| world/geodesic.ts | 2 | 2 |
| world/logisticsGen.ts | 4 | 2 |
| world/logistics/turn.ts | 8 | 2 |
| world/combat/index.ts | 13 | 1 |
| world/combat/preview.ts | 11 | 1 |
| world/combat/reaction.ts | 7 | 1 |
| world/combat/unitDamage.ts | 3 | 1 |
| world/combat/simultaneous.ts | 3 | 1 |
| world/segmentSteepness.ts | 3 | 1 |
| world/logistics/index.ts | 9 | 1 |
| world/logistics/combatIntegration.ts | 3 | 1 |
| generateCli.ts | 9 | 0 |
| validate.ts | 6 | 0 |
| world/index.ts | 21 | 0 |

### Key hubs in src/

- **src/world/types.ts** — depended on by 34 modules
- **src/world/units.ts** — depended on by 22 modules
- **src/world/combatFormula.ts** — depended on by 13 modules
- **src/world/combatFacing.ts** — depended on by 10 modules
- **src/world/combat/types.ts** — depended on by 10 modules

## server/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| logistics/context.ts | 6 | 11 |
| combatExplainer.ts | 5 | 3 |
| combatApi.ts | 11 | 2 |
| logistics/bridgesAndForest.ts | 8 | 2 |
| logistics/dispatch.ts | 11 | 2 |
| logistics/hubs.ts | 7 | 2 |
| logistics/refineries.ts | 6 | 2 |
| logistics/routes.ts | 8 | 2 |
| logistics/shuttle.ts | 7 | 2 |
| logistics/structures.ts | 7 | 2 |
| logistics/transport.ts | 6 | 2 |
| logistics/wells.ts | 7 | 2 |
| developmentMode.ts | 2 | 1 |
| sessionStore.ts | 1 | 1 |
| aiTurnApi.ts | 11 | 0 |
| devPlugin.ts | 1 | 0 |
| generateApi.ts | 6 | 0 |
| logistics/index.ts | 10 | 0 |
| matchApi.ts | 18 | 0 |
| regenerate.ts | 3 | 0 |

### Key hubs in server/

- **server/logistics/context.ts** — depended on by 11 modules
- **server/combatExplainer.ts** — depended on by 3 modules
  - server/aiTurnApi.ts
  - server/combatApi.ts
  - server/matchApi.ts
- **server/combatApi.ts** — depended on by 2 modules
  - server/aiTurnApi.ts
  - server/matchApi.ts
- **server/logistics/bridgesAndForest.ts** — depended on by 2 modules
  - server/logistics/dispatch.ts
  - server/logistics/index.ts
- **server/logistics/dispatch.ts** — depended on by 2 modules
  - server/logistics/index.ts
  - server/matchApi.ts

## shared/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| movementConstants.ts | 1 | 29 |
| logisticsTypes.ts | 2 | 26 |
| logisticsConstants.ts | 0 | 23 |
| unitTypes.ts | 0 | 15 |
| matchTypes.ts | 5 | 15 |
| segmentGraph.ts | 0 | 14 |
| wireTypes.ts | 2 | 13 |
| combatTypes.ts | 1 | 11 |
| rangeCheck.ts | 0 | 9 |
| buildingComponents.ts | 0 | 7 |
| pathfinding.ts | 0 | 4 |
| logisticsSanitization.ts | 1 | 3 |
| buildings.ts | 0 | 2 |
| unitNaming.ts | 1 | 2 |
| rng.ts | 0 | 2 |

### Key hubs in shared/

- **shared/movementConstants.ts** — depended on by 29 modules
- **shared/logisticsTypes.ts** — depended on by 26 modules
- **shared/logisticsConstants.ts** — depended on by 23 modules
- **shared/unitTypes.ts** — depended on by 15 modules
- **shared/matchTypes.ts** — depended on by 15 modules

## client/

| Module | Depends on (count) | Depended on by (count) |
|--------|-------------------|------------------------|
| worldData.ts | 4 | 45 |
| debug.ts | 0 | 18 |
| colors.ts | 1 | 18 |
| localMapProjection.ts | 2 | 15 |
| unitModelHelpers.ts | 1 | 12 |
| turnManager.ts | 3 | 9 |
| facing.ts | 0 | 8 |
| unitModel.ts | 7 | 7 |
| buildingRenderer.ts | 5 | 6 |
| localMapMovement.ts | 3 | 6 |
| world/model.ts | 2 | 5 |
| buildingModel.ts | 9 | 5 |
| unitModelTypes.ts | 0 | 5 |
| localMap.ts | 15 | 5 |
| logisticsModel.ts | 5 | 5 |
| unitRenderer.ts | 5 | 5 |
| firstPersonConstants.ts | 0 | 5 |
| firstPersonTerrain.ts | 17 | 5 |
| gameContext.ts | 9 | 5 |
| world/validation.ts | 0 | 4 |
| buildController.ts | 2 | 4 |
| combatPanel.ts | 6 | 4 |
| htmlUtils.ts | 0 | 4 |
| localMapGeometry.ts | 3 | 4 |
| ewOverlay.ts | 3 | 4 |
| terrainContext.ts | 5 | 4 |
| terrainTextures.ts | 13 | 4 |
| firstPersonGeometry.ts | 3 | 4 |
| gameDebug.ts | 4 | 4 |
| aiPlayback.ts | 1 | 3 |
| splashBombModel.ts | 4 | 3 |
| cityPlan.ts | 3 | 3 |
| mapInput.ts | 10 | 3 |
| movementRange.ts | 4 | 3 |
| localMapUnits.ts | 11 | 3 |
| globe.ts | 5 | 3 |
| logisticsController.ts | 6 | 3 |
| world/codec.ts | 6 | 2 |
| aiTurn.ts | 13 | 2 |
| unitModelAddons.ts | 5 | 2 |
| combatBreakdownView.ts | 4 | 2 |
| cityContextMenus.ts | 0 | 2 |
| movementRoute.ts | 6 | 2 |
| unitContextMenu.ts | 3 | 2 |
| logisticsSpriteRenderer.ts | 5 | 2 |
| detailPanel.ts | 10 | 2 |
| firstPersonInput.ts | 11 | 2 |
| logisticsModelRoad.ts | 3 | 2 |
| logisticsModelTransport.ts | 3 | 2 |
| firstPersonView.ts | 17 | 2 |
| matchClient.ts | 4 | 2 |
| saveLoad.ts | 3 | 2 |
| turnController.ts | 5 | 2 |
| world/repository.ts | 5 | 1 |
| world/expand.ts | 6 | 1 |
| world/tilesClient.ts | 3 | 1 |
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
| logisticsModelBridge.ts | 2 | 1 |
| logisticsModelHub.ts | 2 | 1 |
| logisticsModelRefinery.ts | 2 | 1 |
| logisticsModelWell.ts | 2 | 1 |
| unitIcons.ts | 2 | 1 |
| unitModelFlight.ts | 3 | 1 |
| unitModelLimbed.ts | 3 | 1 |
| unitModelWheeled.ts | 3 | 1 |
| unitNames.ts | 2 | 1 |
| firstPersonEffects.ts | 2 | 1 |
| firstPersonOverlay.ts | 6 | 1 |
| firstPersonScene.ts | 18 | 1 |
| keyboardShortcuts.ts | 10 | 1 |
| newWorldModal.ts | 3 | 1 |
| panelWiring.ts | 3 | 1 |
| playerActions.ts | 11 | 1 |
| refitModal.ts | 5 | 1 |
| shuttleTransportModal.ts | 0 | 1 |
| logisticsPanel.ts | 3 | 0 |
| logisticsRenderer.ts | 6 | 0 |
| main.ts | 27 | 0 |
| mapProjection.ts | 1 | 0 |
| unitDesigner.ts | 5 | 0 |
| vite-env.d.ts | 1 | 0 |

### Key hubs in client/

- **client/worldData.ts** — depended on by 45 modules
- **client/debug.ts** — depended on by 18 modules
- **client/colors.ts** — depended on by 18 modules
- **client/localMapProjection.ts** — depended on by 15 modules
- **client/unitModelHelpers.ts** — depended on by 12 modules

## Cross-area dependencies

Shows imports that cross area boundaries (client→shared, server→src, etc.)

### client → shared (60 edges)

- **shared/buildingComponents.ts** ← client/buildingAttackMenu.ts, client/mapInput.ts, client/playerActions.ts
- **shared/buildings.ts** ← client/buildController.ts
- **shared/combatTypes.ts** ← 5 modules
- **shared/logisticsConstants.ts** ← client/localMapUnits.ts, client/logisticsModelTransport.ts, client/logisticsPanel.ts
- **shared/logisticsSanitization.ts** ← client/world/expand.ts
- **shared/logisticsTypes.ts** ← client/world/model.ts, client/world/codec.ts
- **shared/matchTypes.ts** ← client/matchClient.ts, client/logisticsController.ts
- **shared/movementConstants.ts** ← 18 modules
- **shared/pathfinding.ts** ← client/aiTurn.ts, client/logisticsController.ts
- **shared/rangeCheck.ts** ← 4 modules
- **shared/rng.ts** ← client/firstPersonScene.ts
- **shared/segmentGraph.ts** ← 6 modules
- **shared/unitNaming.ts** ← client/unitNames.ts
- **shared/unitTypes.ts** ← 4 modules
- **shared/wireTypes.ts** ← 7 modules

### server → shared (55 edges)

- **shared/combatTypes.ts** ← 5 modules
- **shared/logisticsConstants.ts** ← 9 modules
- **shared/logisticsSanitization.ts** ← server/logistics/structures.ts, server/matchApi.ts
- **shared/logisticsTypes.ts** ← 9 modules
- **shared/matchTypes.ts** ← 13 modules
- **shared/movementConstants.ts** ← 5 modules
- **shared/pathfinding.ts** ← server/aiTurnApi.ts
- **shared/rangeCheck.ts** ← server/aiTurnApi.ts
- **shared/segmentGraph.ts** ← 5 modules
- **shared/unitTypes.ts** ← server/aiTurnApi.ts, server/combatApi.ts, server/matchApi.ts
- **shared/wireTypes.ts** ← server/combatApi.ts, server/regenerate.ts

### server → src (49 edges)

- **src/world/buildings.ts** ← server/generateApi.ts
- **src/world/combat.ts** ← 4 modules
- **src/world/compact.ts** ← server/regenerate.ts
- **src/world/generate.ts** ← server/generateApi.ts, server/matchApi.ts, server/regenerate.ts
- **src/world/logistics/hubs.ts** ← server/logistics/hubs.ts
- **src/world/logistics/placement.ts** ← 4 modules
- **src/world/logistics/production.ts** ← server/logistics/context.ts
- **src/world/logistics/routes.ts** ← server/logistics/context.ts, server/logistics/routes.ts, server/logistics/shuttle.ts
- **src/world/logistics/shuttle.ts** ← server/logistics/shuttle.ts
- **src/world/logistics/tasks.ts** ← server/logistics/bridgesAndForest.ts, server/logistics/wells.ts
- **src/world/logistics/transport.ts** ← server/logistics/transport.ts
- **src/world/logistics/turn.ts** ← server/matchApi.ts
- **src/world/logisticsSeed.ts** ← server/matchApi.ts
- **src/world/repair.ts** ← server/combatApi.ts, server/combatExplainer.ts, server/matchApi.ts
- **src/world/spawn.ts** ← server/generateApi.ts
- **src/world/tilePathfinding.ts** ← server/generateApi.ts
- **src/world/types.ts** ← 15 modules
- **src/world/units.ts** ← 4 modules
- **src/world/validate.ts** ← server/generateApi.ts

### src → shared (47 edges)

- **shared/buildingComponents.ts** ← src/world/combat/buildingDamage.ts, src/world/combat/buildingDamage.ts, src/world/combat/types.ts
- **shared/buildings.ts** ← src/world/buildings.ts
- **shared/logisticsConstants.ts** ← 10 modules
- **shared/logisticsTypes.ts** ← 12 modules
- **shared/movementConstants.ts** ← 6 modules
- **shared/pathfinding.ts** ← src/world/tilePathfinding.ts
- **shared/rangeCheck.ts** ← 4 modules
- **shared/rng.ts** ← src/world/rng.ts
- **shared/segmentGraph.ts** ← src/world/movement.ts, src/world/logistics/routes.ts, src/world/logistics/turn.ts
- **shared/unitNaming.ts** ← src/world/units.ts
- **shared/unitTypes.ts** ← src/world/types.ts, src/world/units.ts, src/world/logistics/combatIntegration.ts
- **shared/wireTypes.ts** ← src/world/compact.ts, src/validate.ts

