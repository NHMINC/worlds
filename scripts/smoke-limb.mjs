/* Reproduce the black limb ring: pick a cool world with air, put the sun
 * directly behind the camera (fully lit disc), crop the limb.
 * Usage: node scripts/smoke-limb.mjs [seed] */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const seed = process.argv[2] ?? 'smoke-0';
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

// Survey the system: rocky bodies with air, coldest-first.
const bodies = await page.evaluate(() => {
  const e = window.__engine;
  const out = [];
  for (const [id, rt] of e['bodies']) {
    if (rt.spec.kind !== 'rocky' || !rt.phys) continue;
    out.push({
      id,
      name: rt.spec.name,
      temp: rt.phys.temp01,
      pressure: rt.phys.atmosphere.pressure,
      hydro: rt.phys.hydrosphere.state,
      size: rt.spec.size,
    });
  }
  return out;
});
console.log(JSON.stringify(bodies, null, 1));

const pick = bodies
  .filter((b) => b.pressure > 0.2 && b.hydro !== 'none')
  .sort((a, b) => a.temp - b.temp)[0];
if (!pick) {
  console.log('no suitable world in this system');
  await browser.close();
  process.exit(0);
}
console.log('PICK:', pick.name, pick.id);

await page.evaluate((id) => window.__engine.travelTo(id), pick.id);
await page.waitForTimeout(6000);

// Land, move to the substellar point, take off: orbit camera now sits on
// the sun-planet line and the whole disc is lit — limb = terminator ring.
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const e = window.__engine;
  const rt = e['bodies'].get(e['orbitBodyId']);
  const qInv = rt.spinQ.clone().conjugate();
  const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
  e['sDir'].copy(sunL);
});
await page.waitForTimeout(500);
await page.click('button[title="Take off — rise back into orbit"]');
await page.waitForTimeout(3500);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4500);

await page.screenshot({ path: 'previews/limb-0-full.png' });
await page.screenshot({ path: 'previews/limb-1-topleft.png', clip: { x: 260, y: 60, width: 360, height: 300 } });
await page.screenshot({ path: 'previews/limb-2-right.png', clip: { x: 780, y: 250, width: 340, height: 300 } });
await browser.close();
