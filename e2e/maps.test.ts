/**
 * Smoke test: the game shell loads and both canvases render.
 *
 * This test does NOT use ?debug=true — it validates a plain production load.
 * Requires: npm run dev running on port 3000.
 */

import { test, expect } from '@playwright/test';

test.describe('Game shell — initial render', () => {
  test('Globe and local-map panels render with non-zero canvas dimensions and no JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await expect(page.locator('#loading'), 'loading overlay disappears once both views are initialised').toBeHidden({ timeout: 25_000 });

    // Globe (left panel)
    const globeCanvas = page.locator('#globe-canvas');
    await expect(globeCanvas, 'globe canvas is visible').toBeVisible();

    const globeSize = await globeCanvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
    expect(globeSize.width, 'globe canvas width > 0').toBeGreaterThan(0);
    expect(globeSize.height, 'globe canvas height > 0').toBeGreaterThan(0);

    const globePanelBox = await page.locator('#globe-panel').boundingBox();
    expect(globePanelBox, 'globe panel is in the DOM').not.toBeNull();
    expect(globePanelBox!.width, 'globe panel is at least 400 px wide').toBeGreaterThan(400);

    // Local map (right panel)
    const localCanvas = page.locator('#local-canvas');
    await expect(localCanvas, 'local-map canvas is visible').toBeVisible();

    const localSize = await localCanvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
    expect(localSize.width, 'local-map canvas width > 0').toBeGreaterThan(0);
    expect(localSize.height, 'local-map canvas height > 0').toBeGreaterThan(0);

    const localPanelBox = await page.locator('#local-panel').boundingBox();
    expect(localPanelBox, 'local-map panel is in the DOM').not.toBeNull();
    expect(localPanelBox!.width, 'local-map panel is at least 400 px wide').toBeGreaterThan(400);

    // No JS errors
    expect(errors, 'no uncaught JS errors during load').toHaveLength(0);
  });
});
