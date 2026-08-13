/* Frame-throughput probe: uncap vsync and count rAF deltas in the views
 * where the scattering march is heaviest, plus an airless baseline.
 * Usage: node scripts/smoke-perf.mjs [seed] */
import { chromium } from 'playwright-core';

const seed = process.argv[2] ?? 'dusk-0';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(2500);

await page.click('button[title="Star systems"]');
await page.waitForSelector('.modal');
await page.locator('.seed-row input').fill(seed);
await page.waitForTimeout(300);
await page.click('button:has-text("Create system")');
await page.waitForTimeout(4000);

async function measure(label, ms = 4000) {
  const r = await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const dts = [];
        let last = performance.now();
        const t0 = last;
        function tick(now) {
          dts.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(tick);
          else {
            dts.sort((a, b) => a - b);
            const avg = dts.reduce((s, d) => s + d, 0) / dts.length;
            resolve({
              fps: Math.round(1000 / avg),
              avgMs: +avg.toFixed(2),
              p95Ms: +dts[Math.floor(dts.length * 0.95)].toFixed(2),
            });
          }
        }
        requestAnimationFrame(tick);
      }),
    ms,
  );
  console.log(label, JSON.stringify(r));
}

// Airy world, from orbit (terrain + water + two sky-shell passes on screen).
await page.evaluate(() => window.__engine.travelTo('p4'));
await page.waitForTimeout(6000);
await measure('orbit  airy   (p4)');

// Ground view: sky shell fills the frame, terrain+water under it.
await page.click('button[title="Land — set down and glide over the terrain"]');
await page.waitForTimeout(2500);
await measure('ground airy   (p4)');
await page.click('button[title="Take off — rise back into orbit"]');
await page.waitForTimeout(2500);

// Airless baseline: no scattering march at all.
await page.evaluate(() => window.__engine.travelTo('p2m0'));
await page.waitForTimeout(6000);
await measure('orbit  airless(p2m0)');

await browser.close();
