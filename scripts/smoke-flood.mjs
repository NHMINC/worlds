/* The flood test: raise the sea level very high so scattered islands remain,
 * hover over a coast, and sweep the horizon (including up-sun). The water
 * must read solid everywhere — its opacity is the column's, never the
 * backdrop's, so open sea against bright sky may not wash out. */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('dusk-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);
await page.evaluate(() => window.__engine.travelTo('p4'));
await page.waitForTimeout(6000);
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);

// Flood the world, then wait for the terrain rebuild.
await page.evaluate(() => window.__engine.setOverrides('p4', { seaLevel: 0.92 }));
await page.waitForTimeout(6000);

// Stand on a daylit island shore: land at the eye, sea ahead.
await page.evaluate(() => {
  const e = window.__engine;
  const rt = e['bodies'].get(e['orbitBodyId']);
  const qInv = rt.spinQ.clone().conjugate();
  const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
  const grid = rt.grid;
  const levels = rt.levels;
  let best = -1;
  let bestScore = -1e9;
  for (let i = 0; i < grid.count; i++) {
    const cx = grid.centers[i * 3];
    const cy = grid.centers[i * 3 + 1];
    const cz = grid.centers[i * 3 + 2];
    const day = cx * sunL.x + cy * sunL.y + cz * sunL.z;
    if (day < 0.5) continue;
    if (levels[i] <= rt.waterLevel + 1) continue; // must be dry land
    // Prefer land whose wider neighborhood is mostly sea (a small island).
    let sea = 0;
    let n = 0;
    for (let j = 0; j < grid.count; j++) {
      const dot =
        cx * grid.centers[j * 3] + cy * grid.centers[j * 3 + 1] + cz * grid.centers[j * 3 + 2];
      if (dot < 0.99) continue;
      n++;
      if (levels[j] < rt.waterLevel) sea++;
    }
    const score = sea / Math.max(n, 1) + 0.3 * day;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  e['sDir'].set(grid.centers[best * 3], grid.centers[best * 3 + 1], grid.centers[best * 3 + 2]);
  e['sPitch'] = -0.1;
  e['sEyeH'] = e['sEyeHTarget'] = 0.02; // elevated, like standing on a bluff
});
await page.waitForTimeout(1500);

for (const yaw of [0, 1.05, 2.09, 3.14, 4.19, 5.24]) {
  await page.evaluate((y) => { window.__engine['sYaw'] = y; }, yaw);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `previews/flood-${yaw}.png` });
}
await browser.close();
