/* Sunset showcase: scan seeds for the most Earthlike world (gravity,
 * pressure, radius, temperate), land on its terminator facing the sun.
 * Usage: node scripts/smoke-sunset.mjs [seedPrefix] [count] */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const prefix = process.argv[2] ?? 'dusk';
const count = Number(process.argv[3] ?? 6);
mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

let best = null;
for (let s = 0; s < count; s++) {
  const seed = `${prefix}-${s}`;
  await page.click('button[title="Star systems"]');
  await page.waitForSelector('.modal');
  await page.locator('.seed-row input').fill(seed);
  await page.waitForTimeout(250);
  await page.click('button:has-text("Create system")');
  await page.waitForTimeout(3000);
  const rows = await page.evaluate(() => {
    const e = window.__engine;
    const out = [];
    for (const [id, rt] of e['bodies']) {
      const p = rt.phys;
      if (rt.spec.kind !== 'rocky' || !p) continue;
      out.push({
        id,
        name: rt.spec.name,
        g: p.gravity,
        P: p.atmosphere.pressure,
        R: p.radiusRel,
        T: p.TsurfK,
        hydro: p.hydrosphere.state,
      });
    }
    return out;
  });
  for (const b of rows) {
    if (b.P < 0.3 || b.hydro === 'none') continue;
    // Distance from Earthlike in log-space; temperate bonus.
    const score =
      Math.abs(Math.log(b.g / 1)) +
      Math.abs(Math.log(b.P / 1)) +
      Math.abs(Math.log(Math.max(0.05, b.R) / 1)) +
      Math.abs(b.T - 288) / 60;
    if (!best || score < best.score) best = { seed, score, ...b };
  }
  console.log(seed, JSON.stringify(rows));
}
if (!best) {
  console.log('no candidate found');
  await browser.close();
  process.exit(0);
}
console.log('BEST:', JSON.stringify(best));

// Recreate its system and go there.
await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill(best.seed);
await page.waitForTimeout(250);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(3000);
await page.evaluate((id) => window.__engine.travelTo(id), best.id);
await page.waitForTimeout(6000);

await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);

/** Stand at offsetDeg past the substellar point, low to the ground,
 * facing the sun's azimuth. On toy globes even a low eye dips the visible
 * horizon by sqrt(2*eyeH) radians, so "sunset" offsets run past 90 deg. */
async function standAt(offsetDeg, file) {
  await page.evaluate((offsetDeg) => {
    const e = window.__engine;
    const rt = e['bodies'].get(e['orbitBodyId']);
    const qInv = rt.spinQ.clone().conjugate();
    const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
    const pole = sunL.clone().set(-sunL.y, sunL.x, 0).normalize();
    const dir = sunL.clone().applyAxisAngle(pole, (offsetDeg * Math.PI) / 180).normalize();
    e['sDir'].copy(dir);
    const east = dir.clone().set(-dir.y, dir.x, 0).normalize();
    const north = new (dir.constructor)().crossVectors(dir, east);
    const t = sunL.clone().addScaledVector(dir, -sunL.dot(dir));
    e['sYaw'] = Math.atan2(t.dot(east), t.dot(north));
    e['sPitch'] = -0.04;
    e['sEyeH'] = e['sEyeHTarget'] = 0.012;
  }, offsetDeg);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `previews/${file}` });
}

// Visible-horizon dip at eyeH 0.012 is sqrt(2*0.012) = 8.9 deg, so the
// sun kisses the sea horizon around 99 deg past the substellar point.
await standAt(92, 'sunset-1-golden.png');
await standAt(99, 'sunset-2-horizon.png');
await standAt(104, 'sunset-3-afterglow.png');
await browser.close();
