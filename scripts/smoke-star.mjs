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

await page.goto(`http://127.0.0.1:5173/?star=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => window.__engine && window.__engine['bodies']?.size > 0, {
  timeout: 20000,
});
await page.waitForTimeout(2500);

const boot = await page.evaluate(() => {
  const e = window.__engine;
  const star = e.system?.star;
  return {
    bodies: e['bodies']?.size ?? 0,
    mode: e.getView().mode,
    starR: star?.radius ?? 0,
    starL: star?.luminosity ?? 0,
    starColor: star?.color ?? '',
  };
});
console.log('BOOT', JSON.stringify(boot));

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
  await page.waitForTimeout(900);
}

// Habitable-zone look (A_HAB · SPACE_SCALE ≈ 900).
await lookAtSun(900, 40, 0);
await page.screenshot({ path: 'previews/star-1-hz.png' });

// Mid-range, slightly off-axis so the limb and granules can read.
await lookAtSun(160, 50, 90);
await page.screenshot({ path: 'previews/star-1b-mid.png' });

// Close approach — the wash should fill the view.
await lookAtSun(80, 20, 0);
await page.screenshot({ path: 'previews/star-2-close.png' });

// Outer system — a tight spike, not a pale marble.
await lookAtSun(3800, 80, 0);
await page.screenshot({ path: 'previews/star-3-outer.png' });

// From the ground, looking at the sun.
const home = await page.evaluate(() => {
  const e = window.__engine;
  const rocky = [...e['bodies'].values()].find((rt) => rt.spec.kind === 'rocky' && !rt.spec.parent);
  return rocky?.spec.id ?? null;
});
if (home) {
  await page.evaluate((id) => {
    const e = window.__engine;
    const rt = e['bodies'].get(id);
    if (e.getView().mode !== 'flight') e.depart();
    e.fPos.set(rt.pos.x, rt.pos.y + rt.spec.radius * 2.4, rt.pos.z);
    e.camera.position.copy(e.fPos);
    e.camera.lookAt(0, 0, 0);
    e.fQuat.copy(e.camera.quaternion);
    e.throttle = 0;
    e.speed = 0;
  }, home);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'previews/star-3b-planet.png' });

  await page.evaluate((id) => window.__engine.travelTo(id), home);
  await page.waitForTimeout(3500);
  const land = page.locator('button[title="Land — set down and glide over the terrain"]');
  console.log('LAND BTN', await land.count(), 'mode', await page.evaluate(() => window.__engine.getView().mode));
  if (await land.count()) {
    await land.click();
    await page.waitForTimeout(2500);
    console.log('LANDED', await page.evaluate(() => window.__engine.getView().mode));
    await page.evaluate(() => {
      const e = window.__engine;
      const rt = e['bodies'].get(e['orbitBodyId']);
      if (!rt) return;
      const qInv = rt.spinQ.clone().conjugate();
      const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
      e['sDir'].copy(sunL);
      e['sYaw'] = 0;
      e['sPitch'] = 1.52;
      e['sEyeH'] = e['sEyeHTarget'] = 0.05;
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: 'previews/star-4-ground.png' });
  }
}

console.log('smoke-star: wrote previews/star-*.png');
await browser.close();
