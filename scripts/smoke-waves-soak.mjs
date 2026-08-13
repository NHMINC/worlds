/* Wave soak test: the moiré bug (spatially varying frequency x absolute
 * time) only shows after minutes, so hold one coastal view and compare an
 * early frame against one taken ~6 minutes later. Densifying rings = fail.
 * Run: node scripts/smoke-waves-soak.mjs (dev server must be on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGE ERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
});

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('smoke-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate(() => {
  const v = window.__engine.getView();
  window.__engine.setOverrides(v.bodyId, { temp: 0.95 });
  window.__engine.viewLetterbox();
});
await page.waitForTimeout(4000);

const c = page.locator('canvas');
await c.hover({ position: { x: 430, y: 300 } });
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(150);
}
await page.waitForTimeout(8000);
await page.screenshot({ path: 'previews/soak-0-early.png' });
console.log('early frame taken; soaking...');

await page.waitForTimeout(6 * 60 * 1000);
await page.screenshot({ path: 'previews/soak-1-late.png' });
console.log('late frame taken');

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page/shader errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
