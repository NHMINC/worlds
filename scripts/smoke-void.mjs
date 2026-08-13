/* Limb void check: orbit shots of a dry hothouse (worst case — no sea
 * sphere, full bedrock depth exposed) and a sea world (hairline case).
 * Usage: node scripts/smoke-void.mjs */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

async function orbitShot(seed, bodyId, file) {
  await page.click('button[title="Star systems"]');
  await page.waitForSelector('.modal');
  await page.locator('.seed-row input').fill(seed);
  await page.waitForTimeout(300);
  await page.click('button:has-text("Create system")');
  await page.waitForTimeout(4000);
  await page.evaluate((id) => window.__engine.travelTo(id), bodyId);
  await page.waitForTimeout(7000);
  // Frame the whole planet with space around it, like the bug report.
  await page.click('button[title="Fill height (globe spans the screen)"]');
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `previews/${file}` });
}

await orbitShot('dusk-2', 'p0', 'void-1-hothouse.png');
await orbitShot('dusk-0', 'p4', 'void-2-seaworld.png');
await browser.close();
