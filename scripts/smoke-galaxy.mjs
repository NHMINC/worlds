/* Fresh boot + galaxy explorer. Clears IndexedDB, loads the app, opens
 * the catalog, zooms toward home. Run: node scripts/smoke-galaxy.mjs
 * (dev server on :5173). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

mkdirSync('previews', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('hex-world-builder');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  localStorage.removeItem('wb_last_system');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);

const boot = await page.evaluate(() => {
  const e = window.__engine;
  const bodies = e ? [...e.bodies?.keys?.() ?? e['bodies']?.keys?.() ?? []] : [];
  let bodyCount = 0;
  try {
    bodyCount = e?.['bodies']?.size ?? 0;
  } catch {
    bodyCount = -1;
  }
  return {
    hasEngine: Boolean(e),
    bodyCount,
    title: document.querySelector('.tb-world')?.textContent ?? document.querySelector('.toolbar')?.innerText?.slice(0, 80) ?? '',
    toolbar: Boolean(document.querySelector('.toolbar, .tb-btn')),
    galaxyHud: Boolean(document.querySelector('.galaxy-explorer')),
  };
});
console.log('BOOT', JSON.stringify(boot));
await page.screenshot({ path: 'previews/galaxy-0-boot.png' });

const galaxyBtn = page.locator('button[title="Galaxy — the shared catalog"]');
if (await galaxyBtn.count()) {
  await galaxyBtn.click();
  await page.waitForTimeout(4000);
  const gx = await page.evaluate(() => ({
    explorer: Boolean(document.querySelector('.galaxy-explorer')),
    loading: document.querySelector('.galaxy-loading')?.textContent ?? null,
    title: document.querySelector('.galaxy-title')?.textContent ?? null,
    sub: document.querySelector('.galaxy-sub')?.textContent ?? null,
    canvas: document.querySelector('.galaxy-stage canvas')?.width ?? 0,
  }));
  console.log('GALAXY', JSON.stringify(gx));
  await page.screenshot({ path: 'previews/galaxy-1-face.png' });

  await page.waitForFunction(() => Boolean(window.__galaxyView?.home), { timeout: 8000 });
  const ring = await page.evaluate(() => {
    const v = window.__galaxyView;
    const p = v.projectClient(v.home);
    return p;
  });
  console.log('HOME RING', JSON.stringify(ring));
  if (ring) {
    await page.mouse.click(ring.x, ring.y);
    await page.waitForTimeout(2500);
  }
  const afterRing = await page.evaluate(() => ({
    dossier: document.querySelector('.gd-class')?.textContent ?? null,
    pickable: window.__galaxyView?.canPick?.() ?? null,
    radius: window.__galaxyView?.tgtRadius ?? window.__galaxyView?.radius ?? null,
  }));
  console.log('AFTER RING TAP', JSON.stringify(afterRing));
  await page.screenshot({ path: 'previews/galaxy-2-home.png' });
  if (!afterRing.dossier) {
    console.error('FAIL: tapping the home ring did not open a dossier');
    errors.push('home ring tap did not select');
  }

  const approached = await page.evaluate(() => {
    const v = window.__galaxyView;
    const o = v.approachNearest?.();
    return o ? { id: o.id, phase: o.star.phase } : null;
  });
  console.log('APPROACH', JSON.stringify(approached));
  await page.waitForTimeout(800);
  const close = await page.evaluate(() => {
    const v = window.__galaxyView;
    const discs = v.resolvedStars?.() ?? [];
    const target = discs.find((o) => o.id === v.selectedObject?.()?.id) ?? discs[0];
    const first = target ? v.projectClient(target) : null;
    return {
      n: discs.length,
      sample: discs.slice(0, 4).map((o) => o.star.phase),
      first,
      radius: v.radius ?? null,
    };
  });
  console.log('DISCS', JSON.stringify(close));
  await page.screenshot({ path: 'previews/galaxy-3-discs.png' });
  if (!close.n) {
    console.error('FAIL: no photospheres after flying in');
    errors.push('no photospheres after approach');
  }
  const tap = close.first && close.first.x > 40 && close.first.x < 1240 && close.first.y > 40 && close.first.y < 760
    ? close.first
    : { x: 640, y: 400 };
  if (close.n) {
    await page.mouse.click(tap.x, tap.y);
    try {
      await page.waitForFunction(() => !document.querySelector('.galaxy-explorer'), { timeout: 20000 });
    } catch {
      console.error('FAIL: tapping a rendered star did not set course');
      errors.push('rendered star tap did not set course');
    }
    const afterGo = await page.evaluate(() => ({
      explorer: Boolean(document.querySelector('.galaxy-explorer')),
      title: document.querySelector('.tb-world')?.textContent ?? '',
    }));
    console.log('AFTER DISC TAP', JSON.stringify(afterGo));
    await page.screenshot({ path: 'previews/galaxy-3-tap.png' });
  }
} else {
  console.error('NO GALAXY BUTTON');
  errors.push('no galaxy button');
}

const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await phone.waitForTimeout(2500);
await phone.click('button[title="Galaxy — the shared catalog"]');
await phone.waitForTimeout(1500);
const phoneUi = await phone.evaluate(() => ({
  homeChip: Boolean([...document.querySelectorAll('button.gx-chip')].find((b) => b.textContent === 'Home')),
}));
console.log('PHONE', JSON.stringify(phoneUi));
await phone.screenshot({ path: 'previews/galaxy-4-phone.png' });
if (!phoneUi.homeChip) {
  console.error('FAIL: Home chip hidden on a phone-sized viewport');
  errors.push('home chip hidden on phone');
}
await phone.close();

console.log('ERRORS', errors.length ? errors.join('\n---\n') : 'none');
await browser.close();
if (errors.length) process.exitCode = 1;
