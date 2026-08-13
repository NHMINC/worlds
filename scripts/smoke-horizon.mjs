/* Horizon inspection: close crops of the limb from orbit and the horizon
 * line from the ground, to hunt a reported black band.
 * Run: node scripts/smoke-horizon.mjs (dev server must be on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('smoke-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);

// Full frame plus tight crops of the left (day) and right limb.
await page.screenshot({ path: 'previews/horizon-0-orbit.png' });
await page.screenshot({ path: 'previews/horizon-1-limb-left.png', clip: { x: 100, y: 250, width: 300, height: 300 } });
await page.screenshot({ path: 'previews/horizon-2-limb-right.png', clip: { x: 850, y: 250, width: 300, height: 300 } });

// Land at noon and look at the horizon.
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const e = window.__engine;
  const rt = e['bodies'].get(e['orbitBodyId']);
  const qInv = rt.spinQ.clone().conjugate();
  const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
  e['sDir'].copy(sunL);
  e['sYaw'] = 2.0;
  e['sPitch'] = 0.0;
  e['sEyeH'] = e['sEyeHTarget'] = 0.05;
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'previews/horizon-3-ground.png' });
// Slightly higher hover for a wider view of the horizon line.
await page.evaluate(() => {
  const e = window.__engine;
  e['sEyeH'] = e['sEyeHTarget'] = 0.15;
  e['sPitch'] = -0.05;
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'previews/horizon-4-high.png' });

// Deep dusk: stand past the terminator and look along the horizon — the
// spot where extinction with no sunlit in-scatter used to leave a void.
await page.evaluate(() => {
  const e = window.__engine;
  const rt = e['bodies'].get(e['orbitBodyId']);
  const qInv = rt.spinQ.clone().conjugate();
  const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
  const pole = sunL.clone().set(-sunL.y, sunL.x, 0).normalize();
  const dir = sunL.clone().applyAxisAngle(pole, (110 * Math.PI) / 180).normalize();
  e['sDir'].copy(dir);
  const east = dir.clone().set(-dir.y, dir.x, 0).normalize();
  const north = dir.clone().crossVectors(dir, east);
  const t = sunL.clone().addScaledVector(dir, -sunL.dot(dir));
  e['sYaw'] = Math.atan2(t.dot(east), t.dot(north));
  e['sPitch'] = 0.05;
  e['sEyeH'] = e['sEyeHTarget'] = 0.05;
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'previews/horizon-5-dusk.png' });

await browser.close();
