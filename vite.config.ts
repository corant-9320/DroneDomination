import { defineConfig } from 'vite';
import { apiPlugin } from './server/devPlugin.js';

export default defineConfig({
  root: '.',
  publicDir: 'data',
  server: {
    port: 3000,
    open: true,
  },
  plugins: [apiPlugin()],
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Coverage tracks testable logic. Client is 3D/DOM-heavy (e2e/snapshot territory).
      include: ['src/**', 'shared/**', 'server/**'],
      exclude: ['client/**', '**/*.d.ts', 'src/**/index.ts'],
      // Report-only for now — no thresholds. Add gates once a baseline is known.
    },
  },
});
