/**
 * Barrel — Oil Logistics System pure engine.
 *
 * Re-exports every symbol from the split logistics modules, so `src/world/index.ts`
 * and any importer that needs several of them at once has one place to reach for.
 * Prefer importing the owning module directly when you only need one or two
 * symbols — it takes the next reader straight to the implementation. See the
 * individual modules for documentation:
 *
 *   - tasks.ts              Engineer task lifecycle (Req 2, 9, 10)
 *   - placement.ts          Placement validators (Req 2, 4, 12)
 *   - production.ts         Extraction, refining, economy (Req 3, 4, 5, 6.9)
 *   - routes.ts             Route capacity/travel-time/creation/validation (Req 6, 7, 9, 10)
 *   - transport.ts          Transport lifecycle (Req 6, 8, 14)
 *   - hubs.ts               Distribution hubs (Req 11)
 *   - combatIntegration.ts  Structure combat integration (Req 12)
 *   - shuttle.ts            Point-to-point auto-patrol shuttle transports
 *   - turn.ts               Per-turn orchestrator: resolveLogisticsTurn (Req 3–12)
 *
 * Named exports only — no default export. All imports use the `.js` extension.
 */

export * from './tasks.js';
export * from './placement.js';
export * from './production.js';
export * from './routes.js';
export * from './transport.js';
export * from './hubs.js';
export * from './combatIntegration.js';
export * from './shuttle.js';
export * from './turn.js';
