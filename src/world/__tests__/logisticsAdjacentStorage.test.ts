import { describe, expect, it } from 'vitest';
import { resolveLogisticsTurn } from '../logistics/turn.js';
import type { DistributionHub, LogisticsState, LogisticsTile, OilWell, Refinery } from '../../../shared/logisticsTypes.js';

const FACTION = 'faction-a';
const TILES: LogisticsTile[] = [
  { index: 0, neighbours: [1], terrainType: 'plains', height: 0, forested: false },
  { index: 1, neighbours: [0], terrainType: 'plains', height: 0, forested: false },
  { index: 2, neighbours: [], terrainType: 'plains', height: 0, forested: false },
];

function state(wells: OilWell[] = [], refineries: Refinery[] = [], hubs: DistributionHub[] = []): LogisticsState {
  return { wells, refineries, hubs, routes: [], transports: [], home: { [FACTION]: { factionId: FACTION, oil: 0, refinedProduct: 0 } }, tasks: [], clearedForests: [], bridges: [] };
}
function well(storedOil = 0): OilWell {
  return { id: 'well', ownerId: FACTION, tileIndex: 0, segment: 0, storedOil, hitPoints: 30, maxHitPoints: 30 };
}
function hub(tileIndex = 1, ownerId = FACTION, buffer = 0): DistributionHub {
  return { id: `hub-${tileIndex}-${ownerId}`, ownerId, tileIndex, segment: 0, buffer, routeIds: [], hitPoints: 30, maxHitPoints: 30 };
}

describe('adjacent logistics storage', () => {
  it('moves a newly extracted oil unit directly into adjacent same-faction storage', () => {
    const { logistics, events } = resolveLogisticsTurn(state([well()], [], [hub()]), TILES, FACTION);
    expect(logistics.wells[0].storedOil).toBe(0);
    expect(logistics.hubs[0].buffer).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'delivered', cargoType: 'oil', amount: 1 }));
  });

  it('moves up to five petrol per refinery segment into adjacent storage', () => {
    const refinery: Refinery = { id: 'refinery', ownerId: FACTION, tileIndex: 0, segments: [0], heldOil: 5, refinedProductAvailable: 0, hitPoints: 30, maxHitPoints: 30 };
    const { logistics, events } = resolveLogisticsTurn(state([], [refinery], [hub()]), TILES, FACTION);
    expect(logistics.refineries[0]).toMatchObject({ heldOil: 0, refinedProductAvailable: 0 });
    expect(logistics.hubs[0].buffer).toBe(5);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'delivered', cargoType: 'product', amount: 5 }));
  });

  it('retains source inventory when adjacent storage is full', () => {
    const { logistics, events } = resolveLogisticsTurn(state([well()], [], [hub(1, FACTION, 5)]), TILES, FACTION);
    expect(logistics.wells[0].storedOil).toBe(1);
    expect(logistics.hubs[0].buffer).toBe(5);
    expect(events.some((event) => event.kind === 'delivered')).toBe(false);
  });

  it('does not fill non-adjacent or enemy storage', () => {
    const { logistics } = resolveLogisticsTurn(state([well()], [], [hub(1, 'faction-b'), hub(2)]), TILES, FACTION);
    expect(logistics.wells[0].storedOil).toBe(1);
    expect(logistics.hubs.map((item) => item.buffer)).toEqual([0, 0]);
  });
});
