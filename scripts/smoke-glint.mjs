/* Sunglint smoke: frame the dayside ocean from orbit so the Cox–Munk
 * glitter path sits on the disc (the Earth-from-space look), then stand
 * on open water facing the sun. Shader errors fail the run.
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
await page.locator('.seed-row input').fill('smoke-0');
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);

const home = await page.evaluate(() => {
  const v = window.__engine.getView();
  window.__engine.enterOrbit(v.bodyId, 'geo');
  window.__engine.setOverrides(v.bodyId, { temp: 0.95 });
  return v.bodyId;
});
console.log('home body:', home);

/** Aim the geo camera this many radians off the subsolar point so the
 * specular point sits on the disc, sun to one side — not a dead-on noon
 * shot that hides the path in the planet's center. */
async function frameGlint(offset, file) {
  await page.evaluate((off) => {
    const e = window.__engine;
    const rt = e['bodies'].get(e['orbitBodyId']);
    const qInv = rt.spinQ.clone().conjugate();
    const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
    const pole = sunL.clone();
    pole.set(-sunL.y, sunL.x, 0);
    if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
    pole.normalize();
    const camDir = sunL.clone().applyAxisAngle(pole, off).normalize();
    const z = rt.pos.clone().set(0, 0, 1);
    e['orient'].setFromUnitVectors(z, camDir);
    e['orbitStyle'] = 'geo';
    e['angVel'].set(0, 0, 0);
    e.viewLetterbox();
  }, offset);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: file });
}

await frameGlint(0.55, 'previews/glint-0-orbit.png');
await frameGlint(0.95, 'previews/glint-1-oblique.png');

await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);
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
    if (day < 0.45) continue;
    if (levels[i] >= rt.waterLevel - 2) continue;
    const score = day;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  e['sDir'].set(grid.centers[best * 3], grid.centers[best * 3 + 1], grid.centers[best * 3 + 2]);
  const here = e['sDir'];
  const east = here.clone().set(-here.y, here.x, 0);
  if (east.lengthSq() < 1e-8) east.set(0, 1, 0);
  east.normalize();
  const sunTan = sunL.clone().addScaledVector(here, -here.dot(sunL)).normalize();
  e['sYaw'] = Math.atan2(sunTan.dot(east), sunTan.dot(here.clone().cross(east).normalize()));
  e['sPitch'] = -0.18;
  e['sEyeH'] = e['sEyeHTarget'] = 0.012;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'previews/glint-2-surface.png' });

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page/shader errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
