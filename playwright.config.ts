import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
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
});
