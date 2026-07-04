import { describe, it, expect } from 'vitest';
import type { ViteDevServer } from 'vite';
import { apiPlugin } from '../devPlugin.js';

/**
 * Smoke coverage for `server/devPlugin.ts` (previously 0%).
 *
 * This is a single wiring check, not branch-chasing: we confirm the plugin
 * exposes the expected shape and that `configureServer` registers the API
 * routes onto the dev server's middleware stack. The per-route request/response
 * handling is exercised through the dedicated API handler tests
 * (generateApi/combatApi/etc.), not here. No mocks of code-under-test — only a
 * minimal fake dev server stands in for the Vite boundary.
 */

function makeFakeServer(): { server: ViteDevServer; routes: string[] } {
  const routes: string[] = [];
  const server = {
    middlewares: {
      use: (path: string, _handler: unknown) => {
        routes.push(path);
      },
    },
    ssrLoadModule: async () => ({}),
  } as unknown as ViteDevServer;
  return { server, routes };
}

describe('apiPlugin — dev server wiring smoke test', () => {
  it('returns a named Vite plugin with a configureServer hook', () => {
    const plugin = apiPlugin();
    expect(plugin.name).toBe('drone-domination-api');
    expect(typeof plugin.configureServer).toBe('function');
  });

  it('registers the expected API routes on the middleware stack', () => {
    const plugin = apiPlugin();
    const { server, routes } = makeFakeServer();

    // configureServer can be a function or an object hook; this plugin uses a fn.
    const hook = plugin.configureServer;
    expect(typeof hook).toBe('function');
    (hook as (s: ViteDevServer) => void)(server);

    for (const route of [
      '/api/world-tiles',
      '/api/generate',
      '/api/combat',
      '/api/ai-turn',
      '/api/match/create',
      '/api/match/intent',
    ]) {
      expect(routes).toContain(route);
    }
  });
});
