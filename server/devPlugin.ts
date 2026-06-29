/**
 * Vite dev server plugin — adds API routes that will eventually move to Lambda.
 */

import type { Plugin, ViteDevServer } from 'vite';

type RegenerateTiles = (seed: number) => unknown;
type HandleGenerate = (body: unknown) => { success: boolean };
type HandleCombat = (body: unknown) => { success: boolean };
type HandleAiTurn = (body: unknown) => { success: boolean };

export function apiPlugin(): Plugin {
  return {
    name: 'drone-domination-api',
    configureServer(server: ViteDevServer) {
      // Regenerate tiles from seed (used when loading compact saves)
      server.middlewares.use('/api/world-tiles', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { seed?: unknown };
        const { seed } = body;

        if (typeof seed !== 'number') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'seed (number) is required' }));
          return;
        }

        console.log('[DD][api] POST /api/world-tiles — regenerating from seed:', seed);
        const mod = await server.ssrLoadModule('/server/regenerate.ts') as {
          regenerateTiles: RegenerateTiles;
        };
        const result = mod.regenerateTiles(seed);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      });

      server.middlewares.use('/api/generate', async (req, res) => {
        if (req.method !== 'POST') {
          console.warn('[DD][api] Rejected %s /api/generate (405)', req.method);
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        console.log('[DD][api] POST /api/generate — reading body...');
        // Read body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        console.log('[DD][api] Request body:', JSON.stringify(body));

        // Dynamic import so it uses the latest TS via Vite's transform
        const mod = await server.ssrLoadModule('/server/generateApi.ts') as {
          handleGenerate: HandleGenerate;
        };
        const result = mod.handleGenerate(body);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = result.success ? 200 : 400;
        console.log('[DD][api] Response status:', res.statusCode);
        res.end(JSON.stringify(result));
      });

      server.middlewares.use('/api/combat', async (req, res) => {
        if (req.method !== 'POST') {
          console.warn('[DD][api] Rejected %s /api/combat (405)', req.method);
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        console.log('[DD][api] POST /api/combat — reading body...');
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { action?: unknown };
        console.log('[DD][api] Combat request action:', body.action);

        const mod = await server.ssrLoadModule('/server/combatApi.ts') as {
          handleCombat: HandleCombat;
        };
        const result = mod.handleCombat(body);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = result.success ? 200 : 400;
        console.log('[DD][api] Combat response success:', result.success);
        res.end(JSON.stringify(result));
      });

      // Resolve an entire AI faction turn server-side (server-authoritative,
      // Phase 1). Returns an ordered event log + final state for the client to
      // replay through the AI playback bar.
      server.middlewares.use('/api/ai-turn', async (req, res) => {
        if (req.method !== 'POST') {
          console.warn('[DD][api] Rejected %s /api/ai-turn (405)', req.method);
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { factionId?: unknown };
        console.log('[DD][api] POST /api/ai-turn — faction:', body.factionId);

        const mod = await server.ssrLoadModule('/server/aiTurnApi.ts') as {
          handleAiTurn: HandleAiTurn;
        };
        const result = mod.handleAiTurn(body);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = result.success ? 200 : 400;
        console.log('[DD][api] AI-turn response success:', result.success);
        res.end(JSON.stringify(result));
      });
    },
  };
}
