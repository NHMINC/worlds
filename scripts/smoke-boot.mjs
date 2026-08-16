/* The boot cinematic, end to end. Cold boot: the formation sim streams
 * live (Act 1), the catalog builds out (Act 2), the explorer opens
 * face-on and flies the magnifier bubble to the start star (Act 3).
 * Warm boot: the cached field replays keyframes and arrives fast.
 * Run: node scripts/smoke-boot.mjs (dev server on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.error('PAGE ERROR:', e.message);
});
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    errors.push(msg.text());
    console.error('CONSOLE:', msg.text());
  }
});

// --- cold boot: wipe everything, the sim must run live ---
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('hex-world-builder');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  localStorage.removeItem('wb_last_system');
});
const t0 = Date.now();
await page.reload({ waitUntil: 'domcontentloaded' });

await page.waitForSelector('.universe-boot-stage', { timeout: 30000 });

// Act 1: the live sim streams snapshots with a Gyr clock.
await page.waitForFunction(
  () => document.querySelector('.ub-title')?.textContent === 'The galaxy forms',
  { timeout: 60000 },
);
await page.waitForFunction(
  () => /Gyr/.test(document.querySelector('.ub-detail')?.textContent ?? ''),
  { timeout: 60000 },
);
await page.waitForTimeout(2500);
const act1 = await page.evaluate(() => ({
  title: document.querySelector('.ub-title')?.textContent ?? null,
  detail: document.querySelector('.ub-detail')?.textContent ?? null,
}));
console.log('ACT1', JSON.stringify(act1));
await page.screenshot({ path: 'previews/boot-1-formation.png' });

// Act 2: the catalog buildout counts beacons in.
await page.waitForFunction(
  () => document.querySelector('.ub-title')?.textContent === 'Cataloguing the stars',
  { timeout: 150000 },
);
await page.waitForFunction(
  () => /beacons/.test(document.querySelector('.ub-detail')?.textContent ?? ''),
  { timeout: 90000 },
);
const act2 = await page.evaluate(() => ({
  title: document.querySelector('.ub-title')?.textContent ?? null,
  detail: document.querySelector('.ub-detail')?.textContent ?? null,
}));
console.log('ACT2', JSON.stringify(act2));
await page.screenshot({ path: 'previews/boot-2-catalog.png' });

// Act 3: the explorer opens with the relocation flight running.
await page.waitForSelector('.galaxy-explorer', { timeout: 120000 });
await page.waitForFunction(() => window.__galaxyView?.introActive?.() === true, { timeout: 60000 });
const act3 = await page.evaluate(() => ({
  intro: window.__galaxyView?.introActive?.() ?? null,
  skip: Boolean(document.querySelector('.gx-skip')),
  chromeHidden: !document.querySelector('.galaxy-top'),
  region: window.__galaxyView?.currentRegion?.() ?? null,
}));
console.log('ACT3', JSON.stringify(act3));
if (!act3.skip) errors.push('no Skip button during the relocation flight');
if (!act3.chromeHidden) errors.push('explorer chrome visible during the intro');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'previews/boot-3-flight.png' });

// The bubble must be SLIDING (magnifier relocation), camera pinned.
const mid = await page.evaluate(() => {
  const v = window.__galaxyView;
  const r = v?.currentRegion?.() ?? null;
  const p = v?.camera?.position;
  return { region: r, camAtOrigin: p ? Math.hypot(p.x, p.y, p.z) : -1 };
});
const slid =
  act3.region && mid.region
    ? Math.hypot(
        mid.region.x - act3.region.x,
        mid.region.y - act3.region.y,
        mid.region.z - act3.region.z,
      )
    : 0;
console.log('FLIGHT', JSON.stringify({ slid, camAtOrigin: mid.camAtOrigin }));
if (slid < 0.5) errors.push(`relocation did not slide the bubble (${slid.toFixed(3)} kpc)`);
if (mid.camAtOrigin > 1e-4) errors.push('camera left the bubble centre during the flight');

// Arrival: intro ends, the veil lifts, the star is on the reticle.
await page.waitForFunction(() => window.__galaxyView?.introActive?.() === false, { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.universe-boot-stage'), { timeout: 30000 });
const arrived = await page.evaluate(() => ({
  mode: window.__galaxyView?.currentMode?.() ?? null,
  selected: window.__galaxyView?.selectedObject?.()?.id ?? null,
  here: window.__galaxyView?.here?.()?.id ?? null,
  home: window.__galaxyView?.home?.id ?? null,
  chrome: Boolean(document.querySelector('.galaxy-top')),
  dossier: document.querySelector('.gd-class')?.textContent ?? null,
}));
console.log('ARRIVED', JSON.stringify(arrived), `cold boot ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await page.screenshot({ path: 'previews/boot-4-arrived.png' });
if (arrived.mode !== 'region') errors.push(`arrival mode ${arrived.mode}`);
const expect = arrived.here ?? arrived.home;
if (expect != null && arrived.selected !== expect) {
  errors.push(`arrived on ${arrived.selected}, not ${expect}`);
}
if (!arrived.chrome) errors.push('explorer chrome missing after arrival');

// --- warm boot: the cached field replays; no 25 s sim ---
const t1 = Date.now();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.universe-boot-stage', { timeout: 30000 });
await page.waitForSelector('.galaxy-explorer', { timeout: 90000 });
await page.waitForFunction(() => window.__galaxyView?.introActive?.() === false, { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.universe-boot-stage'), { timeout: 30000 });
const warmS = (Date.now() - t1) / 1000;
console.log('WARM', JSON.stringify({ seconds: +warmS.toFixed(1) }));
await page.screenshot({ path: 'previews/boot-5-warm.png' });
if (warmS > 60) errors.push(`warm boot took ${warmS.toFixed(0)}s — cache not used?`);

console.log('ERRORS', errors.length ? errors.join('\n---\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
