# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: maps.test.ts >> both maps render correctly on load
- Location: e2e\maps.test.ts:3:1

# Error details

```
Error: expect(locator).toBeHidden() failed

Locator:  locator('#loading')
Expected: hidden
Received: visible
Timeout:  25000ms

Call log:
  - Expect "toBeHidden" with timeout 25000ms
  - waiting for locator('#loading')
    5 × locator resolved to <div id="loading">…</div>
      - unexpected value "visible"

```

```yaml
- text: Drone Domination Initialising…
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test('both maps render correctly on load', async ({ page }) => {
  4  |   const errors: string[] = [];
  5  |   page.on('pageerror', (err) => errors.push(err.message));
  6  | 
  7  |   await page.goto('/');
  8  | 
  9  |   // Loading overlay should disappear once both views are initialised
> 10 |   await expect(page.locator('#loading')).toBeHidden({ timeout: 25_000 });
     |                                          ^ Error: expect(locator).toBeHidden() failed
  11 | 
  12 |   // ── Globe (left panel) ──────────────────────────────────────────────
  13 |   const globeCanvas = page.locator('#globe-canvas');
  14 |   await expect(globeCanvas).toBeVisible();
  15 | 
  16 |   const globeSize = await globeCanvas.evaluate((el: HTMLCanvasElement) => ({
  17 |     width: el.width,
  18 |     height: el.height,
  19 |   }));
  20 |   expect(globeSize.width, 'globe canvas width should be > 0').toBeGreaterThan(0);
  21 |   expect(globeSize.height, 'globe canvas height should be > 0').toBeGreaterThan(0);
  22 | 
  23 |   // Globe panel should occupy roughly half the viewport
  24 |   const globePanelBox = await page.locator('#globe-panel').boundingBox();
  25 |   expect(globePanelBox, 'globe panel should be in the DOM').not.toBeNull();
  26 |   expect(globePanelBox!.width, 'globe panel should be at least 400px wide').toBeGreaterThan(400);
  27 | 
  28 |   // ── Local map (right panel) ─────────────────────────────────────────
  29 |   const localCanvas = page.locator('#local-canvas');
  30 |   await expect(localCanvas).toBeVisible();
  31 | 
  32 |   const localSize = await localCanvas.evaluate((el: HTMLCanvasElement) => ({
  33 |     width: el.width,
  34 |     height: el.height,
  35 |   }));
  36 |   expect(localSize.width, 'local canvas width should be > 0').toBeGreaterThan(0);
  37 |   expect(localSize.height, 'local canvas height should be > 0').toBeGreaterThan(0);
  38 | 
  39 |   const localPanelBox = await page.locator('#local-panel').boundingBox();
  40 |   expect(localPanelBox, 'local panel should be in the DOM').not.toBeNull();
  41 |   expect(localPanelBox!.width, 'local panel should be at least 400px wide').toBeGreaterThan(400);
  42 | 
  43 |   // ── No JS errors ────────────────────────────────────────────────────
  44 |   expect(errors, 'no uncaught JS errors during load').toHaveLength(0);
  45 | });
  46 | 
```