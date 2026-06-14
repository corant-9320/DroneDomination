/**
 * DEBUG SNAPSHOT — headless capture of the running game for AI agents.
 *
 * Loads the game in headless Chromium, then writes everything an agent needs
 * to diagnose a problem *without a human sending screenshots*:
 *
 *   artifacts/sessions/<timestamp>/
 *     screenshot.png   — full-page render
 *     state.json       — window.__DD_STATE__.snapshot() (turn, units, selection)
 *     console.log      — every browser console message (with type)
 *     errors.json      — uncaught page errors + captured runtime errors
 *     summary.md       — human/agent-readable digest (read this first)
 *
 * Prerequisite: the dev server must be running (`npm run dev`) on :3000.
 *
 * Usage:
 *   node scripts/debug-snapshot.mjs
 *   node scripts/debug-snapshot.mjs --url http://localhost:3000 --turns 2
 *   node scripts/debug-snapshot.mjs --wait 30000
 *
 * Flags:
 *   --url <url>     base URL to load            (default http://localhost:3000)
 *   --turns <n>     press End-Turn n times      (default 0)
 *   --wait <ms>     max wait for load overlay    (default 30000)
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL = arg('url', 'http://localhost:3000');
const TURNS = parseInt(arg('turns', '0'), 10);
const WAIT = parseInt(arg('wait', '30000'), 10);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join('artifacts', 'sessions', stamp);
mkdirSync(outDir, { recursive: true });

const consoleLines = [];
const pageErrors = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-webgl', '--use-gl=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage();

page.on('console', (msg) => {
  consoleLines.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => {
  pageErrors.push({ message: err.message, stack: err.stack });
});

let loadOk = true;
let loadError = null;

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: WAIT });
  // Loading overlay hides once both views initialise.
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: WAIT });
} catch (err) {
  loadOk = false;
  loadError = String(err);
}

// Optionally advance turns (Space = End Turn) so we can capture later state.
for (let i = 0; i < TURNS && loadOk; i++) {
  try {
    await page.keyboard.press('Space');
    await page.waitForTimeout(2000);
  } catch {
    /* ignore — best effort */
  }
}

// Pull the in-page snapshot.
let state = null;
try {
  state = await page.evaluate(() => {
    const dd = window.__DD_STATE__;
    return dd && typeof dd.snapshot === 'function' ? dd.snapshot() : null;
  });
} catch (err) {
  pageErrors.push({ message: `Failed to read __DD_STATE__: ${err}`, stack: undefined });
}

await page.screenshot({ path: join(outDir, 'screenshot.png'), fullPage: true }).catch(() => {});

await browser.close();

// ── Write artefacts ────────────────────────────────────────────────────────
writeFileSync(join(outDir, 'console.log'), consoleLines.join('\n') + '\n');
writeFileSync(
  join(outDir, 'errors.json'),
  JSON.stringify({ pageErrors, runtimeErrors: state?.errors ?? [] }, null, 2),
);
writeFileSync(join(outDir, 'state.json'), JSON.stringify(state, null, 2));

const errorCount = pageErrors.length + (state?.errors?.length ?? 0);
const summary = [
  `# Debug Snapshot — ${stamp}`,
  '',
  `- URL: ${URL}`,
  `- Load: ${loadOk ? 'OK' : 'FAILED'}${loadError ? ` (${loadError})` : ''}`,
  `- Turns advanced: ${TURNS}`,
  `- Errors: ${errorCount}`,
  '',
  '## Turn',
  state
    ? `- Turn ${state.turn.number}, active=${state.turn.activeFaction}, playerTurn=${state.turn.isPlayerTurn}`
    : '- (no state — __DD_STATE__ unavailable)',
  '',
  '## Counts',
  state
    ? `- tiles=${state.counts.tiles}, cities=${state.counts.cities}, units=${state.counts.units}\n- byFaction=${JSON.stringify(state.counts.unitsByFaction)}`
    : '- (none)',
  '',
  '## Selection',
  state
    ? `- selectedTile=${state.selection.selectedTile}, segment=${state.selection.selectedSegment}, units=${JSON.stringify(state.selection.selectedUnitIds)}, centre=${state.selection.centreTile}`
    : '- (none)',
  '',
  '## Errors',
  errorCount === 0 ? '- none' : '- see errors.json',
  ...pageErrors.slice(0, 10).map((e) => `  - ${e.message}`),
  '',
  '## Console (last 20 lines)',
  '```',
  ...consoleLines.slice(-20),
  '```',
  '',
].join('\n');
writeFileSync(join(outDir, 'summary.md'), summary);

console.log(`Snapshot written to ${outDir}`);
console.log(`  Load: ${loadOk ? 'OK' : 'FAILED'} | Errors: ${errorCount} | Units: ${state?.counts?.units ?? '?'}`);
if (!loadOk) {
  console.log('  Hint: is the dev server running? Start it with `npm run dev`.');
  process.exitCode = 1;
}
