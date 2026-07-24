/**
 * Compatibility facade over the `client/world/**` module split.
 *
 * `worldData.ts` used to own everything (types, fetch, validation, cache,
 * save projection, session-storage handoff) in one file. It is now a thin
 * re-export layer so the ~40 existing importers across the client keep
 * compiling without a flag-day migration, while the real implementation is
 * decomposed by responsibility:
 *
 *   client/world/model.ts       Client runtime model (WorldData, TileData, …)
 *   client/world/codec.ts       Unknown-input decoding, validation, migration,
 *                                 bootstrap normalization, save projection
 *   client/world/tilesClient.ts /api/world-tiles request + response validation
 *   client/world/expand.ts      Decoded save + regenerated tiles -> WorldData
 *   client/world/repository.ts  Cache, load-source selection, storage/reload
 *
 * New internal code should import the focused module it needs directly
 * (`./world/model.js`, `./world/codec.js`, etc.) rather than this facade.
 * Existing external callers may keep importing from here.
 */

export type {
  TileData,
  UnitData,
  BuildingData,
  CityData,
  WorldData,
  LogisticsState,
  OilWell,
  Refinery,
  LogisticsRoute,
  Transport,
  DistributionHub,
  HomeStock,
  EngineerTask,
} from './world/model.js';

export { buildingAsAttackerUnit } from './world/model.js';

// `CompactSave` continues to name "a valid, current-format save" for existing
// callers — see `shared/wireTypes.ts::CompactSave` (currently CompactSaveV1).
export type { CompactSave } from '../shared/wireTypes.js';

export { getWorld, getCompactSave, loadWorld, applyNewWorld } from './world/repository.js';
