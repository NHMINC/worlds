/* The distant backdrop is one integral (galaxyField.ts): its frame
 * cost must not follow the look direction. Before the field, aiming
 * at the core rasterized a ~50× deeper envelope-sprite stack and the
 * frame time followed the stellar density law.
 *
 * Local-cloud sprites and near-shell envelopes are APPROACHING
 * OBJECTS — their population legitimately varies with where the
 * bubble sits — so the harness hides them and measures the backdrop
 * alone (field march + silhouette point stars). The ratio gate is
 * dimensionless, so it holds on software CI and real GPUs alike. */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error('PAGE', e.message);
});

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('button[title="Galaxy — the shared catalog"]');
await page.locator('button[title="Galaxy — the shared catalog"]').click();
await page.waitForFunction(() => Boolean(window.__galaxyView?.home), { timeout: 12000 });

async function frameMs(label) {
  const ms = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        let t0 = 0;
        const tick = (t) => {
          if (n === 0) t0 = t;
          n++;
          if (n >= 8) resolve((t - t0) / 7);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(label, 'frame', ms.toFixed(1), 'ms');
  return ms;
}

await page.evaluate(() => window.__galaxyView?.setPreset?.('home'));
await page.waitForFunction(() => window.__galaxyView?.currentMode?.() === 'region', { timeout: 25000 });
await page.waitForTimeout(1500);

const aim = (sign) =>
  page.evaluate((s) => {
    const v = window.__galaxyView;
    const c = v.arcCenter;
    v.aimAt?.(s * -c.x, s * -c.y, s * -c.z);
  }, sign);

// Full-frame numbers first (informational: includes approaching objects).
await aim(-1);
await page.waitForTimeout(500);
const rimAll = await frameMs('RIM full');
await aim(1);
await page.waitForTimeout(500);
const coreAll = await frameMs('CORE full');
console.log('full-frame core/rim', (coreAll / Math.max(rimAll, 1e-3)).toFixed(2));

// Backdrop alone: hide the local cloud and the near-shell envelopes.
await page.evaluate(() => {
  const v = window.__galaxyView;
  for (const k of ['starPts', 'starEmisPts', 'starDustPts', 'silEmisPts', 'silDustPts']) {
    if (v[k]) v[k].visible = false;
  }
});
await aim(-1);
await page.waitForTimeout(400);
const rim = await frameMs('RIM backdrop');
await aim(1);
await page.waitForTimeout(400);
const core = await frameMs('CORE backdrop');

const ratio = core / Math.max(rim, 1e-3);
console.log('backdrop core/rim ratio', ratio.toFixed(2));
if (ratio > 2.5) errors.push(`core backdrop is ${ratio.toFixed(2)}x the rim — the sky cost follows the density law again`);

console.log('ERRORS', errors.length ? errors.join('\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
