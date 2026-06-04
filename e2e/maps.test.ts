import { test, expect } from '@playwright/test';

test('both maps render correctly on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');

  // Loading overlay should disappear once both views are initialised
  await expect(page.locator('#loading')).toBeHidden({ timeout: 25_000 });

  // ── Globe (left panel) ──────────────────────────────────────────────
  const globeCanvas = page.locator('#globe-canvas');
  await expect(globeCanvas).toBeVisible();

  const globeSize = await globeCanvas.evaluate((el: HTMLCanvasElement) => ({
    width: el.width,
    height: el.height,
  }));
  expect(globeSize.width, 'globe canvas width should be > 0').toBeGreaterThan(0);
  expect(globeSize.height, 'globe canvas height should be > 0').toBeGreaterThan(0);

  // Globe panel should occupy roughly half the viewport
  const globePanelBox = await page.locator('#globe-panel').boundingBox();
  expect(globePanelBox, 'globe panel should be in the DOM').not.toBeNull();
  expect(globePanelBox!.width, 'globe panel should be at least 400px wide').toBeGreaterThan(400);

  // ── Local map (right panel) ─────────────────────────────────────────
  const localCanvas = page.locator('#local-canvas');
  await expect(localCanvas).toBeVisible();

  const localSize = await localCanvas.evaluate((el: HTMLCanvasElement) => ({
    width: el.width,
    height: el.height,
  }));
  expect(localSize.width, 'local canvas width should be > 0').toBeGreaterThan(0);
  expect(localSize.height, 'local canvas height should be > 0').toBeGreaterThan(0);

  const localPanelBox = await page.locator('#local-panel').boundingBox();
  expect(localPanelBox, 'local panel should be in the DOM').not.toBeNull();
  expect(localPanelBox!.width, 'local panel should be at least 400px wide').toBeGreaterThan(400);

  // ── No JS errors ────────────────────────────────────────────────────
  expect(errors, 'no uncaught JS errors during load').toHaveLength(0);
});
