/* Visual smoke pass across emergent regimes: creates systems from searched
 * seeds, orbits each target body, and screenshots it into previews/.
 * Run: node scripts/smoke-regimes.mjs (dev server must be on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const TARGETS = [
  { regime: 'living-world', seed: 'smoke-3', body: 'p2' },
  { regime: 'hothouse', seed: 'smoke-0', body: 'p1' },
  { regime: 'gas-giant', seed: 'smoke-0', body: 'p2' },
  { regime: 'titan-moon', seed: 'smoke-0', body: 'p2m0' },
  { regime: 'iceball', seed: 'smoke-0', body: 'p3' },
  { regime: 'methane-world', seed: 'smoke-4', body: 'p6' },
  { regime: 'eyeball-world', seed: 'smoke-9', body: 'p0' },
  { regime: 'airless-rock', seed: 'smoke-2', body: 'p1m0' },
  { regime: 'frozen-methane-world', seed: 'smoke-27', body: 'p10m0' },
  { regime: 'dry-ice-world', seed: 'smoke-0', body: 'p3m0' },
  { regime: 'nitrogen-iceball', seed: 'smoke-50', body: 'p5m0' },
  { regime: 'warm-giant', seed: 'smoke-2', body: 'p0' },
  { regime: 'scorched-giant', seed: 'smoke-8', body: 'p0' },
  // The clear-skied one: its parent planet is also carbon, but hazed over.
  { regime: 'carbon-world', seed: 'smoke-1', body: 'p2m0' },
];

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

let currentSeed = null;

async function openSeed(seed) {
  if (currentSeed === seed) return;
  await page.click('button[title="Star systems"]');
  await page.waitForSelector('.modal');
  const seedInput = page.locator('.seed-row input');
  await seedInput.fill(seed);
  await page.waitForTimeout(300);
  await page.click('button:has-text("Create system")');
  await page.waitForTimeout(4000); // home tier build
  currentSeed = seed;
}

for (const t of TARGETS) {
  await openSeed(t.seed);
  // Fly to the target body and let the LOD build.
  await page.evaluate((bodyId) => {
    const eng = window.__engine;
    eng.depart();
    eng.enterOrbit(bodyId);
  }, t.body);
  await page.waitForTimeout(2200); // capture blend
  await page.evaluate(() => window.__engine.viewLetterbox());
  await page.waitForTimeout(5000); // zoom + tier2 build
  const shot = `previews/regime-${t.regime}.png`;
  await page.screenshot({ path: shot });
  const view = await page.evaluate(() => window.__engine.getView());
  console.log(`${t.regime}: orbiting ${view.bodyName} (${view.bodyId}) -> ${shot}`);
  if (view.bodyId !== t.body) console.error(`  WRONG BODY: wanted ${t.body}`);
}

// A wide system shot for orbit lines (eccentric, inclined ellipses).
await page.evaluate(() => {
  const eng = window.__engine;
  eng.depart();
});
await page.waitForTimeout(500);
// Throttle back to drift outward for a wider view.
await page.evaluate(() => {
  window.__engine.enterOrbit; // no-op keep reference
});
await page.screenshot({ path: 'previews/regime-system-wide.png' });
console.log('system-wide -> previews/regime-system-wide.png');

await browser.close();
