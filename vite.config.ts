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
  },
});
