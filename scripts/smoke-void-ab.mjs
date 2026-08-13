/* Same-frame A/B of the sky shell floor radius: old unit-sphere hand-off
 * (punches the landform-shaped void) vs bedrock hand-off (fixed).
 * Usage: node scripts/smoke-void-ab.mjs [seed] [bodyId] */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const seed = process.argv[2] ?? 'dusk-2';
const bodyId = process.argv[3] ?? 'p0';
mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill(seed);
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate((id) => window.__engine.travelTo(id), bodyId);
await page.waitForTimeout(7000);
await page.click('button[title="Fill height (globe spans the screen)"]');
await page.waitForTimeout(1500);
await page.mouse.wheel(0, 700);
await page.waitForTimeout(1500);

async function setFloor(r) {
  await page.evaluate(
    ({ id, r }) => {
      const rt = window.__engine['bodies'].get(id);
      for (const t of [rt.tier1, rt.tier2]) {
        if (t?.atmoMat) t.atmoMat.uniforms.uFloorR.value = r;
      }
    },
    { id: bodyId, r },
  );
  await page.waitForTimeout(400);
}

const floor = await page.evaluate(
  (id) => window.__engine['bodies'].get(id).tier2.atmoMat.uniforms.uFloorR.value,
  bodyId,
);
console.log('bedrock floorR =', floor);

await setFloor(1.0);
await page.screenshot({ path: 'previews/voidab-1-old.png' });
await setFloor(floor);
await page.screenshot({ path: 'previews/voidab-2-fixed.png' });
await browser.close();
