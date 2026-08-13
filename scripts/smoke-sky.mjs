/* Sky smoke test: ONE scattering law, four viewpoints. From orbit the limb
 * should wear a blue band; from the ground the same numbers should read as
 * a bright noon sky, a warm terminator horizon, and a dark starry night.
 * Run: node scripts/smoke-sky.mjs (dev server must be on :5173). */
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
await page.evaluate(() => window.__engine.viewLetterbox());
await page.waitForTimeout(4000);
await page.screenshot({ path: 'previews/sky-0-orbit.png' });

// Land anywhere, then steer the landing spot by physics: noon is the
// substellar direction, midnight its opposite, evening the terminator.
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);

/** Move the surface rig to a sun-relative spot and aim it. */
async function placeSun(offsetDeg, pitch, faceSun) {
  await page.evaluate(
    ({ offsetDeg, pitch, faceSun }) => {
      const e = window.__engine;
      const rt = e['bodies'].get(e['orbitBodyId']);
      const qInv = rt.spinQ.clone().conjugate();
      const sunL = rt.pos.clone().multiplyScalar(-1).normalize().applyQuaternion(qInv);
      // Rotate away from the substellar point around a perpendicular axis.
      const pole = sunL.clone().set(-sunL.y, sunL.x, 0).normalize();
      const dir = sunL.clone().applyAxisAngle(pole, (offsetDeg * Math.PI) / 180).normalize();
      e['sDir'].copy(dir);
      // Heading: face the sun's azimuth (or away when it is overhead).
      const east = dir.clone().set(-dir.y, dir.x, 0).normalize();
      const north = dir.clone().cross(east).multiplyScalar(-1); // north = dir x east
      north.crossVectors(dir, east);
      const t = sunL.clone().addScaledVector(dir, -sunL.dot(dir));
      e['sYaw'] = t.lengthSq() > 1e-8 && faceSun ? Math.atan2(t.dot(east), t.dot(north)) : 0;
      e['sPitch'] = pitch;
      e['sEyeH'] = e['sEyeHTarget'] = 0.05;
    },
    { offsetDeg, pitch, faceSun },
  );
  await page.waitForTimeout(600);
}

// Noon: sun overhead, camera looking at the horizon.
await placeSun(0, 0.1, false);
await page.screenshot({ path: 'previews/sky-1-noon.png' });
// Noon, looking nearly straight up.
await placeSun(0, 1.25, false);
await page.screenshot({ path: 'previews/sky-2-zenith.png' });
// Evening: standing on the terminator, facing the sun on the horizon.
await placeSun(87, 0.12, true);
await page.screenshot({ path: 'previews/sky-3-sunset.png' });
// Midnight: antisolar point, looking up for stars.
await placeSun(178, 0.9, false);
await page.screenshot({ path: 'previews/sky-4-night.png' });

await browser.close();
