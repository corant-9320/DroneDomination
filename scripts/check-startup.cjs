/**
 * Quick headless check: navigate to localhost:3000, wait 20s, report console errors and
 * whether #loading is still visible. Uses playwright's Node API directly.
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage();

  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      logs.push(`[${m.type()}] ${m.text()}`);
    }
  });

  console.log('Navigating to http://localhost:3000 ...');
  await page.goto('http://localhost:3000');

  console.log('Waiting 20s for app to initialise...');
  await page.waitForTimeout(20_000);

  const loadingVisible = await page.locator('#loading').isVisible();
  const loadingDisplay = await page.evaluate(() => {
    const el = document.getElementById('loading');
    if (!el) return 'NOT IN DOM';
    return window.getComputedStyle(el).display + ' / hidden=' + el.hidden;
  });

  console.log('\n=== Result ===');
  console.log('#loading visible:', loadingVisible);
  console.log('#loading style:', loadingDisplay);
  console.log('\nConsole errors/warnings:');
  logs.forEach(l => console.log(' ', l));
  console.log('\nPage errors:');
  errors.forEach(e => console.log(' ', e));

  await browser.close();
})();
