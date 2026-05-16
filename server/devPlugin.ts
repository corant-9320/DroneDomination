/**
 * Vite dev server plugin — adds API routes that will eventually move to Lambda.
 */

import type { Plugin, ViteDevServer } from 'vite';

export function apiPlugin(): Plugin {
  return {
    name: 'drone-domination-api',
    configureServer(server: ViteDevServer) {
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
        const body = JSON.parse(Buffer.concat(chunks).toString());
        console.log('[DD][api] Request body:', JSON.stringify(body));

        // Dynamic import so it uses the latest TS via Vite's transform
        const { handleGenerate } = await server.ssrLoadModule('/server/generate.ts');
        const result = (handleGenerate as Function)(body);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = result.success ? 200 : 400;
        console.log('[DD][api] Response status:', res.statusCode);
        res.end(JSON.stringify(result));
      });
    },
  };
}
