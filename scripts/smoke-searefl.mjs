/* Land reflections in water: stand just offshore facing the coast — the
 * hills must appear mirrored in the sea. */
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

for (const yaw of [0, 1.57, 3.14, 4.71]) {
  await page.evaluate((y) => {
    const e = window.__engine;
    const rt = e['bodies'].get(e['orbitBodyId']);
    const qInv = rt.spinQ.clone().conjugate();
    const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
    const grid = rt.grid;
    const levels = rt.levels;
    // Daylit spot standing ON open water (everything within ~2 deg is sea)
    // with tall coast a few degrees out: the mirror stage.
    let best = -1;
    let bestScore = -1e9;
    for (let i = 0; i < grid.count; i++) {
      const cx = grid.centers[i * 3];
      const cy = grid.centers[i * 3 + 1];
      const cz = grid.centers[i * 3 + 2];
      const day = cx * sunL.x + cy * sunL.y + cz * sunL.z;
      if (day < 0.6) continue;
      if (levels[i] >= rt.waterLevel - 2) continue;
      let tall = -99;
      let wet = true;
      for (let j = 0; j < grid.count; j++) {
        const dot =
          cx * grid.centers[j * 3] + cy * grid.centers[j * 3 + 1] + cz * grid.centers[j * 3 + 2];
        if (dot < 0.994) continue; // ~6 deg neighborhood
        if (dot > 0.9994 && levels[j] >= rt.waterLevel - 0.5) wet = false; // ~2 deg core must be sea
        else if (levels[j] > tall) tall = levels[j];
      }
      if (!wet) continue;
      const score = tall - rt.waterLevel;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    e['sDir'].set(grid.centers[best * 3], grid.centers[best * 3 + 1], grid.centers[best * 3 + 2]);
    e['sYaw'] = y;
    e['sPitch'] = -0.12;
    e['sEyeH'] = e['sEyeHTarget'] = 0.01;
  }, yaw);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `previews/searefl-${yaw}.png` });
}
await browser.close();
