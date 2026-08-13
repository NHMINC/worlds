/* Sunglint smoke: travel to a temperate liquid-ocean world, aim the
 * camera so the Cox–Munk specular point sits on open water, and shoot
 * orbit (oblique glitter path) plus a surface look toward the sun.
 * Shader errors fail the run.
 * Run: node scripts/smoke-glint.mjs (dev server must be on :5173). */
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

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill('dusk-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);

await page.evaluate(() => window.__engine.travelTo('p4'));
await page.waitForTimeout(6000);
console.log('view', await page.evaluate(() => window.__engine.getView()));

/** Place the geo camera `offset` rad from the sun, rotating around the
 * sun axis so the approximate specular point sits on open ocean. */
async function frameGlint(offset, file) {
  const aim = await page.evaluate((off) => {
    const e = window.__engine;
    const rt = e['bodies'].get(e['orbitBodyId']);
    const qInv = rt.spinQ.clone().conjugate();
    const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
    const grid = rt.grid;
    const levels = rt.levels;
    const wl = rt.waterLevel;
    const ref = Math.abs(sunL.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const pole = sunL
      .clone()
      .set(ref.x, ref.y, ref.z)
      .addScaledVector(sunL, -sunL.dot(ref))
      .normalize();
    let bestAz = 0;
    let bestScore = -1e9;
    for (let i = 0; i < 24; i++) {
      const az = (i / 24) * Math.PI * 2;
      const camDir = sunL.clone().applyAxisAngle(pole, off).applyAxisAngle(sunL, az).normalize();
      const spec = sunL.clone().add(camDir).normalize();
      let wet = 0;
      let land = 0;
      for (let c = 0; c < grid.count; c++) {
        const d =
          grid.centers[c * 3] * spec.x +
          grid.centers[c * 3 + 1] * spec.y +
          grid.centers[c * 3 + 2] * spec.z;
        if (d < 0.985) continue;
        if (levels[c] < wl - 1) wet++;
        else land++;
      }
      const score = wet - 0.5 * land;
      if (score > bestScore) {
        bestScore = score;
        bestAz = az;
      }
    }
    const camDir = sunL.clone().applyAxisAngle(pole, off).applyAxisAngle(sunL, bestAz).normalize();
    const z = rt.pos.clone().set(0, 0, 1);
    e['orient'].setFromUnitVectors(z, camDir);
    e['orbitStyle'] = 'geo';
    e['angVel'].set(0, 0, 0);
    e.viewLetterbox();
    return { bestAz, bestScore };
  }, offset);
  console.log(file, aim);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: file });
}

await frameGlint(0.7, 'previews/glint-0-orbit.png');
await frameGlint(1.05, 'previews/glint-1-oblique.png');
await frameGlint(1.3, 'previews/glint-3-grazing.png');

await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(3500);
const landed = await page.evaluate(() => {
  const e = window.__engine;
  const rt = e['bodies'].get(e['orbitBodyId']);
  if (!rt?.grid) return { ok: false, reason: 'no grid' };
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
    if (day < 0.7) continue;
    if (levels[i] >= rt.waterLevel - 2) continue;
    if (day > bestScore) {
      bestScore = day;
      best = i;
    }
  }
  if (best < 0) return { ok: false, reason: 'no dayside ocean' };
  e['sDir'].set(grid.centers[best * 3], grid.centers[best * 3 + 1], grid.centers[best * 3 + 2]);
  const dir = e['sDir'];
  const east = dir.clone().set(-dir.y, dir.x, 0);
  if (east.lengthSq() < 1e-8) east.set(0, 1, 0);
  east.normalize();
  const north = dir.clone().cross(east).normalize();
  const t = sunL.clone().addScaledVector(dir, -sunL.dot(dir));
  e['sYaw'] = Math.atan2(t.dot(east), t.dot(north));
  e['sPitch'] = -0.12;
  e['sEyeH'] = e['sEyeHTarget'] = 0.012;
  return { ok: true, mode: e.getView().mode, bestScore };
});
console.log('landed', landed);
await page.waitForTimeout(1500);
await page.screenshot({ path: 'previews/glint-2-surface.png' });

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page/shader errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
