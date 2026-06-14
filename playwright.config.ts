import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Run test files sequentially so they don't compete for the single dev server.
  // Tests within a file still run in the order they are declared.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    // Enable software WebGL so Three.js renderers (sprite pre-render + globe)
    // can create contexts in headless Chromium without GPU hardware.
    launchOptions: {
      args: [
        '--enable-webgl',
        '--use-gl=swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
      ],
    },
  },
  // Requires `npm run dev` to already be running on port 3000.
  // Run with extra heap: NODE_OPTIONS=--max-old-space-size=4096 npx playwright test
  // Auto-start the Vite dev server for the test run. If one is already running
  // on :3000 (e.g. you have `npm run dev` open), it is reused instead of spawned.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
