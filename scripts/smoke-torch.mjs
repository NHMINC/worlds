/* Headlamp check: stand at local midnight (Earthlike) and under hothouse
 * gloom at noon — both should fade the torch in; a daylight shot must not.
 * Usage: node scripts/smoke-torch.mjs */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

async function goLand(seed, bodyId) {
  await page.click('button[title="Star systems"]');
  await page.waitForSelector('.modal');
  await page.locator('.seed-row input').fill(seed);
  await page.waitForTimeout(300);
  await page.click('button:has-text("Create system")');
  await page.waitForTimeout(4000);
  await page.evaluate((id) => window.__engine.travelTo(id), bodyId);
  await page.waitForTimeout(6000);
  await page.click('button[title="Land — set down and glide over the terrain"]');
  await page.waitForTimeout(2500);
}

/** Stand at offsetDeg from the substellar point (0 = noon, 180 = midnight),
 * facing the sun's azimuth, pitched a touch down. */
async function standAt(offsetDeg, pitch, file) {
  await page.evaluate(({ offsetDeg, pitch }) => {
    const e = window.__engine;
    const rt = e['bodies'].get(e['orbitBodyId']);
    const qInv = rt.spinQ.clone().conjugate();
    const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
    const pole = sunL.clone().set(-sunL.y, sunL.x, 0).normalize();
    const dir = sunL.clone().applyAxisAngle(pole, (offsetDeg * Math.PI) / 180).normalize();
    e['sDir'].copy(dir);
    e['sYaw'] = 0.8;
    e['sPitch'] = pitch;
    e['sEyeH'] = e['sEyeHTarget'] = 0.014;
  }, { offsetDeg, pitch });
  await page.waitForTimeout(2500); // let the torch ease in
  await page.screenshot({ path: `previews/${file}` });
}

await goLand('dusk-0', 'p4'); // Earthlike
await standAt(170, -0.25, 'torch-1-midnight.png');
await standAt(20, -0.25, 'torch-2-daylight.png');

await goLand('dusk-2', 'p0'); // deep hothouse
await standAt(0, -0.2, 'torch-3-gloom-noon.png');
await page.evaluate(() => {
  const e = window.__engine;
  e['sPitch'] = -0.85;
  e['sEyeH'] = e['sEyeHTarget'] = 0.007;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'previews/torch-4-gloom-feet.png' });
await browser.close();
