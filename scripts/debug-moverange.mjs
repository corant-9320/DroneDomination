/**
 * DEBUG MOVERANGE — probe the movement-range Dijkstra for directional bias.
 *
 * Loads the running dev server headless, finds player units that still have MP,
 * and for each prints which of its 6 hex-neighbours are reachable + the cost,
 * plus the unit's segment/facing. Helps diagnose "blue line only draws one way".
 *
 * Prereq: dev server running on :3000.  Usage: node scripts/debug-moverange.mjs
 */

import { chromium } from '@playwright/test';

const URL = 'http://localhost:3000';
const WAIT = 30000;

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-webgl', '--use-gl=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: WAIT });
await page.locator('#loading').waitFor({ state: 'hidden', timeout: WAIT });

const result = await page.evaluate(() => {
  const dd = window.__DD_STATE__;
  if (!dd) return { error: 'no __DD_STATE__' };
  const s = dd.snapshot();
  const active = s.turn.activeFaction;
  const candidates = s.units.filter((u) => u.ownerId === active && u.mp > 0 && !u.acted);
  const reports = candidates.slice(0, 5).map((u) => dd.moveRange(u.id));
  return { active, total: candidates.length, reports };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
