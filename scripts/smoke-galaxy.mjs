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

  const other = await page.evaluate(() => {
    const v = window.__galaxyView;
    const homeId = v.home?.id;
    for (const o of v.objects) {
      if (o.id === homeId) continue;
      const p = v.projectClient(o);
      if (p && p.x > 80 && p.x < 1200 && p.y > 80 && p.y < 720) return { id: o.id, ...p };
    }
    return null;
  });
  console.log('OTHER STAR', JSON.stringify(other));
  if (other) {
    await page.mouse.click(other.x, other.y);
    await page.waitForTimeout(800);
    const afterStar = await page.evaluate(() => document.querySelector('.gd-class')?.textContent ?? null);
    console.log('AFTER STAR TAP', afterStar);
    await page.screenshot({ path: 'previews/galaxy-3-tap.png' });
    if (!afterStar) {
      console.error('FAIL: tapping a resolved star did not open a dossier');
      errors.push('resolved star tap did not select');
    }
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
