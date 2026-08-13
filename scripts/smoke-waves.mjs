/* Wave smoke test: shoaling surf on the home world's day-side coast (two
 * frames apart in time so crest motion shows in the diff), still shores on
 * a frozen world, an airless glassy moon, and no shader errors anywhere.
 * Run: node scripts/smoke-waves.mjs (dev server must be on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGE ERROR: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || /shader|glsl/i.test(m.text())) errors.push(`CONSOLE: ${m.text()}`);
});

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

// Fresh system: smoke-0.
await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('smoke-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);

// Geostationary orbit over the home world: the ground holds still under the
// camera, so any pixel change between the timed frames is the WAVES moving.
const home = await page.evaluate(() => {
  const v = window.__engine.getView();
  window.__engine.enterOrbit(v.bodyId, 'geo');
  // Warm the world well past the freeze point: every shore must run liquid
  // so the wave model (not the frozen gate) is what we photograph.
  window.__engine.setOverrides(v.bodyId, { temp: 0.95 });
  return v.bodyId;
});
console.log('home body:', home);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);
await page.screenshot({ path: 'previews/waves-0-home-orbit.png' });

// Zoom in a moderate amount, anchored on an equatorial coastline: surf
// bands along the shore, still day side.
const c = page.locator('canvas');
await c.hover({ position: { x: 430, y: 300 } });
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(150);
}
await page.waitForTimeout(8000); // tier build + orbit inertia settles
await page.screenshot({ path: 'previews/waves-1-shore-t0.png' });
await page.waitForTimeout(1500); // ~a wave period: crests must have marched
await page.screenshot({ path: 'previews/waves-2-shore-t1.png' });

// Land: the surface rig rides the spinning frame, so the ground holds
// still and any change between the timed frames is the water moving.
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(3000);
// Glide until the mood says we've reached the sea: the burst then frames a
// shoreline (we stop right as the coast passes underneath).
await page.keyboard.down('KeyW');
let reached = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(700);
  const mood = await page.evaluate(() => window.__engine.getMood().group);
  if (mood === 'water') {
    reached = true;
    break;
  }
}
await page.keyboard.up('KeyW');
console.log('reached water:', reached);
await page.waitForTimeout(1200);
for (let i = 0; i < 4; i++) {
  await page.screenshot({ path: `previews/waves-5-surface-t${i}.png` });
  await page.waitForTimeout(1100);
}
await page.evaluate(() => window.__engine.takeOff());
await page.waitForTimeout(2000);

// Frozen world (p3, iceball with a moon): surf gate must hold shores still.
await page.evaluate(() => window.__engine.enterOrbit('p3', 'geo'));
await page.waitForTimeout(1000);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);
await page.screenshot({ path: 'previews/waves-3-iceball.png' });

// Airless dry-ice moon (p3m0): zero wind — glassy, mirror-still.
await page.evaluate(() => window.__engine.enterOrbit('p3m0', 'geo'));
await page.waitForTimeout(1000);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);
await page.screenshot({ path: 'previews/waves-4-airless.png' });

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page/shader errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
