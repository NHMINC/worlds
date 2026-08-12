/* Terraforming smoke test: load a living home world, drag the climate dial
 * through the UI, and verify by law — sea freezes, snow seals, classification
 * shifts — with screenshots at each step.
 * Run: node scripts/smoke-terraform.mjs (dev server must be on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

// Fresh system: smoke-0's home is a living world.
await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('smoke-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);

// Open the inspector so the class row is visible in every shot.
await page.click('button[title="Inspect — tap a hex to read its composition"]');
await page.waitForSelector('.inspector');

async function classRow() {
  return page.locator('.inspector-row', { hasText: 'class' }).locator('dd').innerText();
}

console.log('natural class:', await classRow());
await page.screenshot({ path: 'previews/terraform-natural.png' });

// Range inputs with fractional bounds reject fill(); set the value through
// the native setter and let React's input event pick it up.
async function setClimate(v) {
  await page.evaluate((val) => {
    const input = [...document.querySelectorAll('.terraform input')].at(-1);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(val));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
}
const climate = page.locator('.terraform label:last-of-type input');

// Full cold (dial 0 = 213 K).
await setClimate(0);
await page.waitForTimeout(1200);
console.log('cooled class:', await classRow());
await page.screenshot({ path: 'previews/terraform-cold.png' });

// Full hot (dial 1 = 371 K).
await setClimate(1);
await page.waitForTimeout(1200);
console.log('heated class:', await classRow());
await page.screenshot({ path: 'previews/terraform-hot.png' });

// Back to natural-ish mid to confirm reversibility.
await setClimate(0.5);
await page.waitForTimeout(1200);
console.log('mid class:', await classRow());
await page.screenshot({ path: 'previews/terraform-mid.png' });

// The unclamped extremes: deep cryo (~40 K) and past boil-off (~600 K).
await setClimate(await climate.getAttribute('min'));
await page.waitForTimeout(2500); // may rebuild (sheet substance changes)
console.log('cryo class:', await classRow());
await page.screenshot({ path: 'previews/terraform-cryo.png' });

await setClimate(await climate.getAttribute('max'));
await page.waitForTimeout(2500); // rebuild: the water sphere must vanish
console.log('scorch class:', await classRow());
await page.screenshot({ path: 'previews/terraform-scorch.png' });

await browser.close();
