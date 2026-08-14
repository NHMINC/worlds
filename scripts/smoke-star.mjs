/* Star smoke: the sun is a furnace. From the void it must glare and
 * dim with inverse-square; from the ground it must punch through the
 * sky, not sit behind a filter. Run: node scripts/smoke-star.mjs
 * (dev server on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE:', m.text());
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

async function lookAtSun(x, y, z) {
  await page.evaluate(({ x, y, z }) => {
    const e = window.__engine;
    if (e.getView().mode !== 'flight') e.depart();
    e.fPos.set(x, y, z);
    e.camera.position.copy(e.fPos);
    e.camera.lookAt(0, 0, 0);
    e.fQuat.copy(e.camera.quaternion);
    e.throttle = 0;
    e.speed = 0;
  }, { x, y, z });
  await page.waitForTimeout(700);
}

// Habitable-zone look (A_HAB · SPACE_SCALE ≈ 900).
await lookAtSun(900, 40, 0);
await page.screenshot({ path: 'previews/star-1-hz.png' });

// Close approach — the wash should fill the view.
await lookAtSun(80, 20, 0);
await page.screenshot({ path: 'previews/star-2-close.png' });

// Outer system — a tight spike, not a pale marble.
await lookAtSun(3800, 80, 0);
await page.screenshot({ path: 'previews/star-3-outer.png' });

// From the ground, noon, looking at the sun.
await page.evaluate(() => window.__engine.travelTo('p3'));
await page.waitForTimeout(2500);
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const e = window.__engine;
  const rt = e['bodies'].get(e['orbitBodyId']);
  const qInv = rt.spinQ.clone().conjugate();
  const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
  e['sDir'].copy(sunL);
  e['sYaw'] = 0;
  e['sPitch'] = 1.15;
  e['sEyeH'] = e['sEyeHTarget'] = 0.05;
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'previews/star-4-ground.png' });

console.log('smoke-star: wrote previews/star-*.png');
await browser.close();
