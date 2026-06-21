import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-webgl','--use-gl=swiftshader','--ignore-gpu-blocklist','--disable-gpu-sandbox']
});
const page = await browser.newPage();
await page.goto('http://localhost:3000/?debug=true');
await page.waitForSelector('#loading', { state: 'hidden', timeout: 25000 });
console.log('Page loaded');

await page.click('#next-turn-btn');
console.log('Clicked next-turn-btn');

await new Promise(r => setTimeout(r, 500));

const confirmBtn = await page.$('#confirm-end');
console.log('confirm-end in DOM:', !!confirmBtn);

if (confirmBtn) {
  const box = await confirmBtn.boundingBox();
  console.log('confirm-end boundingBox:', JSON.stringify(box));
  const isVisible = await confirmBtn.isVisible();
  console.log('confirm-end isVisible:', isVisible);
  const isEnabled = await confirmBtn.isEnabled();
  console.log('confirm-end isEnabled:', isEnabled);

  // Check what element is at the button's center coordinates
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const hitEl = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? { tag: el.tagName, id: el.id, className: el.className } : null;
    }, [cx, cy]);
    console.log('Element at button center:', JSON.stringify(hitEl));

    // Check bounding box stability over 300ms
    const box2 = await confirmBtn.boundingBox();
    await new Promise(r => setTimeout(r, 300));
    const box3 = await confirmBtn.boundingBox();
    console.log('box2:', JSON.stringify(box2));
    console.log('box3 (300ms later):', JSON.stringify(box3));
    console.log('box changed:', JSON.stringify(box2) !== JSON.stringify(box3));
  }

  // Try clicking it
  try {
    await confirmBtn.click({ timeout: 3000 });
    console.log('click succeeded');
  } catch (e) {
    console.log('click failed:', e.message);
  }
}

await browser.close();
